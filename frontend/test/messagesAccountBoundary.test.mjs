import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const io = globalThis.__messagesTest = { user: 'alice', generation: 0, timers: new Map(), nextTimer: 0 };
const result = await build({
  entryPoints: [resolve(import.meta.dirname, '../src/stores/messagesStore.ts')], bundle: true,
  format: 'esm', platform: 'browser', write: false,
  define: { 'import.meta.env.DEV': 'false', setTimeout: '__messagesTest.setTimeout', clearTimeout: '__messagesTest.clearTimeout', 'console.error': '__messagesTest.logError' },
  plugins: [{ name: 'message-io', setup(build) {
    build.onResolve({ filter: /(?:services\/api|utils\/(?:indexedDB|cacheUtils)|stores\/(?:groupsStore|audioStore)|\.\/(?:groupsStore|audioStore))$/ }, ({ path }) => ({ path, namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents:
      path.endsWith('/api') ? `export const getAuthGeneration = () => __messagesTest.generation; export const api = new Proxy({}, {get: (_, name) => (...args) => { __messagesTest.calls.push({name, user: __messagesTest.user, args}); return __messagesTest.api[name](...args); }});` :
      path.endsWith('/cacheUtils') ? `export const getCacheUserId = () => __messagesTest.user;` :
      path.endsWith('/indexedDB') ? ['saveMessagesToIndexedDB', 'loadMessagesFromIndexedDB', 'deleteMessageFromIndexedDB', 'clearAllMessagesFromIndexedDB', 'clearOldMessagesFromIndexedDB'].map(name => `export const ${name} = (...args) => { __messagesTest.storage.push({name:'${name}', user:__messagesTest.user, args}); return __messagesTest.db['${name}'](...args); };`).join('\n') :
      path.endsWith('/groupsStore') ? `export const useGroupsStore = {getState: () => ({currentGroup: {id: 'g'}})};` :
      `export const useAudioStore = {getState: () => ({removeTTSAudio: id => __messagesTest.audio.push(id)})};`
    }));
  } }]
});
const { useMessagesStore: store, resetMessagesModuleState: reset } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const message = (id, content = id, extra = {}) => ({ id, group_id: 'g', sender_type: 'user', sender_id: 'user', content, content_type: 'text', created_at: '2026-10-04T01:00:00.000Z', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const switchTo = (user, { cleanup = true } = {}) => { io.generation++; io.user = user; if (cleanup) reset(); store.setState({ messages: {}, pagination: {}, loading: false, sending: {}, error: null }); };
beforeEach(() => {
  reset(); io.user = 'alice'; io.generation++; io.calls = []; io.storage = []; io.audio = []; io.timers.clear(); io.logError = () => {}; 
  io.setTimeout = (fn, ms) => { const id = ++io.nextTimer; io.timers.set(id, { fn, ms }); return id; };
  io.clearTimeout = id => io.timers.delete(id);
  io.api = { getMessages: async () => ({ messages: [], hasMore: false }) };
  io.db = { loadMessagesFromIndexedDB: async () => [], saveMessagesToIndexedDB: async () => true, deleteMessageFromIndexedDB: async () => {}, clearAllMessagesFromIndexedDB: async () => {}, clearOldMessagesFromIndexedDB: async () => {} };
  store.setState({ messages: {}, pagination: {}, loading: false, sending: {}, error: null });
});

test('a cache read from A must not start an API call or hydrate B after account switch', async () => {
  const cached = deferred(); io.db.loadMessagesFromIndexedDB = () => cached.promise;
  const old = store.getState().fetchMessages('g'); switchTo('bob');
  cached.resolve([message('alice-secret')]); await old;
  assert.deepEqual(io.calls, []);
  assert.deepEqual(store.getState().messages, {});
  assert.equal(io.storage.filter(call => call.name !== 'loadMessagesFromIndexedDB').length, 0);
});

const runTimers = async ms => {
  for (const [id, timer] of [...io.timers]) if (timer.ms === ms) { io.timers.delete(id); timer.fn(); }
  await drain();
};
const rows = () => store.getState().messages.g || [];
const seed = (messages, hasMore = true) => store.setState({ messages: { g: messages }, pagination: { g: { hasMore, loadingMore: false, oldestMessageId: messages[0]?.id || null } } });

test('A→B→A auth generations reject an old cache callback without relying on cleanup', async () => {
  const cached = deferred(); io.db.loadMessagesFromIndexedDB = () => cached.promise;
  const old = store.getState().fetchMessages('g'); switchTo('bob', { cleanup: false }); switchTo('alice', { cleanup: false });
  cached.resolve([message('old-A')]); await old;
  assert.deepEqual(io.calls, []); assert.deepEqual(rows(), []);
});

test('old fetch completion cannot clear B deduplication or overwrite a B response', async () => {
  const oldResponse = deferred(), newResponse = deferred();
  io.api.getMessages = () => oldResponse.promise;
  const old = store.getState().fetchMessages('g'); await drain();
  switchTo('bob'); io.api.getMessages = () => newResponse.promise;
  const fresh = store.getState().fetchMessages('g'); await drain();
  oldResponse.resolve({ messages: [message('old-A')], hasMore: false }); await old;
  const duplicate = store.getState().fetchMessages('g'); await drain();
  assert.equal(io.calls.length, 2);
  newResponse.resolve({ messages: [message('B')], hasMore: false }); await Promise.all([fresh, duplicate]);
  assert.deepEqual(rows().map(row => row.id), ['B']);
  await runTimers(2000); assert.ok(io.storage.filter(call => call.name === 'saveMessagesToIndexedDB').every(call => call.user === 'bob' && call.args[0].every(row => row.id === 'B')));
});

test('module reset invalidates same-user in-flight work and the freshness clock', async () => {
  io.api.getMessages = async () => ({ messages: [message('first')], hasMore: false });
  await store.getState().fetchMessages('g'); reset();
  io.api.getMessages = async () => ({ messages: [message('second')], hasMore: false });
  await store.getState().fetchMessages('g');
  assert.equal(io.calls.length, 2); assert.deepEqual(rows().map(row => row.id), ['second']);
});

for (const rejects of [false, true]) test(`old pagination ${rejects ? 'failure' : 'receipt'} cannot mutate the new session`, async () => {
  seed([message('old-A')]); const page = deferred(); io.api.getMessages = () => page.promise;
  const old = store.getState().loadMoreMessages('g'); switchTo('bob'); seed([message('B')]);
  if (rejects) page.reject(new Error('A failed')); else page.resolve({ messages: [message('oldest-A')], hasMore: false });
  await old; assert.deepEqual(rows().map(row => row.id), ['B']); assert.equal(store.getState().error, null); assert.equal(store.getState().pagination.g.hasMore, true);
});

for (const rejects of [false, true]) test(`late A send ${rejects ? 'failure' : 'success'} cannot release B's send lock or write B's cache`, async () => {
  const a = deferred(), b = deferred(); io.api.sendMessage = () => a.promise;
  const old = store.getState().sendMessage('g', 'A secret'); await drain();
  switchTo('bob'); io.api.sendMessage = () => b.promise;
  const current = store.getState().sendMessage('g', 'B draft'); await drain();
  if (rejects) a.reject(new Error('A failed')); else a.resolve(message('A result'));
  assert.equal((await old).success, false);
  assert.equal(store.getState().sending.g, true);
  assert.equal((await store.getState().sendMessage('g', 'B duplicate')).success, false);
  assert.equal(io.calls.filter(call => call.name === 'sendMessage').length, 2);
  b.resolve(message('B result', 'B draft')); assert.equal((await current).success, true);
  assert.deepEqual(rows().map(row => row.content), ['B draft']);
  await runTimers(2000); assert.ok(io.storage.filter(call => call.name === 'saveMessagesToIndexedDB').every(call => call.args[0].every(row => call.user === 'alice' ? row.content === 'A secret' : row.content === 'B draft')));
});

test('delayed persistence and stream timers cannot start IO or update an A→B→A session', async () => {
  store.getState().addMessage('g', message('A cached'));
  store.getState().addStreamMessage('g', 'stream', 'ai');
  const oldTimers = [...io.timers.values()];
  switchTo('bob', { cleanup: false }); switchTo('alice', { cleanup: false }); seed([message('stream', 'new A', { is_streaming: true })]);
  for (const timer of oldTimers) timer.fn(); await drain();
  assert.equal(io.storage.length, 0); assert.equal(rows()[0].content, 'new A'); assert.equal(rows()[0].is_streaming, true);
});

test('a completed old cache save cannot begin cleanup as B', async () => {
  const save = deferred(); io.db.saveMessagesToIndexedDB = () => save.promise;
  store.getState().addMessage('g', message('A')); await runTimers(2000);
  switchTo('bob'); save.resolve(true); await drain();
  assert.deepEqual(io.storage.map(call => [call.name, call.user]), [['saveMessagesToIndexedDB', 'alice']]);
});

test('latest read preserves optimistic sends and live edits while deduplicating exact client receipts', async () => {
  seed([message('existing', 'original')]); const response = deferred(), send = deferred(); io.api.getMessages = () => response.promise; io.api.sendMessage = () => send.promise;
  const read = store.getState().fetchMessages('g'); await drain();
  store.getState().updateMessage('existing', 'g', { content: 'live edit' });
  const sending = store.getState().sendMessage('g', 'pending'); const tempId = rows().find(row => row.status === 'sending').tempId;
  response.resolve({ messages: [message('existing', 'stale'), message('other-tab', 'unrelated', { client_message_id: 'someone-else' }), message('server', 'pending', { client_message_id: tempId })], hasMore: false });
  await read;
  assert.equal(rows().find(row => row.id === 'existing').content, 'live edit');
  assert.equal(rows().filter(row => row.tempId === tempId).length, 1);
  assert.equal(rows().find(row => row.id === 'server').status, 'sent');
  send.resolve(message('server', 'pending', { client_message_id: tempId })); await sending;
  assert.equal(rows().filter(row => row.id === 'server').length, 1);
  assert.ok(rows().some(row => row.id === 'other-tab'));
});

test('a latest read never drops an unconfirmed optimistic send', async () => {
  const response = deferred(), send = deferred(); io.api.getMessages = () => response.promise; io.api.sendMessage = () => send.promise;
  const read = store.getState().fetchMessages('g'); await drain();
  const sending = store.getState().sendMessage('g', 'pending');
  response.resolve({ messages: [message('other', 'other', { client_message_id: 'other-client' })], hasMore: false }); await read;
  assert.equal(rows().filter(row => row.status === 'sending').length, 1);
  send.resolve(message('server')); await sending;
});

test('cached failed drafts survive refresh and retry reuses the original client ID', async () => {
  const draft = message('temp-retry', 'draft', { tempId: 'temp-retry', status: 'failed' });
  io.db.loadMessagesFromIndexedDB = async () => [draft]; io.api.getMessages = async () => ({ messages: [message('history')], hasMore: false });
  await store.getState().fetchMessages('g'); assert.equal(rows().find(row => row.tempId === draft.tempId).status, 'failed');
  io.api.sendMessage = async (...args) => message('delivered', args[1], { client_message_id: args[6] });
  assert.equal((await store.getState().retryMessage('g', draft.tempId)).success, true);
  assert.equal(io.calls.find(call => call.name === 'sendMessage').args[6], 'temp-retry');
  assert.equal((await store.getState().retryMessage('g', draft.tempId)).success, false);
  assert.equal(io.calls.filter(call => call.name === 'sendMessage').length, 1);
  await runTimers(2000); assert.ok(io.storage.filter(call => call.name === 'deleteMessageFromIndexedDB').every(call => call.args[0] === 'temp-retry'));
});

test('a WebSocket delivery confirmed before a failed HTTP receipt stays sent', async () => {
  const send = deferred(); io.api.sendMessage = () => send.promise;
  const pending = store.getState().sendMessage('g', 'draft'); await drain(); const tempId = rows()[0].tempId;
  store.getState().addMessage('g', message('server', 'draft', { tempId, status: 'sent' }));
  send.reject(new Error('connection lost'));
  assert.equal((await pending).success, true); assert.equal(rows()[0].status, 'sent'); assert.equal(rows()[0].id, 'server');
});

test('latest-page refresh retains older loaded history without blanket cache deletion', async () => {
  seed([message('old', 'old', { created_at: '2026-10-01T00:00:00Z' }), message('recent')]);
  io.api.getMessages = async () => ({ messages: [message('recent')], hasMore: true });
  await store.getState().fetchMessages('g'); await drain();
  assert.deepEqual(rows().map(row => row.id), ['old', 'recent']);
  assert.equal(io.storage.filter(call => call.name === 'clearAllMessagesFromIndexedDB').length, 0);
  assert.ok(io.storage.filter(call => call.name === 'deleteMessageFromIndexedDB').every(call => call.args[0] !== 'old'));
});

test('source deletion during cache and API reads never resurfaces or gets saved later', async () => {
  const cached = deferred(), response = deferred(); io.db.loadMessagesFromIndexedDB = () => cached.promise; io.api.getMessages = () => response.promise;
  const read = store.getState().fetchMessages('g'); store.getState().removeMessages('g', ['deleted']);
  cached.resolve([message('deleted'), message('keep')]); await drain(); assert.ok(!rows().some(row => row.id === 'deleted'));
  store.getState().updateMessage('keep', 'g', { content: 'newer' });
  response.resolve({ messages: [message('deleted'), message('keep', 'old')], hasMore: false }); await read; await runTimers(2000);
  assert.deepEqual(rows().map(row => [row.id, row.content]), [['keep', 'newer']]);
  assert.ok(io.storage.filter(call => call.name === 'saveMessagesToIndexedDB').every(call => call.args[0].every(row => row.id !== 'deleted')));
});

test('source clear invalidates an older read and only clears that group', async () => {
  const response = deferred(); io.api.getMessages = () => response.promise; seed([message('existing')]);
  const read = store.getState().fetchMessages('g'); await drain(); store.getState().clearMessages('g');
  response.resolve({ messages: [message('resurrected')], hasMore: true }); await read; await drain();
  assert.deepEqual(rows(), []); assert.equal(store.getState().pagination.g.hasMore, false);
  assert.deepEqual(io.storage.filter(call => call.name === 'clearAllMessagesFromIndexedDB').map(call => call.args), [['g']]);
});

test('older-page response retains live edits and cannot restore a deleted source', async () => {
  seed([message('existing')]); const response = deferred(); io.api.getMessages = () => response.promise;
  const page = store.getState().loadMoreMessages('g');
  store.getState().updateMessage('existing', 'g', { content: 'live' }); store.getState().removeMessages('g', ['deleted']);
  response.resolve({ messages: [message('older', 'older', { created_at: '2026-10-01T00:00:00Z' }), message('deleted'), message('existing', 'stale')], hasMore: false }); await page;
  assert.deepEqual(rows().map(row => [row.id, row.content]), [['older', 'older'], ['existing', 'live']]);
});

test('failed persistence is not acknowledged or pruned and is retried by the pending timer', async () => {
  io.api.sendMessage = async () => { throw new Error('offline'); }; let attempts = 0;
  io.db.saveMessagesToIndexedDB = async () => ++attempts > 2;
  const sent = await store.getState().sendMessage('g', 'unsaved draft'); assert.equal(sent.success, false); assert.equal(attempts, 2);
  assert.equal(io.storage.filter(call => call.name === 'clearOldMessagesFromIndexedDB').length, 0);
  await runTimers(2000); assert.equal(attempts, 3);
  assert.equal(rows()[0].status, 'failed');
});

test('serialized cache deletion follows an already-started older save', async () => {
  const save = deferred(); const cache = new Map();
  io.db.saveMessagesToIndexedDB = async messages => { await save.promise; for (const row of messages) cache.set(row.id, row); return true; };
  io.db.deleteMessageFromIndexedDB = async id => { cache.delete(id); };
  store.getState().addMessage('g', message('deleted')); await runTimers(2000);
  store.getState().removeMessages('g', ['deleted']); await drain();
  assert.equal(io.storage.filter(call => call.name === 'deleteMessageFromIndexedDB').length, 0);
  save.resolve(); await drain(); await runTimers(2000);
  assert.equal(cache.has('deleted'), false); assert.deepEqual(rows(), []);
});

test('delete failure after a newer remote deletion or clear cannot roll the source back', async () => {
  seed([message('deleted')]); const deletion = deferred(); io.api.deleteMessage = () => deletion.promise;
  const pending = store.getState().deleteMessage('deleted', 'g'); store.getState().removeMessages('g', ['deleted']);
  deletion.reject(new Error('late failure')); await pending; assert.deepEqual(rows(), []);
  seed([message('also-deleted')]); const another = deferred(); io.api.deleteMessage = () => another.promise;
  const pending2 = store.getState().deleteMessage('also-deleted', 'g'); store.getState().clearMessages('g');
  another.reject(new Error('late failure')); await pending2; assert.deepEqual(rows(), []);
});

for (const operation of ['deleteMessage', 'batchDeleteMessages', 'editMessage', 'clearAllMessages', 'likeMessage', 'unlikeMessage', 'dislikeMessage', 'undislikeMessage', 'addComment']) {
  for (const rejects of [false, true]) test(`${operation} ${rejects ? 'error' : 'receipt'} is fenced after A→B→A`, async () => {
    seed([message('same-id')]); const response = deferred(); io.api[operation] = () => response.promise;
    const args = operation === 'batchDeleteMessages' ? [['same-id'], 'g'] : operation === 'clearAllMessages' ? ['g'] : operation === 'addComment' ? ['same-id', 'g', 'private comment', 'user'] : ['same-id', 'g', 'private edit'];
    const pending = store.getState()[operation](...args);
    switchTo('bob'); switchTo('alice'); seed([message('same-id', 'new session')]);
    if (rejects) response.reject(new Error('old session error')); else response.resolve(message('same-id', 'old session'));
    await pending; assert.equal(rows()[0].content, 'new session'); assert.equal(store.getState().error, null); assert.deepEqual(io.audio, []);
    await drain(); assert.ok(io.storage.every(call => call.name === 'loadMessagesFromIndexedDB'));
  });
}

test('a pre-send cache await is fenced before the subsequent API call', async () => {
  const cached = deferred(); io.db.saveMessagesToIndexedDB = () => cached.promise;
  const sending = store.getState().sendMessage('g', 'A draft'); await drain();
  assert.equal(io.calls.length, 0);
  switchTo('bob'); cached.resolve(true); const result = await sending;
  assert.equal(result.success, false); assert.equal(io.calls.length, 0); assert.deepEqual(rows(), []);
});

test('send intent is saved with its original client ID before network IO; restored intent never auto-sends', async () => {
  const send = deferred(); io.api.sendMessage = () => send.promise;
  const pending = store.getState().sendMessage('g', 'recover me'); await drain();
  const saved = io.storage.find(call => call.name === 'saveMessagesToIndexedDB').args[0][0];
  assert.equal(saved.status, 'sending'); assert.equal(io.calls.find(call => call.name === 'sendMessage').args[6], saved.tempId);
  switchTo('alice'); io.db.loadMessagesFromIndexedDB = async () => [saved]; io.api.getMessages = async () => ({ messages: [], hasMore: false });
  await store.getState().fetchMessages('g'); assert.equal(rows()[0].status, 'failed'); assert.equal(rows()[0].metadata.send_unknown, true); assert.equal(rows()[0].tempId, saved.tempId);
  assert.equal(io.calls.filter(call => call.name === 'sendMessage').length, 1);
  send.resolve(message('late-server')); await pending;
});

test('failed clear releases invalidated initial-load and pagination spinners', async () => {
  seed([message('latest')]); const page = deferred(), clear = deferred(); io.api.getMessages = () => page.promise; io.api.clearAllMessages = () => clear.promise;
  const loading = store.getState().loadMoreMessages('g'); const clearing = store.getState().clearAllMessages('g');
  clear.reject(new Error('clear rejected')); await assert.rejects(clearing, /clear rejected/);
  page.resolve({ messages: [], hasMore: false }); await loading;
  assert.equal(store.getState().pagination.g.loadingMore, false);
  reset(); store.setState({ messages: {}, pagination: {}, loading: false });
  const read = deferred(); io.api.getMessages = () => read.promise; const initial = store.getState().fetchMessages('g'); await drain();
  io.api.clearAllMessages = async () => { throw new Error('clear rejected'); }; await assert.rejects(store.getState().clearAllMessages('g'));
  read.resolve({ messages: [], hasMore: false }); await initial; assert.equal(store.getState().loading, false);
});

for (const deleteFrontier of [false, true]) test(`pagination reconciles cached intervals using the server frontier${deleteFrontier ? ' even if that row was deleted' : ''}`, async () => {
  const old = message('old', 'old', { created_at: '2026-10-01T01:00:00Z' });
  const stale = message('deleted-offline', 'stale', { created_at: '2026-10-02T01:00:00Z' });
  const latest = message('latest', 'latest', { created_at: '2026-10-03T01:00:00Z' });
  io.db.loadMessagesFromIndexedDB = async () => [old, stale, latest]; io.api.getMessages = async () => ({ messages: [latest], hasMore: true });
  await store.getState().fetchMessages('g');
  if (deleteFrontier) store.getState().removeMessages('g', ['latest']);
  io.api.getMessages = async () => ({ messages: [old], hasMore: false }); await store.getState().loadMoreMessages('g'); await drain();
  assert.equal(io.calls.at(-1).args[2], latest.created_at); assert.ok(!rows().some(row => row.id === stale.id));
  assert.ok(io.storage.some(call => call.name === 'deleteMessageFromIndexedDB' && call.args[0] === stale.id));
});

test('LRU eviction never becomes a cache source deletion for a valid refreshed group', async () => {
  const messages = { h: [message('old-valid', 'valid', { group_id: 'h', created_at: '2020-01-01T00:00:00Z' })] };
  for (let i = 0; i < 15; i++) messages[`group-${i}`] = [message(`recent-${i}`)];
  store.setState({ messages }); io.api.getMessages = async () => ({ messages: messages.h, hasMore: false });
  await store.getState().fetchMessages('h'); await runTimers(2000);
  assert.equal(store.getState().messages.h, undefined);
  assert.ok(!io.storage.some(call => call.name === 'deleteMessageFromIndexedDB' && call.args[0] === 'old-valid'));
  assert.ok(io.storage.some(call => call.name === 'saveMessagesToIndexedDB' && call.args[0].some(row => row.id === 'old-valid')));
});

test('authoritative removal is targeted in cache and does not revive on an offline reload', async () => {
  const cache = new Map([['gone', message('gone')]]);
  io.db.loadMessagesFromIndexedDB = async () => [...cache.values()]; io.db.saveMessagesToIndexedDB = async messages => { for (const row of messages) cache.set(row.id, row); return true; }; io.db.deleteMessageFromIndexedDB = async id => { cache.delete(id); };
  await store.getState().fetchMessages('g'); await runTimers(2000); assert.equal(cache.size, 0);
  reset(); store.setState({ messages: {}, pagination: {} }); io.api.getMessages = async () => { throw new Error('offline'); };
  await store.getState().fetchMessages('g'); assert.deepEqual(rows(), []);
  assert.equal(io.storage.filter(call => call.name === 'clearAllMessagesFromIndexedDB').length, 0);
});

test('exact client confirmation is queued behind a draft save and does not tombstone future receipts', async () => {
  const cached = deferred(), cache = new Map(); io.db.saveMessagesToIndexedDB = async messages => { await cached.promise; for (const row of messages) cache.set(row.id, row); return true; }; io.db.deleteMessageFromIndexedDB = async id => { cache.delete(id); };
  store.getState().addMessage('g', message('temp-confirm', 'draft', { tempId: 'temp-confirm', status: 'failed' })); await runTimers(2000);
  store.getState().confirmClientMessage('g', 'temp-confirm');
  store.getState().addMessage('g', message('server', 'draft', { client_message_id: 'temp-confirm' }));
  cached.resolve(); await drain(); await runTimers(2000);
  assert.equal(cache.has('temp-confirm'), false); assert.equal(cache.has('server'), true); assert.deepEqual(rows().map(row => row.id), ['server']);
});

test('latest concurrent edit intent wins without overwriting a newer remote edit', async () => {
  seed([message('edit', 'v0')]); const first = deferred(), second = deferred(); let call = 0; io.api.editMessage = () => ++call === 1 ? first.promise : second.promise;
  const a = store.getState().editMessage('edit', 'g', 'v1'), b = store.getState().editMessage('edit', 'g', 'v2');
  first.resolve(message('edit', 'v1')); await a; second.resolve(message('edit', 'v2')); await b; assert.equal(rows()[0].content, 'v2');
  const third = deferred(); io.api.editMessage = () => third.promise; const edit = store.getState().editMessage('edit', 'g', 'v3');
  store.getState().updateMessage('edit', 'g', { content: 'remote-newer', edited_at: '2026-10-05T00:00:00Z' });
  third.resolve(message('edit', 'v3')); await edit; assert.equal(rows()[0].content, 'remote-newer');
});

test('HTTP send receipt preserves a newer edit on an already-confirmed WebSocket row', async () => {
  const send = deferred(); io.api.sendMessage = () => send.promise;
  const pending = store.getState().sendMessage('g', 'original'); await drain(); const tempId = rows()[0].tempId;
  store.getState().addMessage('g', message('server', 'original', { tempId, status: 'sent' }));
  store.getState().updateMessage('server', 'g', { content: 'live edited', is_edited: true, edited_at: '2026-10-04T02:00:00Z' });
  send.resolve(message('server', 'original')); await pending;
  assert.equal(rows()[0].content, 'live edited'); assert.equal(rows()[0].status, 'sent');
});

test('canonical recovery confirmation without a local row wins over a failed HTTP send receipt', async () => {
  const send = deferred(); io.api.sendMessage = () => send.promise;
  const pending = store.getState().sendMessage('g', 'draft'); await drain(); const tempId = rows()[0].tempId;
  store.getState().confirmClientMessage('g', tempId);
  store.getState().addMessage('g', message('server', 'draft', { client_message_id: tempId }));
  send.reject(new Error('HTTP disconnected')); assert.equal((await pending).success, true);
  assert.equal(store.getState().error, null); assert.equal(rows()[0].status, 'sent');
});

test('addMessage delivery owns exact queued cache cleanup even without explicit confirmation helper', async () => {
  const cached = deferred(), cache = new Map(); io.db.saveMessagesToIndexedDB = async messages => { await cached.promise; for (const row of messages) cache.set(row.id, row); return true; }; io.db.deleteMessageFromIndexedDB = async id => { cache.delete(id); };
  store.getState().addMessage('g', message('temp-add', 'draft', { tempId: 'temp-add', status: 'failed' })); await runTimers(2000);
  store.getState().addMessage('g', message('server', 'draft', { tempId: 'temp-add', status: 'sent' }));
  cached.resolve(); await drain(); await runTimers(2000);
  assert.equal(cache.has('temp-add'), false); assert.equal(cache.has('server'), true); assert.equal(rows().length, 1);
});
