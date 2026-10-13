// Production wrapper + registry + required schema + adapters. JSON uses a real
// temporary file. PG/Mongo transports are synthetic, not live DB acceptance.
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
import { requireAccountStore } from '../src/models/accountStoreLifecycle.js';
import { readCommittedUserDb } from '../src/models/readBarrier.js';
import { initializeNewAccountOrder, prepareOrderedAppend, validateMessageOrder, projectMessageOrder } from '../src/services/messageOrder.js';
import { commitAccountSnapshot } from '../src/services/accountSnapshotCommit.js';

// Synthetic transport tests must never inherit a developer's cloud endpoints.
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];

const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const fault = (code, status = 503) => Object.assign(new Error(code), { code, status, statusCode: status });
const kinds = ['JSON-real-file', 'PostgreSQL-synthetic', 'MongoDB-synthetic'];
const owner = 'wrapper-synthetic-owner';
const seed = () => initializeNewAccountOrder({ groups: [{ id: 'group' }], messages: [], sourceAllowed: true,
  sources: [{ id: 'source', attachments: ['public', 'private'] }], profile: { value: 1 } }, owner,
  { generationForGroup: () => '11111111-1111-4111-8111-111111111111' });
const intent = () => ({ message: { id: 'fixed-id', group_id: 'group', content: 'fixed ciphertext', created_at: '2026-10-13T03:00:00.000Z', metadata: { source_id: 'source' } }, creationIntentHash: 'a'.repeat(64), requestHash: 'original request hash' });
function confirm({ snapshot, prepared }) {
  const binding = validateMessageOrder(snapshot, owner).bindings.get(prepared.message.id);
  if (!binding) return null;
  if (binding.creationIntentHash !== prepared.creationIntentHash) throw fault('MESSAGE_INTENT_CONFLICT', 409);
  const message = snapshot.messages.find(row => row.id === prepared.message.id);
  if (!message) throw fault('MESSAGE_DELETED', 410);
  return { confirmed: true, result: projectMessageOrder(message, validateMessageOrder(snapshot, owner)) };
}
function compose(args) {
  const prior = confirm(args);
  if (prior) return { readOnly: true, result: prior.result };
  const { data } = prepareOrderedAppend(args.snapshot, owner, args.prepared.message, { creationIntentHash: args.prepared.creationIntentHash });
  return { snapshot: data, result: projectMessageOrder(data.messages.at(-1), validateMessageOrder(data, owner)) };
}
async function fixture(t, kind) {
  const state = { data: seed(), revision: 3, reads: 0, writes: 0, hooks: {} };
  let file, adapter;
  if (kind === kinds[0]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-commit-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    file = path.join(directory, 'account.json'); adapter = new JSONFile(file); await adapter.write(state.data);
  }
  const read = async () => {
    state.reads++;
    let row = kind === kinds[0] ? { data: JSON.parse(await fs.readFile(file, 'utf8')), exists: true }
      : { data: clone(state.data), revision: state.revision };
    row = await state.hooks.read?.(row) ?? row;
    return row;
  };
  const write = async (data, revision) => {
    state.writes++;
    await state.hooks.before?.(data, revision);
    if (kind !== kinds[0] && state.revision !== revision) return false;
    if (adapter) await adapter.write(data);
    state.data = clone(data); state.revision++;
    await state.hooks.after?.(data); return true;
  };
  const make = () => kind === kinds[0]
    ? new CustomLow({ read: async () => (await read()).data, write }, seed(), { readWithMetadata: read, filePath: file })
    : kind === kinds[1] ? new PgLow(`user:${owner}`, {}, { query: async (sql, values) => {
      if (sql.startsWith('SELECT')) return { rows: [await read()], rowCount: 1 };
      assert.ok(sql.startsWith('UPDATE'), 'required existing account never inserts');
      const changed = await write(values[1], values[2]);
      return { rows: changed ? [{ revision: String(state.revision) }] : [], rowCount: changed ? 1 : 0 };
    } }) : new MongoLow({ findOne: read, updateOne: async (filter, update) => ({ acknowledged: true, matchedCount: await write(update.$set.data, filter.revision) ? 1 : 0 }) }, { userId: owner }, {});
  const registry = createUserDbRegistry();
  const load = async protect => { const db = protect(requireAccountStore(make(), owner)); await db.read({ force: true }); return db; };
  const db = await registry.get(owner, load);
  const durable = async () => adapter ? adapter.read() : clone(state.data);
  const external = async data => { state.data = clone(data); state.revision++; if (adapter) await adapter.write(data); };
  const run = options => commitAccountSnapshot({ userId: owner, db, prepared: intent(), compose, confirm, ...options });
  return { state, db, registry, load, durable, external, run };
}

for (const kind of kinds) {
  test(`${kind}: detached result is hidden until write ACK; PreparedIntent freezes before first await`, async t => {
    const f = await fixture(t, kind), started = deferred(), gate = deferred(), prepared = intent();
    f.state.hooks.before = async () => { started.resolve(); await gate.promise; };
    const running = settle(f.run({ prepared }));
    prepared.message.id = 'late replacement'; prepared.message.content = 'late ciphertext'; prepared.requestHash = 'late hash';
    await started.promise;
    assert.equal(f.db.data.messages.length, 0); assert.equal(f.db.data.message_order.groups[0].next_sequence, '1');
    let readerDone = false;
    const reading = readCommittedUserDb(f.db, data => data.messages).then(value => { readerDone = true; return value; });
    await turn(); assert.equal(readerDone, false);
    gate.resolve(); const result = await running; assert.ifError(result.error);
    assert.equal(result.value.disposition, 'committed'); assert.equal(result.value.result.id, 'fixed-id');
    assert.equal(result.value.result.content, 'fixed ciphertext'); assert.equal(result.value.result.server_order.sequence, '1');
    assert.equal((await reading)[0].id, 'fixed-id');
    result.value.result.content = 'mutate response'; assert.equal(f.db.data.messages[0].content, 'fixed ciphertext');
    assert.equal(f.state.writes, 1);
  });

  test(`${kind}: old async read crossing synchronous publication fence cannot rewind committed data/revision`, async t => {
    const f = await fixture(t, kind), started = deferred(), gate = deferred(); let first = true;
    f.state.hooks.read = async () => { if (first) { first = false; started.resolve(); await gate.promise; } };
    const old = settle(f.db.read({ force: true })); await started.promise;
    const result = await f.run({ authorize: async () => { gate.resolve(); await turn(); assert.equal(f.db.data.messages.length, 0); } });
    assert.equal(result.disposition, 'committed'); assert.ifError((await old).error);
    assert.deepEqual(f.db.data, await f.durable()); assert.equal(f.db.data.messages.length, 1);
    assert.equal(f.db._revision, kind === kinds[0] ? null : 4);
  });

  test(`${kind}: mutating authorization projection cannot alter committed baseline or candidate attachments`, async t => {
    const f = await fixture(t, kind);
    await f.run({ authorize: async ({ snapshot }) => { snapshot.sources[0].attachments = ['public']; snapshot.profile.value = 999; return { accepted: true }; },
      compose: args => { assert.equal(args.authorization.accepted, true); assert.equal(args.snapshot.profile.value, 1); assert.deepEqual(args.snapshot.sources[0].attachments, ['public', 'private']); return compose(args); } });
    assert.deepEqual((await f.durable()).sources[0].attachments, ['public', 'private']);
  });

  for (const phase of ['before', 'after']) test(`${kind}: ${phase} I/O failure never replays write; only matched durable original recovers`, async t => {
    const f = await fixture(t, kind); let compositions = 0;
    f.state.hooks[phase] = () => { throw fault('SYNTHETIC_LOST_ACK'); };
    const result = await settle(f.run({ compose: args => { compositions++; return compose(args); } }));
    if (phase === 'before') { assert.equal(result.error?.code, 'MESSAGE_COMMIT_UNKNOWN'); assert.equal((await f.durable()).messages.length, 0); }
    else { assert.ifError(result.error); assert.equal(result.value.disposition, 'recovered'); assert.equal(result.value.result.id, 'fixed-id'); assert.equal(result.value.result.server_order.sequence, '1'); }
    assert.equal(f.state.writes, 1); assert.equal(compositions, 1);
    f.state.hooks = {}; await f.db.read({ force: true }); assert.deepEqual(f.db.data, await f.durable());
  });

  for (const mode of ['temporarily absent', 'reread failed', 'wrong hash', 'deleted']) test(`${kind}: lost ACK and ${mode} never invent success or automatically rewrite`, async t => {
    const f = await fixture(t, kind);
    f.state.hooks.after = async () => {
      if (mode === 'temporarily absent') f.state.hooks.read = row => ({ ...row, data: seed() });
      if (mode === 'reread failed') f.state.hooks.read = () => { throw fault('SYNTHETIC_READ_FAILURE'); };
      if (mode === 'wrong hash') { const other = await f.durable(); other.message_order.groups[0].bindings[0].creation_intent_hash = 'b'.repeat(64); await f.external(other); }
      if (mode === 'deleted') { const other = await f.durable(); other.messages = []; await f.external(other); }
      throw fault('SYNTHETIC_LOST_ACK');
    };
    const result = await settle(f.run());
    assert.equal(result.error?.code, mode === 'wrong hash' ? 'MESSAGE_INTENT_CONFLICT' : mode === 'deleted' ? 'MESSAGE_DELETED' : 'MESSAGE_COMMIT_UNKNOWN');
    assert.equal(f.state.writes, 1);
    f.state.hooks = {}; await f.db.read({ force: true });
    assert.deepEqual(f.db.data, await f.durable(), 'never roll shared data back to stale pre-write snapshot');
  });

  test(`${kind}: prior matching receipt is read-only and same ID different intent is rejected`, async t => {
    const f = await fixture(t, kind); const first = await f.run();
    const replay = await f.run(); assert.equal(replay.disposition, 'existing'); assert.deepEqual(replay.result, first.result); assert.equal(f.state.writes, 1);
    await assert.rejects(f.run({ prepared: { ...intent(), creationIntentHash: 'b'.repeat(64) } }), error => error.code === 'MESSAGE_INTENT_CONFLICT');
    assert.equal(f.state.writes, 1);
  });

  test(`${kind}: cancellation before compose writes nothing and releases fence`, async t => {
    const f = await fixture(t, kind); let composed = false;
    await assert.rejects(f.run({ authorize: async () => { throw fault('TASK_CANCELLED', 409); }, compose: () => { composed = true; } }), error => error.code === 'TASK_CANCELLED');
    assert.equal(composed, false); assert.equal(f.state.writes, 0); await f.db.read({ force: true });
  });

  test(`${kind}: recovery rechecks source authority and never releases private content`, async t => {
    const f = await fixture(t, kind); let checks = 0;
    f.state.hooks.after = async () => { const revoked = await f.durable(); revoked.sourceAllowed = false; await f.external(revoked); throw fault('SYNTHETIC_LOST_ACK'); };
    await assert.rejects(f.run({ authorize: async ({ snapshot }) => { checks++; if (!snapshot.sourceAllowed) throw fault('SOURCE_NOT_FOUND', 404); } }), error => error.code === 'SOURCE_NOT_FOUND');
    assert.equal(checks, 2); assert.equal(f.state.writes, 1);
  });

  test(`${kind}: retired registry handle does not replay against replacement`, async t => {
    const f = await fixture(t, kind), started = deferred(), gate = deferred();
    f.state.hooks.after = async () => { started.resolve(); await gate.promise; };
    const running = settle(f.run()); await started.promise; f.registry.clear(owner);
    const replacement = f.registry.get(owner, f.load); gate.resolve();
    const result = await running; assert.ok(['USER_DB_REPLACED', 'MESSAGE_COMMIT_UNKNOWN'].includes(result.error?.code));
    assert.equal((await replacement).data.messages[0].id, 'fixed-id'); assert.equal(f.state.writes, 1);
    await assert.rejects(f.db.read(), error => error.code === 'USER_DB_REPLACED');
  });

  test(`${kind}: readonly composition and response objects are not shared DB references`, async t => {
    const f = await fixture(t, kind);
    const result = await f.run({ compose: ({ snapshot }) => { snapshot.profile.value = 99; return { readOnly: true, result: snapshot.profile }; } });
    assert.equal(result.disposition, 'existing'); assert.equal(result.result.value, 99); assert.equal(f.db.data.profile.value, 1); assert.equal(f.state.writes, 0);
  });
}

for (const kind of kinds.slice(1)) {
  test(`${kind}: two CAS rebuilds use the same fixed intent and reauthorize each fresh baseline`, async t => {
    const f = await fixture(t, kind), seen = []; let modelCalls = 0;
    const prepared = (() => { modelCalls++; return intent(); })();
    f.state.hooks.before = async () => { if (f.state.writes <= 2) { const newer = await f.durable(); newer.profile.value++; await f.external(newer); } };
    const result = await f.run({ prepared, authorize: async args => { seen.push([args.attempt, args.snapshot.profile.value, clone(args.prepared)]); } });
    assert.equal(result.disposition, 'committed'); assert.equal(f.state.writes, 3); assert.equal(modelCalls, 1);
    assert.deepEqual(seen.map(row => row.slice(0, 2)), [[0, 1], [1, 2], [2, 3]]);
    assert.ok(seen.every(row => JSON.stringify(row[2]) === JSON.stringify(intent()))); assert.equal((await f.durable()).profile.value, 3);
    assert.equal((await f.durable()).messages.length, 1);
  });

  test(`${kind}: third explicit CAS conflict is terminal, not a fourth write or unknown`, async t => {
    const f = await fixture(t, kind); let checks = 0;
    f.state.hooks.before = async () => { await f.external(await f.durable()); };
    await assert.rejects(f.run({ authorize: async () => { checks++; } }), error => error.code === 'REVISION_CONFLICT');
    assert.equal(f.state.writes, 3); assert.equal(checks, 3); assert.equal((await f.durable()).messages.length, 0);
    f.state.hooks = {}; await f.db.read({ force: true });
  });

  test(`${kind}: source revoked in CAS race stops before a second write`, async t => {
    const f = await fixture(t, kind);
    f.state.hooks.before = async () => { const newer = await f.durable(); newer.sourceAllowed = false; await f.external(newer); };
    await assert.rejects(f.run({ authorize: async ({ snapshot }) => { if (!snapshot.sourceAllowed) throw fault('SOURCE_NOT_FOUND', 404); } }), error => error.code === 'SOURCE_NOT_FOUND');
    assert.equal(f.state.writes, 1); assert.equal((await f.durable()).messages.length, 0);
  });
}

test('synchronous callbacks cannot return promises or mutate the frozen prepared intent', async t => {
  const f = await fixture(t, kinds[0]);
  await assert.rejects(f.run({ compose: async args => compose(args) }), error => error.code === 'ASYNC_COMMIT_CALLBACK');
  await assert.rejects(f.run({ compose: ({ prepared }) => { prepared.message.id = 'mutated'; } }), TypeError);
  assert.equal(f.state.writes, 0); await f.db.read({ force: true });
});

for (const kind of kinds) test(`${kind}: registry retirement after readonly callback but before outer lock resolution suppresses prior result`, async t => {
  const f = await fixture(t, kind);
  await assert.rejects(f.run({ compose: () => {
    queueMicrotask(() => f.registry.clear(owner));
    return { readOnly: true, result: { private: 'prior receipt' } };
  } }), error => error.code === 'USER_DB_REPLACED');
  assert.equal(f.state.writes, 0);
});

for (const kind of kinds) {
  test(`${kind}: two queued commits serialize detached snapshots and never lose the other message`, async t => {
    const f = await fixture(t, kind), started = deferred(), gate = deferred();
    f.state.hooks.before = async () => { if (f.state.writes === 1) { started.resolve(); await gate.promise; } };
    const first = f.run(); await started.promise;
    const secondIntent = intent(); secondIntent.message.id = 'second-fixed-id'; secondIntent.creationIntentHash = 'b'.repeat(64);
    const second = f.run({ prepared: secondIntent }); await turn(); assert.equal(f.state.writes, 1);
    gate.resolve(); const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(row => row.result.server_order.sequence), ['1', '2']);
    assert.deepEqual((await f.durable()).messages.map(row => row.id), ['fixed-id', 'second-fixed-id']);
  });

  test(`${kind}: missing authority on initial force read fails before compose or write`, async t => {
    const f = await fixture(t, kind); let composed = false;
    f.state.hooks.read = row => ({ ...row, data: { ...seed(), message_order: undefined } });
    await assert.rejects(f.run({ compose: () => { composed = true; } }), error => error.code === 'MESSAGE_ORDER_UNAVAILABLE');
    assert.equal(composed, false); assert.equal(f.state.writes, 0);
    f.state.hooks = {}; await f.db.read({ force: true });
  });

  test(`${kind}: an asynchronous confirm is never treated as a recovered receipt`, async t => {
    const f = await fixture(t, kind); f.state.hooks.after = () => { throw fault('SYNTHETIC_LOST_ACK'); };
    await assert.rejects(f.run({ confirm: () => Promise.resolve({ confirmed: true, result: 'false success' }) }), error => error.code === 'ASYNC_COMMIT_CALLBACK');
    assert.equal(f.state.writes, 1); f.state.hooks = {}; await f.db.read({ force: true });
  });
}
