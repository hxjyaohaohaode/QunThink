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
const { initDatabase, initUserDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
await initDatabase();

test('a corrupt local user document fails closed and preserves its bytes until an explicit restore', async () => {
  const userId = 'corrupt-test';
  await initUserDatabase(userId);
  const dbPath = path.join(dataDir, 'users', `db_${userId}.json`);
  const original = await fs.readFile(dbPath, 'utf8');
  const damaged = '{"groups":[{"id":"critical"}],"messages": [not valid JSON';
  await fs.writeFile(dbPath, damaged, 'utf8');
  clearUserDbCache(userId);
  await assert.rejects(getUserDb(userId), /数据库损坏且恢复失败/);
  assert.equal(await fs.readFile(dbPath, 'utf8'), damaged);
  await fs.writeFile(dbPath, original, 'utf8');
  const restored = await getUserDb(userId);
  assert.ok(restored.data.groups.length > 0);
});
