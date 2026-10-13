import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { JSONFile } from 'lowdb/node';
import { CustomLow } from '../src/models/db.js';
import { PgLow } from '../src/models/supabaseAdapter.js';
import { MongoLow } from '../src/models/mongoAdapter.js';
import { createUserDbRegistry } from '../src/models/userDbRegistry.js';
import { initializeNewAccountOrder } from '../src/services/messageOrder.js';
import { createAccountJson, createOnlyAccount, readAccountJson, requireAccountStore } from '../src/models/accountStoreLifecycle.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const code = value => error => error.code === value;
const snapshot = () => initializeNewAccountOrder({ groups: [{ id: 'synthetic-group' }], messages: [] }, 'synthetic', { generationForGroup: () => randomUUID() });

async function fixture(t, kind, hooks = {}) {
  const state = { data: null, exists: false, reads: 0, creates: 0, updates: 0 };
  let db;
  if (kind === 'JSON') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-create-contract-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'account.json'); state.target = target;
    db = new CustomLow(new JSONFile(target), {}, { filePath: target, readWithMetadata: async () => { state.reads++; await hooks.read?.(state); return readAccountJson(target); } });
    const original = db.create.bind(db);
    db.create = async options => { state.creates++; await hooks.beforeCreate?.(state); await original(options); await hooks.afterCreate?.(state); };
  } else if (kind === 'PG') {
    db = new PgLow('user:synthetic', {}, { query: async (sql, values) => {
      if (sql.startsWith('SELECT')) { state.reads++; await hooks.read?.(state); return { rows: state.exists ? [{ data: structuredClone(state.data), revision: '1' }] : [] }; }
      if (sql.startsWith('UPDATE')) { state.updates++; throw new Error('create must never UPDATE'); }
      state.creates++; await hooks.beforeCreate?.(state);
      if (state.exists) return { rowCount: 0, rows: [] };
      state.data = structuredClone(values[1]); state.exists = true; await hooks.afterCreate?.(state);
      return hooks.ack ? hooks.ack() : { rowCount: 1, rows: [{ revision: '1' }] };
    } });
  } else {
    db = new MongoLow({
      findOne: async () => { state.reads++; await hooks.read?.(state); return state.exists ? { data: structuredClone(state.data), revision: 1 } : null; },
      updateOne: async () => { state.updates++; throw new Error('create must never UPDATE'); },
      insertOne: async row => { state.creates++; await hooks.beforeCreate?.(state); if (state.exists) throw Object.assign(new Error('duplicate'), { code: 11000 });
        state.data = structuredClone(row.data); state.exists = true; await hooks.afterCreate?.(state);
        return hooks.ack ? hooks.ack() : { acknowledged: true, insertedId: 'synthetic' }; }
    }, { userId: 'synthetic' }, {});
  }
  return { db, state };
}
for (const kind of ['JSON', 'PG', 'Mongo']) {
  test(`${kind} create ACK loss is recovered only by exact authoritative read with no second insertion`, async t => {
    const candidate = snapshot(), { db, state } = await fixture(t, kind, { afterCreate: () => { throw new Error('synthetic ACK lost'); } });
    assert.equal(await createOnlyAccount(db, candidate, 'synthetic'), db);
    assert.deepEqual(db.data, candidate); assert.equal(state.creates, 1); assert.equal(state.reads, 2); assert.equal(state.updates, 0);
  });
  test(`${kind} precommit failure proves absence and never retries or publishes`, async t => {
    const candidate = snapshot(), { db, state } = await fixture(t, kind, { beforeCreate: () => { throw Object.assign(new Error('blocked'), { code: 'EACCES' }); } });
    await assert.rejects(createOnlyAccount(db, candidate, 'synthetic'), code('EACCES'));
    assert.equal(db._exists, false); assert.equal(state.creates, 1); assert.equal(state.reads, 2);
  });
  test(`${kind} unknown create plus failed reconciliation remains explicitly unknown`, async t => {
    const candidate = snapshot(), { db, state } = await fixture(t, kind, { afterCreate: () => { throw new Error('ACK lost'); }, read: s => { if (s.reads > 1) throw new Error('read unavailable'); } });
    await assert.rejects(createOnlyAccount(db, candidate, 'synthetic'), code('ACCOUNT_CREATION_OUTCOME_UNKNOWN'));
    assert.equal(state.creates, 1); assert.equal(state.reads, 2);
  });
  test(`${kind} retirement drains the started create before replacement loads`, async t => {
    const start = deferred(), release = deferred(), registry = createUserDbRegistry();
    const { db, state } = await fixture(t, kind, { beforeCreate: async () => { start.resolve(); await release.promise; } });
    const pending = registry.get('synthetic', protect => createOnlyAccount(protect(db), snapshot(), 'synthetic'));
    const rejected = assert.rejects(pending, code('USER_DB_REPLACED')); await start.promise;
    registry.clear('synthetic'); let loaded = false;
    const fresh = registry.get('synthetic', async protect => { loaded = true; return protect({ read: async () => {}, write: async () => {} }); });
    await turn(); assert.equal(loaded, false);
    release.resolve(); await rejected; await fresh; assert.equal(loaded, true); assert.equal(state.creates, 1);
  });
  test(`${kind} required read validation runs before publishing bad data or revision`, async t => {
    const candidate = snapshot(), { db, state } = await fixture(t, kind);
    await createOnlyAccount(db, candidate, 'synthetic'); const revision = db._revision;
    if (kind === 'JSON') await fs.writeFile(state.target, 'null'); else state.data = null;
    await assert.rejects(db.read({ force: true }), code('ACCOUNT_DATA_INVALID'));
    assert.deepEqual(db.data, candidate); assert.equal(db._revision, revision);
  });
}
for (const kind of ['PG', 'Mongo']) for (const ack of [null, {}, { acknowledged: false }, { rowCount: 1, rows: [] }]) {
  test(`${kind} create refuses malformed ACK without candidate publication ${JSON.stringify(ack)}`, async t => {
    const { db } = await fixture(t, kind, { ack: () => ack });
    await assert.rejects(db.create({ snapshot: snapshot() }));
    assert.deepEqual(db.data, {}); assert.equal(db._exists, null); assert.equal(db._revision, 0);
  });
}
test('real JSON competing creates publish exactly one complete file and clean both private temporary files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-atomic-create-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'account.json'), a = snapshot(), b = snapshot();
  const results = await Promise.allSettled([createAccountJson(target, a), createAccountJson(target, b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ACCOUNT_DATA_EXISTS');
  const saved = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.ok(JSON.stringify(saved) === JSON.stringify(a) || JSON.stringify(saved) === JSON.stringify(b));
  assert.deepEqual(await fs.readdir(directory), ['account.json']);
});
test('JSON create cleans only its own successfully opened temp on link failure', async () => {
  const removed = [], calls = [], handle = { writeFile: async () => {}, sync: async () => {}, close: async () => {} };
  const io = { mkdir: async () => {}, open: async name => { calls.push(name); return handle; },
    link: async () => { throw Object.assign(new Error('link denied'), { code: 'EACCES' }); }, unlink: async name => { removed.push(name); } };
  await assert.rejects(createAccountJson('/synthetic/account.json', snapshot(), () => {}, io), code('EACCES'));
  assert.deepEqual(removed, calls); assert.notEqual(removed[0], '/synthetic/account.json');
  removed.length = 0; io.open = async () => { throw Object.assign(new Error('temp already exists'), { code: 'EEXIST' }); };
  await assert.rejects(createAccountJson('/synthetic/account.json', snapshot(), () => {}, io), code('EEXIST'));
  assert.deepEqual(removed, []);
});
test('registry maintenance blocks readers, drains old writes, and does not cache its report', async () => {
  const registry = createUserDbRegistry(), started = deferred(), release = deferred(), maintainStarted = deferred(), maintainRelease = deferred();
  const db = await registry.get('a', protect => protect({ data: { old: true }, read: async () => {}, write: async () => { started.resolve(); await release.promise; } }));
  const write = db.write(), rejected = assert.rejects(write, code('USER_DB_REPLACED')); await started.promise;
  const maintenance = registry.maintain('a', async () => { maintainStarted.resolve(); await maintainRelease.promise; return { report: true }; });
  let readStarted = false;
  const reader = registry.get('a', protect => { readStarted = true; return protect({ data: { fresh: true }, read: async () => {}, write: async () => {} }); });
  await turn(); assert.equal(readStarted, false); release.resolve(); await rejected; await maintainStarted.promise;
  await turn(); assert.equal(readStarted, false); maintainRelease.resolve();
  assert.deepEqual(await maintenance, { report: true }); assert.equal((await reader).data.fresh, true);
  assert.equal(registry.cache.get('a').data.fresh, true);
});
for (const kind of ['JSON', 'PG', 'Mongo']) test(`${kind} timed-out creation still absent on immediate read is explicitly unknown, not permission for another insert`, async t => {
  const { db, state } = await fixture(t, kind, { beforeCreate: () => { throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }); } });
  await assert.rejects(createOnlyAccount(db, snapshot(), 'synthetic'), code('ACCOUNT_CREATION_OUTCOME_UNKNOWN'));
  assert.equal(state.creates, 1); assert.equal(state.reads, 2);
});
for (const kind of ['JSON', 'PG', 'Mongo']) for (const recovered of [false, true]) {
  test(`${kind} read begun before write revokes late ACK; queued recovery=${recovered}`, async () => {
    const source = snapshot(), state = { data: structuredClone(source), revision: 7, denied: false }, started = deferred(), release = deferred();
    const readStarted = deferred(), releaseRead = deferred(), releaseRecovery = deferred(); let holdRead = false, holdRecovery = false;
    let writes = 0;
    const commit = async data => { writes++; state.data = structuredClone(data); const revision = ++state.revision; started.resolve(); await release.promise; return revision; };
    const rawRead = async () => { if (holdRead) { holdRead = false; readStarted.resolve(); await releaseRead.promise; } else if (holdRecovery) { await releaseRecovery.promise; } if (state.denied) throw Object.assign(new Error('synthetic required read denied'), { code: 'EACCES' }); };
    const db = kind === 'JSON' ? new CustomLow({ read: async () => null, write: commit }, {}, { readWithMetadata: async () => { await rawRead(); return { exists: true, data: structuredClone(state.data) }; } })
      : kind === 'PG' ? new PgLow('user:synthetic', {}, { query: async (sql, params) => {
        if (sql.startsWith('SELECT')) { await rawRead(); return { rows: [{ data: structuredClone(state.data), revision: String(state.revision) }] }; }
        return { rowCount: 1, rows: [{ revision: String(await commit(params[1])) }] };
      } }) : new MongoLow({ findOne: async () => { await rawRead(); return { data: structuredClone(state.data), revision: state.revision }; },
        updateOne: async (_, update) => { await commit(update.$set.data); return { acknowledged: true, matchedCount: 1 }; }
      }, { userId: 'synthetic' }, {});
    requireAccountStore(db, 'synthetic'); await db.read({ force: true });
    // The failed raw read must already be in flight: a new read correctly
    // waits behind the write fence and cannot revoke its pending ACK.
    holdRead = true;
    const failedRead = assert.rejects(db.read({ force: true }), code('EACCES'));
    await readStarted.promise;
    const candidate = { ...structuredClone(source), marker: 'old write' };
    const writing = db.write({ snapshot: candidate, expectedRevision: kind === 'JSON' ? null : 7 });
    const rejected = assert.rejects(writing, code('WRITE_ACK_UNKNOWN')); await started.promise;
    state.denied = true; releaseRead.resolve(); await failedRead; state.denied = false;
    const published = db.data, revision = db._revision;
    let recovery, recoveredData, recoveredRevision;
    if (recovered) {
      state.data.marker = 'later read'; state.revision++;
      holdRecovery = true;
      recovery = db.read({ force: true, onPublished: () => { recoveredData = db.data; recoveredRevision = db._revision; } });
      await turn(); assert.equal(recoveredData, undefined, 'recovery cannot pass a pending write fence');
    }
    release.resolve(); await rejected;
    assert.equal(db.data, published); assert.equal(db._revision, revision); assert.equal(writes, 1);
    if (recovery) {
      holdRecovery = false; releaseRecovery.resolve(); await recovery;
      assert.equal(db.data, recoveredData); assert.equal(db._revision, recoveredRevision);
      assert.equal(db.data.marker, 'later read');
      await assert.rejects(writing, code('WRITE_ACK_UNKNOWN'));
    }
    await db.read({ force: true }); assert.deepEqual(db.data, state.data);
  });
}
for (const value of [null, false, 0, '']) test(`required JSON write rejects falsy shared data ${String(value)} without I/O`, async () => {
  const source = snapshot(); let writes = 0;
  const db = new CustomLow({ read: async () => source, write: async () => { writes++; } }, {});
  requireAccountStore(db, 'synthetic'); await db.read(); db.data = value;
  await assert.rejects(db.write()); assert.equal(writes, 0);
});
