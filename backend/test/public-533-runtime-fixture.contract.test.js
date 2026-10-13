import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublic533LegacySample, verifyPublic533Sources } from './fixtures/generate-public-533-legacy.mjs';

const helper = new URL('./fixtures/generate-public-533-legacy.mjs', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');

test('legacy producer sources are complete, unchanged public533 bytes', async () => {
  const { manifest, sources } = await verifyPublic533Sources();
  assert.equal(manifest.public_commit, '533d7be3cdd47691602574ccac7c6524e7ed7ab3');
  assert.equal(sources.size, 8);
  for (const [name, bytes] of sources) assert.equal(digest(bytes), manifest.source_sha256[name]);
});

test('each producer run uses fresh key, identities and ciphertext without changing caller environment', async () => {
  const environment = JSON.stringify(process.env), before = await fs.readdir(new URL('./fixtures/', import.meta.url));
  const first = await createPublic533LegacySample(), second = await createPublic533LegacySample();
  assert.ok(first.encryptionKey !== second.encryptionKey, 'keys are independently random');
  assert.ok(first.owner !== second.owner, 'fixture owner IDs are independently random');
  assert.ok(first.snapshot.tasks[0].id !== second.snapshot.tasks[0].id, 'task IDs are independently random');
  assert.ok(first.snapshot.messages[0].content !== second.snapshot.messages[0].content, 'ciphertexts vary between runs');
  assert.ok(JSON.stringify(process.env) === environment, 'producer leaves caller environment untouched');
  assert.ok(JSON.stringify(await fs.readdir(new URL('./fixtures/', import.meta.url))) === JSON.stringify(before), 'producer writes no fixture artifacts');
  assert.equal(first.snapshot.messages.length, 51);
  assert.equal(first.snapshot.files.length, 5);
  assert.equal(Object.hasOwn(first.tasks.authority.tasks[0], 'priority'), false);
  assert.equal(Object.hasOwn(first.tasks.authority.tasks[0], 'estimated_minutes'), false);
  assert.equal(first.tasks.authority.taskMetadataCommands[0].committed_revision, 1);
  assert.equal(Object.keys(first).includes('encryptionKey'), false);
  assert.throws(() => JSON.stringify(first), /runtime-only and must not be exported/);
  assert.throws(() => JSON.stringify({ sample: first }), /runtime-only and must not be exported/);
});

for (const fault of ['before-generation', 'after-generation', 'write', 'network', 'source-hash']) {
  test(`legacy producer ${fault} failure is isolated and never returns a partial sample`, async () => {
    const environment = JSON.stringify(process.env);
    await assert.rejects(createPublic533LegacySample({ fault }), error =>
      error.message === 'Legacy fixture producer failed; runtime sample output is suppressed'
      && !Object.hasOwn(error, 'stdout') && !Object.hasOwn(error, 'stderr') && !Object.hasOwn(error, 'cause'));
    assert.ok(JSON.stringify(process.env) === environment, 'failed producer leaves caller environment untouched');
    const recovered = await createPublic533LegacySample();
    assert.equal(recovered.snapshot.messages.length, 51);
  });
}

test('retired export CLI rejects arguments and creates no output or runtime material', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-no-export-'));
  try {
    const output = path.join(directory, 'forbidden.json');
    const result = spawnSync(process.execPath, [helper.pathname, output], {
      env: { NODE_ENV: 'test', TZ: 'UTC' }, encoding: 'utf8', timeout: 15000,
    });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('Fixture file export is retired'));
    assert.equal((await fs.readdir(directory)).length, 0);
    const summary = spawnSync(process.execPath, [helper.pathname], {
      env: { NODE_ENV: 'test', TZ: 'UTC' }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(summary.status, 0);
    const value = JSON.parse(summary.stdout);
    assert.deepEqual(Object.keys(value).sort(), ['files', 'messages', 'publicCommit', 'runtimeOnly', 'sourceFiles', 'syntheticOnly']);
    assert.equal(value.runtimeOnly, true); assert.equal(value.messages, 51);
    assert.equal(summary.stderr, '');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// SIGSTOP is a POSIX-only state. The producer deadline remains the real 15s;
// no shortened fake clock can mask a worker that ignores TERM while stopped.
for (const mode of ['ipc-error', 'timeout', 'spawn-error', 'cleanup-error']) {
  test(`legacy producer lifecycle ${mode} terminates or explicitly reports cleanup failure`,
    { skip: process.platform === 'win32' }, () => {
      const probe = new URL('./fixtures/probe-public-533-cleanup.mjs', import.meta.url);
      const result = spawnSync(process.execPath, [probe.pathname, mode, helper.pathname], {
        env: { NODE_ENV: 'test', TZ: 'UTC' }, encoding: 'utf8', timeout: 23000,
      });
      assert.ok(result.status === 0, 'Isolated lifecycle probe failed; output suppressed');
      const observation = JSON.parse(result.stdout);
      assert.equal(observation.returnedSample, false);
      assert.equal(observation.probeCleanupConfirmed, true);
      if (mode === 'cleanup-error') {
        assert.equal(observation.explicitCleanupFailure, true);
        assert.equal(observation.liveAtRejection, true);
        assert.equal(observation.exitConfirmed, false);
        assert.ok(observation.elapsedMs >= 1900 && observation.elapsedMs < 10000);
      } else {
        assert.equal(observation.fixedFailure, true);
        assert.equal(observation.liveAtRejection, false);
        if (mode === 'spawn-error') assert.equal(observation.spawned, false);
        else {
          assert.equal(observation.exitConfirmed, true);
          assert.equal(observation.killedWithSIGKILL, true);
        }
        if (mode === 'timeout') assert.ok(observation.elapsedMs >= 14500 && observation.elapsedMs < 22000);
      }
    });
}
