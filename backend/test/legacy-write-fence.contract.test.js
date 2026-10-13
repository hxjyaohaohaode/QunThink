// Exercise production adapters and registry methods. JSON uses real temporary
// files; PG/Mongo use deterministic transports, not live database evidence.
// Faults target raw transport methods (JSON adapter.write/fs.link), never replace
// production db.write/create entrypoints unless explicitly wrapping their result
// to exercise the additional registry post-adapter lease boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JSONFile } from 'lowdb/node';
import { CustomLow } from '../src/models/db.js';
import { PgLow } from '../src/models/supabaseAdapter.js';
import { MongoLow } from '../src/models/mongoAdapter.js';
import { createUserDbRegistry } from '../src/models/userDbRegistry.js';
import { beginUserDbWriteBarrier } from '../src/models/readBarrier.js';
import { initializeNewAccountOrder } from '../src/services/messageOrder.js';
import { readAccountJson, requireAccountStore } from '../src/models/accountStoreLifecycle.js';

const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const code = expected => error => error.code === expected;
const kinds = ['JSON', 'PG', 'Mongo'];
const owner = 'synthetic-fence';
const initial = () => initializeNewAccountOrder({ groups: [{ id: 'g', pinned: false }], messages: [], marker: 'initial' }, owner, { generationForGroup: () => randomUUID() });

async function fixture(t, kind, { protectedDb = false, missing = false, required = !missing, afterAdapter } = {}) {
  const seed = initial(), hooks = {}, state = { data: missing ? null : clone(seed), revision: missing ? 0 : 7, reads: 0, writes: 0, creates: 0 };
  let file, disk;
  if (kind === 'JSON') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-legacy-fence-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    file = path.join(directory, 'account.json'); disk = new JSONFile(file);
    if (!missing) await disk.write(seed);
  }
  const durable = async () => kind === 'JSON' ? (await readAccountJson(file)).data : clone(state.data);
  const read = async () => {
    const index = ++state.reads;
    const value = kind === 'JSON' ? await readAccountJson(file) : state.data === null ? null : { data: clone(state.data), revision: state.revision };
    await hooks.read?.(value, index); return value;
  };
  const write = async (data, expected, create = false) => {
    state[create ? 'creates' : 'writes']++;
    await hooks.before?.();
    if (kind !== 'JSON' && (create ? state.data !== null : state.data === null || state.revision !== expected)) return null;
    if (kind === 'JSON') await disk.write(data);
    state.data = clone(data); const revision = state.revision = create ? 1 : state.revision + 1;
    await hooks.ack?.(); return revision;
  };
  const make = () => {
    let db;
    if (kind === 'JSON') db = new CustomLow({ read: async () => (await read()).data, write: data => write(data) }, {}, { filePath: file, readWithMetadata: read });
    else if (kind === 'PG') db = new PgLow(`user:${owner}`, {}, { query: async (sql, values) => {
      if (sql.startsWith('SELECT')) { const row = await read(); return { rows: row ? [row] : [] }; }
      const revision = await write(values[1], values[2], sql.startsWith('INSERT'));
      if (hooks.result) return hooks.result();
      return { rowCount: revision === null ? 0 : 1, rows: revision === null ? [] : [{ revision: String(revision) }] };
    } });
    else db = new MongoLow({ findOne: read,
      updateOne: async (filter, update) => {
        const revision = await write(update.$set.data, filter.revision ?? 0);
        return hooks.result ? hooks.result() : { acknowledged: true, matchedCount: revision === null ? 0 : 1 };
      },
      insertOne: async row => {
        if (await write(row.data, null, true) === null) throw Object.assign(new Error('duplicate'), { code: 11000 });
        return hooks.result ? hooks.result() : { acknowledged: true, insertedId: 'synthetic' };
      }
    }, { userId: owner }, {});
    if (required) requireAccountStore(db, owner);
    if (afterAdapter) for (const method of ['write', 'create']) {
      const original = db[method].bind(db);
      db[method] = async (...args) => { const result = await original(...args); await afterAdapter(method); return result; };
    }
    return db;
  };
  const registry = createUserDbRegistry();
  const load = async protect => { const db = protect(make()); await db.read({ force: true }); return db; };
  const db = protectedDb ? await registry.get(owner, load) : await load(db => db);
  // Hold the real atomic-create link operation, not the CustomLow entrypoint.
  const gateJsonCreate = (phase, hook) => {
    const link = fs.link;
    fs.link = async (source, target) => {
      if (target === file && phase === 'before') { state.creates++; await hook(); }
      const result = await link(source, target);
      if (target === file && phase === 'after') { state.creates++; await hook(); }
      return result;
    };
    const restore = () => { fs.link = link; }; t.after(restore); return restore;
  };
  const candidate = () => ({ ...clone(seed), marker: 'candidate' });
  const startWrite = (mode = 'explicit') => {
    const value = candidate();
    if (mode === 'legacy') { db.data.marker = value.marker; return db.write(); }
    return db.write({ snapshot: value, expectedRevision: kind === 'JSON' ? null : db._revision });
  };
  return { db, state, hooks, registry, load, durable, candidate, startWrite, gateJsonCreate };
}

for (const kind of kinds) {
  for (const protectedDb of [false, true]) for (const mode of ['legacy', 'explicit']) {
    test(`${kind} ${protectedDb ? 'registry' : 'bare'} ${mode}: new reads wait through full ACK`, async t => {
      const f = await fixture(t, kind, { protectedDb }), entered = deferred(), release = deferred();
      f.hooks.ack = async () => { entered.resolve(); await release.promise; };
      const writing = settle(f.startWrite(mode)); await entered.promise;
      const reads = f.state.reads; let published = false;
      const reading = settle(f.db.read({ force: true, onPublished: () => { published = true; } }));
      try { await turn(); assert.equal(published, false); assert.equal(f.state.reads, reads); }
      finally { release.resolve(); }
      assert.ifError((await writing).error); assert.ifError((await reading).error);
      assert.equal(published, true); assert.equal(f.db.data.marker, 'candidate');
      assert.deepEqual(f.db.data, await f.durable()); assert.equal(f.state.writes, 1);
    });
  }

  for (const mode of ['legacy', 'explicit']) test(`${kind} ${mode}: caller and adapter fences nest and release independently`, async t => {
    const f = await fixture(t, kind, { protectedDb: true }), release = beginUserDbWriteBarrier(f.db);
    let published = false; const reads = f.state.reads;
    const reading = settle(f.db.read({ force: true, onPublished: () => { published = true; } }));
    try {
      assert.ifError((await settle(f.startWrite(mode))).error);
      await turn(); assert.equal(published, false);
      assert.equal(f.state.reads, reads + (kind === 'JSON' ? 1 : 0), 'only JSON raw preflight may run within fence');
    } finally { release(); release(); }
    assert.ifError((await reading).error); assert.equal(f.db.data.marker, 'candidate');
  });

  test(`${kind}: already-started successful read is discarded and reread after write`, async t => {
    const f = await fixture(t, kind), readEntered = deferred(), readRelease = deferred(), ackEntered = deferred(), ackRelease = deferred();
    let first = true, published = false;
    f.hooks.read = async () => { if (first) { first = false; readEntered.resolve(); await readRelease.promise; } };
    const reading = settle(f.db.read({ force: true, onPublished: () => { published = true; } })); await readEntered.promise;
    f.hooks.ack = async () => { ackEntered.resolve(); await ackRelease.promise; };
    const writing = settle(f.startWrite()); await ackEntered.promise;
    try { readRelease.resolve(); await turn(); assert.equal(published, false); assert.equal(f.db.data.marker, 'initial'); }
    finally { readRelease.resolve(); ackRelease.resolve(); }
    assert.ifError((await writing).error); assert.ifError((await reading).error);
    assert.equal(f.db.data.marker, 'candidate'); assert.equal(f.db._revision, kind === 'JSON' ? null : 8);
  });

  for (const recover of [false, true]) test(`${kind}: pre-existing failed read revokes delayed ACK; queued recovery=${recover}`, async t => {
    const f = await fixture(t, kind), readEntered = deferred(), readRelease = deferred(), ackEntered = deferred(), ackRelease = deferred(), recoveryRelease = deferred();
    let failFirst = true, recoveryHeld = false, published = false;
    f.hooks.read = async () => {
      if (failFirst) { failFirst = false; readEntered.resolve(); await readRelease.promise; throw Object.assign(new Error('raw read denied'), { code: 'EACCES' }); }
      if (recoveryHeld) await recoveryRelease.promise;
    };
    const reading = settle(f.db.read({ force: true })); await readEntered.promise;
    f.hooks.ack = async () => { ackEntered.resolve(); await ackRelease.promise; };
    const writing = settle(f.startWrite()); await ackEntered.promise;
    readRelease.resolve(); assert.equal((await reading).error?.code, 'EACCES');
    assert.throws(() => f.db._accountStoreContract.beforeWrite(f.candidate()), code('ACCOUNT_WRITE_REQUIRES_READ'));
    const previous = f.db.data, revision = f.db._revision; let recovery;
    try {
      if (recover) {
        recoveryHeld = true;
        recovery = settle(f.db.read({ force: true, onPublished: () => { published = true; } }));
        const reads = f.state.reads; await turn(); assert.equal(f.state.reads, reads); assert.equal(published, false);
      }
      ackRelease.resolve(); assert.equal((await writing).error?.code, 'WRITE_ACK_UNKNOWN');
      assert.equal(f.db.data, previous); assert.equal(f.db._revision, revision); assert.equal(f.state.writes, 1);
    } finally { readRelease.resolve(); ackRelease.resolve(); recoveryHeld = false; recoveryRelease.resolve(); }
    if (recovery) { assert.ifError((await recovery).error); assert.equal(published, true); }
    else await f.db.read({ force: true });
    assert.deepEqual(f.db.data, await f.durable());
    assert.equal((await writing).error?.code, 'WRITE_ACK_UNKNOWN', 'later successful read cannot retroactively acknowledge rejected attempt');
  });

  for (const phase of ['before', 'ack']) test(`${kind}: ${phase} write failure releases fence for authoritative read`, async t => {
    const f = await fixture(t, kind);
    f.hooks[phase] = () => { throw Object.assign(new Error('synthetic I/O failure'), { code: 'EACCES' }); };
    await assert.rejects(f.startWrite(), code('EACCES'));
    f.hooks[phase] = undefined; await f.db.read({ force: true });
    assert.equal(f.db.data.marker, phase === 'before' ? 'initial' : 'candidate');
    assert.doesNotThrow(() => f.db._accountStoreContract.beforeWrite(f.candidate()));
  });

  test(`${kind}: invalid snapshot releases fence without storage write`, async t => {
    const f = await fixture(t, kind);
    await assert.rejects(f.db.write({ snapshot: null })); await f.db.read({ force: true });
    assert.equal(f.state.writes, 0); assert.equal(f.db.data.marker, 'initial');
  });

  for (const protectedDb of [false, true]) test(`${kind} ${protectedDb ? 'registry' : 'bare'}: create blocks new reads through durable ACK`, async t => {
    const f = await fixture(t, kind, { protectedDb, missing: true }), entered = deferred(), release = deferred();
    const hold = async () => { entered.resolve(); await release.promise; };
    const restore = kind === 'JSON' ? f.gateJsonCreate('after', hold) : () => {};
    if (kind !== 'JSON') f.hooks.ack = hold;
    const creation = settle(f.db.create({ snapshot: f.candidate() })); await entered.promise;
    const reads = f.state.reads; let published = false;
    const reading = settle(f.db.read({ force: true, onPublished: () => { published = true; } }));
    try { await turn(); assert.equal(published, false); assert.equal(f.state.reads, reads); }
    finally { release.resolve(); restore(); }
    assert.ifError((await creation).error); assert.ifError((await reading).error);
    assert.equal(f.db.data.marker, 'candidate'); assert.equal(f.state.creates, 1);
  });

  for (const phase of ['before', 'after']) test(`${kind}: create ${phase} failure releases fence without guessed publication`, async t => {
    const f = await fixture(t, kind, { missing: true });
    const fail = () => { throw Object.assign(new Error('create failure'), { code: 'EACCES' }); };
    const restore = kind === 'JSON' ? f.gateJsonCreate(phase, fail) : () => {};
    if (kind !== 'JSON') f.hooks[phase === 'before' ? 'before' : 'ack'] = fail;
    try { await assert.rejects(f.db.create({ snapshot: f.candidate() }), code('EACCES')); }
    finally { restore(); f.hooks.before = undefined; f.hooks.ack = undefined; }
    assert.deepEqual(f.db.data, {}); await f.db.read({ force: true });
    assert.equal(f.db._exists, phase === 'after');
    assert.equal(f.db.data.marker, phase === 'after' ? 'candidate' : undefined);
  });

  for (const method of ['write', 'create']) test(`${kind}: registry holds ${method} fence past adapter return and retirement`, async t => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, kind, { protectedDb: true, missing: method === 'create', afterAdapter: async called => { if (called === method) { entered.resolve(); await release.promise; } } });
    const writing = settle(method === 'write' ? f.startWrite() : f.db.create({ snapshot: f.candidate() })); await entered.promise;
    const reads = f.state.reads; let published = false, loaded = false;
    const reading = settle(f.db.read({ force: true, onPublished: () => { published = true; } }));
    await turn(); assert.equal(f.state.reads, reads); assert.equal(published, false);
    f.registry.clear(owner);
    const fresh = f.registry.get(owner, async protect => { loaded = true; return f.load(protect); });
    try { await turn(); assert.equal(loaded, false); }
    finally { release.resolve(); }
    assert.equal((await writing).error?.code, 'USER_DB_REPLACED');
    assert.equal((await reading).error?.code, 'USER_DB_REPLACED'); assert.equal(published, false);
    assert.equal((await fresh).data.marker, 'candidate'); assert.equal(loaded, true);
  });
}

for (const protectedDb of [false, true]) test(`JSON ${protectedDb ? 'registry' : 'bare'}: raw target preflight cannot be overtaken by new GET`, async t => {
  const f = await fixture(t, 'JSON', { protectedDb }), entered = deferred(), release = deferred();
  let first = true, published = false;
  f.hooks.read = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const writing = settle(f.startWrite('legacy')); await entered.promise;
  const reads = f.state.reads; const reading = settle(f.db.read({ force: true, onPublished: () => { published = true; } }));
  try { await turn(); assert.equal(f.state.reads, reads); assert.equal(published, false); }
  finally { release.resolve(); }
  assert.ifError((await writing).error); assert.ifError((await reading).error);
  assert.equal(f.db.data.marker, 'candidate'); assert.equal(f.state.writes, 1);
});

test('JSON generic read cache cannot hide or overtake an unacknowledged write', async t => {
  const f = await fixture(t, 'JSON', { required: false }), entered = deferred(), release = deferred();
  await f.startWrite(); await f.db.read({ force: true });
  f.db.data.marker = 'next'; f.hooks.ack = async () => { entered.resolve(); await release.promise; };
  const writing = settle(f.db.write()); await entered.promise;
  let published = false; const reading = settle(f.db.read({ onPublished: () => { published = true; } }));
  try { await turn(); assert.equal(published, false); }
  finally { release.resolve(); }
  assert.ifError((await writing).error); assert.ifError((await reading).error);
  assert.equal(f.db.data.marker, 'next'); assert.deepEqual(f.db.data, await f.durable());
});

for (const kind of ['PG', 'Mongo']) for (const method of ['write', 'create']) test(`${kind}: unknown ${method} ACK releases fence and requires raw reconciliation`, async t => {
  const f = await fixture(t, kind, { missing: method === 'create' }), prior = f.db.data, revision = f.db._revision;
  f.hooks.result = () => kind === 'PG' ? { rowCount: undefined, rows: [] } : { acknowledged: false };
  await assert.rejects(method === 'write' ? f.startWrite() : f.db.create({ snapshot: f.candidate() }), code('WRITE_ACK_UNKNOWN'));
  assert.equal(f.db.data, prior); assert.equal(f.db._revision, revision);
  await f.db.read({ force: true }); assert.equal(f.db.data.marker, 'candidate');
  assert.equal(f.state[method === 'create' ? 'creates' : 'writes'], 1);
});

test('required-store permit epoch still rejects an old attempt even after later authority is established', () => {
  // Direct contract check, not a claim that public reads can cross the fence.
  const db = requireAccountStore({}, owner), source = initial(), contract = db._accountStoreContract;
  contract.read(source, true); const permit = contract.beforeWrite(source);
  contract.uncertain(); contract.read({ ...source, marker: 'later authority' }, true);
  assert.throws(() => contract.checkWrite(permit, { afterIo: true }), code('WRITE_ACK_UNKNOWN'));
  assert.throws(() => contract.beforeWrite(source), code('ACCOUNT_WRITE_REQUIRES_READ'));
});
