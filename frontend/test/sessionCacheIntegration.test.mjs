import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Uses real stores, Axios, cache utilities and IndexedDB helper. Browser storage
// events and transport are deterministic fixtures, not native-browser coverage.
const root = process.env.QUNTHINK_FRONTEND_ROOT || resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'package.json'));
const { build } = require('esbuild');
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href);
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

class AutoFactory extends Factory {
  holdWrites = false;
  held = [];
  complete(tx) {
    if (tx.aborted) return;
    for (let i = 0; i < tx.requests.length; i++) {
      if (tx.requests[i].kind === 'getAll') tx.read(i);
      else if (tx.requests[i].kind === 'cursor') tx.cursorAll();
    }
    if (!tx.aborted) tx.complete();
  }
  releaseHeld() { for (const tx of this.held.splice(0)) this.complete(tx); }
  open(name, version) {
    const request = super.open(name, version), index = this.opens.length - 1;
    setTimeout(() => {
      const db = this.succeed(index), native = db.transaction.bind(db);
      db.transaction = (...args) => {
        const tx = native(...args);
        setTimeout(() => {
          if (this.holdWrites && args[1] === 'readwrite') this.held.push(tx);
          else this.complete(tx);
        }, 0);
        return tx;
      };
    }, 0);
    return request;
  }
  deleteDatabase(name) { const request = super.deleteDatabase(name); setTimeout(() => request.succeed(), 0); return request; }
}


const bundled = await build({
  stdin: { contents: `
    import * as api from './src/services/api';
    import * as ws from './src/services/websocket';
    import * as idb from './src/utils/indexedDB';
    import * as cache from './src/utils/cacheUtils';
    import * as privateCache from './src/utils/privateCache';
    import { useMessagesStore as messages, resetMessagesModuleState } from './src/stores/messagesStore';
    import { useGroupsStore as groups } from './src/stores/groupsStore';
    globalThis.__sessionIntegration = { api, ws, idb, cache, privateCache, messages, groups, resetMessagesModuleState };
  `, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'iife', platform: 'browser', write: false,
  define: { 'import.meta.env': JSON.stringify({ DEV: false, MODE: 'test', VITE_AUTH_MODE: 'session', VITE_BACKEND_URL: 'http://synthetic.test' }) },
});
let activeWindow, application;
afterEach(() => {
  application?.ws.destroyWebSocket();
  application?.resetMessagesModuleState();
  activeWindow?.close();
  delete globalThis.indexedDB;
});
function fixture() {
  activeWindow = new Window({ url: 'http://synthetic.test/' });
  // Encryption/key provisioning is outside this message-cache boundary test.
  Object.defineProperty(activeWindow, 'crypto', { configurable: true, value: { randomUUID: crypto.randomUUID.bind(crypto) } });
  Object.assign(globalThis, { window: activeWindow, document: activeWindow.document, localStorage: activeWindow.localStorage,
    Storage: activeWindow.Storage, HTMLElement: activeWindow.HTMLElement, CustomEvent: activeWindow.CustomEvent });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: activeWindow.navigator });
  globalThis.indexedDB = new AutoFactory();
  globalThis.caches = { delete: async () => true };
  (0, eval)(bundled.outputFiles[0].text);
  application = globalThis.__sessionIntegration;
  document.cookie = 'XSRF-TOKEN=synthetic';
  return application;
}
function switchTo(app, user) {
  app.cache.setCacheUserId(user); app.idb.setIndexedDBUserId(user); app.api.confirmAuthIdentity(user);
  app.resetMessagesModuleState(); app.messages.setState({ messages: {}, pagination: {}, loading: false, sending: {}, error: null });
}
const row = (id, created_at = '2026-10-04T00:00:00Z', extra = {}) => ({ id, group_id: 'g', content: id, sender_type: 'user', sender_id: 'user', content_type: 'text', created_at, status: 'sent', ...extra });
const response = (config, data) => ({ config, data, status: 200, statusText: 'OK', headers: {} });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw new Error('Fixture did not settle'); await sleep(5); } }
class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3; static current;
  constructor() { this.readyState = 0; Socket.current = this; }
  send() {} close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
}

test('real socket/store first-page reconciliation does not tombstone pageable cached history', async () => {
  const app = fixture(); switchTo(app, 'alice');
  const old = row('old', '2026-10-01T00:00:00Z'), latest = row('latest');
  assert.equal(await app.idb.saveMessagesToIndexedDB([old, latest]), true);
  const group = { id: 'g', name: 'g', members: [] };
  app.groups.setState({ groups: [group], currentGroup: null });
  const requests = [];
  app.api.axiosInstance.defaults.adapter = async config => {
    requests.push(config);
    const data = config.url === '/groups/g/messages'
      ? (config.params?.before ? { messages: [old], hasMore: false } : { messages: [latest], hasMore: true })
      : config.url === '/groups' ? [group] : { personas: {} };
    return response(config, data);
  };
  globalThis.WebSocket = Socket; app.ws.connectWebSocket(); Socket.current.open();
  await until(() => app.messages.getState().pagination.g);
  await app.messages.getState().loadMoreMessages('g');
  assert.deepEqual(app.messages.getState().messages.g.map(item => item.id), ['old', 'latest']);
  assert.equal(requests.at(-1).params.before, latest.created_at);
});

test('real Axios public invocation forms freeze ownership before the first interceptor microtask', async () => {
  const app = fixture(); let sent = 0;
  app.api.axiosInstance.defaults.adapter = async config => { sent++; return response(config, {}); };
  const calls = [
    () => app.api.axiosInstance.get('/private'),
    () => app.api.axiosInstance.post('/private', { content: 'alice-private' }),
    () => app.api.axiosInstance.request('/private'),
    () => app.api.axiosInstance({ url: '/private' }),
    () => app.api.axiosInstance.delete('/private'),
  ];
  for (const call of calls) {
    switchTo(app, 'alice'); const pending = call(); switchTo(app, 'bob');
    await assert.rejects(pending, error => error.code === 'STALE_ACCOUNT_RESPONSE');
  }
  assert.equal(sent, 0);
});

test('real send intent/cache continuation cannot issue an API request for a newer account', async () => {
  const app = fixture(); switchTo(app, 'alice'); let sent = 0;
  app.api.axiosInstance.defaults.adapter = async config => { sent++; return response(config, row('unexpected')); };
  const pending = app.messages.getState().sendMessage('g', 'alice-private');
  switchTo(app, 'bob');
  assert.equal((await pending).success, false); assert.equal(sent, 0);
  assert.deepEqual(app.messages.getState().messages, {});
  assert.deepEqual(await app.idb.loadMessagesFromIndexedDB('g'), []);
});

test('real private-cache cleanup fails if localStorage refuses a user-owned key deletion', async () => {
  const app = fixture(); switchTo(app, 'alice'); const key = 'app_cache_alice_messages_cache';
  localStorage.setItem(key, 'synthetic-private-cache');
  const native = globalThis.localStorage;
  globalThis.localStorage = new Proxy(native, { get(target, prop) {
    if (prop === 'removeItem') return name => { if (name === key) throw new DOMException('Synthetic blocked deletion', 'SecurityError'); return target.removeItem(name); };
    const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await assert.rejects(app.privateCache.clearCurrentUserCache(), error => error.code === 'CACHE_CLEAR_INCOMPLETE');
    assert.equal(localStorage.getItem(key), 'synthetic-private-cache');
  } finally { globalThis.localStorage = native; }
});

test('explicit cleanup invalidates old cache timers but allows later user edits to persist', async () => {
  const app = fixture(); switchTo(app, 'alice');
  app.messages.getState().addMessage('g', row('queued-private'));
  await app.privateCache.clearCurrentUserCache();
  assert.deepEqual(await app.idb.loadMessagesFromIndexedDB('g'), []);
  await sleep(2200);
  assert.deepEqual(await app.idb.loadMessagesFromIndexedDB('g'), []);
  app.messages.getState().updateMessage('queued-private', 'g', { content: 'new authorized edit' });
  await sleep(2200);
  assert.equal((await app.idb.loadMessagesFromIndexedDB('g'))[0].content, 'new authorized edit');
});

test('ownerless legacy cache cannot be assigned to the next account or silently erased', async () => {
  const app = fixture(); const oldKey = 'app_cache_messages_cache';
  const raw = JSON.stringify({ version: '1.0', timestamp: Date.now(), data: { g: [row('alice-unconfirmed', undefined, { status: 'failed' })] } });
  localStorage.setItem(oldKey, raw); app.cache.setCacheUserId('bob');
  assert.equal(await app.cache.loadMessagesCacheAsync(), null);
  assert.equal(localStorage.getItem(oldKey), raw);
  assert.equal(localStorage.getItem('app_cache_bob_messages_cache'), null);
});

test('real IndexedDB helper copies caller values before its opening await', async () => {
  const app = fixture(); switchTo(app, 'alice'); const original = row('copy', undefined, { metadata: { private: 'original' } });
  const pending = app.idb.saveMessagesToIndexedDB([original]); original.content = 'mutated'; original.metadata.private = 'mutated';
  assert.equal(await pending, true);
  const loaded = await app.idb.loadMessagesFromIndexedDB('g');
  assert.equal(loaded[0].content, 'copy'); assert.equal(loaded[0].metadata.private, 'original');
});


test('explicit cleanup retires an active helper write and its queued source-delete work', async () => {
  const app = fixture(); switchTo(app, 'alice');
  const factory = globalThis.indexedDB;
  await app.idb.saveMessagesToIndexedDB([row('source')]);
  app.messages.getState().addMessage('g', row('source'));
  factory.holdWrites = true;
  app.api.axiosInstance.defaults.adapter = async config => response(config, row('server-ack'));
  const sending = app.messages.getState().sendMessage('g', 'synthetic draft');
  await until(() => factory.held.length > 0);
  const oldWrite = factory.held[0];
  app.messages.getState().removeMessages('g', ['source']);
  await app.privateCache.clearCurrentUserCache();
  assert.equal(oldWrite.aborted, true);
  factory.holdWrites = false; factory.releaseHeld();
  await sending;
  await app.idb.saveMessagesToIndexedDB([row('source', undefined, { content: 'created after explicit cleanup' })]);
  await sleep(25);
  assert.equal((await app.idb.loadMessagesFromIndexedDB('g')).find(item => item.id === 'source').content, 'created after explicit cleanup');
  const sourceDeletes = factory.opens.flatMap(request => request.result?.transactions || []).flatMap(tx => tx.staged).filter(([kind, id]) => kind === 'delete' && id === 'source');
  assert.deepEqual(sourceDeletes, []);
});
