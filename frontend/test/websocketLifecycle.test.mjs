import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Execute the real WebSocket service AND Axios/auth interceptors. Only browser
// scheduling, WebSocket transport, stores/cache effects and HTTP IO are synthetic.
const root = resolve(import.meta.dirname, '..');
const bundled = await build({
  stdin: { contents: `export * from './src/services/websocket'; export { axiosInstance, confirmAuthIdentity, onAuthExpired } from './src/services/api';`, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', write: false,
  define: { 'import.meta.env.DEV': 'true', 'import.meta.env.VITE_AUTH_MODE': '"session"' },
  plugins: [{ name: 'socket-io-boundaries', setup(build) {
    build.onResolve({ filter: /stores\/(messages|audio|ui|groups|personas)Store$/ }, ({ path }) => ({ path: path.match(/(\w+)Store$/)[1], namespace: 'fixture' }));
    build.onResolve({ filter: /utils\/cacheUtils$/ }, () => ({ path: 'cache', namespace: 'fixture' }));
    build.onResolve({ filter: /utils\/indexedDB$/ }, () => ({ path: 'indexedDB', namespace: 'fixture' }));
    build.onResolve({ filter: /\.\/runtimeConfig$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents:
      path === 'cache' ? `export const getCacheUserId=()=>globalThis.__socketFixture.user; export const saveGroupsCache=data=>globalThis.__socketFixture.writes.push(['groups',globalThis.__socketFixture.user,data]); export const savePersonasCache=data=>globalThis.__socketFixture.writes.push(['personas',globalThis.__socketFixture.user,data]);` :
      path === 'indexedDB' ? `export const loadMessagesFromIndexedDB=groupId=>globalThis.__socketFixture.loadCache(groupId);` :
      path === 'messages' ? `export const useMessagesStore={getState:()=>globalThis.__socketFixture.stores.messages.getState(),setState:patch=>globalThis.__socketFixture.stores.messages.setState(patch)}; export const recoverCachedMessage=message=>message.status==='sending'?{...message,status:'failed',metadata:{...message.metadata,send_unknown:true}}:message;` :
      path === 'runtime' ? `export const getWebSocketUrl=()=> 'ws://synthetic.test/ws'; export const getApiBaseUrl=()=>'/api'; export const getApiBaseUrlCandidates=()=>['/api']; export const rememberBackendOrigin=()=>{};` :
      `export const use${path === 'ui' ? 'UI' : path[0].toUpperCase()+path.slice(1)}Store={getState:()=>globalThis.__socketFixture.stores.${path}.getState(),setState:patch=>globalThis.__socketFixture.stores.${path}.setState(patch)};`
    }));
  } }]
});
// Axios checks browser globals at module import.
globalThis.window = new EventTarget();
window.location = new URL('http://synthetic.test/');
globalThis.document = new EventTarget();
document.cookie = '';
const service = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function store(initial) {
  let state = initial;
  return { getState: () => state, setState: patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
}
function fixture() {
  const messages = store({ messages: {}, pagination: {}, fetchMessages: () => { throw new Error('Unguarded store fetch must not be used'); } });
  const updateMessages = (groupId, transform) => messages.setState(state => ({ messages: { ...state.messages, [groupId]: transform(state.messages[groupId] || []) } }));
  messages.setState({
    confirmClientMessage: (groupId, tempId) => { globalThis.__socketFixture.deletions.push(tempId); updateMessages(groupId, values => values.filter(item => item.id !== tempId || item.tempId !== tempId)); },
    addMessage: (groupId, message) => {
      const clientId = message.tempId || message.client_message_id;
      if (clientId && message.id !== clientId) globalThis.__socketFixture.deletions.push(clientId);
      return updateMessages(groupId, values => {
      const position = values.findIndex(item => item.id === message.id || (item.tempId && item.tempId === message.tempId));
      return position < 0 ? [...values, message] : values.map((item, index) => index === position ? { ...item, ...message } : item);
    }); },
    finalizeStreamMessage: (groupId, id, content) => updateMessages(groupId, values => values.map(item => item.id === id ? { ...item, content, is_streaming: false } : item)),
    removeMessages: (groupId, ids) => updateMessages(groupId, values => values.filter(item => !ids.includes(item.id))),
    updateMessage: (id, groupId, fields) => updateMessages(groupId, values => values.map(item => item.id === id ? { ...item, ...fields } : item)),
    clearMessages: groupId => updateMessages(groupId, () => []),
    applyLikeUpdate: (id, groupId, actor) => updateMessages(groupId, values => values.map(item => item.id === id ? { ...item, likes: [...new Set([...(item.likes || []), actor])] } : item)),
    addCommentFromRemote: (id, groupId, comment) => updateMessages(groupId, values => values.map(item => item.id === id && !(item.comments || []).some(existing => existing.id === comment.id) ? { ...item, comments: [...(item.comments || []), comment] } : item)),
  });
  const groups = store({ groups: [], currentGroup: null, fetchGroups: () => { throw new Error('Unguarded store fetch must not be used'); }, setTypingAI() {}, updateChatStatus() {} });
  const ui = store({ connectionStatus: 'disconnected', connectionError: null, setTyping() {}, clearAllTypingForGroup() {} });
  ui.setState({ setConnectionStatus: status => ui.setState({ connectionStatus: status }), setConnectionError: error => ui.setState({ connectionError: error }) });
  const personas = store({ personas: {}, fetchPersonas: () => { throw new Error('Unguarded store fetch must not be used'); } });
  personas.setState({ handlePersonaUpdate: (id, persona) => personas.setState(state => ({ personas: { ...state.personas, [id]: persona } })) });
  return { user: 'alice', loadCache: async () => [], stores: { messages, groups, ui, personas, audio: store({ removeTTSAudio() {} }) }, writes: [], deletions: [] };
}
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static sockets = [];
  constructor(url) { this.url = url; this.readyState = FakeWebSocket.CONNECTING; this.sent = []; this.closes = []; FakeWebSocket.sockets.push(this); }
  send(data) { if (this.failSend) throw new Error('synthetic send failure'); this.sent.push(JSON.parse(data)); }
  close(code = 1000, reason = '') { this.closes.push({ code, reason }); this.readyState = FakeWebSocket.CLOSED; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  closed(code = 1006, reason = '') { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code, reason }); }
  callbacks() { return { open: this.onopen, message: this.onmessage, close: this.onclose, error: this.onerror }; }
}
const originals = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now, random: Math.random };
let timers, now, nextTimer, requests, transport;
const settle = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };
const currentSocket = () => FakeWebSocket.sockets.at(-1);
const state = name => globalThis.__socketFixture.stores[name].getState();
const defaultData = config => config.url === '/groups' ? state('groups').groups : config.url === '/personas' ? { personas: state('personas').personas } : { messages: [], hasMore: false };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function advance(ms) {
  const target = now + ms;
  for (;;) {
    const entry = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a,b) => a[1].at-b[1].at)[0];
    if (!entry) break;
    const [id, timer] = entry; now = timer.at;
    if (timer.interval) timer.at += timer.delay; else timers.delete(id);
    timer.callback();
  }
  now = target;
}
function visibility(value) { document.visibilityState = value; document.dispatchEvent(new Event('visibilitychange')); }
function switchAccount(user) { globalThis.__socketFixture.user = user; service.confirmAuthIdentity(user); }
function open(groupId) { service.connectWebSocket(groupId); currentSocket().open(); return currentSocket(); }
const msg = (id = 'message', content = 'synthetic-private-body') => ({ type: 'new_message', id, group_id: 'group', content, sender_type: 'user', created_at: '2026-10-04T12:00:00.000Z' });

beforeEach(() => {
  globalThis.__socketFixture = fixture();
  timers = new Map(); now = Date.parse('2026-10-04T12:01:00.000Z'); nextTimer = 0;
  globalThis.setTimeout = (callback, delay = 0) => { const id = ++nextTimer; timers.set(id, { callback, delay, at: now + delay, interval: false }); return id; };
  globalThis.setInterval = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, at: now + delay, interval: true }); return id; };
  globalThis.clearTimeout = globalThis.clearInterval = id => timers.delete(id);
  Date.now = () => now; Math.random = () => 0;
  globalThis.WebSocket = FakeWebSocket; FakeWebSocket.sockets = [];
  globalThis.localStorage = { values: new Map(), getItem(key) { return this.values.get(key) ?? null; }, setItem(key, value) { this.values.set(key, value); } };
  document.visibilityState = 'visible';
  service.confirmAuthIdentity('alice');
  requests = []; transport = async config => defaultData(config);
  service.axiosInstance.defaults.adapter = async config => {
    requests.push(config);
    return { config, data: await transport(config), status: 200, statusText: 'OK', headers: {} };
  };
});
afterEach(async () => {
  service.destroyWebSocket(); await settle();
  Object.assign(globalThis, { setTimeout: originals.setTimeout, clearTimeout: originals.clearTimeout, setInterval: originals.setInterval, clearInterval: originals.clearInterval });
  Date.now = originals.now; Math.random = originals.random;
});

test('old message/open/error/4001-close cannot mutate a new account or stop its heartbeat', async () => {
  const authEvents = []; const off = service.onAuthExpired(reason => authEvents.push(reason));
  const old = open(); const queued = old.callbacks(); await settle();
  switchAccount('bob'); const fresh = open(); await settle();
  const writes = globalThis.__socketFixture.writes.length;
  queued.open({}); queued.error({ private: 'socket-secret' });
  queued.message({ data: JSON.stringify({ type: 'batch', messages: [msg(), { type: 'persona_updated', aiId: 'ai', persona: { name: 'alice-private' } }, { type: 'error', message: 'private-token' }] }) });
  queued.close({ code: 4001, reason: 'alice-private-reason' });
  assert.deepEqual(state('messages').messages, {}); assert.deepEqual(state('personas').personas, {});
  assert.equal(state('ui').connectionStatus, 'connected'); assert.equal(state('ui').connectionError, null);
  assert.equal(globalThis.__socketFixture.writes.length, writes); assert.deepEqual(authEvents, []);
  assert.equal([...timers.values()].filter(timer => timer.interval).length, 1);
  advance(60000); assert.ok(fresh.closes.some(item => item.code === 4002), 'new heartbeat remains active');
  off();
});

test('authentication generation fences A-B-A even before a replacement socket is created', async () => {
  const socket = open(); await settle(); const callbacks = socket.callbacks();
  switchAccount('bob'); switchAccount('alice');
  callbacks.message({ data: JSON.stringify(msg()) }); callbacks.close({ code: 4001 });
  window.dispatchEvent(new Event('online')); visibility('hidden'); advance(10000); visibility('visible');
  assert.deepEqual(state('messages').messages, {}); assert.equal(FakeWebSocket.sockets.length, 1);
  const fresh = open(); fresh.message(msg('fresh', 'new-session')); assert.equal(state('messages').messages.group[0].content, 'new-session');
});

test('same-account replacement discards late HTTP messages, group/persona sync and stream recovery', async () => {
  globalThis.__socketFixture.stores.messages.setState({ messages: { group: [{ id: 'stream', group_id: 'group', content: 'partial', is_streaming: true, created_at: '2026-10-04T11:00:00Z' }] } });
  const waits = [];
  transport = config => { const wait = deferred(); waits.push({ ...wait, url: config.url }); return wait.promise; };
  const old = open('group'); await settle(); assert.equal(waits.length, 4);
  old.closed(); transport = async config => defaultData(config);
  const fresh = open('group'); await settle();
  globalThis.__socketFixture.stores.messages.setState({ messages: { group: [{ id: 'stream', content: 'new-session-stream', is_streaming: true, created_at: '2026-10-04T12:00:59Z' }] } });
  for (const wait of waits) wait.resolve(wait.url === '/groups' ? [{ id: 'private-old-group' }] : wait.url === '/personas' ? { personas: { old: { name: 'private-old-persona' } } } : wait.url === '/messages/stream' ? { content: 'private-old-final' } : { messages: [msg('late')], hasMore: true });
  await settle();
  assert.equal(currentSocket(), fresh); assert.equal(state('messages').messages.group[0].content, 'new-session-stream');
  assert.equal(state('messages').messages.group.length, 1); assert.deepEqual(state('groups').groups, []); assert.deepEqual(state('personas').personas, {});
  assert.ok(!JSON.stringify(globalThis.__socketFixture.writes).includes('private-old'));
});

test('destroy invalidates in-flight HTTP completion even without changing auth identity', async () => {
  const waits = [];
  transport = config => { const wait = deferred(); waits.push({ ...wait, url: config.url }); return wait.promise; };
  open('group'); await settle(); service.destroyWebSocket();
  waits.forEach(wait => wait.resolve(wait.url === '/groups' ? [{ id: 'stale' }] : wait.url === '/personas' ? { personas: { stale: {} } } : { messages: [msg()], hasMore: true }));
  await settle(); assert.deepEqual(state('messages').messages, {}); assert.deepEqual(state('groups').groups, []);
  assert.deepEqual(globalThis.__socketFixture.writes, []); assert.equal(timers.size, 0);
});

test('logout clears retry/listeners/pending selection; queued callbacks cannot resurrect a connection', async () => {
  const old = open('old-group'); await settle(); old.closed();
  const queued = [...timers.values()].map(timer => timer.callback);
  visibility('hidden'); service.disconnectWebSocket();
  queued.forEach(callback => callback()); window.dispatchEvent(new Event('online')); advance(10000); visibility('visible');
  assert.equal(FakeWebSocket.sockets.length, 1); assert.equal(timers.size, 0);
  open(); await settle(); assert.ok(!currentSocket().sent.some(item => item.group_id === 'old-group'));
});

test('connecting latest selection wins; old connection timeout cannot close a replacement', async () => {
  service.connectWebSocket('first'); const oldTimeout = [...timers.values()][0].callback;
  service.connectWebSocket('last'); assert.equal(FakeWebSocket.sockets.length, 1);
  currentSocket().open(); await settle(); assert.ok(currentSocket().sent.some(item => item.group_id === 'last'));
  service.destroyWebSocket(); const fresh = open(); await settle(); oldTimeout();
  assert.equal(fresh.closes.length, 0); assert.equal(state('ui').connectionStatus, 'connected');
});

test('late connection error timer cannot clear the new connection or a newer external error', async () => {
  let socket = open(); await settle(); socket.message({ type: 'error', message: 'private-server-error' });
  const staleClear = [...timers.values()].find(timer => !timer.interval).callback;
  service.destroyWebSocket(); socket = open(); await settle(); socket.onerror({}); const newError = state('ui').connectionError;
  staleClear(); assert.equal(state('ui').connectionError, newError);
  socket.message({ type: 'error' }); state('ui').setConnectionError('newer-http-error'); advance(5000);
  assert.equal(state('ui').connectionError, 'newer-http-error');
});

test('repeated brief opens preserve bounded backoff; browser events cannot bypass its cap', async () => {
  open(); await settle();
  for (let attempt = 0; attempt <= 30; attempt++) {
    currentSocket().closed();
    if (attempt < 30) { advance(30000); currentSocket().open(); await settle(); }
  }
  assert.deepEqual(service.getReconnectProgress(), { current: 30, max: 30 });
  assert.equal(FakeWebSocket.sockets.length, 31); assert.equal(timers.size, 0);
  advance(600000); window.dispatchEvent(new Event('online')); visibility('hidden'); advance(10000); visibility('visible');
  assert.equal(FakeWebSocket.sockets.length, 31); assert.match(state('ui').connectionError, /刷新/);
  service.connectWebSocket(); assert.equal(FakeWebSocket.sockets.length, 32);
});

test('a genuinely stable connection resets backoff, and normal/auth closure does not auto-retry', async () => {
  open(); await settle(); currentSocket().closed(); advance(1000); currentSocket().open(); await settle();
  advance(30000); currentSocket().message({ type: 'ping' }); currentSocket().closed();
  assert.equal(service.getReconnectProgress().current, 1);
  advance(1000); currentSocket().open(); await settle(); currentSocket().closed(1000); assert.equal(timers.size, 0);
  service.connectWebSocket(); currentSocket().open(); await settle();
  const events = []; const off = service.onAuthExpired(reason => events.push(reason));
  currentSocket().closed(4001, 'private-secret'); assert.deepEqual(events, ['expired']);
  assert.equal(timers.size, 0); assert.ok(!state('ui').connectionError.includes('private-secret')); off();
});

test('missing identity never connects; cursors from one account are never reused by another', async () => {
  globalThis.__socketFixture.user = null; service.connectWebSocket('group'); assert.equal(FakeWebSocket.sockets.length, 0);
  switchAccount('alice'); open(); await settle(); currentSocket().message(msg());
  service.destroyWebSocket(); switchAccount('bob'); open('group'); await settle();
  const messageRequest = requests.filter(config => config.url === '/groups/group/messages').at(-1);
  assert.equal(messageRequest.params.after, undefined); assert.equal(messageRequest.headers['X-Expected-User-Id'], 'bob');
});

test('current message delivery/recovery still works without private console payloads', async () => {
  const captured = []; const oldWarn = console.warn; const oldLog = console.log; const oldError = console.error;
  console.warn = console.log = console.error = (...args) => captured.push(args);
  try {
    open(); await settle(); const socket = currentSocket();
    socket.message(msg('one', 'synthetic-private-body')); socket.message({ type: 'ping' });
    socket.onmessage({ data: '{ private-body-invalid-json' });
    socket.message({ type: 'error', message: 'synthetic-secret-provider-error' });
    assert.equal(state('messages').messages.group[0].content, 'synthetic-private-body');
    assert.ok(socket.sent.some(item => item.type === 'pong'));
    assert.ok(!JSON.stringify(captured).includes('private')); assert.ok(!JSON.stringify(captured).includes('secret'));
    assert.ok(!state('ui').connectionError.includes('secret'));
  } finally { console.warn = oldWarn; console.log = oldLog; console.error = oldError; }
});

test('initial/group join HTTP results are deduplicated and stay ordered with pagination', async () => {
  transport = async config => config.url === '/groups/group/messages' ? { messages: [msg('older', 'older')], hasMore: true } : defaultData(config);
  open('group'); service.joinGroup('group'); await settle();
  assert.equal(requests.filter(config => config.url === '/groups/group/messages').length, 1);
  assert.equal(state('messages').messages.group[0].content, 'older'); assert.equal(state('messages').pagination.group.hasMore, true);
});

test('recovery read cannot resurrect a message deleted while the request was in flight', async () => {
  const wait = deferred(); transport = config => config.url === '/groups/group/messages' ? wait.promise : Promise.resolve(defaultData(config));
  const socket = open('group'); await settle(); socket.message({ type: 'message_deleted', group_id: 'group', message_id: 'deleted' });
  wait.resolve({ messages: [msg('deleted')], hasMore: false }); await settle();
  assert.deepEqual(state('messages').messages.group, []);
});

test('destroy before Axios request interceptors run aborts queued reads without sending them', async () => {
  open('old-group'); service.destroyWebSocket(); switchAccount('bob'); await settle();
  assert.deepEqual(requests, []); assert.deepEqual(globalThis.__socketFixture.writes, []);
});

test('a queued old retry cannot retire the newer same-account connection', async () => {
  open(); await settle(); currentSocket().closed();
  const queuedRetry = [...timers.values()][0].callback;
  const fresh = open(); await settle(); queuedRetry();
  assert.equal(FakeWebSocket.sockets.length, 2); assert.equal(currentSocket(), fresh);
  assert.equal(fresh.closes.length, 0); assert.equal(state('ui').connectionStatus, 'connected');
});

test('same-account old HTTP 401/rejection cannot expire or clear a replacement session', async () => {
  const waits = [];
  transport = config => { const wait = deferred(); waits.push({ ...wait, config }); return wait.promise; };
  open('group'); await settle(); currentSocket().closed();
  transport = async config => defaultData(config); open('group'); await settle();
  state('ui').setConnectionError('new-session-visible-error');
  const events = []; const off = service.onAuthExpired(reason => events.push(reason));
  for (const wait of waits) wait.reject(Object.assign(new Error('private-transport-error'), { config: wait.config, response: { status: 401, data: { error: 'private-body' } } }));
  await settle(); assert.deepEqual(events, []); assert.equal(state('ui').connectionError, 'new-session-visible-error'); off();
});

test('pagination stops at retirement and never issues another old-account page', async () => {
  globalThis.__socketFixture.stores.messages.setState({ messages: { group: [msg('existing')] } });
  localStorage.setItem('ws_last_msg_ts_alice', JSON.stringify({ group: '2026-10-04T11:00:00Z' }));
  const wait = deferred(); transport = config => config.url === '/groups/group/messages' ? wait.promise : Promise.resolve(defaultData(config));
  open('group'); await settle(); service.destroyWebSocket();
  wait.resolve({ messages: [msg('old-page')], hasMore: true }); await settle();
  assert.equal(requests.filter(config => config.url === '/groups/group/messages').length, 1);
  assert.equal(state('messages').messages.group.length, 1);
  assert.equal(state('messages').messages.group[0].id, 'existing');
  assert.equal(requests.find(config => config.url === '/groups/group/messages').params.after, '2026-10-04T11:00:00Z');
});

test('live messages during gap fill preserve unrelated history while edits/deletes win', async () => {
  const wait = deferred(); transport = config => config.url === '/groups/group/messages' ? wait.promise : Promise.resolve(defaultData(config));
  const socket = open('group'); await settle();
  socket.message(msg('live', 'current-live'));
  socket.message({ type: 'message_deleted', group_id: 'group', message_id: 'deleted' });
  wait.resolve({ messages: [msg('earlier', 'missed-history'), msg('live', 'stale-live'), msg('deleted', 'deleted-history')], hasMore: false });
  await settle();
  const messages = state('messages').messages.group;
  assert.equal(messages.length, 2); assert.equal(messages.find(item => item.id === 'live').content, 'current-live');
  assert.equal(messages.find(item => item.id === 'earlier').content, 'missed-history');
});

test('constructor failure is visible and does not enter an automatic retry loop', async () => {
  globalThis.WebSocket = class extends FakeWebSocket { constructor() { throw new Error('private-endpoint-error'); } };
  service.connectWebSocket(); await settle(); advance(600000);
  assert.equal(state('ui').connectionStatus, 'disconnected'); assert.match(service.getConnectionError(), /服务地址/);
  assert.equal(timers.size, 0); assert.equal(FakeWebSocket.sockets.length, 0);
});

test('connection timeout and send failure schedule exactly one bounded retry', async () => {
  service.connectWebSocket(); advance(20000);
  assert.equal(service.getReconnectProgress().current, 1); assert.equal(timers.size, 1);
  advance(1000); const socket = currentSocket(); socket.open(); await settle(); socket.failSend = true;
  socket.message({ type: 'ping' }); socket.closed(1006);
  assert.equal(service.getReconnectProgress().current, 2); assert.equal(timers.size, 1);
});

test('an edit for an unloaded message overlays the history response instead of hiding it', async () => {
  const wait = deferred(); transport = config => config.url === '/groups/group/messages' ? wait.promise : Promise.resolve(defaultData(config));
  const socket = open('group'); await settle();
  socket.message({ type: 'message_updated', group_id: 'group', message_id: 'unseen', content: 'edited-while-loading', edited_at: '2026-10-04T12:00:30Z' });
  wait.resolve({ messages: [msg('unseen', 'stale-history')], hasMore: false }); await settle();
  assert.equal(state('messages').messages.group.length, 1);
  assert.equal(state('messages').messages.group[0].content, 'edited-while-loading');
});

test('cold-tab cached failed drafts remain retryable, and confirmed client IDs reconcile once', async () => {
  const draft = { id: 'temporary', tempId: 'request-id', sender_type: 'user', status: 'failed', group_id: 'group', content: 'unsent-draft', created_at: '2026-10-04T11:59:00Z' };
  globalThis.__socketFixture.loadCache = async () => [draft];
  localStorage.setItem('ws_last_msg_ts_alice', JSON.stringify({ group: '2026-10-04T11:59:59Z' }));
  open('group'); await settle();
  assert.equal(state('messages').messages.group[0].status, 'failed');
  assert.equal(requests.find(config => config.url === '/groups/group/messages').params.after, undefined);
  transport = async config => config.url === '/groups/group/messages' ? { messages: [{ ...msg('confirmed', 'sent-draft'), client_message_id: 'request-id' }], hasMore: false } : defaultData(config);
  service.joinGroup('group'); await settle();
  assert.equal(state('messages').messages.group.length, 1); assert.equal(state('messages').messages.group[0].id, 'confirmed');
  assert.equal(state('messages').messages.group[0].status, 'sent'); assert.deepEqual(globalThis.__socketFixture.deletions, ['request-id']);
});

test('unavailable history keeps cached drafts; retired IndexedDB reads cannot hydrate new sessions', async () => {
  const draft = { ...msg('draft', 'cached-draft'), tempId: 'draft', status: 'failed' };
  globalThis.__socketFixture.loadCache = async () => [draft];
  transport = async config => {
    if (config.url === '/groups/group/messages') throw Object.assign(new Error('synthetic HTTP rejection'), { config, response: { status: 400, data: { error: 'synthetic unavailable' } } });
    return defaultData(config);
  };
  open('group'); await settle(); assert.equal(state('messages').messages.group[0].content, 'cached-draft');
  service.destroyWebSocket(); globalThis.__socketFixture.stores.messages.setState({ messages: {} });
  const wait = deferred(); globalThis.__socketFixture.loadCache = () => wait.promise;
  open('group'); await settle(); service.destroyWebSocket(); switchAccount('bob');
  globalThis.__socketFixture.loadCache = async () => []; transport = async config => defaultData(config);
  open('group'); await settle(); wait.resolve([{ ...draft, content: 'late-alice-cache' }]); await settle();
  assert.deepEqual(state('messages').messages.group, []); assert.ok(!JSON.stringify(globalThis.__socketFixture.writes).includes('late-alice-cache'));
});

test('live sidebar/persona edits do not discard unrelated server-added records during reconnect', async () => {
  globalThis.__socketFixture.stores.groups.setState({ groups: [{ id: 'group', name: 'before', last_message_preview: 'before-preview' }] });
  globalThis.__socketFixture.stores.personas.setState({ personas: { ai: { name: 'before', style: 'old-style' } } });
  const groups = deferred(), personas = deferred();
  transport = config => config.url === '/groups' ? groups.promise : config.url === '/personas' ? personas.promise : Promise.resolve(defaultData(config));
  const socket = open('group'); await settle(); socket.message(msg('live', 'latest-preview'));
  socket.message({ type: 'persona_updated', aiId: 'ai', persona: { name: 'live-name', style: 'old-style' } });
  groups.resolve([{ id: 'group', name: 'server-name', last_message_preview: 'stale-preview' }, { id: 'added-group', name: 'new' }]);
  personas.resolve({ personas: { ai: { name: 'stale-name', style: 'server-style' }, added: { name: 'added-persona' } } });
  await settle();
  assert.equal(state('groups').groups.length, 2); assert.equal(state('groups').groups[0].name, 'server-name');
  assert.match(state('groups').groups[0].last_message_preview, /latest-preview/);
  assert.ok(socket.sent.some(item => item.group_id === 'added-group'));
  assert.equal(state('personas').personas.ai.name, 'live-name'); assert.equal(state('personas').personas.ai.style, 'server-style');
  assert.equal(state('personas').personas.added.name, 'added-persona');
});

test('silent open sockets cannot reset the reconnect cap through repeated heartbeat expiry', async () => {
  open(); await settle();
  for (let count = 0; count <= 30; count++) {
    advance(60000);
    if (count < 30) {
      const retry = [...timers.values()].find(timer => !timer.interval);
      assert.ok(retry); advance(retry.at - now); currentSocket().open(); await settle();
    }
  }
  assert.equal(FakeWebSocket.sockets.length, 31); assert.equal(service.getReconnectProgress().current, 30);
  assert.equal(timers.size, 0); assert.match(service.getConnectionError(), /刷新/);
});

test('authoritative initial history removes unchanged cached deleted bodies while preserving drafts', async () => {
  globalThis.__socketFixture.loadCache = async () => [msg('deleted-offline'), { ...msg('failed'), status: 'failed', tempId: 'failed' }];
  open('group'); await settle();
  assert.deepEqual(state('messages').messages.group.map(item => item.id), ['failed']);
});

test('late cached failed draft is not restored after its live confirmed echo', async () => {
  const wait = deferred(); globalThis.__socketFixture.loadCache = () => wait.promise;
  const socket = open('group'); await settle();
  socket.message({ ...msg('confirmed', 'new-live-content'), client_message_id: 'request-id' });
  transport = async config => config.url === '/groups/group/messages' ? { messages: [{ ...msg('confirmed', 'old-http-content'), client_message_id: 'request-id' }], hasMore: false } : defaultData(config);
  wait.resolve([{ ...msg('temporary'), tempId: 'request-id', status: 'failed' }]); await settle();
  assert.equal(state('messages').messages.group.length, 1); assert.equal(state('messages').messages.group[0].content, 'new-live-content');
  assert.deepEqual(globalThis.__socketFixture.deletions, ['request-id']);
});

test('unloaded reactions/comments apply once after history without duplicating included comments', async () => {
  const wait = deferred(); transport = config => config.url === '/groups/group/messages' ? wait.promise : Promise.resolve(defaultData(config));
  const socket = open('group'); await settle();
  const comment = { id: 'comment', sender_id: 'alice', sender_type: 'user', content: 'comment-text' };
  socket.message({ type: 'message_liked', group_id: 'group', message_id: 'unseen', liked_by: 'alice' });
  socket.message({ type: 'new_comment', group_id: 'group', message_id: 'unseen', comment });
  wait.resolve({ messages: [{ ...msg('unseen'), comments: [comment] }], hasMore: false }); await settle();
  assert.deepEqual(state('messages').messages.group[0].likes, ['alice']);
  assert.equal(state('messages').messages.group[0].comments.length, 1);
});

test('malformed sync bodies retain current records and report a fixed error without unhandled rejection', async () => {
  globalThis.__socketFixture.stores.groups.setState({ groups: [{ id: 'known', name: 'known' }] });
  transport = async config => config.url === '/groups' ? {} : config.url === '/personas' ? { personas: null } : defaultData(config);
  open(); await settle(); assert.equal(state('groups').groups[0].id, 'known');
  assert.match(service.getConnectionError(), /资料同步失败/);
});

test('duplicate open callback cannot orphan an extra heartbeat interval', async () => {
  const socket = open(); const callback = socket.onopen; await settle(); callback({}); await settle();
  assert.equal([...timers.values()].filter(timer => timer.interval).length, 1);
  service.destroyWebSocket(); assert.equal(timers.size, 0);
});

test('a later first-page refresh updates pagination after an initially empty group grows', async () => {
  open('group'); await settle(); assert.equal(state('messages').pagination.group.hasMore, false);
  service.destroyWebSocket();
  transport = async config => config.url === '/groups/group/messages' ? { messages: [msg('newer')], hasMore: true } : defaultData(config);
  open('group'); await settle();
  assert.equal(state('messages').pagination.group.hasMore, true);
  assert.equal(state('messages').pagination.group.oldestMessageId, 'newer');
});


test('cold-tab in-flight cached draft becomes explicit unknown outcome without resend', async () => {
  globalThis.__socketFixture.loadCache = async () => [{ ...msg('draft'), tempId: 'draft', status: 'sending' }];
  transport = async config => { if (config.url.includes('/messages')) throw new Error('offline'); return defaultData(config); };
  open('group'); await settle();
  const draft = state('messages').messages.group[0];
  assert.equal(draft.status, 'failed'); assert.equal(draft.metadata.send_unknown, true);
  assert.ok(requests.every(request => request.method === 'get'));
});


test('cold first page with more history never tombstones cached rows outside its time range', async () => {
  const old = { ...msg('older'), created_at: '2026-10-03T00:00:00Z' };
  globalThis.__socketFixture.loadCache = async () => [old];
  transport = async config => config.url.includes('/messages') ? { messages: [msg('latest')], hasMore: true } : defaultData(config);
  open('group'); await settle();
  assert.deepEqual(state('messages').messages.group.map(row => row.id), ['older', 'latest']);
  assert.equal(state('messages').pagination.group.oldestMessageCreatedAt, '2026-10-04T12:00:00.000Z');
});
