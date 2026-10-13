import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-legacy-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
delete process.env.SUPABASE_DB_URL;
delete process.env.MONGODB_URI;
await fs.mkdir(path.join(dataDir, 'users'));
const badLegacy = path.join(dataDir, 'db.json');
await fs.writeFile(badLegacy, '{broken legacy data', 'utf8');
const { initDatabase } = await import('../src/models/db.js');
const cli = fileURLToPath(new URL('../scripts/account-store-maintenance.mjs', import.meta.url));
const runCli = (directory, args) => promisify(execFile)(process.execPath, [cli, ...args], {
  cwd: directory,
  env: { PATH: process.env.PATH, NODE_ENV: 'test', DATA_DIR: directory },
  timeout: 10000
});

test('invalid legacy data fails closed at startup and explicit CLI import without creating a blank default user', async () => {
  // Startup no longer attempts legacy import. Missing current storage is its
  // own fail-closed error; malformed legacy bytes are checked only by the CLI.
  await assert.rejects(initDatabase(), { code: 'ACCOUNT_DATA_MISSING' });
  assert.equal(await fs.readFile(badLegacy, 'utf8'), '{broken legacy data');
  await assert.rejects(fs.access(path.join(dataDir, 'users', 'db_default.json')), error => error.code === 'ENOENT');
  await assert.rejects(runCli(dataDir, ['import-legacy']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr.trim()).code, 'ACCOUNT_DATA_CORRUPT');
    return true;
  });
  assert.equal(await fs.readFile(badLegacy, 'utf8'), '{broken legacy data');
  await assert.rejects(fs.access(path.join(dataDir, 'users', 'db_default.json')), { code: 'ENOENT' });
});

test('explicit raw legacy CLI import preserves source bytes, ciphertext, identities, timestamps and old hashes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-valid-legacy-'));
  const source = {
    groups: [{ id: 'legacy-group', name: 'synthetic legacy', ai_members: ['retired-model'] }],
    messages: [{ id: 'legacy-message', group_id: 'legacy-group', created_at: '2024-01-02T03:04:05.000Z',
      content: '{"encrypted":true,"iv":"synthetic","ciphertext":"preserve-verbatim"}', metadata: { oldHash: 'untouched-old-hash' } }],
    receipts: [{ id: 'legacy-receipt', hash: 'original-receipt-hash' }], unrelated: { retained: true }
  };
  const sourceBytes = JSON.stringify(source, null, 3) + '\n';
  const sourcePath = path.join(directory, 'db.json');
  await fs.writeFile(sourcePath, sourceBytes);
  const dry = JSON.parse((await runCli(directory, ['import-legacy'])).stdout.trim());
  assert.equal(dry.applied, false);
  assert.equal(dry.sourceHash, createHash('sha256').update(JSON.stringify(source)).digest('hex'));
  assert.equal(await fs.readFile(sourcePath, 'utf8'), sourceBytes);
  const targetPath = path.join(directory, 'users', 'db_default.json');
  await assert.rejects(fs.access(targetPath), { code: 'ENOENT' });
  const applied = JSON.parse((await runCli(directory, ['import-legacy', '--apply', dry.sourceHash])).stdout.trim());
  assert.equal(applied.applied, true);
  assert.equal(applied.confirmedByRead, true);
  const { message_order, ...preserved } = JSON.parse(await fs.readFile(targetPath, 'utf8'));
  assert.deepEqual(preserved, source);
  assert.equal(createHash('sha256').update(JSON.stringify(preserved)).digest('hex'), dry.sourceHash);
  assert.equal(message_order.owner_id, 'default');
  assert.equal(message_order.groups[0].bindings[0].message_id, 'legacy-message');
  assert.equal(await fs.readFile(sourcePath, 'utf8'), sourceBytes);
});
