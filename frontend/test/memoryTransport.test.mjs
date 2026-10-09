import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// Synthetic in-process HTTP only. Test real Axios fetch/JSON/error/connection-loss
// behavior rather than returning preconstructed Axios adapter responses.
const rootDir = resolve(import.meta.dirname, '..');
const browserWindow = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browserWindow, document: browserWindow.document,
  localStorage: browserWindow.localStorage });
const record = (id, content, revision = 0) => ({ id, content, revision, category: 'note',
  kind: 'user_note', evidence: 'user_asserted', confirmedFact: false, source: null,
  recordedAt: '2026-09-27T00:00:00Z' });
let records = [], keys = new Map(), writes = [], transportMode = 'normal';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  if (req.method === 'GET' && url.pathname === '/api/memory') {
    const offset = Number(url.searchParams.get('offset'));
    send(200, { offset, total: records.length, memories: records.slice(offset, offset + 100) }); return;
  }
  if (req.method === 'POST') writes.push({ url: url.pathname, body,
    key: req.headers['idempotency-key'], account: req.headers['x-expected-user-id'] });
  if (req.method === 'POST' && url.pathname === '/api/memory/store') {
    const key = req.headers['idempotency-key'];
    const id = keys.get(key);
    let memory;
    if (id) {
      memory = records.find(item => item.id === id);
      if (!memory) { send(410, { code: 'MEMORY_FORGOTTEN', error: 'forgotten' }); return; }
      if (memory.content !== body.content) { send(409, { code: 'IDEMPOTENCY_CONFLICT', error: 'conflict' }); return; }
    } else {
      memory = record(`saved-${keys.size}`, body.content);
      keys.set(key, memory.id); records.unshift(memory);
    }
    if (transportMode === 'lose-create') {
      transportMode = 'normal'; req.socket.destroy(); return;
    }
    send(200, { memoryId: memory.id, memory }); return;
  }
  const match = /^\/api\/memory\/([^/]+)(?:\/(correct))?$/.exec(url.pathname);
  if (match) {
    const [, id, operation] = match;
    const memory = records.find(item => item.id === id);
    if (!memory) { send(404, { code: 'MEMORY_NOT_FOUND', error: 'not found' }); return; }
    if (operation === 'correct' && req.method === 'POST') {
      if (memory.revision !== body.expectedRevision) { send(409, { code: 'STALE_MEMORY', error: 'stale' }); return; }
      const updated = { ...memory, content: body.content, revision: memory.revision + 1 };
      records = records.map(item => item.id === id ? updated : item);
      if (transportMode === 'lose-correct') {
        transportMode = 'normal'; req.socket.destroy(); return;
      }
      send(200, { memory: updated }); return;
    }
    if (!operation && req.method === 'GET') { send(200, { memory }); return; }
  }
  send(404, { error: 'Synthetic test route not found' });
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const apiBase = `http://127.0.0.1:${server.address().port}/api`;
const bundled = await build({
  stdin: { contents: `export { useMemoryStore as store } from './src/stores/memoryStore';
    export { axiosInstance } from './src/services/api';
    export { setCacheUserId } from './src/utils/cacheUtils';`,
    resolveDir: rootDir, sourcefile: 'test-memory-transport.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', write: false,
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_AUTH_MODE': '"session"' },
  plugins: [{ name: 'synthetic-http-origin', setup(buildTool) {
    buildTool.onResolve({ filter: /^\.\/runtimeConfig$/ }, () => ({ path: 'runtime', namespace: 'test' }));
    buildTool.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents:
      `export const getApiBaseUrl = () => ${JSON.stringify(apiBase)};
       export const getApiBaseUrlCandidates = () => [${JSON.stringify(apiBase)}];
       export const rememberBackendOrigin = () => {};` }));
  } }],
});
const { store, axiosInstance, setCacheUserId } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
async function settleReads() {
  for (let attempt = 0; attempt < 100 && (store.getState().loading || store.getState().loadingMore); attempt++) {
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.equal(store.getState().loading || store.getState().loadingMore, false, 'background refresh settled');
}
beforeEach(() => {
  store.getState().cleanup(); localStorage.clear(); setCacheUserId('synthetic-alice');
  records = [record('note-1', 'original')]; keys = new Map(); writes = []; transportMode = 'normal';
  document.cookie = 'XSRF-TOKEN=synthetic-test-csrf';
  axiosInstance.defaults.adapter = 'fetch'; store.getState().activate();
});
afterEach(async () => { await settleReads(); store.getState().cleanup(); });
after(async () => {
  await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
  await browserWindow.close();
});

test('HTTP lost create receipt retains frozen key/payload and produces only one record', async () => {
  transportMode = 'lose-create'; store.getState().setNote('frozen payload');
  await store.getState().saveNote(); await settleReads();
  assert.equal(writes.length, 1); assert.equal(records.length, 2); assert.ok(store.getState().pending);
  store.getState().setNote('different input'); assert.equal(store.getState().note, 'frozen payload');
  await store.getState().retry(); await settleReads();
  assert.equal(writes.length, 2); assert.equal(writes[0].key, writes[1].key);
  assert.deepEqual(writes[0].body, writes[1].body); assert.equal(writes[0].account, 'synthetic-alice');
  assert.equal(records.length, 2); assert.equal(store.getState().pending, null);
});

test('HTTP 409 after another client edits a lost-ACK create retains its original intent', async () => {
  transportMode = 'lose-create'; store.getState().setNote('new note');
  await store.getState().saveNote(); await settleReads(); const key = writes[0].key;
  records[0] = { ...records[0], content: 'changed elsewhere', revision: 1 };
  await store.getState().retry(); await settleReads();
  assert.equal(writes.length, 2); assert.equal(store.getState().pending.key, key);
  assert.match(store.getState().error, /已存在且内容发生变化/); assert.equal(records.length, 2);
});

test('HTTP lost correction receipt reconciles by GET without a second POST', async () => {
  await store.getState().refresh(); store.getState().beginEdit(records[0]);
  store.getState().setEditText('changed'); transportMode = 'lose-correct';
  await store.getState().saveCorrection(); await settleReads();
  assert.equal(writes.length, 1); assert.ok(store.getState().pending);
  await store.getState().retry(); await settleReads();
  assert.equal(writes.length, 1); assert.equal(store.getState().pending, null); assert.equal(records[0].revision, 1);
});
