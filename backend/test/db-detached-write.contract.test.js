// Production adapter/registry/barrier calls. JSON uses real temporary files;
// PostgreSQL and MongoDB transports below are synthetic, not live DB evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSONFile } from 'lowdb/node';
import { CustomLow } from '../src/models/db.js';
import { PgLow } from '../src/models/supabaseAdapter.js';
import { MongoLow } from '../src/models/mongoAdapter.js';
import { createUserDbRegistry } from '../src/models/userDbRegistry.js';
import { beginUserDbWriteBarrier } from '../src/models/readBarrier.js';

const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const seed = () => ({ marker: 'committed', nested: { value: 1 }, messages: [] });
const candidate = () => ({ marker: 'candidate', nested: { value: 2 }, messages: [{ id: 'fixed-id' }] });
const kinds = ['JSON-real-file', 'PostgreSQL-synthetic', 'MongoDB-synthetic'];
async function fixture(t, kind, { missing = false, revision = 3 } = {}) {
  const state = { data: missing ? null : seed(), revision, reads: 0, writes: 0, hooks: {} };
  let file, adapter;
  if (kind === kinds[0]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-detached-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    file = path.join(dir, 'account.json'); adapter = new JSONFile(file);
    if (!missing) await adapter.write(state.data);
  }
  const read = async () => {
    state.reads++;
    let value;
    if (kind === kinds[0]) {
      try { value = { data: JSON.parse(await fs.readFile(file, 'utf8')), exists: true }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; value = { data: null, exists: false }; }
    } else value = state.data === null ? null : { data: clone(state.data), revision: state.revision };
    await state.hooks.read?.(value); return value;
  };
  const write = async (data, expected, insert = false) => {
    state.writes++;
    await state.hooks.before?.();
    if (kind !== kinds[0] && (insert ? state.data !== null : state.data === null || state.revision !== expected)) return false;
    if (kind === kinds[0]) await adapter.write(data);
    state.data = clone(data); state.revision = insert ? 1 : state.revision + 1;
    await state.hooks.after?.(); return true;
  };
  const make = () => kind === kinds[0] ? new CustomLow({ read: async () => (await read()).data, write: data => write(data) }, seed(), { readWithMetadata: read })
    : kind === kinds[1] ? new PgLow('user:synthetic', seed(), { query: async (sql, params) => {
      if (sql.startsWith('SELECT')) { const row = await read(); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; }
      const success = await write(params[1], params[2], sql.startsWith('INSERT'));
      return { rowCount: success ? 1 : 0, rows: success ? [{ revision: String(state.revision) }] : [] };
    } }) : new MongoLow({ findOne: read,
      updateOne: async (filter, update) => ({ acknowledged: true, matchedCount: await write(update.$set.data, filter.revision ?? 0) ? 1 : 0 }),
      insertOne: async document => {
        if (!await write(document.data, 0, true)) throw Object.assign(new Error('duplicate'), { code: 11000 });
        return { acknowledged: true, insertedId: 'synthetic' };
      }
    }, { userId: 'synthetic' }, seed());
  const registry = createUserDbRegistry();
  const load = async protect => { const db = protect(make()); await db.read({ force: true }); return db; };
  const db = await registry.get('account', load);
  const durable = async () => kind === kinds[0] ? adapter.read() : clone(state.data);
  return { state, db, registry, load, durable, file, adapter, expected: kind === kinds[0] ? null : revision };
}

for (const kind of kinds) {
  test(`${kind}: detached candidate is private until ACK and copied before I/O`, async t => {
    const f = await fixture(t, kind), gate = deferred(), started = deferred();
    const input = candidate(), options = { snapshot: input, expectedRevision: f.expected };
    f.state.hooks.before = async () => { started.resolve(); await gate.promise; };
    const writing = settle(f.db.write(options));
    await started.promise;
    try {
      assert.equal(f.db.data.marker, 'committed'); assert.equal(f.db.data.messages.length, 0);
      input.nested.value = 999; options.expectedRevision = 999; f.db.data.nested.value = 777;
    } finally { gate.resolve(); }
    const result = await writing; assert.ifError(result.error);
    assert.deepEqual(await f.durable(), candidate()); assert.deepEqual(f.db.data, candidate());
    assert.notEqual(f.db.data, input); assert.notEqual(f.db.data.nested, input.nested);
    if (kind !== kinds[0]) assert.equal(f.db._revision, f.expected + 1);
  });

  for (const phase of ['before', 'after']) test(`${kind}: ${phase === 'before' ? 'precommit failure' : 'commit with lost ACK'} never publishes candidate`, async t => {
    const f = await fixture(t, kind), previous = f.db.data, beforeRevision = f.db._revision;
    f.state.hooks[phase] = () => { throw Object.assign(new Error(`synthetic ${phase} failure`), { code: 'SYNTHETIC_IO_FAILURE' }); };
    await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: f.expected }), /synthetic/);
    assert.equal(f.db.data, previous); assert.equal(f.db._revision, beforeRevision);
    assert.deepEqual(await f.durable(), phase === 'after' ? candidate() : seed());
    f.state.hooks = {}; await f.db.read();
    assert.deepEqual(f.db.data, phase === 'after' ? candidate() : seed());
  });

  test(`${kind}: onPublished observes a matched durable pair and establishes a synchronous fence`, async t => {
    const f = await fixture(t, kind), gate = deferred(), started = deferred(); let release, published, calls = 0;
    f.state.hooks.read = async () => { if (++calls === 1) { started.resolve(); await gate.promise; } };
    const oldRead = settle(f.db.read({ force: true })); await started.promise;
    try {
      await f.db.read({ force: true, onPublished: snapshot => {
        published = snapshot; release = beginUserDbWriteBarrier(f.db);
      } });
      assert.ok(release, 'hook must run before read resolves');
      assert.equal(published.data, f.db.data); assert.equal(published.exists, true);
      assert.equal(published.supportsRevisionCas, kind !== kinds[0]);
      assert.equal(published.revision, f.expected);
      gate.resolve(); await turn();
      await f.db.write({ snapshot: candidate(), expectedRevision: f.expected });
      assert.deepEqual(f.db.data, candidate());
    } finally { gate.resolve(); release?.(); }
    const old = await oldRead; assert.ifError(old.error);
    assert.ok(calls >= 3, 'read crossing synchronous fence must retry');
    assert.deepEqual(f.db.data, candidate());
  });

  for (const mode of ['hook throws', 'registry retires after hook']) test(`${kind}: caller release slot survives ${mode}`, async t => {
    const f = await fixture(t, kind); let release, hookCalled = false;
    try {
      await assert.rejects(f.db.read({ force: true, onPublished: () => {
        hookCalled = true; release = beginUserDbWriteBarrier(f.db);
        if (mode === 'hook throws') throw new Error('hook deliberately failed');
        f.registry.clear('account');
      } }), mode === 'hook throws' ? /hook deliberately failed/ : error => error.code === 'USER_DB_REPLACED');
    } finally { release?.(); release?.(); }
    assert.ok(hookCalled); assert.ok(release);
    if (mode === 'hook throws') await f.db.read({ force: true });
    else assert.deepEqual((await f.registry.get('account', f.load)).data, seed());
  });

  test(`${kind}: retirement before read publication does not expose stale data or call hook`, async t => {
    const f = await fixture(t, kind), gate = deferred(), started = deferred(); let called = false;
    f.state.hooks.read = async () => { started.resolve(); await gate.promise; };
    const read = settle(f.db.read({ force: true, onPublished: () => { called = true; } }));
    await started.promise; f.db.data = { marker: 'untouched retired handle' }; f.registry.clear('account');
    gate.resolve(); const result = await read;
    assert.equal(result.error?.code, 'USER_DB_REPLACED'); assert.equal(called, false);
    assert.equal(f.db.data.marker, 'untouched retired handle');
  });

  for (const loseAck of [false, true]) test(`${kind}: registry clear drains candidate write, lost ACK=${loseAck}`, async t => {
    const f = await fixture(t, kind), gate = deferred(), started = deferred(); let loads = 0;
    f.state.hooks.after = async () => { started.resolve(); await gate.promise; if (loseAck) throw new Error('lost ACK'); };
    const writing = settle(f.db.write({ snapshot: candidate(), expectedRevision: f.expected })); await started.promise;
    f.registry.clear('account');
    const loading = f.registry.get('account', async protect => { loads++; return f.load(protect); });
    await turn(); assert.equal(loads, 0); assert.equal(f.db.data.marker, 'committed');
    gate.resolve(); const result = await writing; assert.equal(result.error?.code, 'USER_DB_REPLACED');
    const fresh = await loading; assert.equal(loads, 1); assert.deepEqual(fresh.data, candidate());
  });

  for (const missing of [false, true]) test(`${kind}: read preserves storage existence metadata, missing=${missing}`, async t => {
    const f = await fixture(t, kind, { missing, revision: 0 }); let published;
    await f.db.read({ force: true, onPublished: value => { published = value; } });
    assert.equal(f.db._exists, !missing); assert.equal(published?.exists, !missing);
    assert.equal(published?.supportsRevisionCas, kind !== kinds[0]);
    assert.equal(published?.revision, kind === kinds[0] ? null : 0);
    assert.equal(f.state.writes, 0, 'missing is a read result, never permission to create');
  });

  test(`${kind}: no-argument writes remain available for non-message documents`, async t => {
    const f = await fixture(t, kind);
    f.db.data = { auth: { users: ['synthetic'] } }; await f.db.write();
    assert.deepEqual(await f.durable(), { auth: { users: ['synthetic'] } });
  });
}

for (const kind of kinds.slice(1)) {
  test(`${kind}: a stale expected revision conflicts without publishing or retrying`, async t => {
    const f = await fixture(t, kind);
    await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: 2 }), error => error.code === 'REVISION_CONFLICT');
    assert.deepEqual(f.db.data, seed()); assert.equal(f.db._revision, 3); assert.equal(f.state.writes, 1);
  });
  test(`${kind}: explicit expectedRevision remains fixed when shared revision changes during I/O`, async t => {
    const f = await fixture(t, kind), gate = deferred(), started = deferred();
    f.state.hooks.before = async () => { started.resolve(); await gate.promise; };
    const writing = settle(f.db.write({ snapshot: candidate(), expectedRevision: 3 }));
    await started.promise; f.db._revision = 777; gate.resolve(); const result = await writing;
    assert.ifError(result.error); assert.equal(f.db._revision, 4); assert.deepEqual(await f.durable(), candidate());
  });
  for (const revision of [-1, 0.5, NaN, Infinity, null, '', '01', '1e2', '9007199254740992', 9007199254740992]) {
    test(`${kind}: malformed read revision ${String(revision)} does not publish`, async t => {
      const f = await fixture(t, kind); f.state.revision = revision; f.state.data = candidate(); let called = false;
      await assert.rejects(f.db.read({ onPublished: () => { called = true; } }), error => error.code === 'INVALID_DB_REVISION');
      assert.deepEqual(f.db.data, seed()); assert.equal(f.db._revision, 3); assert.equal(called, false);
    });
  }
  for (const revision of [-1, 0.5, null, NaN, 9007199254740992, Number.MAX_SAFE_INTEGER]) {
    test(`${kind}: unsafe write revision ${String(revision)} fails before any I/O`, async t => {
      const f = await fixture(t, kind);
      await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: revision }), error => ['INVALID_DB_REVISION', 'DB_REVISION_EXHAUSTED'].includes(error.code));
      assert.equal(f.state.writes, 0); assert.deepEqual(f.db.data, seed());
    });
  }
  test(`${kind}: MAX_SAFE_INTEGER-1 permits exactly the final safe revision`, async t => {
    const f = await fixture(t, kind, { revision: Number.MAX_SAFE_INTEGER - 1 });
    await f.db.write({ snapshot: candidate(), expectedRevision: f.expected });
    assert.equal(f.db._revision, Number.MAX_SAFE_INTEGER);
    await assert.rejects(f.db.write(), error => error.code === 'DB_REVISION_EXHAUSTED');
    assert.equal(f.state.writes, 1);
  });
}

test('JSON: numeric expectedRevision is rejected rather than pretending to offer durable CAS', async t => {
  const f = await fixture(t, kinds[0]);
  await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: 3 }), error => error.code === 'REVISION_CAS_UNSUPPORTED');
  assert.equal(f.state.writes, 0); assert.deepEqual(await f.durable(), seed());
});
for (const code of ['ENOENT', 'EPERM']) test(`JSON: real rename fallback ${code} uses the original detached candidate`, async t => {
  const f = await fixture(t, kinds[0]); const input = candidate(); let passed;
  f.db.adapter.write = async data => {
    passed = clone(data); input.nested.value = 999; f.db.data.nested.value = 888;
    throw Object.assign(new Error('synthetic steno rename failure'), { code, syscall: 'rename', dest: f.file });
  };
  await f.db.write({ snapshot: input, expectedRevision: null });
  assert.deepEqual(passed, candidate()); assert.deepEqual(await f.durable(), candidate()); assert.deepEqual(f.db.data, candidate());
});

test('JSON: failed rename fallback never publishes candidate', async t => {
  const f = await fixture(t, kinds[0]);
  const invalidDestination = path.join(f.file, 'not-a-directory.json');
  f.db.adapter.write = async () => { throw Object.assign(new Error('synthetic rename failure'), { code: 'ENOENT', syscall: 'rename', dest: invalidDestination }); };
  await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: null }));
  assert.deepEqual(f.db.data, seed()); assert.deepEqual(await f.durable(), seed());
});

for (const kind of kinds) {
  test(`${kind}: durable commit remains private while acknowledgement is pending`, async t => {
    const f = await fixture(t, kind), gate = deferred(), started = deferred();
    f.state.hooks.after = async () => { started.resolve(); await gate.promise; };
    const writing = settle(f.db.write({ snapshot: candidate(), expectedRevision: f.expected }));
    await started.promise;
    try {
      assert.deepEqual(await f.durable(), candidate()); assert.deepEqual(f.db.data, seed());
      assert.equal(f.db._revision, f.expected);
    } finally { gate.resolve(); }
    const result = await writing; assert.ifError(result.error); assert.deepEqual(f.db.data, candidate());
    assert.equal(f.db._revision, kind === kinds[0] ? null : f.expected + 1);
  });
  test(`${kind}: no-argument write captures input without breaking legacy shared object identity`, async t => {
    const f = await fixture(t, kind), gate = deferred(), started = deferred(), shared = f.db.data;
    f.state.hooks.before = async () => { started.resolve(); await gate.promise; };
    const writing = settle(f.db.write()); await started.promise;
    shared.nested.value = 888; gate.resolve(); const result = await writing; assert.ifError(result.error);
    assert.deepEqual(await f.durable(), seed()); assert.equal(f.db.data, shared); assert.equal(shared.nested.value, 888);
  });
  test(`${kind}: fresh insert freezes the same candidate and publishes existence only after ACK`, async t => {
    const f = await fixture(t, kind, { missing: true, revision: 0 }), gate = deferred(), started = deferred();
    const input = candidate(); f.state.hooks.after = async () => { started.resolve(); await gate.promise; };
    const writing = settle(f.db.write({ snapshot: input, expectedRevision: f.expected })); await started.promise;
    try { assert.equal(f.db._exists, false); assert.deepEqual(f.db.data, seed()); input.marker = 'too late'; }
    finally { gate.resolve(); }
    const result = await writing; assert.ifError(result.error);
    assert.equal(f.db._exists, true); assert.deepEqual(f.db.data, candidate()); assert.deepEqual(await f.durable(), candidate());
  });
}

for (const ack of [{ rowCount: 1, rows: [{ revision: '5' }] }, { rowCount: 1, rows: [{ revision: '9007199254740992' }] }, { rowCount: 1, rows: [] }, { rows: [] }]) {
  test(`PostgreSQL-synthetic: malformed update ACK ${JSON.stringify(ack)} is not success/conflict`, async () => {
    const db = new PgLow('synthetic', seed(), { query: async () => ack }); db._revision = 3;
    await assert.rejects(db.write({ snapshot: candidate(), expectedRevision: 3 }), e => ['WRITE_ACK_UNKNOWN', 'INVALID_DB_REVISION'].includes(e.code));
    assert.deepEqual(db.data, seed()); assert.equal(db._revision, 3);
  });
}
for (const ack of [{ acknowledged: false, matchedCount: 1 }, { acknowledged: false, matchedCount: 0 }, { acknowledged: true }, {}]) {
  test(`MongoDB-synthetic: incomplete update ACK ${JSON.stringify(ack)} cannot publish or insert`, async () => {
    let inserts = 0;
    const db = new MongoLow({ updateOne: async () => ack, insertOne: async () => { inserts++; } }, {}, seed());
    await assert.rejects(db.write({ snapshot: candidate(), expectedRevision: 0 }), e => e.code === 'WRITE_ACK_UNKNOWN');
    assert.equal(inserts, 0); assert.deepEqual(db.data, seed()); assert.equal(db._revision, 0);
  });
}
for (const ack of [{ acknowledged: false, insertedId: 'synthetic' }, { acknowledged: true }, {}]) {
  test(`MongoDB-synthetic: incomplete insert ACK ${JSON.stringify(ack)} never publishes`, async () => {
    const db = new MongoLow({ updateOne: async () => ({ acknowledged: true, matchedCount: 0 }), insertOne: async () => ack }, {}, seed());
    await assert.rejects(db.write({ snapshot: candidate(), expectedRevision: 0 }), e => e.code === 'WRITE_ACK_UNKNOWN');
    assert.deepEqual(db.data, seed()); assert.equal(db._revision, 0);
  });
}

test('MongoDB-synthetic: legacy absent revision is zero, but a present null is invalid', async () => {
  let doc = { data: seed() };
  const db = new MongoLow({ findOne: async () => doc }, {}, {});
  await db.read(); assert.equal(db._revision, 0); assert.equal(db._exists, true);
  doc = { data: candidate(), revision: null };
  await assert.rejects(db.read(), e => e.code === 'INVALID_DB_REVISION'); assert.deepEqual(db.data, seed());
});

test('JSON: lost ACK invalidates a previously eligible read cache', async t => {
  const f = await fixture(t, kinds[0]); await f.db.write(); await f.db.read({ force: true });
  const reads = f.state.reads; await f.db.read(); assert.equal(f.state.reads, reads, 'cache was genuinely primed');
  f.state.hooks.after = () => { throw new Error('lost ACK'); };
  await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: null }), /lost ACK/);
  await f.db.read(); assert.equal(f.state.reads, reads + 1); assert.deepEqual(f.db.data, candidate());
});

test('JSON: rename fallback derives target from steno temporary path without dest', async t => {
  const f = await fixture(t, kinds[0]);
  f.db.adapter.write = async () => { throw Object.assign(new Error('rename fail'), { code: 'EPERM', syscall: 'rename', path: path.join(path.dirname(f.file), '.account.json.tmp') }); };
  await f.db.write({ snapshot: candidate(), expectedRevision: null }); assert.deepEqual(await f.durable(), candidate());
});

test('JSON: fallback rename can commit but lose ACK without publishing or guessing rollback', async t => {
  const f = await fixture(t, kinds[0]), original = fs.rename;
  f.db.adapter.write = async () => { throw Object.assign(new Error('steno failure'), { code: 'ENOENT', syscall: 'rename', dest: f.file }); };
  fs.rename = async (from, to) => { await original(from, to); throw new Error('fallback rename lost ACK'); };
  try { await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: null }), /fallback rename lost ACK/); }
  finally { fs.rename = original; }
  assert.deepEqual(f.db.data, seed()); assert.deepEqual(await f.durable(), candidate());
  await f.db.read(); assert.deepEqual(f.db.data, candidate());
});

test('JSON: registry retirement during fallback prevents target rename and drains the write', async t => {
  const f = await fixture(t, kinds[0]), original = fs.writeFile;
  f.db.adapter.write = async () => { throw Object.assign(new Error('steno failure'), { code: 'EPERM', syscall: 'rename', dest: f.file }); };
  fs.writeFile = async (...args) => { await original(...args); if (String(args[0]).includes('.fb-')) f.registry.clear('account'); };
  try { await assert.rejects(f.db.write({ snapshot: candidate(), expectedRevision: null }), e => e.code === 'USER_DB_REPLACED'); }
  finally { fs.writeFile = original; }
  assert.deepEqual(await f.durable(), seed()); assert.deepEqual(f.db.data, seed());
  assert.equal((await fs.readdir(path.dirname(f.file))).filter(name => name.includes('.fb-')).length, 0);
});

test('PostgreSQL-synthetic: candidate and revision are captured before awaiting initial pool connection', async () => {
  const pg = (await import('pg')).default, Pool = pg.Pool;
  const previousUrl = process.env.SUPABASE_DB_URL;
  const gate = deferred(), started = deferred(); let sent;
  pg.Pool = class {
    on() {}
    async connect() { started.resolve(); await gate.promise; return { query: async () => ({ rows: [] }), release() {} }; }
    async query(sql, params) { sent = clone(params); return { rowCount: 1, rows: [{ revision: '4' }] }; }
    async end() {}
  };
  process.env.SUPABASE_DB_URL = 'postgres://synthetic:synthetic@127.0.0.1/synthetic?sslmode=verify-full';
  let module;
  try {
    module = await import('../src/models/supabaseAdapter.js?synthetic-delayed-pool');
    const db = new module.PgLow('synthetic', seed()); db._revision = 3;
    const input = candidate(), options = { snapshot: input, expectedRevision: 3 };
    const writing = settle(db.write(options)); await Promise.race([started.promise, writing.then(result => { if (result.error) throw result.error; throw new Error('write finished without entering pool'); })]);
    input.nested.value = 999; options.expectedRevision = 999; db._revision = 777; db.data.marker = 'external mutation';
    gate.resolve(); const result = await writing; assert.ifError(result.error);
    assert.deepEqual(sent, ['synthetic', candidate(), 3]); assert.deepEqual(db.data, candidate()); assert.equal(db._revision, 4);
  } finally {
    gate.resolve(); await module?.closeSupabaseConnection(); pg.Pool = Pool;
    if (previousUrl === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previousUrl;
  }
});

// Existence-aware raw reads are opt-in. Current production loaders are not
// switched here; their later create/load split must supply this callback.
async function rawJsonFixture(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-raw-meta-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'account.json');
  if (content !== undefined) await fs.writeFile(file, content);
  let rawReads = 0;
  const db = new CustomLow(new JSONFile(file), seed(), { readWithMetadata: async () => {
    rawReads++;
    try { return { data: JSON.parse(await fs.readFile(file, 'utf8')), exists: true }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { data: null, exists: false }; }
  } });
  return { db, file, reads: () => rawReads };
}
for (const text of [undefined, 'null', 'false', '0', '""', '[]', '{}']) {
  test(`JSON real raw metadata: ${text === undefined ? 'missing file' : `existing ${text}`} remains distinct`, async t => {
    const f = await rawJsonFixture(t, text); let published;
    await f.db.read({ force: true, onPublished: value => { published = value; } });
    assert.equal(f.reads(), 1); assert.equal(f.db._exists, text !== undefined); assert.equal(published.exists, text !== undefined);
    assert.deepEqual(f.db.data, text === undefined ? seed() : JSON.parse(text));
    if (text === undefined) await assert.rejects(fs.access(f.file), e => e.code === 'ENOENT');
    else assert.equal(await fs.readFile(f.file, 'utf8'), text);
  });
}
for (const absent of [null, undefined]) test(`JSON generic adapter: ${String(absent)} without reliable metadata means unknown existence`, async () => {
  const db = new CustomLow({ read: async () => absent, write: async () => {} }, seed()); let published;
  await db.read({ onPublished: value => { published = value; } });
  assert.equal(db._exists, null); assert.equal(published.exists, null); assert.deepEqual(db.data, seed());
});

test('JSON real raw metadata: corrupt JSON is never treated as absent, repaired, or published', async t => {
  const f = await rawJsonFixture(t, '{bad JSON'); let called = false;
  await assert.rejects(f.db.read({ force: true, onPublished: () => { called = true; } }), SyntaxError);
  assert.ok(f.reads() > 0); assert.equal(f.db._exists, null); assert.deepEqual(f.db.data, seed()); assert.equal(called, false);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{bad JSON');
});

test('JSON real raw metadata: actual EACCES is not converted into missing data', async t => {
  const f = await rawJsonFixture(t, JSON.stringify(candidate())); let called = false;
  await fs.chmod(f.file, 0);
  try {
    await assert.rejects(f.db.read({ force: true, onPublished: () => { called = true; } }), e => e.code === 'EACCES');
    assert.equal(f.reads(), 1); assert.equal(f.db._exists, null); assert.deepEqual(f.db.data, seed()); assert.equal(called, false);
  } finally { await fs.chmod(f.file, 0o600); }
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), candidate());
});
for (const metadata of [{ data: seed(), exists: 'yes' }, { data: seed(), exists: false }, { exists: true }, null]) {
  test(`JSON: invalid raw metadata ${JSON.stringify(metadata)} fails before publication`, async () => {
    const db = new CustomLow({ read: async () => candidate(), write: async () => {} }, seed(), { readWithMetadata: async () => metadata });
    await assert.rejects(db.read(), e => e.code === 'INVALID_READ_METADATA');
    assert.equal(db._exists, null); assert.deepEqual(db.data, seed());
  });
}

for (const kind of kinds.slice(1)) test(`${kind}: zero-revision update-to-insert transition uses one frozen attempt`, async t => {
  const f = await fixture(t, kind, { missing: true, revision: 0 }), gate = deferred(), started = deferred();
  const input = candidate(), options = { snapshot: input, expectedRevision: 0 }; let attempts = 0;
  f.state.hooks.before = async () => { if (++attempts === 1) { started.resolve(); await gate.promise; } };
  const writing = settle(f.db.write(options)); await started.promise;
  input.nested.value = 999; options.expectedRevision = 999; f.db._revision = 777; f.db.data.marker = 'unrelated shared mutation';
  gate.resolve(); const result = await writing; assert.ifError(result.error);
  assert.equal(attempts, 2); assert.deepEqual(await f.durable(), candidate()); assert.deepEqual(f.db.data, candidate()); assert.equal(f.db._revision, 1);
});

test('JSON: no-argument write keeps Low compatibility for an undefined data handle', async () => {
  let writes = 0;
  const db = new CustomLow({ read: async () => null, write: async () => { writes++; } }, {});
  db.data = undefined; await db.write(); assert.equal(writes, 0); assert.equal(db.data, undefined);
});
for (const kind of kinds.slice(1)) test(`${kind}: an existing document containing null is not mistaken for a missing document`, async () => {
  const db = kind === kinds[1]
    ? new PgLow('synthetic', seed(), { query: async () => ({ rows: [{ data: null, revision: '3' }], rowCount: 1 }) })
    : new MongoLow({ findOne: async () => ({ data: null, revision: 3 }) }, {}, seed());
  let published; await db.read({ onPublished: value => { published = value; } });
  assert.equal(db.data, null); assert.equal(db._exists, true); assert.equal(db._revision, 3); assert.equal(published.exists, true);
});

test('JSON: an explicit null snapshot is invalid even though legacy empty handles may be no-ops', async t => {
  const f = await fixture(t, kinds[0]);
  await assert.rejects(f.db.write({ snapshot: null, expectedRevision: null }));
  assert.equal(f.state.writes, 0); assert.deepEqual(await f.durable(), seed()); assert.deepEqual(f.db.data, seed());
});

for (const kind of kinds) {
  for (const value of [null, undefined, false, 0, '', [], new Date(0), new Map(), new Set(), new (class Snapshot {})()]) {
    test(`${kind}: invalid explicit account snapshot ${Object.prototype.toString.call(value)} rejects before I/O`, async t => {
      const f = await fixture(t, kind), before = f.db.data, revision = f.db._revision;
      await assert.rejects(f.db.write({ snapshot: value, expectedRevision: f.expected }), e => e.code === 'INVALID_DB_SNAPSHOT');
      assert.equal(f.state.writes, 0); assert.equal(f.db.data, before); assert.equal(f.db._revision, revision);
    });
  }
  test(`${kind}: an obviously async onPublished hook is rejected before I/O`, async t => {
    const f = await fixture(t, kind), reads = f.state.reads, previous = f.db.data; let called = false;
    await assert.rejects(f.db.read({ force: true, onPublished: async () => { called = true; } }), e => e.code === 'ASYNC_PUBLISH_HOOK');
    assert.equal(called, false); assert.equal(f.state.reads, reads); assert.equal(f.db.data, previous);
  });
  for (const mode of ['resolved promise', 'rejected promise', 'thenable']) test(`${kind}: ${mode} hook result rejects and caller finally releases its fence`, async t => {
    const f = await fixture(t, kind); let release, thenCalls = 0;
    try {
      await assert.rejects(f.db.read({ force: true, onPublished: () => {
        release = beginUserDbWriteBarrier(f.db);
        if (mode === 'resolved promise') return Promise.resolve();
        if (mode === 'rejected promise') return Promise.reject(new Error('synthetic unsupported async work'));
        return { then() { thenCalls++; } };
      } }), e => e.code === 'ASYNC_PUBLISH_HOOK');
    } finally { release?.(); }
    await f.db.read({ force: true }); assert.equal(thenCalls, 0, 'arbitrary thenables are rejected, never executed');
  });
}
for (const acknowledged of [undefined, null, 0, 'yes']) {
  test(`MongoDB-synthetic: matched update with non-true acknowledged=${String(acknowledged)} is unknown`, async () => {
    const db = new MongoLow({ updateOne: async () => ({ acknowledged, matchedCount: 1 }) }, {}, seed());
    await assert.rejects(db.write({ snapshot: candidate(), expectedRevision: 0 }), e => e.code === 'WRITE_ACK_UNKNOWN');
    assert.deepEqual(db.data, seed()); assert.equal(db._revision, 0);
  });
  test(`MongoDB-synthetic: insertedId with non-true acknowledged=${String(acknowledged)} is unknown`, async () => {
    const db = new MongoLow({ updateOne: async () => ({ acknowledged: true, matchedCount: 0 }), insertOne: async () => ({ acknowledged, insertedId: 'synthetic' }) }, {}, seed());
    await assert.rejects(db.write({ snapshot: candidate(), expectedRevision: 0 }), e => e.code === 'WRITE_ACK_UNKNOWN');
    assert.deepEqual(db.data, seed()); assert.equal(db._revision, 0);
  });
}
