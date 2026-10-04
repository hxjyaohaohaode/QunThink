import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
globalThis.__taskTest = { user: 'alice', get: async () => ({ data: [] }), post: async () => ({ data: {} }), patch: async () => ({ data: {} }), delete: async () => ({ data: {} }) };
const result = await build({ entryPoints: [resolve(root, 'src/stores/tasksStore.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'task-boundaries', setup(build) {
  build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
  build.onResolve({ filter: /utils\/cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
  build.onResolve({ filter: /^\.\/modelsStore$/ }, () => ({ path: 'models', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `export const axiosInstance = Object.fromEntries(['get','post','patch','delete'].map(method => [method, (...args) => globalThis.__taskTest[method](...args)]));` : path === 'cache' ? 'export const getCacheUserId = () => globalThis.__taskTest.user;' : 'export const requestError = error => error.message;', loader: 'js' }));
}}] });
const { useTasksStore: store } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const input = { title: '中文任务', prompt: '私密输入不应进入诊断', category: 'work', model_id: null, group_id: null, source_message_id: null, run_at: null, repeat_minutes: null, auto_run: false };
const task = { id: 'task-a', ...input, status: 'pending', history: [], result: '', run_id: 'run-a' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { store.getState().cleanup(); globalThis.__taskTest.user = 'alice'; for (const method of ['post', 'patch', 'delete']) globalThis.__taskTest[method] = async () => ({ data: task }); globalThis.__taskTest.get = async () => ({ data: [] }); });
test('newer task reads win over delayed polling', async () => {
  const reads = []; globalThis.__taskTest.get = () => new Promise(resolve => reads.push(resolve));
  const older = store.getState().fetch(), newer = store.getState().fetch();
  reads[1]({ data: [{ ...task, title: '新版' }] }); await newer;
  reads[0]({ data: [{ ...task, title: '旧版' }] }); await older;
  assert.equal(store.getState().tasks[0].title, '新版');
});
test('create preserves exact intent through lost acknowledgment and rejects changed replay', async () => {
  const calls = []; globalThis.__taskTest.post = async (...args) => { calls.push(args); if (calls.length === 1) throw new Error('Network error with secret'); return { data: task }; };
  await assert.rejects(store.getState().create(input));
  assert.equal(store.getState().uncertainCreate, true);
  await assert.rejects(store.getState().create({ ...input, title: '新内容' }), /先按原内容重试/);
  assert.equal(calls.length, 1);
  const saved = await store.getState().create(input);
  assert.equal(saved.id, task.id);
  assert.equal(calls[0][2].headers['Idempotency-Key'], calls[1][2].headers['Idempotency-Key']);
  assert.equal(store.getState().uncertainCreate, false);
});
test('definitive validation error unlocks draft for correction', async () => {
  const keys = []; globalThis.__taskTest.post = async (_, __, config) => { keys.push(config.headers['Idempotency-Key']); throw Object.assign(new Error('validation'), { status: 400 }); };
  await assert.rejects(store.getState().create(input));
  assert.equal(store.getState().uncertainCreate, false);
  await assert.rejects(store.getState().create({ ...input, title: '改正' }));
  assert.notEqual(keys[0], keys[1]);
});
test('double create sends once; account switch rejects late receipt and does not fetch for new account', async () => {
  let complete, writes = 0, reads = 0;
  globalThis.__taskTest.get = async () => { reads++; return { data: [] }; };
  globalThis.__taskTest.post = () => { writes++; return new Promise(resolve => { complete = resolve; }); };
  const first = store.getState().create(input);
  await assert.rejects(store.getState().create(input), /正在保存/);
  assert.equal(writes, 1);
  store.getState().cleanup(); globalThis.__taskTest.user = 'bob';
  complete({ data: task }); await assert.rejects(first, /账号已切换/);
  assert.equal(reads, 0); assert.deepEqual(store.getState().tasks, []); assert.equal(store.getState().composerDraft.prompt, '');
});
test('run retry reuses key after timeout and cancellation can be sent while request is pending', async () => {
  const keys = []; let complete;
  globalThis.__taskTest.post = async (_, __, config) => { keys.push(config.headers['Idempotency-Key']); if (keys.length === 1) throw new Error('timeout'); return new Promise(resolve => { complete = resolve; }); };
  await assert.rejects(store.getState().run(task.id));
  const retry = store.getState().run(task.id); await tick();
  assert.equal(keys[0], keys[1]);
  await assert.rejects(store.getState().run(task.id), /正在处理/);
  let cancelled = false; globalThis.__taskTest.patch = async (path, payload) => { assert.equal(payload.status, 'cancelled'); cancelled = true; return { data: task }; };
  await store.getState().update(task.id, { status: 'cancelled' }); assert.equal(cancelled, true);
  complete({ data: { ...task, status: 'outcome_unknown' } }); await retry;
});
test('resolve unknown names the exact displayed run', async () => {
  store.setState({ tasks: [task] });
  globalThis.__taskTest.post = async (path, payload) => { assert.equal(payload.run_id, task.run_id); return { data: task }; };
  await store.getState().resolveUnknown(task.id, task.run_id, 'allow_retry');
});
test('terminal polling receipt clears admitted retry key before intentional regeneration', async () => {
  let key; const sent = [];
  globalThis.__taskTest.post = async (_, __, config) => { key = config.headers['Idempotency-Key']; sent.push(key); if (sent.length === 1) throw new Error('lost response'); return { data: { ...task, status:'running', run_request_id:key } }; };
  globalThis.__taskTest.get = async () => ({data:[]});
  await assert.rejects(store.getState().run(task.id)); await store.getState().run(task.id);
  assert.equal(sent[0], sent[1]);
  globalThis.__taskTest.get = async () => ({data:[{ ...task, status:'needs_review', run_request_id:key }]});
  await store.getState().fetch(); await store.getState().run(task.id);
  assert.notEqual(sent[1], sent[2]);
});
