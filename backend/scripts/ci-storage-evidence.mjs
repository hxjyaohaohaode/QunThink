import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));

// Reporting only: test input and raw TAP validation never pass through this.
// Redact before truncating, including incomplete PEM blocks from a killed child.
export function sanitizeStorageOutput(value, maxBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) throw new Error('Invalid evidence output byte limit');
  const clean = String(value)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/"'<>?#]*@/gi, '$1[REDACTED USERINFO]@');
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= maxBytes) return clean;
  const marker = '[bounded output: UTF-8 tail]\n';
  let start = bytes.length - (maxBytes - Buffer.byteLength(marker));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return marker + bytes.subarray(start).toString('utf8');
}
export async function writeStorageEvidence(name, value, env = process.env) {
  if (!env.QUNTHINK_STORAGE_EVIDENCE_DIR) return;
  if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('Invalid storage evidence filename');
  const directory = path.resolve(env.QUNTHINK_STORAGE_EVIDENCE_DIR);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  const safe = sanitizeStorageOutput(serialized, typeof value === 'string' ? 1024 * 1024 : Math.max(64, Buffer.byteLength(serialized)));
  // A structured receipt must remain valid JSON, never a silently truncated tail.
  if (typeof value !== 'string' && Buffer.byteLength(safe) > 1024 * 1024) throw new Error('Storage evidence JSON exceeds 1 MiB');
  await fs.writeFile(path.join(directory, name), safe, { mode: 0o600 });
}
export async function sourceManifest() {
  const files = [];
  async function visit(relative) {
    const full = path.join(repository, relative);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(full)).sort()) await visit(`${relative}/${child}`);
    } else if (stat.isFile()) {
      const content = await fs.readFile(full);
      files.push({ path: relative, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    }
  }
  for (const source of ['.github/workflows/ci.yml', 'backend/package.json', 'backend/package-lock.json', 'backend/scripts', 'backend/src', 'backend/test', 'shared']) await visit(source);
  return { schemaVersion: 1, node: process.version, platform: process.platform, architecture: process.arch,
    gitHubSha: process.env.GITHUB_SHA || null, files,
    manifestSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'sanitize-setup') {
    // The raw file stays outside the artifact directory, and is removed even on failure.
    const raw = process.argv[3];
    try {
      const output = sanitizeStorageOutput(await fs.readFile(raw, 'utf8'));
      await writeStorageEvidence('setup.log', output);
      process.stdout.write(output);
    } finally { await fs.rm(raw, { force: true }); }
  } else {
    await writeStorageEvidence('source-manifest.json', await sourceManifest());
  }
}
