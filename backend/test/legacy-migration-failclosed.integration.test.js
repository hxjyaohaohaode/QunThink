import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-legacy-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
delete process.env.SUPABASE_DB_URL;
delete process.env.MONGODB_URI;
await fs.mkdir(path.join(dataDir, 'users'));
const badLegacy = path.join(dataDir, 'db.json');
await fs.writeFile(badLegacy, '{broken legacy data', 'utf8');
const { initDatabase } = await import('../src/models/db.js');

test('invalid legacy data prevents initialization without creating a blank default user', async () => {
  await assert.rejects(initDatabase(), SyntaxError);
  assert.equal(await fs.readFile(badLegacy, 'utf8'), '{broken legacy data');
  await assert.rejects(fs.access(path.join(dataDir, 'users', 'db_default.json')), error => error.code === 'ENOENT');
});
