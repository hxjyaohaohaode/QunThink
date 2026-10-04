import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareLocalMemoryRegistry } from '../src/services/memory/installation.js';

function auth(users = []) {
  return { data: { users, sessions: [] }, writes: 0,
    async write() { this.writes += 1; } };
}

test('empty local installation creates one registry and persists its configured identity', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qt-memory-install-'));
  const root = path.join(dataDir, 'deletions');
  const db = auth();
  assert.deepEqual(await prepareLocalMemoryRegistry(db, { dataDir, root }),
    { ready: true, created: true });
  assert.equal(db.writes, 1);
  assert.equal(db.data.memoryBarrierInstallation.root, root);
  assert.deepEqual(await prepareLocalMemoryRegistry(db, { dataDir, root }),
    { ready: true, created: false });
  assert.equal(db.writes, 1);
  await assert.rejects(prepareLocalMemoryRegistry(db, {
    dataDir, root: path.join(dataDir, 'changed-path')
  }), /does not match/);
  await fs.unlink(path.join(root, 'registry', 'deletions.v1.log'));
  await assert.rejects(prepareLocalMemoryRegistry(db, { dataDir, root }));
});

test('existing accounts or stale ledger directory never bootstrap a replacement registry', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qt-memory-existing-'));
  const root = path.join(dataDir, 'deletions');
  const db = auth([{ id: 'existing-account' }]);
  assert.deepEqual(await prepareLocalMemoryRegistry(db, { dataDir, root }),
    { ready: false, reason: 'migration_required' });
  assert.equal(db.writes, 0);
  await fs.mkdir(path.join(root, 'orphaned-account-ledger'), { recursive: true });
  const emptyAuth = auth();
  assert.deepEqual(await prepareLocalMemoryRegistry(emptyAuth, { dataDir, root }),
    { ready: false, reason: 'registry_missing_with_existing_ledgers' });
  assert.equal(emptyAuth.writes, 0);
});
