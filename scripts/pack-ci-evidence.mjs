import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the fixed upload slots in ci.yml and their contract test in sync.
export const PART_BYTES = 20 * 1024 * 1024;
export const MAX_PARTS = 16;
const MANIFEST_BYTES = 1024 * 1024;
const digest = () => createHash('sha256');
const partName = (index) => `evidence.part-${String(index + 1).padStart(3, '0')}`;

export async function hashFile(filename) {
  const hash = digest();
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

export async function splitArchive({ input, outputDir, source = {}, partBytes = PART_BYTES, maxParts = MAX_PARTS }) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > PART_BYTES ||
      !Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > MAX_PARTS) {
    throw new Error('Invalid evidence part bounds');
  }
  const info = await stat(input);
  if (!info.isFile() || info.size < 1) throw new Error('Evidence archive must be a nonempty regular file');
  const count = Math.ceil(info.size / partBytes);
  if (count > maxParts) throw new Error(`Evidence needs ${count} parts; upload capacity is ${maxParts}. No bytes were discarded. Increase the script and workflow slots together; the full artifact remains available.`);
  // Refuse stale output rather than mixing evidence from different runs.
  await mkdir(outputDir);
  try {
    const handle = await open(input, 'r');
    const wholeHash = digest();
    const parts = [];
    const buffer = Buffer.alloc(Math.min(partBytes, 1024 * 1024));
    try {
      let offset = 0;
      for (let index = 0; index < count; index++) {
        const name = partName(index);
        const bytes = Math.min(partBytes, info.size - offset);
        const partHash = digest();
        const output = await open(path.join(outputDir, name), 'wx');
        try {
          let remaining = bytes;
          while (remaining > 0) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), offset);
            if (!bytesRead) throw new Error('Evidence archive changed while reading');
            const chunk = buffer.subarray(0, bytesRead);
            await output.writeFile(chunk);
            wholeHash.update(chunk);
            partHash.update(chunk);
            offset += bytesRead;
            remaining -= bytesRead;
          }
        } finally { await output.close(); }
        parts.push({ name, bytes, sha256: partHash.digest('hex') });
      }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Evidence archive changed while reading');
    } finally { await handle.close(); }
    const manifest = {
      schema: 'qunthink-ci-evidence/v1',
      source,
      archive: { name: path.basename(input), bytes: info.size, sha256: wholeHash.digest('hex') },
      partBytes, maxParts, parts,
      reconstruction: 'Extract every separately uploaded part into one directory with manifest.json. Run: node scripts/pack-ci-evidence.mjs restore <directory> <new-output-archive>. All part and whole-archive SHA-256 values are verified before success. Then unpack the restored tar.gz or original ZIP.',
    };
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(json) > MANIFEST_BYTES) throw new Error('Evidence manifest exceeds its 1 MiB upload bound');
    await writeFile(path.join(outputDir, 'manifest.json'), json, { flag: 'wx' });
    await verifyParts(outputDir);
    return manifest;
  } catch (error) {
    // This directory was created exclusively by this invocation.
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  if ((await stat(manifestPath)).size > MANIFEST_BYTES) throw new Error('Evidence manifest is too large');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema !== 'qunthink-ci-evidence/v1' || !Array.isArray(manifest.parts) ||
      !manifest.parts.length || manifest.parts.length > MAX_PARTS ||
      !Number.isSafeInteger(manifest.partBytes) || manifest.partBytes < 1 || manifest.partBytes > PART_BYTES ||
      !Number.isSafeInteger(manifest.archive?.bytes) || manifest.archive.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.archive?.sha256)) throw new Error('Invalid evidence manifest');
  let total = 0;
  for (const [index, part] of manifest.parts.entries()) {
    if (part.name !== partName(index) || !Number.isSafeInteger(part.bytes) || part.bytes < 1 ||
        part.bytes > manifest.partBytes || !/^[a-f0-9]{64}$/.test(part.sha256) ||
        (index < manifest.parts.length - 1 && part.bytes !== manifest.partBytes)) throw new Error('Invalid evidence part manifest');
    total += part.bytes;
  }
  if (total !== manifest.archive.bytes) throw new Error('Evidence archive byte count mismatch');
  return manifest;
}

export async function verifyParts(directory, outputArchive) {
  const manifest = await readManifest(directory);
  const output = outputArchive ? await open(outputArchive, 'wx') : undefined;
  try {
    const wholeHash = digest();
    for (const part of manifest.parts) {
      const filename = path.join(directory, part.name);
      const info = await lstat(filename);
      if (!info.isFile() || info.size !== part.bytes) throw new Error(`Evidence part byte count/type mismatch: ${part.name}`);
      const partHash = digest();
      let bytes = 0;
      for await (const chunk of createReadStream(filename)) {
        bytes += chunk.length;
        partHash.update(chunk);
        wholeHash.update(chunk);
        if (output) await output.writeFile(chunk);
      }
      if (bytes !== part.bytes || partHash.digest('hex') !== part.sha256) throw new Error(`Evidence part SHA-256 mismatch: ${part.name}`);
    }
    if (wholeHash.digest('hex') !== manifest.archive.sha256) throw new Error('Evidence archive SHA-256 mismatch');
  } catch (error) {
    if (output) {
      await output.close();
      await rm(outputArchive);
    }
    throw error;
  }
  if (output) await output.close();
  return manifest;
}

export async function archiveEvidence({ cwd = process.cwd(), roots, outputDir, source = {} }) {
  const includedRoots = [];
  const missingRoots = [];
  for (const root of roots) {
    if (path.isAbsolute(root) || root.split(/[\\/]/).includes('..')) throw new Error('Evidence roots must be relative descendants');
    const resolved = path.resolve(cwd, root);
    if (path.resolve(outputDir) === resolved || path.resolve(outputDir).startsWith(`${resolved}${path.sep}`)) throw new Error('Evidence output must be outside input roots');
    try {
      if (!(await lstat(resolved)).isDirectory()) throw new Error(`Evidence root is not a directory: ${root}`);
      includedRoots.push(root);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missingRoots.push(root);
    }
  }
  if (!includedRoots.length) throw new Error('No browser evidence directories exist');
  const temporary = await mkdtemp(path.join(tmpdir(), 'qunthink-evidence-'));
  try {
    const input = path.join(temporary, 'evidence.tar.gz');
    // No exclusions or media conversion: directories, hidden files, traces,
    // full-resolution screenshots, videos and reports all remain lossless.
    const result = spawnSync('tar', ['-czf', input, '-C', cwd, '--', ...includedRoots], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Evidence archive creation failed: ${result.error?.message || result.stderr}`);
    return await splitArchive({ input, outputDir, source: { ...source, format: 'tar+gzip', includedRoots, missingRoots } });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, ...args] = process.argv.slice(2);
  try {
    let manifest;
    if (command === 'archive' && directory && args.length) {
      manifest = await archiveEvidence({ outputDir: directory, roots: args, source: {
        kind: 'current-run-browser-evidence', repository: process.env.GITHUB_REPOSITORY || null,
        runId: process.env.GITHUB_RUN_ID || null, runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
        checkoutSha: process.env.GITHUB_SHA || null, project: process.env.EVIDENCE_PROJECT || null,
      } });
    } else if (command === 'restore' && directory && args.length === 1) {
      manifest = await verifyParts(directory, args[0]);
    } else if (command === 'verify' && directory && args.length === 0) {
      manifest = await verifyParts(directory);
    } else throw new Error('Usage: pack-ci-evidence.mjs archive <new-parts-dir> <evidence-root>... | verify <parts-dir> | restore <parts-dir> <new-archive>');
    console.log(`Verified ${manifest.parts.length} evidence parts, ${manifest.archive.bytes} bytes, SHA-256 ${manifest.archive.sha256}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
