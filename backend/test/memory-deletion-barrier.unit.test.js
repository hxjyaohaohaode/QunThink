import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeletionBarrier } from '../src/services/memory/deletionBarrier.js';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-deletion-barrier-'));
  t.after(async () => {
    assert.equal(path.dirname(temp), os.tmpdir());
    await fs.rm(temp, { recursive: true, force: true });
  });
  return path.join(temp, 'barrier');
}

test('old user JSON snapshot cannot make a durably deleted memory visible', async t => {
  const directory = await fixture(t);
  const fresh = createDeletionBarrier({ directory, createIfMissing: true });
  await fresh.initialize();
  const oldUserJson = { memoryRecords: [
    { id: 'memory-1', ownerId: 'account-1', state: 'active', content: 'old encrypted body' }
  ] };
  assert.equal(await fresh.isDeleted('account-1', 'memory-1'), false);
  assert.deepEqual(await fresh.markDeleted('account-1', 'memory-1'), { written: true, sequence: 1 });
  assert.deepEqual(await fresh.markDeleted('account-1', 'memory-1'), { written: false, sequence: 1 });

  // Model a restart after replacing only the user JSON with its old backup.
  const restarted = createDeletionBarrier({ directory });
  await restarted.initialize();
  assert.equal(oldUserJson.memoryRecords[0].state, 'active');
  assert.equal(await restarted.isDeleted('account-1', oldUserJson.memoryRecords[0].id), true);
  assert.equal(await restarted.isDeleted('account-2', 'memory-1'), false);
  assert.equal(await restarted.isDeleted('account-1', 'memory-2'), false);
  assert.deepEqual(
    await restarted.deletedIds('account-1', ['memory-1', 'memory-2', 'memory-1']),
    new Set(['memory-1'])
  );
  assert.deepEqual(await restarted.deletedIds('account-2', ['memory-1']), new Set());
  const journal = await fs.readFile(path.join(directory, 'deletions.v1.log'), 'utf8');
  assert.equal(journal.includes('old encrypted body'), false);
  assert.equal(journal.includes('account-1'), false);
  assert.equal(journal.includes('memory-1'), false);
});

test('existing missing or damaged journal fails closed, including after initialization', async t => {
  const directory = await fixture(t);
  await assert.rejects(
    createDeletionBarrier({ directory }).initialize(),
    { code: 'DELETION_BARRIER_UNAVAILABLE' }
  );
  const barrier = createDeletionBarrier({ directory, createIfMissing: true });
  await barrier.initialize();
  await barrier.markDeleted('account-1', 'memory-1');
  await fs.appendFile(path.join(directory, 'deletions.v1.receipts'), 'corrupt\n');
  await assert.rejects(barrier.isDeleted('account-1', 'memory-1'), { code: 'DELETION_BARRIER_CORRUPT' });
  await assert.rejects(barrier.isDeleted('account-2', 'memory-2'), { code: 'DELETION_BARRIER_CORRUPT' });
  await assert.rejects(barrier.markDeleted('account-1', 'memory-2'), { code: 'DELETION_BARRIER_CORRUPT' });
  await assert.rejects(createDeletionBarrier({ directory }).initialize(), { code: 'DELETION_BARRIER_CORRUPT' });
});

test('failure between prewrite and durable receipt is never acknowledged as deleted', async t => {
  const directory = await fixture(t);
  const barrier = createDeletionBarrier({ directory, createIfMissing: true });
  await barrier.initialize();
  const failingFs = {
    ...fs,
    async open(filename, flags) {
      const handle = await fs.open(filename, flags);
      if (path.basename(filename) !== 'deletions.v1.receipts' || flags !== 'a') return handle;
      return {
        writeFile: async () => { throw Object.assign(new Error('injected receipt failure'), { code: 'EIO' }); },
        sync: () => handle.sync(), close: () => handle.close()
      };
    }
  };
  const failing = createDeletionBarrier({ directory, filesystem: failingFs });
  await failing.initialize();
  await assert.rejects(failing.markDeleted('account-1', 'memory-1'), /injected receipt failure/);
  await assert.rejects(failing.isDeleted('account-1', 'memory-1'), { code: 'DELETION_BARRIER_CORRUPT' });
  await assert.rejects(barrier.isDeleted('account-1', 'memory-1'), { code: 'DELETION_BARRIER_CORRUPT' });
});

test('one instance serializes concurrent distinct deletions and rejects a broken chain', async t => {
  const directory = await fixture(t);
  const barrier = createDeletionBarrier({ directory, createIfMissing: true });
  await barrier.initialize();
  const results = await Promise.all([
    barrier.markDeleted('account-1', 'memory-1'),
    barrier.markDeleted('account-1', 'memory-2')
  ]);
  assert.deepEqual(results.map(result => result.sequence), [1, 2]);
  assert.deepEqual(await barrier.deletedIds('account-1', ['memory-1', 'memory-2']),
    new Set(['memory-1', 'memory-2']));
  const logPath = path.join(directory, 'deletions.v1.log');
  const lines = (await fs.readFile(logPath, 'utf8')).split('\n');
  const first = JSON.parse(lines[1]);
  lines[1] = JSON.stringify({ ...first, previous: '0'.repeat(63) + '1' });
  await fs.writeFile(logPath, lines.join('\n'));
  await assert.rejects(barrier.deletedIds('account-1', ['memory-1']),
    { code: 'DELETION_BARRIER_CORRUPT' });
});

test('IDs never become paths and cloud adapters must reject this local barrier', async t => {
  const directory = await fixture(t);
  const barrier = createDeletionBarrier({ directory, createIfMissing: true });
  await barrier.initialize();
  await assert.rejects(barrier.markDeleted('../escape', 'memory-1'), { code: 'INVALID_BARRIER_ID' });
  await assert.rejects(barrier.isDeleted('account-1', '..\\escape'), { code: 'INVALID_BARRIER_ID' });
  assert.throws(
    () => createDeletionBarrier({ directory, storageKind: 'postgres' }),
    { code: 'DELETION_BARRIER_UNSUPPORTED_STORAGE' }
  );
  assert.deepEqual((await fs.readdir(directory)).sort(), ['deletions.v1.log', 'deletions.v1.receipts']);
});
