import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-corrupt-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
delete process.env.SUPABASE_DB_URL;
delete process.env.MONGODB_URI;
const { initializeEmptyInstallation, initDatabase, createNewUserDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
await initializeEmptyInstallation();
await initDatabase();
const { initAuthDb } = await import('../src/models/authDb.js');
await initAuthDb();

test('a corrupt local user document fails closed and preserves its bytes until an explicit restore', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const userDb = await createNewUserDatabase(userId);
  await provisionNewLocalMemoryAccount(userId, userDb);
  const dbPath = path.join(dataDir, 'users', `db_${userId}.json`);
  const original = await fs.readFile(dbPath, 'utf8');
  const damaged = '{"groups":[{"id":"critical"}],"messages": [not valid JSON';
  await fs.writeFile(dbPath, damaged, 'utf8');
  clearUserDbCache(userId);
  await assert.rejects(getUserDb(userId), { code: 'ACCOUNT_DATA_CORRUPT' });
  assert.equal(await fs.readFile(dbPath, 'utf8'), damaged);
  await fs.writeFile(dbPath, original, 'utf8');
  const restored = await getUserDb(userId);
  assert.ok(restored.data.groups.length > 0);
  assert.deepEqual(restored.data, JSON.parse(original));
  assert.equal(await fs.readFile(dbPath, 'utf8'), original);
});
