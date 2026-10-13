import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSONFile } from 'lowdb/node';
import { initializeNewAccountOrder } from '../src/services/messageOrder.js';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-required-lifecycle-'));
delete process.env.SUPABASE_DB_URL; delete process.env.MONGODB_URI;
const api = await import('../src/models/db.js');
const { PgLow } = await import('../src/models/supabaseAdapter.js');
const { MongoLow } = await import('../src/models/mongoAdapter.js');
const file = id => path.join(process.env.DATA_DIR, 'users', `db_${id}.json`);
const code = expected => error => error.code === expected;
const order = (owner, groups = []) => initializeNewAccountOrder({ groups, messages: [] }, owner, { generationForGroup: () => randomUUID() });
await fs.mkdir(path.join(process.env.DATA_DIR, 'users'), { recursive: true });

test('existing loader never creates a missing account', async () => {
  const id = randomUUID();
  await assert.rejects(api.getUserDb(id), code('ACCOUNT_DATA_MISSING'));
  await assert.rejects(fs.stat(file(id)), code('ENOENT'));
});
for (const [value, expected] of [['null', 'ACCOUNT_DATA_INVALID'], ['{}', 'MESSAGE_ORDER_UNAVAILABLE'], ['{"groups":[],"messages":[]}', 'MESSAGE_ORDER_UNAVAILABLE'], ['{}{}', 'ACCOUNT_DATA_CORRUPT']]) {
  test(`required loader leaves ${value} untouched`, async () => {
    const id = randomUUID(); await fs.writeFile(file(id), value);
    await assert.rejects(api.getUserDb(id), code(expected));
    assert.equal(await fs.readFile(file(id), 'utf8'), value);
    assert.equal((await fs.readdir(path.dirname(file(id)))).filter(name => name.startsWith(`db_${id}.json.`)).length, 0);
  });
}
test('all deleted groups stay empty on reload and retain original sidecar', async () => {
  const id = randomUUID(), value = order(id, [{ id: 'group-presidential' }]);
  value.groups = []; await fs.writeFile(file(id), JSON.stringify(value));
  const db = await api.getUserDb(id); assert.deepEqual(db.data, value);
  api.clearUserDbCache(id); assert.deepEqual((await api.getUserDb(id)).data, value);
  assert.deepEqual(JSON.parse(await fs.readFile(file(id), 'utf8')), value);
});
test('normal startup does not guess an empty installation', async () => {
  await assert.rejects(api.initDatabase(), code('ACCOUNT_DATA_MISSING'));
  await assert.rejects(fs.stat(file('default')), code('ENOENT'));
});
test('new account has one create-only published snapshot shared by concurrent callers', async () => {
  const id = randomUUID();
  assert.equal(typeof api.createNewUserDatabase, 'function');
  const all = await Promise.all(Array.from({ length: 8 }, () => api.createNewUserDatabase(id)));
  assert.ok(all.every(db => db === all[0]));
  assert.equal(all[0].data.groups.length, 3); assert.equal(all[0].data.message_order.groups.length, 3);
  assert.ok(all[0].data.message_order.groups.every(g => g.next_sequence === '1'));
  assert.deepEqual(JSON.parse(await fs.readFile(file(id), 'utf8')), all[0].data);
});
test('CustomLow create never overwrites an existing target', async () => {
  const id = randomUUID(), original = { legacy: 'must survive' }; await fs.writeFile(file(id), JSON.stringify(original));
  const db = new api.CustomLow(new JSONFile(file(id)), {}, { filePath: file(id) });
  assert.equal(typeof db.create, 'function');
  await assert.rejects(db.create({ snapshot: { replacement: true } }), code('ACCOUNT_DATA_EXISTS'));
  assert.deepEqual(JSON.parse(await fs.readFile(file(id), 'utf8')), original);
});
for (const kind of ['PG', 'Mongo']) test(`${kind} create is insert-only even for a revision zero existing row`, async () => {
  const calls = [];
  const db = kind === 'PG' ? new PgLow('user:synthetic', {}, { query: async sql => { calls.push(sql); return { rowCount: 0, rows: [] }; } })
    : new MongoLow({ updateOne: async () => { calls.push('update'); return { acknowledged: true, matchedCount: 1 }; }, insertOne: async () => { calls.push('insert'); throw Object.assign(new Error('duplicate'), { code: 11000 }); } }, { userId: 'synthetic' }, {});
  assert.equal(typeof db.create, 'function');
  await assert.rejects(db.create({ snapshot: { candidate: true } }), code('ACCOUNT_DATA_EXISTS'));
  assert.equal(calls.length, 1); assert.ok(kind === 'PG' ? calls[0].startsWith('INSERT') : calls[0] === 'insert');
  assert.deepEqual(db.data, {});
});

test('new account repeated creation returns the same authoritative generation without a rewrite', async () => {
  const id = randomUUID(), first = await api.createNewUserDatabase(id), original = await fs.readFile(file(id), 'utf8');
  const generation = structuredClone(first.data.message_order);
  api.clearUserDbCache(id);
  assert.deepEqual((await api.createNewUserDatabase(id)).data.message_order, generation);
  assert.equal(await fs.readFile(file(id), 'utf8'), original);
});
for (const existing of ['null', '{}', '{bad', 'used']) test(`create-only refuses existing ${existing} bytes without overwrite`, async () => {
  const id = randomUUID();
  const raw = existing === 'used' ? JSON.stringify(order(id)) : existing;
  await fs.writeFile(file(id), raw);
  await assert.rejects(api.createNewUserDatabase(id));
  assert.equal(await fs.readFile(file(id), 'utf8'), raw);
});
test('required subsequent reads reject missing, invalid and legacy snapshots before publishing', async () => {
  const id = randomUUID(), db = await api.createNewUserDatabase(id), before = structuredClone(db.data);
  for (const [raw, expected] of [[null, 'ACCOUNT_DATA_MISSING'], ['null', 'ACCOUNT_DATA_INVALID'], ['{}', 'MESSAGE_ORDER_UNAVAILABLE'], ['{}{}', 'ACCOUNT_DATA_CORRUPT']]) {
    if (raw === null) await fs.unlink(file(id)); else await fs.writeFile(file(id), raw);
    await assert.rejects(db.read(), code(expected)); assert.deepEqual(db.data, before);
  }
});
test('required write gate has an independent committed baseline and rejects old unsequenced writers', async () => {
  const id = randomUUID(), db = await api.createNewUserDatabase(id), original = await fs.readFile(file(id), 'utf8');
  db.data.messages.push({ id: randomUUID(), group_id: db.data.groups[0].id, content: 'synthetic' });
  await assert.rejects(db.write(), code('MESSAGE_ORDER_UNAVAILABLE'));
  assert.equal(await fs.readFile(file(id), 'utf8'), original);
  await db.read({ force: true });
  db.data.message_order.groups[0].generation = randomUUID();
  await assert.rejects(db.write(), code('MESSAGE_ORDER_UNAVAILABLE'));
  assert.equal(await fs.readFile(file(id), 'utf8'), original);
  await db.read({ force: true });
  db.data.userProfile.nickname = 'synthetic allowed update'; await db.write();
  api.clearUserDbCache(id);
  assert.equal((await api.getUserDb(id)).data.userProfile.nickname, 'synthetic allowed update');
});
test('raw legacy account migration is dry by default and apply preserves every original value', async () => {
  const id = randomUUID(), value = { groups: [], messages: [{ id: 'legacy-orphan', group_id: 'deleted-group', created_at: '2025-01-01T00:00:00Z', content: 'opaque-original' }], retained: { irregular: true } };
  const raw = JSON.stringify(value); await fs.writeFile(file(id), raw);
  const dry = await api.migrateLegacyUserDatabase(id);
  assert.equal(dry.applied, false); assert.equal(dry.bindings, 1);
  assert.equal(await fs.readFile(file(id), 'utf8'), raw);
  await assert.rejects(api.getUserDb(id), code('MESSAGE_ORDER_UNAVAILABLE'));
  await assert.rejects(api.migrateLegacyUserDatabase(id, { apply: true }), code('MIGRATION_SOURCE_HASH_REQUIRED'));
  await assert.rejects(api.migrateLegacyUserDatabase(id, { apply: true, expectedSourceHash: '0'.repeat(64) }), code('MIGRATION_SOURCE_CHANGED'));
  assert.equal(await fs.readFile(file(id), 'utf8'), raw);
  const result = await api.migrateLegacyUserDatabase(id, { apply: true, expectedSourceHash: dry.sourceHash });
  assert.equal(result.confirmedByRead, true);
  const actual = (await api.getUserDb(id)).data, { message_order, ...unchanged } = actual;
  assert.deepEqual(unchanged, value); assert.equal(message_order.groups[0].group_id, 'deleted-group');
  assert.equal(message_order.groups[0].next_sequence, '2');
  await assert.rejects(api.migrateLegacyUserDatabase(id), code('MESSAGE_ORDER_UNAVAILABLE'));
});
test('raw legacy import preserves source and does not guess existing data is the same migration', async () => {
  const source = path.join(process.env.DATA_DIR, 'db.json');
  const legacy = { groups: [], messages: [], original: ['do not patch defaults'] }, raw = JSON.stringify(legacy);
  await fs.writeFile(source, raw);
  const dry = await api.migrateExistingData(); assert.equal(dry.applied, false);
  await assert.rejects(fs.stat(file('default')), code('ENOENT'));
  await api.migrateExistingData({ apply: true, expectedSourceHash: dry.sourceHash });
  assert.equal(await fs.readFile(source, 'utf8'), raw);
  const first = await fs.readFile(file('default'), 'utf8');
  await api.migrateExistingData({ apply: true, expectedSourceHash: dry.sourceHash });
  assert.equal(await fs.readFile(file('default'), 'utf8'), first);
  const changed = { groups: [], messages: [], altered: true }; await fs.writeFile(source, JSON.stringify(changed));
  const next = await api.migrateExistingData();
  await assert.rejects(api.migrateExistingData({ apply: true, expectedSourceHash: next.sourceHash }), code('MIGRATION_SOURCE_CHANGED'));
  assert.equal(await fs.readFile(file('default'), 'utf8'), first);
});
test('a failed required read blocks later writes until an authoritative successful read', async () => {
  const id = randomUUID(), db = await api.createNewUserDatabase(id), original = await fs.readFile(file(id), 'utf8');
  await fs.unlink(file(id));
  await assert.rejects(db.read({ force: true }), code('ACCOUNT_DATA_MISSING'));
  await assert.rejects(db.write(), code('ACCOUNT_WRITE_REQUIRES_READ'));
  await assert.rejects(fs.stat(file(id)), code('ENOENT'));
  await fs.writeFile(file(id), original); await db.read({ force: true });
  db.data.userProfile.nickname = 'after-recovery'; await db.write();
  assert.equal(JSON.parse(await fs.readFile(file(id), 'utf8')).userProfile.nickname, 'after-recovery');
});
for (const [raw, expected] of [[null, 'ACCOUNT_DATA_MISSING'], ['null', 'ACCOUNT_DATA_INVALID'], ['{}{}', 'ACCOUNT_DATA_CORRUPT'], ['{"groups":[],"messages":[]}', 'MESSAGE_ORDER_UNAVAILABLE']]) {
  test(`cached new-account creation rechecks authority: ${expected}`, async () => {
    const id = randomUUID(); await api.createNewUserDatabase(id);
    if (raw === null) await fs.unlink(file(id)); else await fs.writeFile(file(id), raw);
    await assert.rejects(api.createNewUserDatabase(id), code(expected));
    if (raw === null) await assert.rejects(fs.stat(file(id)), code('ENOENT'));
    else assert.equal(await fs.readFile(file(id), 'utf8'), raw);
  });
}
for (const [raw, expected] of [[null, 'ACCOUNT_DATA_MISSING'], ['null', 'ACCOUNT_DATA_INVALID'], ['{}{}', 'ACCOUNT_DATA_CORRUPT'], ['{"groups":[],"messages":[]}', 'MESSAGE_ORDER_UNAVAILABLE']]) {
  test(`required JSON write checks invalidated durable target without publishing a read: ${expected}`, async () => {
    const id = randomUUID(), db = await api.createNewUserDatabase(id), original = db.data;
    const candidate = structuredClone(db.data); candidate.userProfile.nickname = 'do not silently restore';
    if (raw === null) await fs.unlink(file(id)); else await fs.writeFile(file(id), raw);
    await assert.rejects(db.write({ snapshot: candidate }), code(expected));
    assert.equal(db.data, original); assert.equal(db._revision, null);
    if (raw === null) await assert.rejects(fs.stat(file(id)), code('ENOENT'));
    else assert.equal(await fs.readFile(file(id), 'utf8'), raw);
  });
}
test('required JSON write keeps actual EACCES without overwriting a denied target', async () => {
  const id = randomUUID(), db = await api.createNewUserDatabase(id), before = await fs.readFile(file(id), 'utf8');
  await fs.chmod(file(id), 0);
  try { await assert.rejects(db.write(), code('EACCES')); }
  finally { await fs.chmod(file(id), 0o600); }
  assert.equal(await fs.readFile(file(id), 'utf8'), before);
});
