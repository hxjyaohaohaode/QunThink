import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const cwd = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-maintenance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, ['scripts/account-store-maintenance.mjs', ...args], { cwd,
    env: { ...process.env, DATA_DIR: directory, AUTH_DB_PATH: path.join(directory, 'auth.json'), SUPABASE_DB_URL: '', MONGODB_URI: '' }, encoding: 'utf8' });
  return { directory, run, file: id => path.join(directory, 'users', `db_${id}.json`) };
}
test('explicit empty-install command creates a verified default, and a second invocation refuses existing installation', async t => {
  const { directory, run, file } = await fixture(t);
  const first = run('init-empty'); assert.equal(first.status, 0, first.stderr);
  const raw = await fs.readFile(file('default'), 'utf8'), value = JSON.parse(raw);
  assert.equal(value.message_order.groups.length, 3);
  const second = run('init-empty'); assert.equal(second.status, 1); assert.match(second.stderr, /INSTALLATION_NOT_EMPTY/);
  assert.equal(await fs.readFile(file('default'), 'utf8'), raw);
  assert.deepEqual(await fs.readdir(directory), ['users']);
});
for (const [name, raw] of [['auth.json', 'null'], ['db.json', '{}'], ['leftover-ledger', ''], ['nested/old-user.json', 'null']]) {
  test(`empty install rejects existing ${name} even if its contents look empty`, async t => {
    const { directory, run, file } = await fixture(t);
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), raw);
    const result = run('init-empty'); assert.equal(result.status, 1); assert.match(result.stderr, /INSTALLATION_NOT_EMPTY/);
    assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), raw);
    await assert.rejects(fs.stat(file('default')), error => error.code === 'ENOENT');
  });
}
test('real EACCES is not mistaken for a missing account or an empty installation', async t => {
  const { directory, run, file } = await fixture(t), id = randomUUID();
  await fs.mkdir(path.dirname(file(id)), { recursive: true }); await fs.writeFile(file(id), '{}');
  await fs.chmod(file(id), 0);
  const read = run('migrate-account', id); assert.equal(read.status, 1); assert.match(read.stderr, /EACCES/);
  await fs.chmod(file(id), 0o600);
  assert.equal(await fs.readFile(file(id), 'utf8'), '{}');
  await fs.chmod(directory, 0);
  try { const install = run('init-empty'); assert.equal(install.status, 1); assert.match(install.stderr, /EACCES/); }
  finally { await fs.chmod(directory, 0o700); }
});
test('CLI raw migrate is dry-run by default, applies only reviewed source hash, and retains original message bytes', async t => {
  const { run, file } = await fixture(t), id = randomUUID();
  const value = { groups: [{ id: 'empty' }], messages: [], preserved: 'synthetic' }, raw = JSON.stringify(value);
  await fs.mkdir(path.dirname(file(id)), { recursive: true }); await fs.writeFile(file(id), raw);
  const dry = run('migrate-account', id); assert.equal(dry.status, 0, dry.stderr);
  const report = JSON.parse(dry.stdout); assert.equal(report.applied, false); assert.equal(report.groups, 1);
  assert.equal(await fs.readFile(file(id), 'utf8'), raw);
  const stale = run('migrate-account', id, '--apply', '0'.repeat(64)); assert.equal(stale.status, 1); assert.match(stale.stderr, /MIGRATION_SOURCE_CHANGED/);
  assert.equal(await fs.readFile(file(id), 'utf8'), raw);
  const apply = run('migrate-account', id, '--apply', report.sourceHash); assert.equal(apply.status, 0, apply.stderr);
  const { message_order, ...original } = JSON.parse(await fs.readFile(file(id), 'utf8'));
  assert.deepEqual(original, value); assert.equal(message_order.groups[0].next_sequence, '1');
  const repeated = run('migrate-account', id); assert.equal(repeated.status, 1); assert.match(repeated.stderr, /MESSAGE_ORDER_UNAVAILABLE/);
});
for (const raw of ['null', '{}{}', '{"groups":[],"messages":[],"message_order":null}', '{"groups":[],"messages":[{"id":"a","group_id":"g","created_at":"local-time"}]}']) {
  test(`CLI import refuses invalid or partly new legacy input ${raw}`, async t => {
    const { directory, run, file } = await fixture(t); await fs.writeFile(path.join(directory, 'db.json'), raw);
    const result = run('import-legacy'); assert.equal(result.status, 1);
    assert.equal(await fs.readFile(path.join(directory, 'db.json'), 'utf8'), raw);
    await assert.rejects(fs.stat(file('default')), error => error.code === 'ENOENT');
  });
}
test('empty installation cannot ignore configured external deletion records', async t => {
  const { directory } = await fixture(t), ledger = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-external-ledger-'));
  t.after(() => fs.rm(ledger, { recursive: true, force: true }));
  const marker = path.join(ledger, 'deleted.json'); await fs.writeFile(marker, '{"existing":"synthetic deletion"}');
  const result = spawnSync(process.execPath, ['scripts/account-store-maintenance.mjs', 'init-empty'], { cwd,
    env: { ...process.env, DATA_DIR: directory, AUTH_DB_PATH: path.join(directory, 'auth.json'), MEMORY_DELETION_DIR: ledger, SUPABASE_DB_URL: '', MONGODB_URI: '' }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /INSTALLATION_NOT_EMPTY/);
  assert.equal(await fs.readFile(marker, 'utf8'), '{"existing":"synthetic deletion"}');
  assert.deepEqual(await fs.readdir(directory), []);
});
