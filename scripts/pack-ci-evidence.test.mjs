import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { archiveEvidence, hashFile, MAX_PARTS, PART_BYTES, splitArchive, verifyParts } from './pack-ci-evidence.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qunthink-evidence-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('production-size chunks reconstruct incompressible evidence with exact byte counts and SHA-256', async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, 'original.zip');
  const outputDir = path.join(directory, 'parts');
  const bytes = randomBytes(PART_BYTES * 2 + 123);
  await writeFile(input, bytes);
  const manifest = await splitArchive({ input, outputDir, source: { kind: 'synthetic-test' } });
  assert.deepEqual(manifest.parts.map((part) => part.bytes), [PART_BYTES, PART_BYTES, 123]);
  assert.equal(manifest.archive.sha256, createHash('sha256').update(bytes).digest('hex'));
  for (const part of manifest.parts) assert.ok((await stat(path.join(outputDir, part.name))).size <= 20 * 1024 * 1024);
  assert.ok((await stat(path.join(outputDir, 'manifest.json'))).size < 1024 * 1024);
  const restored = path.join(directory, 'restored.zip');
  await verifyParts(outputDir, restored);
  assert.equal(await hashFile(restored), await hashFile(input));
  assert.deepEqual(await readFile(restored), bytes);
});

test('exact part boundaries and a single byte never produce an empty trailing part', async (t) => {
  const directory = await workspace(t);
  for (const size of [1, 16, 17, 32]) {
    const input = path.join(directory, `${size}.zip`);
    await writeFile(input, Buffer.alloc(size, size));
    const manifest = await splitArchive({ input, outputDir: path.join(directory, `parts-${size}`), partBytes: 16 });
    assert.equal(manifest.parts.length, Math.ceil(size / 16));
    assert.ok(manifest.parts.every((part) => part.bytes > 0 && part.bytes <= 16));
  }
});

test('overflow is explicit and never modifies the source or publishes a partial manifest', async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, 'oversized.zip');
  const bytes = randomBytes(33);
  await writeFile(input, bytes);
  const outputDir = path.join(directory, 'parts');
  await assert.rejects(splitArchive({ input, outputDir, partBytes: 16, maxParts: 2 }), /needs 3 parts/);
  await assert.rejects(stat(outputDir), { code: 'ENOENT' });
  assert.deepEqual(await readFile(input), bytes);
  await assert.rejects(splitArchive({ input, outputDir, partBytes: PART_BYTES + 1 }), /Invalid evidence part bounds/);
  await assert.rejects(splitArchive({ input, outputDir, maxParts: MAX_PARTS + 1 }), /Invalid evidence part bounds/);
});

test('stale output, empty input and missing input fail rather than masquerading as complete evidence', async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, 'input.zip');
  const outputDir = path.join(directory, 'parts');
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, 'keep'), 'older-evidence');
  await writeFile(input, 'new-evidence');
  await assert.rejects(splitArchive({ input, outputDir }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(outputDir, 'keep'), 'utf8'), 'older-evidence');
  await writeFile(input, '');
  await assert.rejects(splitArchive({ input, outputDir }), /nonempty/);
  await assert.rejects(splitArchive({ input: `${input}-missing`, outputDir }), { code: 'ENOENT' });
});

test('corrupt, truncated, missing and symlinked parts fail, with incomplete restore output removed', async (t) => {
  const directory = await workspace(t);
  for (const failure of ['corrupt', 'truncated', 'missing', 'symlink']) {
    const input = path.join(directory, `${failure}.zip`);
    const outputDir = path.join(directory, failure);
    const restored = path.join(directory, `${failure}-restored.zip`);
    await writeFile(input, 'full source evidence bytes');
    const manifest = await splitArchive({ input, outputDir, partBytes: 8 });
    const target = path.join(outputDir, manifest.parts[0].name);
    if (failure === 'corrupt') await writeFile(target, 'XXXXXXXX');
    if (failure === 'truncated') await writeFile(target, 'X');
    if (failure === 'missing' || failure === 'symlink') await rm(target);
    if (failure === 'symlink') await symlink(input, target);
    await assert.rejects(verifyParts(outputDir, restored));
    await assert.rejects(stat(restored), { code: 'ENOENT' });
  }
});

test('manifest path traversal, reordered parts, false totals and whole-archive corruption fail', async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, 'input.zip');
  await writeFile(input, 'full source evidence bytes');
  for (const [index, change] of [
    (manifest) => { manifest.parts[0].name = '../input.zip'; },
    (manifest) => { manifest.parts.reverse(); },
    (manifest) => { manifest.archive.bytes++; },
    (manifest) => { manifest.archive.sha256 = '0'.repeat(64); },
  ].entries()) {
    const outputDir = path.join(directory, `parts-${index}`);
    const manifest = await splitArchive({ input, outputDir, partBytes: 8 });
    change(manifest);
    await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyParts(outputDir));
  }
});

test('restore refuses to overwrite an existing archive', async (t) => {
  const directory = await workspace(t);
  const input = path.join(directory, 'input.zip');
  const outputDir = path.join(directory, 'parts');
  await writeFile(input, 'preserved-original');
  await splitArchive({ input, outputDir });
  await assert.rejects(verifyParts(outputDir, input), { code: 'EEXIST' });
  assert.equal(await readFile(input, 'utf8'), 'preserved-original');
});

test('tar round trip retains nested, hidden, Unicode and binary files plus empty directories without conversion', async (t) => {
  const directory = await workspace(t);
  const root = path.join(directory, 'frontend/test-results');
  await mkdir(path.join(root, 'empty directory'), { recursive: true });
  const files = { 'trace.zip': randomBytes(1024), 'video.webm': randomBytes(2048), '完整 screenshot.png': randomBytes(4096), '.hidden-evidence': Buffer.from('kept') };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(root, name), bytes);
  const outputDir = path.join(directory, 'parts');
  const manifest = await archiveEvidence({ cwd: directory, roots: ['frontend/test-results', 'frontend/playwright-report'], outputDir });
  assert.deepEqual(manifest.source.includedRoots, ['frontend/test-results']);
  assert.deepEqual(manifest.source.missingRoots, ['frontend/playwright-report']);
  const restored = path.join(directory, 'restored.tar.gz');
  await verifyParts(outputDir, restored);
  const unpacked = path.join(directory, 'unpacked');
  await mkdir(unpacked);
  assert.equal(spawnSync('tar', ['-xzf', restored, '-C', unpacked]).status, 0);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(await readFile(path.join(unpacked, 'frontend/test-results', name)), bytes);
  assert.deepEqual(await readdir(path.join(unpacked, 'frontend/test-results/empty directory')), []);
  await assert.rejects(archiveEvidence({ cwd: directory, roots: ['absent'], outputDir: path.join(directory, 'none') }), /No browser evidence/);
  await assert.rejects(archiveEvidence({ cwd: directory, roots: ['frontend/test-results'], outputDir: path.join(root, 'parts') }), /outside input roots/);
});

test('workflow uploads each bounded part separately, preserves full evidence and does not repeat historical recovery', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const blocks = workflow.split(/(?=^      - name:)/m);
  for (const directory of ['.ci-evidence']) {
    const filenames = ['manifest.json', ...Array.from({ length: MAX_PARTS }, (_, index) => `evidence.part-${String(index + 1).padStart(3, '0')}`)];
    for (const filename of filenames) {
      const matching = blocks.filter((block) => block.includes(`path: ${directory}/${filename}\n`));
      assert.equal(matching.length, 1, `one independent upload for ${directory}/${filename}`);
      assert.match(matching[0], /uses: actions\/upload-artifact@v4/);
      assert.match(matching[0], /include-hidden-files: true/, 'explicitly include only this exact file under the hidden staging directory');
      assert.match(matching[0], /compression-level: 0/);
      assert.match(matching[0], /if-no-files-found: error/);
      assert.match(matching[0], /name: qunthink-.*-\$\{\{ matrix.project \}\}-(manifest|part-\d{3})/);
    }
  }
  assert.equal(workflow.split('project: [desktop-chromium, mobile-reduced-motion]').length - 1, 1, 'current evidence matrix covers both projects');
  assert.match(workflow, /name: qunthink-browser-evidence.*-\$\{\{ matrix.project \}\}/);
  assert.match(workflow, /suite: \[core, q2\]/);
  assert.match(workflow, /playwright.q2.config.ts/);
  assert.match(workflow, /node --test scripts\/pack-ci-evidence.test.mjs/);
  assert.doesNotMatch(workflow, /actions: write|pull_request_target|workflow_run:|workflow_dispatch:/);
  assert.doesNotMatch(workflow, /recover-original-q1-evidence|recover-ci-evidence|actions\/github-script/, 'completed historical recovery is not repeated');
});
