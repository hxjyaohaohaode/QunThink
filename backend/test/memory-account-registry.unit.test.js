import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalAccountRegistry } from '../src/services/memory/localAccountRegistry.js';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-account-registry-'));
  t.after(async () => {
    assert.equal(path.dirname(temp), os.tmpdir());
    await fs.rm(temp, { recursive: true, force: true });
  });
  return {
    registryDirectory: path.join(temp, 'registry'),
    ledgerDirectory: path.join(temp, 'account-1-ledger')
  };
}

test('registered account with empty restored memoryRecords cannot recreate a lost ledger', async t => {
  const { registryDirectory, ledgerDirectory } = await fixture(t);
  const registry = createLocalAccountRegistry({ directory: registryDirectory, createIfMissing: true });
  await registry.initialize();
  await assert.rejects(registry.openAccount('account-1', { ledgerDirectory }),
    { code: 'ACCOUNT_BARRIER_UNREGISTERED' });
  const first = await registry.openAccount('account-1', { ledgerDirectory, allowNew: true });
  assert.equal(first.newlyRegistered, true);
  await first.barrier.markDeleted('account-1', 'memory-1');
  const oldUserJson = { memoryRecords: [] };
  assert.equal(oldUserJson.memoryRecords.length, 0);

  const restarted = createLocalAccountRegistry({ directory: registryDirectory });
  await restarted.initialize();
  const reopened = await restarted.openAccount('account-1', { ledgerDirectory });
  assert.equal(reopened.newlyRegistered, false);
  assert.equal(await reopened.barrier.isDeleted('account-1', 'memory-1'), true);

  // A restored old JSON array can be empty, but a registered ledger must not
  // be replaced after it disappears. Even allowNew cannot bypass this check.
  const tempRoot = path.dirname(registryDirectory);
  assert.equal(path.dirname(ledgerDirectory), tempRoot);
  await fs.rm(ledgerDirectory, { recursive: true });
  await assert.rejects(
    restarted.openAccount('account-1', { ledgerDirectory, allowNew: true }),
    { code: 'DELETION_BARRIER_UNAVAILABLE' }
  );
  await assert.rejects(
    restarted.openAccount('account-1', { ledgerDirectory }),
    { code: 'DELETION_BARRIER_UNAVAILABLE' }
  );
  await assert.rejects(fs.access(ledgerDirectory), { code: 'ENOENT' });
  const journal = await fs.readFile(path.join(registryDirectory, 'deletions.v1.log'), 'utf8');
  assert.equal(journal.includes('account-1'), false);
});

test('damaged or missing registry fails closed before opening an account ledger', async t => {
  const { registryDirectory, ledgerDirectory } = await fixture(t);
  await assert.rejects(createLocalAccountRegistry({ directory: registryDirectory }).initialize(),
    { code: 'DELETION_BARRIER_UNAVAILABLE' });
  const registry = createLocalAccountRegistry({ directory: registryDirectory, createIfMissing: true });
  await registry.initialize();
  await registry.openAccount('account-1', { ledgerDirectory, allowNew: true });
  await fs.appendFile(path.join(registryDirectory, 'deletions.v1.receipts'), 'bad\n');
  await assert.rejects(registry.openAccount('account-1', { ledgerDirectory }),
    { code: 'DELETION_BARRIER_CORRUPT' });
  await assert.rejects(createLocalAccountRegistry({ directory: registryDirectory }).initialize(),
    { code: 'DELETION_BARRIER_CORRUPT' });
});

test('account ledger paths are trusted separate directories and owner IDs cannot traverse', async t => {
  const { registryDirectory, ledgerDirectory } = await fixture(t);
  assert.throws(() => createLocalAccountRegistry({
    directory: registryDirectory, storageKind: 'postgres'
  }), { code: 'DELETION_BARRIER_UNSUPPORTED_STORAGE' });
  const registry = createLocalAccountRegistry({ directory: registryDirectory, createIfMissing: true });
  await registry.initialize();
  await assert.rejects(registry.openAccount('../account', { ledgerDirectory, allowNew: true }),
    { code: 'INVALID_BARRIER_ID' });
  await assert.rejects(registry.openAccount('account-1', {
    ledgerDirectory: registryDirectory, allowNew: true
  }), { code: 'INVALID_BARRIER_DIRECTORY' });
  await assert.rejects(registry.openAccount('account-1', {
    ledgerDirectory: path.join(registryDirectory, 'nested'), allowNew: true
  }), { code: 'INVALID_BARRIER_DIRECTORY' });
  await assert.rejects(registry.openAccount('account-1', {
    ledgerDirectory: 'relative/ledger', allowNew: true
  }), { code: 'INVALID_BARRIER_DIRECTORY' });
});
