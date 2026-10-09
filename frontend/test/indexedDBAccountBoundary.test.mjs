import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const compiled = await build({ entryPoints: [resolve(import.meta.dirname, '../src/utils/indexedDB.ts')], bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'import.meta.env.DEV': 'false' } });
let moduleId = 0;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const message = (id = 'private-message', group = 'shared-group', created = '2026-10-01T00:00:00Z') => ({ id, group_id: group, content: id, created_at: created });
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
afterEach(() => { if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB); else delete globalThis.indexedDB; });

// Deterministic event driver for the real helper module, not a mock of the helper.
// Commit applies staged writes; request success alone never changes durable data.
class Request {
  result;
  error = null;
  fire(type) { this[`on${type}`]?.({ target: this, type }); }
  succeed(result) { this.result = result; this.fire('success'); }
  fail(error = new DOMException('Synthetic failure', 'UnknownError')) { this.error = error; this.fire('error'); }
}
class Transaction {
  requests = [];
  staged = [];
  error = null;
  aborted = false;
  committed = false;
  constructor(db, mode) { this.db = db; this.mode = mode; }
  request(kind, key) { const request = new Request(); Object.assign(request, { kind, key }); this.requests.push(request); return request; }
  objectStore() {
    const tx = this;
    return {
      put(value) { if (tx.db.putError) throw tx.db.putError; tx.staged.push(['put', structuredClone(value)]); return tx.request('put', value.id); },
      delete(key) { tx.staged.push(['delete', key]); return tx.request('delete', key); },
      index() { return { getAll(key) { return tx.request('getAll', key); }, openCursor(key) { return tx.request('cursor', key); } }; },
    };
  }
  complete() { assert.equal(this.aborted, false, 'an aborted transaction cannot commit'); for (const [kind, value] of this.staged) kind === 'put' ? this.db.data.set(value.id, value) : this.db.data.delete(value); this.committed = true; this.oncomplete?.(); }
  abort() { if (this.committed) throw new DOMException('Already complete', 'InvalidStateError'); this.aborted = true; queueMicrotask(() => this.onabort?.()); }
  fail(error = new DOMException('Synthetic transaction failure', 'QuotaExceededError')) { this.error = error; this.onerror?.(); this.abort(); }
  read(index = 0) { const request = this.requests[index]; request.succeed([...this.db.data.values()].filter(value => value.group_id === request.key).map(value => structuredClone(value))); }
  cursorAll() { const request = this.requests.find(value => value.kind === 'cursor'); for (const value of this.db.data.values()) { if (value.group_id === request.key) request.succeed({ delete: () => { this.staged.push(['delete', value.id]); }, continue: () => {} }); } request.succeed(null); }
}
class Database {
  transactions = [];
  data = new Map();
  closed = false;
  created = [];
  objectStoreNames = { contains: () => true };
  constructor(name) { this.name = name; }
  close() { this.closed = true; }
  transaction(_name, mode) { if (this.closed) throw new DOMException('Closed', 'InvalidStateError'); const tx = new Transaction(this, mode); this.transactions.push(tx); return tx; }
  createObjectStore(name) { this.created.push(name); return { createIndex() {} }; }
}
class Factory {
  opens = [];
  deletes = [];
  databases = new Map();
  open(name, version) { const request = new Request(); Object.assign(request, { name, version }); this.opens.push(request); return request; }
  deleteDatabase(name) { const request = new Request(); request.name = name; const succeed = request.succeed.bind(request); request.succeed = result => { this.databases.delete(name); succeed(result); }; this.deletes.push(request); return request; }
  succeed(index = this.opens.length - 1) { const request = this.opens[index]; const db = new Database(request.name); if (!this.databases.has(request.name)) this.databases.set(request.name, new Map()); db.data = this.databases.get(request.name); request.succeed(db); return db; }
  upgrade(index = this.opens.length - 1) { const request = this.opens[index]; const db = new Database(request.name); db.objectStoreNames = { contains: () => false }; request.result = db; request.transaction = new Transaction(db, 'versionchange'); request.fire('upgradeneeded'); return { db, tx: request.transaction }; }
}
async function setup(available = true) {
  const factory = new Factory(); Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: available ? factory : undefined });
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + `\n// fixture ${++moduleId}`).toString('base64')}`);
  const errors = []; module.onStorageError((operation, error) => errors.push({ operation, error }));
  return { ...module, factory, errors };
}

// Regression reproduction: B's next write used the late A handle in the original helper.
test('late A open cannot replace B handle or accept obsolete A writes', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice');
  const oldSave = api.saveMessagesToIndexedDB([message('alice-private')]);
  api.setIndexedDBUserId('bob'); const firstB = api.saveMessagesToIndexedDB([message('bob-one')]);
  const bob = api.factory.succeed(1); await flush(); bob.transactions[0].complete(); assert.equal(await firstB, true);
  const alice = api.factory.succeed(0); await flush();
  assert.equal(alice.closed, true); assert.equal(alice.transactions.length, 0); assert.equal(await oldSave, false);
  const nextB = api.saveMessagesToIndexedDB([message('bob-two')]); await flush();
  assert.equal(bob.transactions.length, 2); bob.transactions[1].complete(); assert.equal(await nextB, true);
  assert.deepEqual([...bob.data.keys()], ['bob-one', 'bob-two']); assert.equal(alice.data.size, 0);
});
test('in-memory fallback is separated by account, including guest', async () => {
  const api = await setup(false); api.setIndexedDBUserId('alice'); await api.saveMessagesToIndexedDB([message('alice')]);
  api.setIndexedDBUserId('bob'); assert.deepEqual(await api.loadMessagesFromIndexedDB('shared-group'), []);
  await api.saveMessagesToIndexedDB([message('bob')]); api.setIndexedDBUserId(null); assert.deepEqual(await api.loadMessagesFromIndexedDB('shared-group'), []);
  api.setIndexedDBUserId('alice'); assert.deepEqual((await api.loadMessagesFromIndexedDB('shared-group')).map(value => value.id), ['alice']);
});
test('group clear waits for transaction commit, not cursor exhaustion', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice');
  let settled = false; const pending = api.clearAllMessagesFromIndexedDB('shared-group').then(result => { settled = true; return result; });
  const db = api.factory.succeed(); db.data.set('one', message('one')); await flush(); const tx = db.transactions[0]; tx.cursorAll(); await flush();
  assert.equal(settled, false); assert.equal(db.data.size, 1); tx.complete(); assert.equal(await pending, true); assert.equal(db.data.size, 0);
});

async function connect(api, user = 'alice', messages = [message('seed')]) {
  api.setIndexedDBUserId(user); const pending = api.saveMessagesToIndexedDB(messages);
  const db = api.factory.succeed(); await flush(); db.transactions.at(-1).complete(); assert.equal(await pending, true); return db;
}

test('concurrent first operations share exactly one opening and use separate transactions', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice');
  const saving = api.saveMessagesToIndexedDB([message()]); const loading = api.loadMessagesFromIndexedDB('shared-group');
  assert.equal(api.factory.opens.length, 1); const db = api.factory.succeed(); await flush();
  assert.equal(db.transactions.length, 2); db.transactions[0].complete(); db.transactions[1].read(); db.transactions[1].complete();
  assert.equal(await saving, true); assert.deepEqual(await loading, [message()]);
});
test('A-B-A cancels an old open immediately and never revives it in a same-account session', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const obsolete = api.saveMessagesToIndexedDB([message('obsolete')]);
  api.setIndexedDBUserId('bob'); api.setIndexedDBUserId('alice'); assert.equal(await obsolete, false);
  const fresh = api.saveMessagesToIndexedDB([message('fresh')]); const current = api.factory.succeed(1); await flush(); current.transactions[0].complete(); assert.equal(await fresh, true);
  const old = api.factory.succeed(0); await flush(); assert.equal(old.closed, true); assert.equal(old.transactions.length, 0);
  const loading = api.loadMessagesFromIndexedDB('shared-group'); await flush(); current.transactions[1].read(); current.transactions[1].complete(); assert.deepEqual((await loading).map(value => value.id), ['fresh']);
  assert.deepEqual(api.errors, []);
});
test('account replacement after an open promise resolves prevents starting its transaction', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const pending = api.saveMessagesToIndexedDB([message('old')]);
  const db = api.factory.succeed(); api.setIndexedDBUserId('bob'); assert.equal(await pending, false); assert.equal(db.transactions.length, 0);
});
test('A-B-A aborts pending writes and late transaction completions cannot report success', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const pending = api.saveMessagesToIndexedDB([message('old')]);
  const db = api.factory.succeed(); await flush(); const tx = db.transactions[0];
  api.setIndexedDBUserId('bob'); api.setIndexedDBUserId('alice'); assert.equal(tx.aborted, true); assert.equal(await pending, false); assert.equal(db.data.size, 0);
  tx.oncomplete?.(); assert.equal(await pending, false); assert.deepEqual(api.errors, []);
});
test('late close and error callbacks from A never discard B connection', async () => {
  const api = await setup(); const alice = await connect(api); const bob = await connect(api, 'bob');
  alice.onclose?.(); alice.onerror?.(); alice.onversionchange?.();
  const pending = api.saveMessagesToIndexedDB([message('new-b')]); await flush(); assert.equal(api.factory.opens.length, 2); assert.equal(bob.closed, false); bob.transactions.at(-1).complete(); assert.equal(await pending, true);
});
test('unexpected close retires the matching connection and aborts only its active work', async () => {
  const api = await setup(); const db = await connect(api); const pending = api.saveMessagesToIndexedDB([message('not-committed')]); await flush();
  db.onclose?.(); assert.equal(await pending, false); assert.equal(db.transactions[1].aborted, true);
  const next = api.saveMessagesToIndexedDB([message('recovered')]); const newDb = api.factory.succeed(); await flush(); newDb.transactions[0].complete(); assert.equal(await next, true);
  assert.deepEqual([...newDb.data.keys()], ['seed', 'recovered']);
});
test('versionchange closes our handle for another tab and fences pending reads', async () => {
  const api = await setup(); const db = await connect(api); const pending = api.loadMessagesFromIndexedDB('shared-group'); await flush();
  db.transactions[1].read(); db.onversionchange?.(); assert.equal(db.closed, true); assert.deepEqual(await pending, []); assert.equal(db.transactions[1].aborted, true);
});
test('read request success cannot leak A data while transaction is pending across A-B-A', async () => {
  const api = await setup(); const db = await connect(api); const pending = api.loadMessagesFromIndexedDB('shared-group'); await flush();
  const tx = db.transactions[1]; tx.read(); api.setIndexedDBUserId('bob'); api.setIndexedDBUserId('alice');
  assert.deepEqual(await pending, []); assert.equal(tx.aborted, true); tx.oncomplete?.(); assert.deepEqual(await pending, []);
});
test('session changes between transaction complete and helper continuation suppress returned data', async () => {
  const api = await setup(); const db = await connect(api); const pending = api.loadMessagesFromIndexedDB('shared-group'); await flush();
  const tx = db.transactions[1]; tx.read(); tx.complete(); api.setIndexedDBUserId('bob'); assert.deepEqual(await pending, []);
});
test('stale upgrade is aborted without writing schema into the old account database', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const pending = api.saveMessagesToIndexedDB([message()]);
  api.setIndexedDBUserId('bob'); const { db, tx } = api.factory.upgrade(); assert.equal(tx.aborted, true); assert.deepEqual(db.created, []); assert.equal(await pending, false);
  api.factory.opens[0].fail(new DOMException('Upgrade cancelled', 'AbortError')); assert.deepEqual(api.errors, []);
});
test('fresh upgrade initializes its own store once, then writes only after open success', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const pending = api.saveMessagesToIndexedDB([message()]);
  const { db, tx } = api.factory.upgrade(); assert.deepEqual(db.created, ['messages']); assert.equal(tx.aborted, false); assert.equal(db.transactions.length, 0);
  api.factory.opens[0].succeed(db); await flush(); db.transactions[0].complete(); assert.equal(await pending, true);
});
test('open errors are observable and a subsequent operation can reopen', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const pending = api.saveMessagesToIndexedDB([message()]);
  const error = new DOMException('Synthetic denied storage', 'SecurityError'); api.factory.opens[0].fail(error); assert.equal(await pending, false); assert.deepEqual(api.errors.map(value => value.operation), ['save']); assert.equal(api.errors[0].error, error);
  const retry = api.saveMessagesToIndexedDB([message('retry')]); const db = api.factory.succeed(); await flush(); db.transactions[0].complete(); assert.equal(await retry, true);
});
test('synchronously thrown open fails without leaving a hung shared promise', async () => {
  const api = await setup(); api.factory.open = () => { throw new DOMException('Denied', 'SecurityError'); };
  assert.equal(await api.saveMessagesToIndexedDB([message()]), false); assert.deepEqual(await api.loadMessagesFromIndexedDB('shared-group'), []); assert.equal(api.errors.length, 2);
});
test('blocked open reports failure and its later success closes instead of replacing a newer handle', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const pending = api.saveMessagesToIndexedDB([message('blocked')]);
  api.factory.opens[0].fire('blocked'); assert.equal(await pending, false); assert.equal(api.errors.length, 1);
  const retry = api.saveMessagesToIndexedDB([message('retry')]); const db = api.factory.succeed(1); await flush(); db.transactions[0].complete(); assert.equal(await retry, true);
  const blockedDb = api.factory.succeed(0); assert.equal(blockedDb.closed, true); assert.equal(blockedDb.transactions.length, 0);
  const next = api.saveMessagesToIndexedDB([message('next')]); await flush(); db.transactions[1].complete(); assert.equal(await next, true);
});
test('a blocked open subsequently asked to upgrade aborts rather than silently mutating schema', async () => {
  const api = await setup(); const pending = api.saveMessagesToIndexedDB([message()]); api.factory.opens[0].fire('blocked'); assert.equal(await pending, false);
  const { db, tx } = api.factory.upgrade(); assert.equal(tx.aborted, true); assert.deepEqual(db.created, []);
});

for (const [operation, invoke, prepare] of [
  ['save', api => api.saveMessagesToIndexedDB([message('new')]), () => {}],
  ['delete_one', api => api.deleteMessageFromIndexedDB('seed'), () => {}],
  ['clear_all', api => api.clearAllMessagesFromIndexedDB('shared-group'), tx => tx.cursorAll()],
  ['clear_old', api => api.clearOldMessagesFromIndexedDB('shared-group', 0), tx => tx.read()],
  ['load', api => api.loadMessagesFromIndexedDB('shared-group'), tx => tx.read()],
]) {
  for (const failure of ['error', 'abort']) {
    test(`${operation} settles honestly on transaction ${failure}, with durable data unchanged`, async () => {
      const api = await setup(); const db = await connect(api); const pending = invoke(api); await flush(); const tx = db.transactions[1]; prepare(tx);
      if (failure === 'error') tx.fail(); else tx.abort();
      assert.deepEqual(await pending, operation === 'load' ? [] : false); assert.deepEqual([...db.data.keys()], ['seed']); assert.deepEqual(api.errors.map(value => value.operation), [operation]);
    });
  }
}
test('synchronous batch put failure aborts earlier staged writes atomically', async () => {
  const api = await setup(); const db = await connect(api);
  const originalTransaction = db.transaction.bind(db); db.transaction = (...args) => { const tx = originalTransaction(...args); const originalStore = tx.objectStore.bind(tx); tx.objectStore = () => { const store = originalStore(); const put = store.put; let count = 0; store.put = value => { if (++count === 2) throw new DOMException('Cannot clone', 'DataCloneError'); return put(value); }; return store; }; return tx; };
  assert.equal(await api.saveMessagesToIndexedDB([message('first'), message('bad')]), false); assert.equal(db.transactions[1].aborted, true); assert.deepEqual([...db.data.keys()], ['seed']);
});
test('single transaction failure never invalidates unrelated concurrent transactions', async () => {
  const api = await setup(); const db = await connect(api); const bad = api.saveMessagesToIndexedDB([message('bad')]); const good = api.saveMessagesToIndexedDB([message('good')]); await flush();
  db.transactions[1].fail(); db.onerror?.(); db.transactions[2].complete(); assert.equal(await bad, false); assert.equal(await good, true); assert.equal(db.closed, false);
});
test('retention trims the requested group in transaction event and keeps newest zero or N correctly', async () => {
  const api = await setup(); const db = await connect(api, 'alice', [message('new', 'shared-group', '2026-10-03'), message('old', 'shared-group', '2026-10-01'), message('middle', 'shared-group', '2026-10-02'), message('other', 'elsewhere')]);
  const pending = api.clearOldMessagesFromIndexedDB('shared-group', 2); await flush(); const tx = db.transactions[1]; tx.read(); assert.deepEqual(tx.staged, [['delete', 'old']]); assert.equal(db.data.size, 4); tx.complete(); assert.equal(await pending, true);
  const all = api.clearOldMessagesFromIndexedDB('shared-group', 0); await flush(); db.transactions[2].read(); db.transactions[2].complete(); assert.equal(await all, true); assert.deepEqual([...db.data.keys()], ['other']);
});
test('invalid retention counts fail before opening or deleting any data', async () => {
  const api = await setup(); for (const count of [-1, 1.5, NaN, Infinity]) assert.equal(await api.clearOldMessagesFromIndexedDB('group', count), false); assert.equal(api.factory.opens.length, 0);
});
test('successful reads retain chronological newest 1000 and exclude other groups', async () => {
  const api = await setup(); const messages = Array.from({ length: 1002 }, (_, i) => message(`msg-${i}`, 'shared-group', new Date(i * 1000).toISOString())).reverse();
  const db = await connect(api, 'alice', [...messages, message('other', 'elsewhere')]); const pending = api.loadMessagesFromIndexedDB('shared-group'); await flush(); db.transactions[1].read(); db.transactions[1].complete();
  const found = await pending; assert.equal(found.length, 1000); assert.equal(found[0].id, 'msg-2'); assert.equal(found.at(-1).id, 'msg-1001');
});
test('account replacement cancels every destructive helper before pending open can mutate data', async () => {
  for (const invoke of [api => api.deleteMessageFromIndexedDB('seed'), api => api.clearOldMessagesFromIndexedDB('shared-group', 0), api => api.clearAllMessagesFromIndexedDB('shared-group')]) {
    const api = await setup(); api.setIndexedDBUserId('alice'); const pending = invoke(api); api.setIndexedDBUserId('bob'); assert.equal(await pending, false); const db = api.factory.succeed(); assert.equal(db.closed, true); assert.equal(db.transactions.length, 0);
  }
});
test('clear current DB cancels pending open; late success closes and cannot repopulate deleted data', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const save = api.saveMessagesToIndexedDB([message('old')]); const clear = api.clearAllIndexedDBForUser();
  assert.equal(await save, false); assert.equal(api.factory.deletes[0].name, 'ai-chat-group-alice'); assert.equal(await api.saveMessagesToIndexedDB([message('during-delete')]), false);
  const old = api.factory.succeed(); assert.equal(old.closed, true); assert.equal(old.transactions.length, 0); api.factory.deletes[0].succeed(); assert.equal(await clear, true);
  const retry = api.saveMessagesToIndexedDB([message('fresh')]); const fresh = api.factory.succeed(); await flush(); fresh.transactions[0].complete(); assert.equal(await retry, true); assert.deepEqual([...fresh.data.keys()], ['fresh']);
});
test('explicit cleanup of Alice never closes Bob or switches its write destination', async () => {
  const api = await setup(); const db = await connect(api, 'bob'); const saving = api.saveMessagesToIndexedDB([message('bob-new')]); await flush();
  const clear = api.clearAllIndexedDBForUser('alice'); assert.equal(db.closed, false); assert.equal(db.transactions[1].aborted, false); assert.equal(api.factory.deletes[0].name, 'ai-chat-group-alice');
  db.transactions[1].complete(); assert.equal(await saving, true); api.factory.deletes[0].succeed(); assert.equal(await clear, true); assert.equal(db.closed, false);
});
test('blocked deletion returns false, stays fenced through A-B-A, and never starts a retry', async () => {
  const api = await setup(); const alice = await connect(api); const clear = api.clearAllIndexedDBForUser('alice'); assert.equal(alice.closed, true);
  api.factory.deletes[0].fire('blocked'); assert.equal(await clear, false); assert.deepEqual(api.errors.map(value => value.operation), ['clear_user']);
  const bob = await connect(api, 'bob'); api.setIndexedDBUserId('alice'); assert.equal(await api.saveMessagesToIndexedDB([message('too-soon')]), false); assert.equal(await api.clearAllIndexedDBForUser('alice'), false); assert.equal(api.factory.deletes.length, 1);
  api.setIndexedDBUserId('bob'); api.factory.deletes[0].succeed(); assert.equal(await clear, false); assert.equal(bob.data.size, 1);
  const fresh = await connect(api, 'alice', [message('after-delete')]); assert.deepEqual([...fresh.data.keys()], ['after-delete']); assert.equal(api.factory.deletes.length, 1);
});
test('failed database deletion releases only its barrier and reports incomplete cleanup', async () => {
  const api = await setup(); await connect(api); const clear = api.clearAllIndexedDBForUser('alice'); const error = new DOMException('Denied delete', 'UnknownError'); api.factory.deletes[0].fail(error); assert.equal(await clear, false); assert.equal(api.errors.at(-1).error, error);
  const db = await connect(api, 'alice', [message('new')]); assert.deepEqual([...db.data.keys()], ['seed', 'new']);
});
test('synchronously thrown deletion cannot strand future operations behind its barrier', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); api.factory.deleteDatabase = () => { throw new DOMException('Denied delete', 'SecurityError'); };
  assert.equal(await api.clearAllIndexedDBForUser(), false); await connect(api);
});
test('concurrent delete requests share one pending operation and resolve only on actual success', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); let settled = false; const first = api.clearAllIndexedDBForUser('alice').then(result => { settled = true; return result; }); const second = api.clearAllIndexedDBForUser('alice');
  await flush(); assert.equal(settled, false); assert.equal(api.factory.deletes.length, 1); api.factory.deletes[0].succeed(); assert.equal(await first, true); assert.equal(await second, true);
});
test('fallback copies values, trims groups, and explicit cleanup affects only the named account', async () => {
  const api = await setup(false); api.setIndexedDBUserId('alice'); const value = message('alice'); await api.saveMessagesToIndexedDB([value]); value.content = 'caller-mutated';
  const loaded = await api.loadMessagesFromIndexedDB('shared-group'); assert.equal(loaded[0].content, 'alice'); loaded[0].content = 'reader-mutated'; assert.equal((await api.loadMessagesFromIndexedDB('shared-group'))[0].content, 'alice');
  api.setIndexedDBUserId('bob'); await api.saveMessagesToIndexedDB([message('bob-old', 'shared-group', '2026-10-01'), message('bob-new', 'shared-group', '2026-10-02'), message('bob-other', 'elsewhere')]);
  assert.equal(await api.clearAllIndexedDBForUser('alice'), false); assert.equal(await api.clearOldMessagesFromIndexedDB('shared-group', 1), true); assert.deepEqual((await api.loadMessagesFromIndexedDB('shared-group')).map(value => value.id), ['bob-new']);
  assert.equal(await api.deleteMessageFromIndexedDB('bob-new'), true); assert.deepEqual(await api.loadMessagesFromIndexedDB('shared-group'), []); assert.equal(await api.clearAllMessagesFromIndexedDB('elsewhere'), true); assert.deepEqual(await api.loadMessagesFromIndexedDB('elsewhere'), []);
  api.setIndexedDBUserId('alice'); assert.deepEqual(await api.loadMessagesFromIndexedDB('shared-group'), []);
});
test('fallback operation interrupted before its await resumes does not write into either account', async () => {
  const api = await setup(false); api.setIndexedDBUserId('alice'); const saving = api.saveMessagesToIndexedDB([message('obsolete')]); api.setIndexedDBUserId('bob'); assert.equal(await saving, false); api.setIndexedDBUserId('alice'); assert.deepEqual(await api.loadMessagesFromIndexedDB('shared-group'), []);
});
test('throwing storage-error subscribers do not hide the failure from other subscribers', async () => {
  const api = await setup(); const observed = []; const off = api.onStorageError(() => { throw new Error('subscriber failure'); }); api.onStorageError(operation => observed.push(operation));
  const pending = api.saveMessagesToIndexedDB([message()]); api.factory.opens[0].fail(); assert.equal(await pending, false); assert.deepEqual(observed, ['save']); off();
});

test('same-account assignment preserves the current connection, while later reentry retains only its data', async () => {
  const api = await setup(); const alice = await connect(api, 'alice', [message('alice-private')]); api.setIndexedDBUserId('alice'); assert.equal(alice.closed, false);
  const bob = await connect(api, 'bob', [message('bob-private')]); const pending = api.loadMessagesFromIndexedDB('shared-group'); await flush(); bob.transactions[1].read(); bob.transactions[1].complete(); assert.deepEqual((await pending).map(value => value.id), ['bob-private']);
  api.setIndexedDBUserId('alice'); const reentry = api.loadMessagesFromIndexedDB('shared-group'); const reopened = api.factory.succeed(); await flush(); reopened.transactions[0].read(); reopened.transactions[0].complete(); assert.deepEqual((await reentry).map(value => value.id), ['alice-private']);
});
for (const [operation, invoke] of [
  ['load', api => api.loadMessagesFromIndexedDB('shared-group')],
  ['clear_old', api => api.clearOldMessagesFromIndexedDB('shared-group', 0)],
  ['clear_all', api => api.clearAllMessagesFromIndexedDB('shared-group')],
]) {
  test(`${operation} request errors abort and settle without waiting for a missing complete event`, async () => {
    const api = await setup(); const db = await connect(api); const pending = invoke(api); await flush(); const tx = db.transactions[1]; tx.requests[0].fail();
    assert.deepEqual(await pending, operation === 'load' ? [] : false); assert.equal(tx.aborted, true); assert.deepEqual([...db.data.keys()], ['seed']); assert.equal(api.errors.at(-1).operation, operation);
  });
}
test('schema creation failure aborts the upgrade and reports the original error', async () => {
  const api = await setup(); const pending = api.saveMessagesToIndexedDB([message()]); const request = api.factory.opens[0]; const db = new Database(request.name); db.objectStoreNames = { contains: () => false };
  const error = new DOMException('Schema failure', 'UnknownError'); db.createObjectStore = () => { throw error; }; request.result = db; request.transaction = new Transaction(db, 'versionchange'); request.fire('upgradeneeded');
  assert.equal(await pending, false); assert.equal(request.transaction.aborted, true); assert.equal(api.errors[0].error, error);
});
test('transaction creation failure is returned without destroying a subsequently usable connection', async () => {
  const api = await setup(); const db = await connect(api); const original = db.transaction.bind(db); db.transaction = () => { throw new DOMException('Temporarily unavailable', 'InvalidStateError'); };
  assert.equal(await api.deleteMessageFromIndexedDB('seed'), false); db.transaction = original; const retry = api.deleteMessageFromIndexedDB('seed'); await flush(); db.transactions[1].complete(); assert.equal(await retry, true); assert.equal(db.data.size, 0);
});
test('clearing the active user aborts all uncommitted operations before deleting the database', async () => {
  const api = await setup(); const db = await connect(api); const saving = api.saveMessagesToIndexedDB([message('must-not-commit')]); const loading = api.loadMessagesFromIndexedDB('shared-group'); await flush(); db.transactions[2].read();
  const clearing = api.clearAllIndexedDBForUser(); assert.equal(await saving, false); assert.deepEqual(await loading, []); assert.equal(db.transactions[1].aborted, true); assert.equal(db.transactions[2].aborted, true);
  api.factory.deletes[0].succeed(); assert.equal(await clearing, true);
});
test('blocked deletion ending in an error releases the fence without claiming deletion', async () => {
  const api = await setup(); await connect(api); const clearing = api.clearAllIndexedDBForUser(); api.factory.deletes[0].fire('blocked'); assert.equal(await clearing, false); api.factory.deletes[0].fail();
  const db = await connect(api, 'alice', [message('new')]); assert.deepEqual([...db.data.keys()], ['seed', 'new']); assert.equal(await clearing, false);
});
test('late old-account open errors do not emit failure into the new account', async () => {
  const api = await setup(); api.setIndexedDBUserId('alice'); const saving = api.saveMessagesToIndexedDB([message()]); api.setIndexedDBUserId('bob'); api.factory.opens[0].fail(); assert.equal(await saving, false); assert.deepEqual(api.errors, []);
});


test('unavailable IndexedDB cannot produce a false affirmative receipt for persistent database deletion', async () => {
  const api = await setup(); const db = await connect(api); globalThis.indexedDB = undefined;
  assert.equal(await api.clearAllIndexedDBForUser('alice'), false); assert.equal(db.closed, true); assert.deepEqual([...db.data.keys()], ['seed']); assert.equal(api.errors.at(-1).operation, 'clear_user');
});

test('save freezes message values before a delayed open permits later mutation', async () => {
  const api=await setup();api.setIndexedDBUserId('alice');const rows=[message('original')];const pending=api.saveMessagesToIndexedDB(rows);rows[0].content='changed-after-call';rows.push(message('not-in-original-intent'));
  const db=api.factory.succeed();await flush();db.transactions[0].complete();assert.equal(await pending,true);assert.equal(db.data.get('original').content,'original');assert.equal(db.data.has('not-in-original-intent'),false);
});
for(const native of [false,true])test(`${native?'native':'fallback'} retention never prunes or hides unconfirmed local drafts`,async()=>{
  const api=await setup(native);const rows=[{...message('old-failed','shared-group','2020-01-01'),status:'failed'},{...message('old-sending','shared-group','2020-01-02'),status:'sending'},...Array.from({length:1001},(_,i)=>message(`sent-${i}`,'shared-group',new Date(1700000000000+i*1000).toISOString()))];let db;
  if(native)db=await connect(api,'alice',rows);else{api.setIndexedDBUserId('alice');await api.saveMessagesToIndexedDB(rows);}
  let loading=api.loadMessagesFromIndexedDB('shared-group');if(native){await flush();db.transactions.at(-1).read();db.transactions.at(-1).complete();}let loaded=await loading;assert.equal(loaded.length,1002);assert.ok(loaded.some(row=>row.id==='old-failed'));assert.ok(loaded.some(row=>row.id==='old-sending'));
  const trimming=api.clearOldMessagesFromIndexedDB('shared-group',0);if(native){await flush();db.transactions.at(-1).read();db.transactions.at(-1).complete();}assert.equal(await trimming,true);
  loading=api.loadMessagesFromIndexedDB('shared-group');if(native){await flush();db.transactions.at(-1).read();db.transactions.at(-1).complete();}loaded=await loading;assert.deepEqual(loaded.map(row=>row.id),['old-failed','old-sending']);
});
