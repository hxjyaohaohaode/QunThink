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

test('the observed seventeenth part and exact twenty-four-part bound restore every byte', async (t) => {
  const directory = await workspace(t);
  assert.equal(MAX_PARTS, 24); assert.equal(PART_BYTES, 20 * 1024 * 1024);
  for (const size of [16 * 16 + 1, 24 * 16]) {
    const input = path.join(directory, `input-${size}.zip`), bytes = randomBytes(size);
    await writeFile(input, bytes);
    const outputDir = path.join(directory, `parts-${size}`);
    const manifest = await splitArchive({ input, outputDir, partBytes: 16 });
    assert.equal(manifest.parts.length, Math.ceil(size / 16)); assert.equal(manifest.maxParts, 24);
    assert.equal(manifest.archive.bytes, size); assert.equal(manifest.archive.sha256, createHash('sha256').update(bytes).digest('hex'));
    const restored = path.join(directory, `restored-${size}.zip`); await verifyParts(outputDir, restored);
    assert.deepEqual(await readFile(restored), bytes); assert.equal(await hashFile(restored), await hashFile(input));
    if (manifest.parts.length === 17) {
      const oldOutput = path.join(directory, 'old-capacity');
      await assert.rejects(splitArchive({ input, outputDir: oldOutput, partBytes: 16, maxParts: 16 }), /needs 17 parts; upload capacity is 16/);
      await assert.rejects(stat(oldOutput), { code: 'ENOENT' }); assert.deepEqual(await readFile(input), bytes);
    }
  }
});

test('twenty-fifth part fails before output creation and a forged oversized manifest also fails closed', async (t) => {
  const directory = await workspace(t), input = path.join(directory, 'too-large.zip'), bytes = randomBytes(24 * 16 + 1), outputDir = path.join(directory, 'refused');
  await writeFile(input, bytes);
  await assert.rejects(splitArchive({ input, outputDir, partBytes: 16 }), /needs 25 parts; upload capacity is 24/);
  await assert.rejects(stat(outputDir), { code: 'ENOENT' }); assert.deepEqual(await readFile(input), bytes);
  await writeFile(input, bytes.subarray(0, 24 * 16));
  const accepted = path.join(directory, 'accepted'), manifest = await splitArchive({ input, outputDir: accepted, partBytes: 16 });
  const last = { ...manifest.parts.at(-1), name: 'evidence.part-025' }; manifest.parts.push(last); manifest.archive.bytes += last.bytes;
  await writeFile(path.join(accepted, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyParts(accepted), /Invalid evidence manifest/);
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

// Source contracts use the checked-in workflow's job and step indentation, without a YAML dependency.
function workflowJob(workflow, name) {
  // Split at every peer mapping key, including quoted or anchored jobs, so unknown headers cannot bleed into a previous job.
  const header = new RegExp(`^  ${name}:[ \\t]*(?:#[^\\n]*)?\\n`);
  const jobs = workflow.split(/(?=^  [^\s#][^\n]*:)/m).filter(block => header.test(block));
  assert.equal(jobs.length, 1, `exactly one ${name} job`);
  return jobs[0];
}

function workflowSteps(job) {
  return job.split(/(?=^      - )/m);
}

function assertBrowserEvidenceContract(workflow) {
  const browser = workflowJob(workflow, 'ui-browser-check');
  const blocks = workflowSteps(browser);
  const uploadBlocks = blocks.filter(block => /uses: actions\/upload-artifact@v4/.test(block));
  assert.equal(uploadBlocks.length, MAX_PARTS + 2, 'all parts, one manifest and the complete original artifact');
  for (const block of uploadBlocks) assert.match(block, /^          retention-days: 1$/m, 'every newly uploaded artifact has exactly one-day retention');
  const actualSlots = [...browser.matchAll(/^      - name: Save browser-evidence-parts part (\d{3})$/gm)].map(match => match[1]);
  assert.deepEqual(actualSlots, Array.from({ length: MAX_PARTS }, (_, index) => String(index + 1).padStart(3, '0')), 'exactly the bounded ordered upload slots, no extra or duplicate slots');
  for (const directory of ['.ci-evidence']) {
    const filenames = ['manifest.json', ...Array.from({ length: MAX_PARTS }, (_, index) => `evidence.part-${String(index + 1).padStart(3, '0')}`)];
    for (const filename of filenames) {
      const matching = blocks.filter((block) => block.includes(`path: ${directory}/${filename}\n`));
      assert.equal(matching.length, 1, `one independent upload for ${directory}/${filename}`);
      assert.match(matching[0], /uses: actions\/upload-artifact@v4/);
      assert.match(matching[0], /include-hidden-files: true/, 'explicitly include only this exact file under the hidden staging directory');
      assert.match(matching[0], /compression-level: 0/);
      assert.match(matching[0], /if-no-files-found: error/);
      assert.match(matching[0], /^          retention-days: 1$/m);
      assert.match(matching[0], /steps\.package-evidence\.outcome == 'success'/);
      if (filename !== 'manifest.json') assert.ok(matching[0].includes(`hashFiles('${directory}/${filename}') != ''`));
      assert.match(matching[0], /name: qunthink-.*-\$\{\{ matrix.project \}\}-(manifest|part-\d{3})/);
    }
  }
  const originals = uploadBlocks.filter(block => /^      - name: Save browser evidence$/m.test(block));
  assert.equal(originals.length, 1, 'one complete original browser artifact');
  assert.match(originals[0], /^        if: always\(\)$/m, 'complete browser evidence is uploaded even after failure');
  assert.match(originals[0], /name: qunthink-browser-evidence.*-\$\{\{ matrix.project \}\}/);
  assert.match(originals[0], /^          path: \|\n            frontend\/playwright-report\/\n            frontend\/test-results\/\n/m, 'complete original browser evidence retains both roots');
  assert.equal(browser.split('project: [desktop-chromium, mobile-reduced-motion]').length - 1, 1, 'current evidence matrix covers both projects');
  assert.match(browser, /suite: \[core, q2\]/);
  assert.match(browser, /playwright.q2.config.ts/);
}

function assertWorkflowEvidenceContract(workflow) {
  assertBrowserEvidenceContract(workflow);
  const backendUploads = workflowSteps(workflowJob(workflow, 'backend-check')).filter(block => /uses: actions\/upload-artifact@v4/.test(block));
  assert.equal(backendUploads.length, 1, 'one independent backend storage evidence upload');
  assert.match(backendUploads[0], /^          name: qunthink-backend-storage-evidence$/m, 'backend storage artifact has its own name');
  assert.match(backendUploads[0], /^        if: always\(\)$/m, 'backend storage evidence is uploaded even after failure');
  assert.match(backendUploads[0], /^          path: \$\{\{ runner\.temp \}\}\/qunthink-storage-evidence\/$/m, 'backend storage upload uses only its runner-temporary evidence directory');
  assert.match(backendUploads[0], /^          if-no-files-found: error$/m, 'missing backend storage evidence fails closed');
  assert.match(backendUploads[0], /^          retention-days: 1$/m, 'backend storage evidence has exactly one-day retention');
  for (const block of workflowSteps(workflow).filter(block => /uses: actions\/upload-artifact@v4/.test(block))) {
    assert.match(block, /^          retention-days: 1$/m, 'every newly uploaded artifact has exactly one-day retention');
  }
  assert.match(workflow, /node --test scripts\/pack-ci-evidence.test.mjs/);
  assert.doesNotMatch(workflow, /actions: write|pull_request_target|workflow_run:|workflow_dispatch:/);
  assert.doesNotMatch(workflow, /recover-original-q1-evidence|recover-ci-evidence|actions\/github-script/, 'completed historical recovery is not repeated');
}

test('workflow uploads each bounded part separately, preserves full evidence and does not repeat historical recovery', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assertWorkflowEvidenceContract(workflow);
});

test('backend storage evidence does not consume a browser upload slot and invalid contracts fail closed', async (t) => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const browserSteps = workflowSteps(workflowJob(workflow, 'ui-browser-check'));
  const original = browserSteps.find(block => /^      - name: Save browser evidence$/m.test(block));
  const manifest = browserSteps.find(block => /^      - name: Save browser-evidence-parts manifest$/m.test(block));
  const part = browserSteps.find(block => /^      - name: Save browser-evidence-parts part 001$/m.test(block));
  const storage = workflowSteps(workflowJob(workflow, 'backend-check')).find(block => /uses: actions\/upload-artifact@v4/.test(block));
  assert.ok(original && manifest && part && storage, 'regressions require the real workflow evidence steps');
  assert.doesNotThrow(() => assertBrowserEvidenceContract(workflow.replace(storage, '')));
  assert.doesNotThrow(() => assertWorkflowEvidenceContract(workflow));

  const cases = [
    ['extra browser upload', original, original + original, /all parts, one manifest and the complete original artifact/],
    ['extra unnamed browser upload', original, original + '      - uses: actions/upload-artifact@v4\n        with:\n          retention-days: 1\n', /all parts, one manifest and the complete original artifact/],
    ['missing original browser upload', original, '', /all parts, one manifest and the complete original artifact/],
    ['missing browser manifest', manifest, '', /all parts, one manifest and the complete original artifact/],
    ['missing browser part', part, '', /all parts, one manifest and the complete original artifact/],
    ['extra browser part', part, part + part.replaceAll('001', '025'), /all parts, one manifest and the complete original artifact/],
    ['duplicate browser slot', 'part 002\n', 'part 001\n', /exactly the bounded ordered upload slots/],
    ['out-of-bounds browser slot', 'part 024\n', 'part 025\n', /exactly the bounded ordered upload slots/],
    ['missing browser part path', 'path: .ci-evidence/evidence.part-001\n', 'path: .ci-evidence/wrong-part\n', /one independent upload for .ci-evidence\/evidence.part-001/],
    ['missing browser manifest path', 'path: .ci-evidence/manifest.json\n', 'path: .ci-evidence/wrong-manifest.json\n', /one independent upload for .ci-evidence\/manifest.json/],
    ['incomplete original browser roots', '            frontend/test-results/\n', '', /complete original browser evidence retains both roots/],
    ['missing backend storage upload', storage, '', /one independent backend storage evidence upload/],
    ['duplicate backend storage upload', storage, storage + storage, /one independent backend storage evidence upload/],
    ['wrong backend storage name', storage, storage.replace('name: qunthink-backend-storage-evidence', 'name: unrelated-evidence'), /backend storage artifact has its own name/],
    ['conditional backend storage upload', storage, storage.replace('if: always()', 'if: success()'), /backend storage evidence is uploaded even after failure/],
    ['wrong backend storage path', storage, storage.replace('/qunthink-storage-evidence/', '/other-evidence/'), /backend storage upload uses only its runner-temporary evidence directory/],
    ['missing backend storage allowed', storage, storage.replace('if-no-files-found: error', 'if-no-files-found: ignore'), /missing backend storage evidence fails closed/],
    ['wrong backend storage retention', storage, storage.replace('retention-days: 1', 'retention-days: 2'), /backend storage evidence has exactly one-day retention/],
    ['missing backend storage retention', storage, storage.replace('          retention-days: 1\n', ''), /backend storage evidence has exactly one-day retention/],
    ['unsafe permission outside browser job', '  frontend-check:\n', '  frontend-check:\n    permissions:\n      actions: write\n', /expected to not match/],
    ['historical recovery outside browser job', '  frontend-check:\n', '  frontend-check:\n    name: recover-original-q1-evidence\n', /completed historical recovery is not repeated/],
  ];
  for (const [name, before, after, message] of cases) {
    await t.test(name, () => {
      const changed = workflow.replace(before, after);
      assert.notEqual(changed, workflow, 'the regression must change the real workflow');
      assert.throws(() => assertWorkflowEvidenceContract(changed), { code: 'ERR_ASSERTION', message });
    });
  }
});

test('commented job headers preserve evidence boundaries and cannot mask cross-job moves', async (t) => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const original = workflowSteps(workflowJob(workflow, 'ui-browser-check')).find(block => /^      - name: Save browser evidence$/m.test(block));
  const storage = workflowSteps(workflowJob(workflow, 'backend-check')).find(block => /uses: actions\/upload-artifact@v4/.test(block));
  assert.ok(original && storage && workflow.includes('  docker:\n'), 'boundary regressions require the real jobs and uploads');
  for (const job of ['backend-check', 'ui-browser-check', 'docker']) {
    await t.test(`${job} accepts a trailing header comment`, () => {
      assert.doesNotThrow(() => assertWorkflowEvidenceContract(workflow.replace(`  ${job}:\n`, `  ${job}: # job comment\n`)));
    });
  }
  await t.test('an additional upload in a commented adjacent job is outside the browser count', () => {
    assert.doesNotThrow(() => assertWorkflowEvidenceContract(workflow.replace('  docker:\n', '  docker: # unrelated job\n') + original));
  });
  for (const header of ['docker: # unrelated job', '"docker": # quoted unrelated job', 'docker: &docker_job']) {
    await t.test(`the original upload cannot move into ${header}`, () => {
      const changed = workflow.replace(original, '').replace('  docker:\n', `  ${header}\n`) + original;
      assert.throws(() => assertWorkflowEvidenceContract(changed), { code: 'ERR_ASSERTION', message: /all parts, one manifest and the complete original artifact/ });
    });
  }
  await t.test('storage cannot move into a commented frontend job', () => {
    const changed = workflow.replace(storage, '').replace('  frontend-check:\n', '  frontend-check: # unrelated job\n')
      .replace('      - name: Install frontend dependencies\n', storage + '      - name: Install frontend dependencies\n');
    assert.throws(() => assertWorkflowEvidenceContract(changed), { code: 'ERR_ASSERTION', message: /one independent backend storage evidence upload/ });
  });
  await t.test('a commented duplicate browser job fails closed', () => {
    assert.throws(() => assertWorkflowEvidenceContract(workflow + '\n  ui-browser-check: # duplicate\n    runs-on: ubuntu-latest\n'), { code: 'ERR_ASSERTION', message: /exactly one ui-browser-check job/ });
  });
});
