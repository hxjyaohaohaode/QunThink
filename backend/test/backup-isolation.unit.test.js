import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createBackup } = await import('../src/models/db.js');

test('local backups keep each account separate and same-millisecond copies distinct', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-backup-isolation-'));
  const first = path.join(dir, 'db_first.json');
  const second = path.join(dir, 'db_second.json');
  await fs.writeFile(first, JSON.stringify({ account: 'first', revision: 1 }));
  await fs.writeFile(second, JSON.stringify({ account: 'second', revision: 1 }));
  await Promise.all([createBackup(first), createBackup(second)]);
  await createBackup(first);
  const firstDir = path.join(dir, 'backups', 'db_first');
  const secondDir = path.join(dir, 'backups', 'db_second');
  const firstNames = await fs.readdir(firstDir);
  const secondNames = await fs.readdir(secondDir);
  assert.equal(firstNames.length, 2);
  assert.equal(new Set(firstNames).size, 2);
  assert.equal(secondNames.length, 1);
  for (const name of firstNames) {
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(firstDir, name), 'utf8')),
      { account: 'first', revision: 1 });
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(secondDir, secondNames[0]), 'utf8')),
    { account: 'second', revision: 1 });
});
