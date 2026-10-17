import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Window } from 'happy-dom';
import { createTaskPlanningLegacySample, verifyTaskPlanningLegacySources } from './fixtures/generate-task-planning-legacy.mjs';
const root = resolve(import.meta.dirname, '..'), window = new Window({ url: 'https://qunthink.test/' });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, HTMLElement: window.HTMLElement, Node: window.Node, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
// IndexedDB protocol stand-in, real WebCrypto. These are NOT native browser tests.
const databases = new Map();
globalThis.indexedDB = { open(name) { const request = {}; queueMicrotask(() => { let values = databases.get(name), fresh = !values; if (!values) { values = new Map(); databases.set(name, values); } const db = { close() {}, createObjectStore() {}, transaction() { const tx = {}; tx.objectStore = () => ({ get(key) { const r = {}; queueMicrotask(() => { r.result = values.get(key); r.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); }); return r; }, put(value, key) { values.set(key, value); } }); return tx; } }; request.result = db; if (fresh) request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; } };
globalThis.__metadata = {};
const built = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import {createRoot} from 'react-dom/client';import {act} from 'react';import {TaskMetadata} from './src/components/Writing/TaskMetadata';import {useTasksStore} from './src/stores/tasksStore';export {act,useTasksStore};export * from './src/utils/taskRecovery';export * from './src/utils/taskMetadataRecovery';export async function mount(el,id){const root=createRoot(el);await act(async()=>root.render(<TaskMetadata taskId={id}/>));return root;}` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', plugins: [{ name: 'metadata-fixture', setup(build) {
 build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
 build.onResolve({ filter: /(?:utils\/|\.\/)cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
 build.onResolve({ filter: /^\.\/modelsStore$/ }, () => ({ path: 'models', namespace: 'mock' }));
 build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents: path === 'api' ? `export const getAuthGeneration=()=>globalThis.__metadata.auth;export const axiosInstance=Object.fromEntries(['get','post','put','patch','delete'].map(method=>[method,(...args)=>globalThis.__metadata[method](...args)]));` : path === 'cache' ? `export const getCacheUserId=()=>globalThis.__metadata.user;` : `export const requestError=error=>error.message;` }));
} }] });
const folder = await mkdtemp(join(tmpdir(), 'qunthink-metadata-react-')); await writeFile(join(folder, 'fixture.mjs'), built.outputFiles[0].text);
const fixture = await import(pathToFileURL(join(folder, 'fixture.mjs')).href);
const { act, mount, useTasksStore: store, setWritingPreferences, clearWritingContent, readMetadataJournal, persistMetadataJournal, textHash, canonicalMetadata, metadataContentKey, saveWritingContent } = fixture;
const id = '10000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002';
const makeTask = (extra = {}) => ({ id, title: '原任务', prompt: 'PRIVATE-PROMPT', status: 'pending', category: 'work', auto_run: false, run_at: null, metadata_revision: 0, dependency_ids: [], dependency_revision: 0, history: [], result: 'PRIVATE-RESULT', ...extra });
const receipt = (payload, task = makeTask({ ...payload.changes, metadata_revision: payload.expected_revision + 1 })) => ({ data: { receipt: { id: payload.client_request_id, task_id: id, operation: 'metadata', status: 'succeeded', committed_revision: payload.expected_revision + 1 }, task, ...(task ? {} : { task_deleted: true }) } });
const cancelled = item => ({ data: { receipt: { id: item.key, task_id: id, operation: 'metadata', status: 'cancelled', committed_revision: null }, task: tasks[0] || null, ...(!tasks[0] ? { task_deleted: true } : {}) } });
const failure = (status, code = '') => Object.assign(new Error('request failed'), { response: { status, data: { code } } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.fail('asynchronous action did not dispatch'); }
let tasks, container, mounted;
const button = label => [...container.querySelectorAll('button')].find(el => el.textContent === label);
async function open() { mounted = await mount(container, id); }
async function close() { if (mounted) await act(async () => mounted.unmount()); mounted = null; }
function draft(changes = { title: '私密标题-NEW', auto_run: true, run_at: '2030-02-03T04:05:00.000Z' }) { store.getState().editMetadata(id, changes); }
async function lost() { globalThis.__metadata.put = async () => { throw new Error('lost ACK'); }; draft(); await assert.rejects(store.getState().saveMetadata(id)); return store.getState().metadataIntents[id]; }
// Keep the real Axios friendly-error interceptor in this second fixture. The
// ordinary transport stub above deliberately tests raw Axios response shapes.
const realTransportBuilt = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import {createRoot} from 'react-dom/client';import {act} from 'react';import {TaskMetadata} from './src/components/Writing/TaskMetadata';import {TaskDependencies} from './src/components/Writing/TaskDependencies';export {act};export {useTasksStore} from './src/stores/tasksStore';export {axiosInstance,confirmAuthIdentity} from './src/services/api';export async function mount(el,id){const root=createRoot(el);await act(async()=>root.render(<TaskMetadata taskId={id}/>));return root;}export async function mountDependencies(el,id){const root=createRoot(el);await act(async()=>root.render(<TaskDependencies taskId={id}/>));return root;}` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_AUTH_MODE': '"session"' }, plugins: [{ name: 'real-metadata-transport', setup(build) {
 build.onResolve({ filter: /(?:utils\/|\.\/)cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
 build.onResolve({ filter: /^\.\/modelsStore$/ }, () => ({ path: 'models', namespace: 'mock' }));
 build.onResolve({ filter: /\.\/runtimeConfig$/ }, () => ({ path: 'runtime', namespace: 'mock' }));
 build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents: path === 'models' ? `export const requestError=error=>error.message;` : path === 'cache' ? `export const getCacheUserId=()=>globalThis.__metadata.user;` : `export const getApiBaseUrl=()=>'/api';export const getApiBaseUrlCandidates=()=>['/api'];export const rememberBackendOrigin=()=>{};` }));
} }] });
await writeFile(join(folder, 'real-transport.mjs'), realTransportBuilt.outputFiles[0].text);
const realTransport = await import(pathToFileURL(join(folder, 'real-transport.mjs')).href);

beforeEach(async () => {
 await close(); container?.remove(); localStorage.clear(); databases.clear(); store.getState().cleanup(); tasks = [makeTask()];
 globalThis.__metadata = { user: 'alice', auth: 1, get: async path => { if (path === '/tasks') return { data: tasks }; throw failure(404); }, put: async (_, payload) => { const result = receipt(payload); tasks[0] = result.data.task; return result; }, post: async () => { throw new Error('MODEL-MUST-NOT-RUN'); }, patch: async () => { throw new Error('NO-BARE-PATCH'); } };
 store.setState({ tasks }); container = document.createElement('div'); document.body.append(container);
});
after(async () => { await close(); window.close(); await rm(folder, { recursive: true, force: true }); });
test('React panel edits three values and retains draft across close/reopen without persisting text', async () => {
 await open(); await act(async () => draft()); assert.equal(container.querySelectorAll('input').length, 4); await close(); await open(); assert.equal(container.querySelector('input').value, '私密标题-NEW'); assert.equal(button('保存任务设置').disabled, false); assert.equal(localStorage.length, 0);
});
test('double click sends one guarded command, freezes controls, never writes private plaintext', async () => {
 let resolve, calls = []; globalThis.__metadata.put = (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); };
 await open(); await act(async () => draft()); await act(async () => { button('保存任务设置').click(); button('保存任务设置')?.click(); await until(() => calls.length); });
 assert.equal(calls.length, 1); assert.equal(container.querySelector('fieldset').disabled, true); assert.equal(calls[0][2].headers['X-Expected-User-Id'], 'alice'); assert.deepEqual(Object.keys(calls[0][1].changes).sort(), ['auto_run', 'run_at', 'title']); assert.doesNotMatch(JSON.stringify(Object.values(localStorage)), /私密标题|2030-02|PRIVATE/);
 await act(async () => { tasks[0] = receipt(calls[0][1]).data.task; resolve(receipt(calls[0][1])); await until(() => !store.getState().pending[id]); }); assert.equal(store.getState().metadataIntents[id], undefined); assert.equal(store.getState().metadataDrafts[id], undefined); assert.equal(store.getState().metadataNotices[id], '任务设置已确认保存。'); assert.match(container.textContent, /任务设置已确认保存。/); assert.doesNotMatch(container.textContent, /当前草稿尚未保存/);
});
test('recovery off reloads only ID; query404 never permits replacement or blind replay', async () => {
 const item = await lost(); store.getState().cleanup(); await store.getState().fetch(); assert.equal(store.getState().metadataIntents[id].key, item.key); assert.equal(store.getState().metadataIntents[id].payload, undefined); await assert.rejects(store.getState().verifyMetadata(id, item.key)); await assert.rejects(store.getState().saveMetadata(id), /不能换编号覆盖/); await assert.rejects(store.getState().retryMetadata(id, item.key), /只能核验或结束/); await open(); assert.equal(button('按原设置同号重试').disabled, true);
});
test('opted-in AES-GCM restores exact payload and same-key retry after reload', async () => {
 setWritingPreferences({ recoverDrafts: true, offlineCopies: false }); const item = await lost(); assert.doesNotMatch(JSON.stringify(Object.values(localStorage)), /私密标题|2030-02|PRIVATE/); store.getState().cleanup(); await store.getState().fetch(); assert.deepEqual(store.getState().metadataIntents[id].payload, item.payload); let sent; globalThis.__metadata.put = async (_, payload) => { sent = payload; tasks[0] = receipt(payload).data.task; return receipt(payload); }; await store.getState().retryMetadata(id, item.key); assert.deepEqual(sent, item.payload); assert.equal(readMetadataJournal().length, 0);
});
test('tampered encrypted payload is never replayable; UUID remains queryable', async () => {
 setWritingPreferences({ recoverDrafts: true, offlineCopies: false }); const item = await lost(); await saveWritingContent(metadataContentKey(item), { body: JSON.stringify({ ...item.payload, changes: { title: '被改动' } }), baseRevisionId: null, savedAt: item.createdAt }); store.getState().cleanup(); await store.getState().fetch(); assert.equal(store.getState().metadataIntents[id].payload, undefined); await assert.rejects(store.getState().retryMetadata(id, item.key)); assert.equal(readMetadataJournal().length, 1);
});
test('turning recovery off/logout clears private content but preserves unresolved UUID', async () => {
 setWritingPreferences({ recoverDrafts: true, offlineCopies: false }); const item = await lost(); setWritingPreferences({ recoverDrafts: false, offlineCopies: false }); clearWritingContent(); store.getState().cleanup(); await store.getState().fetch(); assert.equal(store.getState().metadataIntents[id].key, item.key); assert.equal(store.getState().metadataIntents[id].payload, undefined);
});
for (const status of [409, 404, 410, 503, 428, 400, 403]) test(`dispatched ${status} preserves original UUID`, async () => {
 draft(); globalThis.__metadata.put = async () => { throw failure(status, status === 409 ? 'TASK_METADATA_REVISION_CONFLICT' : 'TASK_METADATA_NOT_FOUND'); }; await assert.rejects(store.getState().saveMetadata(id)); assert.ok(store.getState().metadataIntents[id]); assert.equal(readMetadataJournal().length, 1); if (status === 428) assert.match(store.getState().metadataErrors[id], /刷新或升级/);
});
test('conflict requires close and explicit reread; no silent rebase of frozen draft', async () => {
 globalThis.__metadata.put = async () => { tasks[0] = makeTask({ title: '另一标签新标题', metadata_revision: 1 }); throw failure(409, 'TASK_METADATA_REVISION_CONFLICT'); }; draft(); await assert.rejects(store.getState().saveMetadata(id)); const item = store.getState().metadataIntents[id]; globalThis.__metadata.post = async () => cancelled(item); await store.getState().closeMetadata(id, item.key); assert.equal(store.getState().metadataDrafts[id].revision, 0); draft({ title: '不能静默重放' }); assert.equal(store.getState().metadataDrafts[id].values.title, '私密标题-NEW'); await assert.rejects(store.getState().saveMetadata(id)); await store.getState().resetMetadata(id); draft({ title: '明确新编辑' }); assert.equal(store.getState().metadataDrafts[id].revision, 1);
});
test('ordinary refresh never rebases dirty draft', async () => {
 draft(); tasks[0] = makeTask({ title: '更新标题', metadata_revision: 2 }); await store.getState().fetch(); assert.equal(store.getState().metadataDrafts[id].values.title, '私密标题-NEW'); assert.equal(store.getState().metadataDrafts[id].revision, 0); await assert.rejects(store.getState().saveMetadata(id), /读取最新/); await open(); assert.equal(container.querySelector('fieldset').disabled, true);
});
for (const [name, change] of Object.entries({ wrongId: reply => reply.data.receipt.id = other, wrongTask: reply => reply.data.receipt.task_id = other, wrongOperation: reply => reply.data.receipt.operation = 'dependencies', wrongRevision: reply => reply.data.receipt.committed_revision = 0, wrongContent: reply => reply.data.task.title = '错内容', wrongDeleted: reply => reply.data.task_deleted = true })) test(`invalid receipt remains unresolved: ${name}`, async () => {
 draft(); globalThis.__metadata.put = async (_, payload) => { const reply = receipt(payload); change(reply); return reply; }; await assert.rejects(store.getState().saveMetadata(id), /回执/); assert.ok(store.getState().metadataIntents[id]);
});
test('historical ACK cannot downgrade newer projection', async () => {
 let finish, payload; globalThis.__metadata.put = (_, body) => { payload = body; return new Promise(resolve => { finish = resolve; }); }; draft(); const work = store.getState().saveMetadata(id); await until(() => finish); tasks[0] = makeTask({ title: '更新到第三版', metadata_revision: 3 }); await store.getState().fetch(); finish(receipt(payload)); await work; assert.equal(store.getState().tasks[0].metadata_revision, 3); assert.equal(store.getState().tasks[0].title, '更新到第三版');
});
test('A-B-A epoch rejects delayed receipt without new-account fetch or content', async () => {
 let finish, payload, reads = 0; globalThis.__metadata.put = (_, body) => { payload = body; return new Promise(resolve => { finish = resolve; }); }; draft(); const work = store.getState().saveMetadata(id); await until(() => finish); store.getState().cleanup(); globalThis.__metadata.user = 'bob'; globalThis.__metadata.auth++; globalThis.__metadata.get = async () => { reads++; return { data: [] }; }; await store.getState().fetch(); assert.deepEqual(store.getState().metadataIntents, {}); store.getState().cleanup(); globalThis.__metadata.user = 'alice'; globalThis.__metadata.auth++; const before = reads; finish(receipt(payload)); await assert.rejects(work, /账号已切换/); assert.equal(reads, before); assert.deepEqual(store.getState().tasks, []); assert.deepEqual(store.getState().metadataIntents, {});
});
test('deleted task exposes recovery; query never recreates it', async () => {
 const item = await lost(); tasks = []; await store.getState().fetch(); await open(); assert.match(container.textContent, /不会重新创建/); assert.ok(button('核对并结束原设置请求')); globalThis.__metadata.get = async path => path === '/tasks' ? { data: [] } : receipt(item.payload, null); await act(async () => store.getState().verifyMetadata(id, item.key)); assert.deepEqual(store.getState().tasks, []); assert.equal(store.getState().metadataIntents[id], undefined); assert.equal(store.getState().metadataNotices[id], '原请求已确认；任务已删除，没有重新创建。');
});
test('close lost ACK/malformed cancel retain key; authoritative close cannot alter saved values', async () => {
 const item = await lost(); globalThis.__metadata.post = async () => { throw new Error('lost close'); }; await assert.rejects(store.getState().closeMetadata(id, item.key)); globalThis.__metadata.post = async () => { const reply = cancelled(item); reply.data.receipt.committed_revision = 1; return reply; }; await assert.rejects(store.getState().closeMetadata(id, item.key)); globalThis.__metadata.post = async (path, body) => { assert.equal(path, `/tasks/${id}/metadata/commands/${item.key}/close`); assert.deepEqual(body, {}); return cancelled(item); }; await store.getState().closeMetadata(id, item.key); assert.equal(tasks[0].title, '原任务'); assert.equal(readMetadataJournal().length, 0); assert.equal(store.getState().metadataNotices[id], '原请求已结束。已保存设置保持不变，请读取最新设置后明确重新编辑。');
});
test('close already-successful returns original receipt without undoing newer settings', async () => {
 const item = await lost(); tasks[0] = makeTask({ title: '更新第三版', metadata_revision: 3 }); globalThis.__metadata.post = async () => receipt(item.payload, tasks[0]); await store.getState().closeMetadata(id, item.key); assert.equal(store.getState().tasks[0].title, '更新第三版'); assert.equal(store.getState().metadataIntents[id], undefined);
});
test('corrupt or quota-blocked journal stops dispatch but allows ordinary reads', async () => {
 let calls = 0; globalThis.__metadata.put = async () => { calls++; }; localStorage.setItem('qunthink_metadata_command_v1_alice:' + id + ':bad', '{broken'); await store.getState().fetch(); assert.equal(store.getState().tasks.length, 1); await assert.rejects(store.getState().saveMetadata(id), /无法读取/); assert.equal(calls, 0); localStorage.clear(); store.getState().cleanup(); store.setState({ tasks }); draft(); const original = globalThis.localStorage; globalThis.localStorage = { length: 0, key() {}, getItem() { return null; }, setItem() { throw new Error('quota'); } }; try { await assert.rejects(store.getState().saveMetadata(id), /尚未发送/); assert.equal(calls, 0); } finally { globalThis.localStorage = original; }
});
test('running/unknown lock settings; barePATCH rejected; exact cancellation unchanged', async () => {
 for (const status of ['running', 'outcome_unknown']) { tasks[0] = makeTask({ status }); store.setState({ tasks }); draft(); assert.equal(store.getState().metadataDrafts[id], undefined); await open(); assert.equal(container.querySelector('fieldset').disabled, true); await close(); } await assert.rejects(store.getState().update(id, { title: 'bare' }), /刷新或升级/); await assert.rejects(store.getState().update(id, { status: 'cancelled', auto_run: false })); let sent; globalThis.__metadata.patch = async (_, body) => { sent = body; return { data: tasks[0] }; }; await store.getState().update(id, { status: 'cancelled', run_id: other }); assert.deepEqual(sent, { status: 'cancelled', run_id: other });
});
test('foreign keys remain invisible; pending metadata blocks run and acceptance', async () => {
 const item = await lost(); await assert.rejects(store.getState().run(id), /任务设置/); await assert.rejects(store.getState().accept(id, other), /任务设置/); store.getState().cleanup(); globalThis.__metadata.user = 'bob'; globalThis.__metadata.auth++; await store.getState().fetch(); assert.deepEqual(readMetadataJournal(), []); assert.deepEqual(store.getState().metadataQueues, {}); globalThis.__metadata.user = 'alice'; globalThis.__metadata.auth++; assert.equal(readMetadataJournal()[0].key, item.key);
});
test('two independent tab empty-read race preserves UUID queue; settling one cannot delete interleaved third key', async () => {
 await writeFile(join(folder, 'tab2.mjs'), built.outputFiles[0].text); const { useTasksStore: tab } = await import(pathToFileURL(join(folder, 'tab2.mjs')).href); tab.setState({ tasks }); tab.getState().editMetadata(id, { title: '第二标签私密文字' }); draft(); globalThis.__metadata.put = async () => { throw new Error('lost'); }; await Promise.all([assert.rejects(store.getState().saveMetadata(id)), assert.rejects(tab.getState().saveMetadata(id))]); assert.equal(readMetadataJournal().length, 2); store.getState().cleanup(); await store.getState().fetch(); assert.equal(store.getState().metadataQueues[id].length, 2);
 const first = store.getState().metadataIntents[id], payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '第三标签' } }, third = { taskId: id, key: payload.client_request_id, revision: 0, fields: ['title'], payloadHash: await textHash(canonicalMetadata(payload)), createdAt: new Date().toISOString() }; const original = globalThis.localStorage; let inserted = false;
 globalThis.localStorage = { get length() { return original.length; }, key: n => original.key(n), getItem: key => original.getItem(key), setItem: (key, value) => original.setItem(key, value), removeItem(key) { if (!inserted && key.startsWith('qunthink_metadata_command_v1')) { inserted = true; persistMetadataJournal(third); } original.removeItem(key); } }; globalThis.__metadata.post = async () => cancelled(first); try { await store.getState().closeMetadata(id, first.key); } finally { globalThis.localStorage = original; } assert.equal(readMetadataJournal().length, 2); assert.equal(store.getState().metadataQueues[id].length, 2); assert.ok(readMetadataJournal().some(value => value.key === third.key)); assert.ok(readMetadataJournal().every(value => value.key !== first.key)); tab.getState().cleanup();
});
test('title trim freezes canonical request and receipt hash; normalized no-op still commits one revision', async () => {
 for (const title of ['  新标题  ', ' 原任务 ', 'x'.repeat(150)]) {
  localStorage.clear(); store.getState().cleanup(); tasks = [makeTask()]; store.setState({ tasks }); draft({ title }); let sent;
  globalThis.__metadata.put = async (_, body) => { sent = body; tasks[0] = receipt(body).data.task; return receipt(body); }; await store.getState().saveMetadata(id); assert.equal(sent.changes.title, title.trim()); assert.equal(store.getState().metadataIntents[id], undefined); assert.equal(tasks[0].metadata_revision, 1);
 }
});
test('whitespace-only or over150 title fails before request while draft is retained', async () => {
 let writes = 0; globalThis.__metadata.put = async () => { writes++; }; for (const title of ['   ', 'x'.repeat(151)]) { store.getState().cleanup(); store.setState({ tasks }); draft({ title }); await assert.rejects(store.getState().saveMetadata(id), /有效标题/); assert.equal(store.getState().metadataDrafts[id].values.title, title); } assert.equal(writes, 0);
});
test('invalid enabled scheduling and completed task cannot dispatch metadata command', async () => {
 draft({ auto_run: true }); await assert.rejects(store.getState().saveMetadata(id), /下次生成时间/); store.getState().cleanup(); tasks=[makeTask({status:'completed'})];store.setState({tasks});draft({auto_run:true,run_at:'2030-01-01T00:00:00.000Z'});await assert.rejects(store.getState().saveMetadata(id),/不能启用/);
});
test('another tab success cannot erase this tabs unsent dirty metadata draft', async () => {
 await open(); await act(async () => draft({ title: '本标签尚未提交的私密草稿' }));
 const payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '另一标签已经提交' } };
 persistMetadataJournal({ taskId: id, key: payload.client_request_id, revision: 0, fields: ['title'], payloadHash: await textHash(canonicalMetadata(payload)), createdAt: new Date().toISOString() });
 tasks[0] = receipt(payload).data.task; globalThis.__metadata.get = async path => path === '/tasks' ? { data: tasks } : receipt(payload, tasks[0]);
 await act(async () => store.getState().fetch()); await act(async () => { button('核验任务设置请求').click(); await until(() => !store.getState().metadataIntents[id]); });
 assert.equal(store.getState().metadataDrafts[id].values.title, '本标签尚未提交的私密草稿'); assert.equal(store.getState().metadataDrafts[id].revision, 0); assert.equal(store.getState().metadataConflicts[id], true); await assert.rejects(store.getState().saveMetadata(id), /读取最新/);
 assert.equal(store.getState().metadataNotices[id], '原请求已确认保存，当前草稿尚未保存。'); assert.match(container.textContent, /原请求已确认保存，当前草稿尚未保存。/); assert.equal(container.querySelector('input').value, '本标签尚未提交的私密草稿'); assert.equal(button('保存任务设置').disabled, true);
});


for (const [name, changes, savedChanges, newerChanges, unsaved] of [
 ['no local draft', null, {}, null, false],
 ['unchanged draft shell', {}, {}, null, false],
 ['draft returned to base', { title: '原任务' }, {}, null, false],
 ['title whitespace only', { title: ' 原任务 ' }, {}, null, false],
 ['same normalized saved title', { title: '  另一标签已经提交  ' }, {}, null, false],
 ['untouched fields changed remotely', { title: '另一标签已经提交' }, { auto_run: true, run_at: '2030-02-03T04:05:00.000Z' }, null, false],
 ['same saved planning priority', { priority: 'high' }, { priority: 'high' }, null, false],
 ['different planning priority', { priority: 'high' }, { priority: 'low' }, null, true],
 ['same saved zero estimate', { estimated_minutes: 0 }, { estimated_minutes: 0 }, null, false],
 ['untouched estimate changed remotely', { title: '另一标签已经提交' }, { estimated_minutes: 20 }, null, false],
 ['different auto-run draft', { auto_run: true }, {}, null, true],
 ['different schedule draft', { run_at: '2030-02-03T04:05:00.000Z' }, {}, null, true],
 ['same saved schedule draft', { run_at: '2030-02-03T04:05:00.000Z' }, { run_at: '2030-02-03T04:05:00.000Z' }, null, false],
 ['newer saved projection matches draft', { title: '更新标题' }, {}, { title: '更新标题' }, false],
 ['newer saved projection differs from draft', { title: '另一标签已经提交' }, {}, { title: '更新标题' }, true],
]) test(`metadata receipt notice distinguishes ${name}`, async () => {
 if (changes) draft(changes);
 const localDraft = store.getState().metadataDrafts[id];
 const payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '另一标签已经提交', ...savedChanges } };
 persistMetadataJournal({ taskId: id, key: payload.client_request_id, revision: 0, fields: Object.keys(payload.changes), payloadHash: await textHash(canonicalMetadata(payload)), createdAt: new Date().toISOString() });
 const reply = receipt(payload); tasks[0] = newerChanges ? { ...reply.data.task, ...newerChanges, metadata_revision: 2 } : reply.data.task;
 globalThis.__metadata.get = async path => path === '/tasks' ? { data: tasks } : reply;
 await store.getState().fetch(); await open(); await act(async () => store.getState().verifyMetadata(id, payload.client_request_id));
 const expected = unsaved ? '原请求已确认保存，当前草稿尚未保存。' : '任务设置已确认保存。';
 assert.equal(store.getState().metadataNotices[id], expected); assert.ok([...container.querySelectorAll('[role="status"]')].some(el => el.textContent === expected));
 assert.deepEqual(store.getState().metadataDrafts[id], localDraft); assert.equal(store.getState().tasks[0].metadata_revision, newerChanges ? 2 : 1);
 if (!unsaved) assert.doesNotMatch(container.textContent, /当前草稿尚未保存/);
});
test('metadata receipt notice never calls another command-bound draft unsaved', async () => {
 draft({ title: '另一笔结果未知的设置' });
 const payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '另一标签已经提交' } };
 const pending = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '另一笔结果未知的设置' } };
 for (const [index, body] of [payload, pending].entries()) persistMetadataJournal({ taskId: id, key: body.client_request_id, revision: 0, fields: ['title'], payloadHash: await textHash(canonicalMetadata(body)), createdAt: `2030-01-01T00:00:0${index}.000Z` });
 store.setState({ metadataDrafts: { [id]: { ...store.getState().metadataDrafts[id], commandKey: pending.client_request_id } } });
 const localDraft = store.getState().metadataDrafts[id]; tasks[0] = receipt(payload).data.task;
 globalThis.__metadata.get = async path => path === '/tasks' ? { data: tasks } : receipt(payload, tasks[0]);
 await store.getState().fetch(); await open(); await act(async () => store.getState().verifyMetadata(id, payload.client_request_id));
 assert.equal(store.getState().metadataNotices[id], '任务设置已确认保存。'); assert.doesNotMatch(container.textContent, /当前草稿尚未保存/); assert.match(container.textContent, /结果待核验/);
 assert.deepEqual(store.getState().metadataDrafts[id], localDraft); assert.equal(store.getState().metadataIntents[id].key, pending.client_request_id); assert.equal(store.getState().metadataQueues[id].length, 1);
});

for (const [status, code, message, expected] of [
 [409, 'TASK_METADATA_REVISION_CONFLICT', '任务设置已变化，请核对原请求，再明确比较并重新编辑', /任务设置已被修改/],
 [428, 'TASK_METADATA_PRECONDITION_REQUIRED', '任务设置需要带修订和原请求编号的新接口，请更新或刷新页面；未应用任何字段', /刷新或升级应用后核验原请求/],
]) test(`real Axios interceptor and React controls preserve metadata ${status} classification and exact recovery UUID`, async () => {
 const { axiosInstance, confirmAuthIdentity, useTasksStore: realStore, act: realAct, mount: realMount } = realTransport;
 realStore.getState().cleanup(); confirmAuthIdentity('alice'); document.cookie = 'XSRF-TOKEN=synthetic'; realStore.setState({ tasks });
 let payload, writes = 0, normalized;
 const interceptor = axiosInstance.interceptors.response.use(undefined, error => { normalized = { status: error.status, code: error.code, responsePresent: !!error.response }; return Promise.reject(error); });
 axiosInstance.defaults.adapter = config => {
  let data = tasks, resultStatus = 200;
  if (config.method === 'put') { writes++; payload = JSON.parse(config.data); resultStatus = status; data = { success: false, error: message, code }; if (status === 409) tasks = [makeTask({ title: '其他标签已保存', metadata_revision: 1 })]; }
  const response = { config, status: resultStatus, data, headers: {}, statusText: String(resultStatus) };
  return config.validateStatus(resultStatus) ? Promise.resolve(response) : Promise.reject(Object.assign(new Error('adapter-error'), { config, response }));
 };
 const rendered = await realMount(container, id);
 try {
  await realAct(async () => realStore.getState().editMetadata(id, { title: '需要完整保留的本地草稿' }));
  await realAct(async () => { button('保存任务设置').click(); await until(() => writes === 1 && !realStore.getState().pending[id]); });
  assert.deepEqual(normalized, { status, code, responsePresent: false }); assert.equal(writes, 1);
  assert.match(container.textContent, expected); assert.equal(realStore.getState().metadataIntents[id].key, payload.client_request_id); assert.equal(readMetadataJournal()[0].key, payload.client_request_id);
  assert.equal(realStore.getState().metadataDrafts[id].values.title, '需要完整保留的本地草稿'); assert.equal(realStore.getState().metadataDrafts[id].revision, 0); assert.equal(button('核对并结束原设置请求').disabled, false);
  if (status === 409) assert.equal(realStore.getState().metadataConflicts[id], true);
 } finally { axiosInstance.interceptors.response.eject(interceptor); await realAct(async () => rendered.unmount()); realStore.getState().cleanup(); }
});
test('raw Axios transport code never masks the structured metadata conflict code', async () => {
 draft({ title: '保留草稿' }); globalThis.__metadata.put = async () => { throw Object.assign(failure(409, 'TASK_METADATA_REVISION_CONFLICT'), { code: 'ERR_BAD_REQUEST' }); };
 await assert.rejects(store.getState().saveMetadata(id)); assert.equal(store.getState().metadataConflicts[id], true); assert.match(store.getState().metadataErrors[id], /任务设置已被修改/); assert.equal(readMetadataJournal().length, 1);
});
test('real Axios dependency409 classification preserves exact selected IDs, revision and recovery key', async () => {
 const { axiosInstance, confirmAuthIdentity, useTasksStore: realStore, act: realAct, mountDependencies } = realTransport;
 realStore.getState().cleanup(); confirmAuthIdentity('alice'); document.cookie = 'XSRF-TOKEN=synthetic'; tasks.push(makeTask({ id: other, title: '实际前置选项' })); realStore.setState({ tasks });
 let payload, writes = 0;
 axiosInstance.defaults.adapter = config => {
  let data = tasks, status = 200;
  if (config.method === 'put') { writes++; payload = JSON.parse(config.data); status = 409; data = { success: false, error: '前置任务关系已变化，请核对原请求', code: 'TASK_DEPENDENCY_REVISION_CONFLICT' }; tasks[0] = makeTask({ dependency_revision: 1 }); }
  const response = { config, status, data, headers: {}, statusText: String(status) }; return config.validateStatus(status) ? Promise.resolve(response) : Promise.reject(Object.assign(new Error('adapter-error'), { config, response }));
 };
 const rendered = await mountDependencies(container, id);
 try {
  await realAct(async () => [...container.querySelectorAll('label')].find(label => label.textContent === '实际前置选项').querySelector('input').click());
  await realAct(async () => { button('保存前置任务').click(); await until(() => writes === 1 && !realStore.getState().pending[id]); });
  assert.equal(realStore.getState().dependencyConflicts[id], true); assert.equal(realStore.getState().dependencyIntents[id].payload.client_request_id, payload.client_request_id); assert.deepEqual(realStore.getState().dependencyDrafts[id].ids, [other]); assert.equal(realStore.getState().dependencyDrafts[id].revision, 0); assert.equal(button('核对并结束原前置请求').disabled, false); assert.equal(writes, 1);
 } finally { await realAct(async () => rendered.unmount()); realStore.getState().cleanup(); }
});
test('real normalized dependency404 never gains permission to discard original request', async () => {
 const { axiosInstance, confirmAuthIdentity, useTasksStore: realStore } = realTransport; realStore.getState().cleanup(); confirmAuthIdentity('alice'); document.cookie = 'XSRF-TOKEN=synthetic'; realStore.setState({ tasks }); let payload, writes = 0;
 axiosInstance.defaults.adapter = config => { if (config.method !== 'put') return Promise.resolve({ config, status: 200, data: tasks, headers: {} }); writes++; payload = JSON.parse(config.data); return Promise.reject(Object.assign(new Error('adapter-error'), { config, response: { config, status: 404, data: { error: '任务不存在', code: 'TASK_DEPENDENCY_NOT_FOUND' }, headers: {} } })); };
 realStore.getState().editDependencies(id, [other]); await assert.rejects(realStore.getState().saveDependencies(id)); assert.equal(writes, 1); assert.equal(realStore.getState().dependencyIntents[id].payload.client_request_id, payload.client_request_id); assert.equal(realStore.getState().dependencyDrafts[id].revision, 0); realStore.getState().cleanup();
});
test('real metadata network failure keeps original UUID without automatic retry or conflict inference', async () => {
 const { axiosInstance, confirmAuthIdentity, useTasksStore: realStore } = realTransport; realStore.getState().cleanup(); confirmAuthIdentity('alice'); document.cookie = 'XSRF-TOKEN=synthetic'; realStore.setState({ tasks }); let payload, writes = 0;
 axiosInstance.defaults.adapter = config => { if (config.method !== 'put') return Promise.resolve({ config, status: 200, data: tasks, headers: {} }); writes++; payload = JSON.parse(config.data); return Promise.reject(Object.assign(new Error('TASK_METADATA_REVISION_CONFLICT is only text'), { config, code: 'ERR_NETWORK' })); };
 realStore.getState().editMetadata(id, { title: '未知必须保留' }); await assert.rejects(realStore.getState().saveMetadata(id)); assert.equal(writes, 1); assert.equal(realStore.getState().metadataIntents[id].key, payload.client_request_id); assert.equal(realStore.getState().metadataConflicts[id], false); assert.equal(readMetadataJournal()[0].key, payload.client_request_id); realStore.getState().cleanup();
});

// F14.1: these exercise mounted React and the real encrypted recovery path.
test('planning React controls distinguish unset and zero without changing the schedule', async () => {
 await open();
 const priority = container.querySelector('select[aria-label="设置优先级"]');
 const minutes = container.querySelector('input[aria-label="设置预计分钟"]');
 assert.ok(priority, 'priority control must be mounted'); assert.ok(minutes, 'estimated-minutes control must be mounted');
 assert.deepEqual([...priority.options].map(option => [option.value, option.textContent]), [['', '未设置'], ['low', '低'], ['medium', '中'], ['high', '高']]);
 assert.equal(priority.value, ''); assert.equal(minutes.value, '');
 await act(async () => { priority.value = 'high'; priority.dispatchEvent(new window.Event('change', { bubbles: true })); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(minutes, '0'); minutes.dispatchEvent(new window.Event('input', { bubbles: true })); });
 assert.deepEqual(store.getState().metadataDrafts[id].values, { title: '原任务', auto_run: false, run_at: null, priority: 'high', estimated_minutes: 0 });
 let sent; globalThis.__metadata.put = async (_, payload) => { sent = payload; tasks[0] = receipt(payload).data.task; return receipt(payload); };
 await act(async () => { button('保存任务设置').click(); await until(() => !!sent && !store.getState().pending[id]); });
 assert.deepEqual(sent.changes, { priority: 'high', estimated_minutes: 0 }); assert.equal(tasks[0].auto_run, false); assert.equal(tasks[0].run_at, null);
 await close(); await open(); assert.equal(container.querySelector('input[aria-label="设置预计分钟"]').value, '0');
});
test('planning AES recovery restores exact zero/null payload and original UUID after reload', async () => {
 setWritingPreferences({ recoverDrafts: true, offlineCopies: false });
 tasks[0] = makeTask({ priority: 'high', estimated_minutes: 30 }); store.setState({ tasks });
 draft({ priority: null, estimated_minutes: 0 });
 globalThis.__metadata.put = async () => { throw new Error('lost ACK'); }; await assert.rejects(store.getState().saveMetadata(id));
 const item = store.getState().metadataIntents[id]; assert.ok(item, 'new planning changes must dispatch through the recoverable metadata command');
 assert.deepEqual(item.payload.changes, { priority: null, estimated_minutes: 0 });
 store.getState().cleanup(); await store.getState().fetch(); assert.deepEqual(store.getState().metadataIntents[id].payload, item.payload);
 let sent; globalThis.__metadata.put = async (_, payload) => { sent = payload; tasks[0] = receipt(payload).data.task; return receipt(payload); };
 await store.getState().retryMetadata(id, item.key); assert.deepEqual(sent, item.payload); assert.equal(readMetadataJournal().length, 0);
});
for (const changes of [{ priority: 'high' }, { estimated_minutes: 0 }]) test(`planning local draft remains explicitly unsaved after another tab ACK: ${Object.keys(changes)[0]}`, async () => {
 draft(changes); const localDraft = store.getState().metadataDrafts[id];
 const payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '另一标签已保存' } };
 persistMetadataJournal({ taskId: id, key: payload.client_request_id, revision: 0, fields: ['title'], payloadHash: await textHash(canonicalMetadata(payload)), createdAt: new Date().toISOString() });
 tasks[0] = receipt(payload).data.task; globalThis.__metadata.get = async path => path === '/tasks' ? { data: tasks } : receipt(payload, tasks[0]);
 await store.getState().fetch(); await open(); await act(async () => store.getState().verifyMetadata(id, payload.client_request_id));
 assert.equal(store.getState().metadataNotices[id], '原请求已确认保存，当前草稿尚未保存。'); assert.deepEqual(store.getState().metadataDrafts[id], localDraft);
 assert.equal(button('保存任务设置').disabled, true);
});

for (const value of [null, 'low', 'medium', 'high']) test(`planning priority accepts exact supported value ${value}`, () => { assert.equal(fixture.validMetadataChanges({ priority: value }), true); });
for (const value of [null, 0, 1, 525600]) test(`planning estimate accepts exact supported value ${value}`, () => { assert.equal(fixture.validMetadataChanges({ estimated_minutes: value }), true); });
for (const [field, values] of Object.entries({ priority: ['', 'urgent', 0, false, [], {}, undefined], estimated_minutes: ['', '0', -1, 1.5, 525601, NaN, Infinity, false, [], {}, undefined] })) {
 for (const [index, value] of values.entries()) test(`planning ${field} rejects invalid type/range ${index}`, () => { assert.equal(fixture.validMetadataChanges({ [field]: value }), false); });
}
test('planning extension leaves historic three-field canonical bytes and hash untouched', async () => {
 const payload = { client_request_id: id, expected_revision: 0, changes: { title: '旧设置', run_at: null, auto_run: false } };
 const frozen = '{"client_request_id":"10000000-0000-4000-8000-000000000001","expected_revision":0,"changes":{"auto_run":false,"run_at":null,"title":"旧设置"}}';
 assert.equal(canonicalMetadata(payload), frozen); assert.equal(await textHash(canonicalMetadata(payload)), await textHash(frozen));
 assert.equal(fixture.validMetadataChanges(payload.changes), true);
});

for (const changes of [{ priority: null }, { estimated_minutes: null }, { estimated_minutes: 0 }]) test(`planning same-revision ACK missing ${Object.keys(changes)[0]} cannot settle the original command`, async () => {
 tasks[0] = makeTask({ priority: 'high', estimated_minutes: 30 }); store.setState({ tasks }); draft(changes);
 let dispatched; globalThis.__metadata.put = async (_, payload) => { dispatched = payload; const reply = receipt(payload); delete reply.data.task[Object.keys(changes)[0]]; return reply; };
 await assert.rejects(store.getState().saveMetadata(id), /回执/); assert.ok(dispatched, 'validation must reach the real command transport');
 assert.equal(store.getState().metadataIntents[id].key, dispatched.client_request_id); assert.equal(readMetadataJournal().length, 1);
});

test('planning legacy encrypted creation replay retains byte-exact old fields without default injection', async () => {
 setWritingPreferences({ recoverDrafts: true, offlineCopies: false });
 const legacy = { title: '旧版加密创建', prompt: '合成私密正文', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false };
 let original; globalThis.__metadata.post = async (_, payload, config) => { original = { payload: JSON.stringify(payload), key: config.headers['Idempotency-Key'] }; throw new Error('lost ACK'); };
 await assert.rejects(store.getState().create(legacy)); store.getState().cleanup(); tasks = []; await store.getState().fetch();
 assert.equal(store.getState().canRetryCreate(original.key), true); let replay;
 globalThis.__metadata.post = async (_, payload, config) => { replay = { payload: JSON.stringify(payload), key: config.headers['Idempotency-Key'] }; return { data: makeTask({ priority: null, estimated_minutes: null, ...payload, client_request_id: replay.key }) }; };
 await store.getState().retryCreate(original.key); assert.deepEqual(replay, original); assert.equal(replay.payload, JSON.stringify(legacy));
});
for (const [status, code] of [[403, 'OWNER_MISMATCH'], [409, 'TASK_METADATA_REVISION_CONFLICT']]) test(`planning ${status} preserves frozen null/zero intent and UUID without model calls`, async () => {
 tasks[0] = makeTask({ priority: 'low', estimated_minutes: 8 }); store.setState({ tasks }); draft({ priority: null, estimated_minutes: 0 });
 let sent; globalThis.__metadata.put = async (_, payload) => { sent = payload; throw failure(status, code); };
 await assert.rejects(store.getState().saveMetadata(id)); assert.ok(sent); const item = store.getState().metadataIntents[id];
 assert.deepEqual(item.payload.changes, { priority: null, estimated_minutes: 0 }); assert.equal(item.key, sent.client_request_id);
 assert.equal(!!store.getState().metadataConflicts[id], status === 409); assert.equal(readMetadataJournal().length, 1);
});
test('planning historical ACK preserves newer priority and estimate projection', async () => {
 let finish, payload; globalThis.__metadata.put = (_, body) => { payload = body; return new Promise(resolve => { finish = resolve; }); };
 draft({ priority: 'high', estimated_minutes: 0 }); const work = store.getState().saveMetadata(id); const pending = work.catch(() => {}); await until(() => finish);
 tasks[0] = makeTask({ priority: 'low', estimated_minutes: 525600, metadata_revision: 3 }); await store.getState().fetch(); finish(receipt(payload)); await work; await pending;
 assert.equal(store.getState().tasks[0].priority, 'low'); assert.equal(store.getState().tasks[0].estimated_minutes, 525600); assert.equal(store.getState().tasks[0].metadata_revision, 3);
});


test('planning public-533 sources are byte-pinned and static metadata contains provenance only', async () => {
 const { manifest, sources } = await verifyTaskPlanningLegacySources();
 assert.deepEqual(Object.keys(manifest).sort(), ['sourceCommit', 'sourceFiles']);
 assert.equal(sources.size, 6);
 assert.equal(manifest.sourceFiles['frontend/src/stores/tasksStore.ts'], '80236b6e96a38641349f82ff9db161c957ae2e1b6e7c938721200984de54aadc');
 assert.equal(manifest.sourceFiles['frontend/src/stores/taskMetadataSlice.ts'], '91442b45bc92c9eda7e78dc50f32924d7743692ea41a5a8d9d54d25d382cab61');
 assert.equal(manifest.sourceFiles['frontend/src/utils/taskMetadataRecovery.ts'], '5fcfb830c8103e0ecfe2d4e05a463f686915f873c2ba2ac5be9fe38f6de503f8');
 assert.equal(manifest.sourceFiles['frontend/src/utils/taskRecovery.ts'], '7cd45fb8b2e6ca9c5ee9eb84b2832962181dd4f982401cfa4558477f1d6435df');
});
test('planning public-533 samples use fresh non-extractable keys and never share runtime UUIDs or ciphertext', async () => {
 const previousStorage = globalThis.localStorage, previousDatabase = globalThis.indexedDB;
 const generateKey = crypto.subtle.generateKey, getRandomValues = crypto.getRandomValues;
 const first = await createTaskPlanningLegacySample(), second = await createTaskPlanningLegacySample();
 assert.ok(first.owner?.startsWith('fixture-task-planning-') && second.owner?.startsWith('fixture-task-planning-') && first.owner !== second.owner, 'Each invocation needs a fresh, explicitly synthetic fixture owner');
 assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(first.taskId) && first.taskId !== second.taskId, 'Each invocation needs a fresh fixture task UUID');
 assert.ok(globalThis.localStorage === previousStorage && globalThis.indexedDB === previousDatabase, 'The producer must restore the consumer storage environment');
 assert.ok(crypto.subtle.generateKey === generateKey && crypto.getRandomValues === getRandomValues, 'The producer must not replace WebCrypto randomness');
 assert.ok(first.key !== second.key && !first.key.extractable && !second.key.extractable, 'Each sample needs its own non-extractable key');
 // Node 22 uses the older name; newer WebCrypto implementations use the DOM name.
 await assert.rejects(crypto.subtle.exportKey('raw', first.key), error =>
   error instanceof DOMException && ['InvalidAccessException', 'InvalidAccessError'].includes(error.name));
 assert.ok(first.createReceipt.key !== second.createReceipt.key && first.metadataJournal.key !== second.metadataJournal.key, 'Each invocation needs fresh request UUIDs');
 const ciphertexts = sample => Object.entries(sample.storage).filter(([name]) => name.startsWith('qunthink_writing_v1_')).map(([, bytes]) => bytes);
 assert.ok(ciphertexts(first).length === 2 && ciphertexts(second).length === 2, 'Both legacy creation and metadata ciphertexts must exist');
 assert.ok(ciphertexts(first).every(bytes => !ciphertexts(second).includes(bytes)), 'Runtime ciphertexts must not be fixed across invocations');
 const [storageName, envelopeBytes] = Object.entries(first.storage).find(([name]) => name.startsWith('qunthink_writing_v1_'));
 const envelope = JSON.parse(envelopeBytes);
 await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(envelope.iv), additionalData: new TextEncoder().encode(storageName) }, second.key, new Uint8Array(envelope.data)), { name: 'OperationError' });
 assert.throws(() => JSON.stringify(first), /memory-only/);
 // Only boolean assertions touch keys/ciphertext, keeping failures value-free.
});
for (const [mode, generationFails, closeFails] of [
 ['normal generation', false, false], ['key generation failure', true, false],
 ['window close failure', false, true], ['key generation and window close failures', true, true],
]) test(`planning public-533 restores exact global descriptors after ${mode}`, async () => {
 const names = ['localStorage', 'indexedDB', '__taskPlanningLegacy'];
 const originalTransport = Object.getOwnPropertyDescriptor(globalThis, '__taskPlanningLegacy');
 const originalGenerateKey = Object.getOwnPropertyDescriptor(crypto.subtle, 'generateKey');
 const originalClose = Object.getOwnPropertyDescriptor(BrowserWindow.prototype, 'close');
 let closeCalls = 0, generationCalls = 0;
 // Exercise restoration of a pre-existing, non-enumerable/read-only property.
 Object.defineProperty(globalThis, '__taskPlanningLegacy', { configurable: true, writable: false, enumerable: false, value: Object.freeze({ sentinel: true }) });
 const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
 try {
  if (generationFails) Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true, value: async () => { generationCalls++; throw new Error('Injected key generation failure'); } });
  Object.defineProperty(BrowserWindow.prototype, 'close', { ...originalClose, value() { closeCalls++; if (closeFails) throw new Error('Injected close failure'); return originalClose.value.call(this); } });
  let failure;
  try { await createTaskPlanningLegacySample(); } catch (error) { failure = error; }
  if (generationFails) {
   assert.ok(generationCalls > 0, 'The real old producer must attempt key generation');
   assert.ok(failure?.message === 'Legacy producer did not emit both old-format AES-GCM samples', 'The primary producer error must survive any cleanup error');
  } else if (closeFails) assert.ok(failure?.message === 'Legacy producer cleanup failed', 'Cleanup-only failures must have a fixed, value-free diagnostic');
  else assert.ok(!failure, 'Normal generation must succeed');
  assert.ok(closeCalls === 1, 'Window cleanup must still be attempted exactly once');
  for (const name of names) {
   const actual = Object.getOwnPropertyDescriptor(globalThis, name), expected = previous.get(name);
   assert.ok(!!actual && Object.keys(actual).length === Object.keys(expected).length && Object.keys(expected).every(key => actual[key] === expected[key]), 'Every original global descriptor must be restored, even after cleanup throws');
  }
 } finally {
  // Restore test instrumentation even if a regression assertion fails.
  if (originalGenerateKey) Object.defineProperty(crypto.subtle, 'generateKey', originalGenerateKey); else delete crypto.subtle.generateKey;
  Object.defineProperty(BrowserWindow.prototype, 'close', originalClose);
  for (const name of names) Object.defineProperty(globalThis, name, previous.get(name));
  if (originalTransport) Object.defineProperty(globalThis, '__taskPlanningLegacy', originalTransport); else delete globalThis.__taskPlanningLegacy;
 }
});
function installLegacyTaskPlanningSample(legacy) {
 store.getState().cleanup(); globalThis.__metadata.user = legacy.owner; globalThis.__metadata.auth++;
 tasks = [structuredClone(legacy.task)]; store.setState({ tasks });
 databases.set(`qunthink-writing-key-${encodeURIComponent(legacy.owner)}`, new Map([['key', legacy.key]]));
 for (const [name, value] of Object.entries(legacy.storage)) localStorage.setItem(name, value);
}
test('planning candidate consumes fresh public-533 synthetic v1 journal/AES samples without changing same-run bytes', async () => {
 const legacy = await createTaskPlanningLegacySample();
 const taskId = legacy.taskId;
 assert.equal(legacy.sourceCommit, '533d7be3cdd47691602574ccac7c6524e7ed7ab3');
 assert.deepEqual(Object.keys(legacy.createPayload), ['title', 'prompt', 'category', 'model_id', 'group_id', 'run_at', 'repeat_minutes', 'auto_run']);
 assert.deepEqual(Object.keys(legacy.metadataPayload), ['client_request_id', 'expected_revision', 'changes']);
 assert.deepEqual(Object.keys(legacy.metadataPayload.changes), ['title', 'auto_run', 'run_at']);
 installLegacyTaskPlanningSample(legacy);
 await store.getState().fetch();
 for (const [name, bytes] of Object.entries(legacy.storage)) assert.ok(localStorage.getItem(name) === bytes, 'Hydration must not rewrite any same-run legacy storage bytes');
 const metadata = store.getState().metadataIntents[taskId]; assert.ok(metadata?.payload); assert.equal(canonicalMetadata(metadata.payload), legacy.metadataCanonical);
 const creation = store.getState().pendingCreates[0]; assert.ok(creation); assert.equal(store.getState().canRetryCreate(creation.key), true);
 assert.deepEqual(creation, legacy.createReceipt); assert.equal(metadata.key, legacy.metadataJournal.key); assert.equal(metadata.payload.client_request_id, legacy.metadataJournal.key);
 assert.equal(metadata.revision, legacy.metadataJournal.revision); assert.deepEqual(metadata.fields, legacy.metadataJournal.fields); assert.equal(metadata.createdAt, legacy.metadataJournal.createdAt);
 assert.equal(metadata.payloadHash, legacy.metadataJournal.payloadHash); assert.equal(metadata.payloadHash, await textHash(legacy.metadataCanonical)); assert.equal(creation.payloadHash, await textHash(JSON.stringify(legacy.createPayload)));
 let createSent, metadataSent;
 globalThis.__metadata.post = async (_, payload, config) => { createSent = { raw: JSON.stringify(payload), key: config.headers['Idempotency-Key'] }; assert.equal(config.headers['X-Expected-User-Id'], legacy.owner); return { data: { ...legacy.task, priority: null, estimated_minutes: null, ...payload, id: crypto.randomUUID(), client_request_id: createSent.key } }; };
 await store.getState().retryCreate(creation.key); assert.equal(createSent.raw, JSON.stringify(legacy.createPayload)); assert.equal(createSent.key, creation.key);
 globalThis.__metadata.put = async (path, payload, config) => {
  assert.equal(path, `/tasks/${taskId}/metadata`); assert.equal(config.headers['X-Expected-User-Id'], legacy.owner);
  metadataSent = payload; tasks[0] = { ...legacy.task, ...payload.changes, metadata_revision: payload.expected_revision + 1 };
  return { data: { receipt: { id: payload.client_request_id, task_id: taskId, operation: 'metadata', status: 'succeeded', committed_revision: payload.expected_revision + 1 }, task: tasks[0] } };
 };
 await store.getState().retryMetadata(taskId, metadata.key); assert.deepEqual(metadataSent, legacy.metadataPayload); assert.equal(canonicalMetadata(metadataSent), legacy.metadataCanonical); assert.equal(readMetadataJournal().length, 0);
 assert.equal(store.getState().pendingCreates.length, 0); assert.equal(store.getState().metadataIntents[taskId], undefined);
 assert.equal(Object.keys(localStorage).filter(name => name.startsWith('qunthink_writing_v1_')).length, 0);
});
test('planning public-533 synthetic samples stay isolated from another runtime fixture owner', async () => {
 const legacy = await createTaskPlanningLegacySample(); installLegacyTaskPlanningSample(legacy);
 store.getState().cleanup(); globalThis.__metadata.user = `fixture-isolation-${crypto.randomUUID()}`; globalThis.__metadata.auth++;
 tasks = []; await store.getState().fetch();
 assert.equal(store.getState().pendingCreates.length, 0); assert.equal(Object.keys(store.getState().metadataIntents).length, 0);
 assert.equal(store.getState().canRetryCreate(legacy.createReceipt.key), false);
 for (const [name, bytes] of Object.entries(legacy.storage)) assert.ok(localStorage.getItem(name) === bytes, 'Another owner must not read, settle, or rewrite the source sample');
});
for (const [kind, prefix, requiredField] of [
 ['creation', 'qunthink_command_v1_', 'payloadHash'], ['metadata', 'qunthink_metadata_command_v1_', 'revision'],
]) test(`planning public-533 synthetic ${kind} journal missing a required field fails closed`, async () => {
 const legacy = await createTaskPlanningLegacySample(); installLegacyTaskPlanningSample(legacy);
 const [name, bytes] = Object.entries(legacy.storage).find(([name]) => name.startsWith(prefix));
 const journal = JSON.parse(bytes); delete journal[requiredField]; const malformed = JSON.stringify(journal);
 localStorage.setItem(name, malformed);
 let sends = 0; globalThis.__metadata.post = globalThis.__metadata.put = async () => { sends++; throw new Error('Malformed journals must not dispatch'); };
 await store.getState().fetch();
 if (kind === 'creation') {
  assert.ok(store.getState().recoveryError, 'Malformed creation journals must block recovery');
  await assert.rejects(store.getState().retryCreate(legacy.createReceipt.key));
 } else {
  assert.ok(store.getState().metadataRecoveryError, 'Malformed metadata journals must block recovery');
  await assert.rejects(store.getState().retryMetadata(legacy.taskId, legacy.metadataJournal.key));
 }
 assert.equal(sends, 0); assert.ok(localStorage.getItem(name) === malformed, 'Malformed records must remain available for verification');
 for (const [key, value] of Object.entries(legacy.storage).filter(([name]) => name.startsWith('qunthink_writing_v1_'))) assert.ok(localStorage.getItem(key) === value, 'Failed-closed recovery must preserve ciphertext without diagnostic disclosure');
});

for (const input of ['-1', '1.5', '1e2', '  ', 'NaN', '525601', '99999999999999999999']) test(`planning mounted estimate rejects ${JSON.stringify(input)} without erasing typed intent or clearing server value`, async () => {
 tasks[0] = makeTask({ estimated_minutes: 30 }); store.setState({ tasks }); await open(); const el = container.querySelector('input[aria-label="设置预计分钟"]'); let writes = 0; globalThis.__metadata.put = async () => { writes++; };
 await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, input); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
 assert.equal(el.value, input); assert.equal(el.getAttribute('aria-invalid'), 'true'); assert.equal(button('保存任务设置').disabled, true); assert.equal(store.getState().metadataDrafts[id].values.estimated_minutes, 30);
 await assert.rejects(store.getState().saveMetadata(id), /预计分钟/); assert.equal(writes, 0); await close(); await open(); assert.equal(container.querySelector('input[aria-label="设置预计分钟"]').value, input); assert.equal(localStorage.length, 0);
});
test('planning explicit empty control clears estimate to null instead of zero', async () => {
 tasks[0] = makeTask({ priority: 'medium', estimated_minutes: 0 }); store.setState({ tasks }); await open(); const el = container.querySelector('input[aria-label="设置预计分钟"]');
 await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
 let sent; globalThis.__metadata.put = async (_, body) => { sent = body; return receipt(body); }; await act(async () => store.getState().saveMetadata(id)); assert.deepEqual(sent.changes, { estimated_minutes: null });
});
test('planning invalid raw estimate remains unsaved after another tab receipt', async () => {
 await open(); await act(async () => store.getState().editMetadataEstimate(id, '1e2')); const payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '另一标签已保存' } };
 persistMetadataJournal({ taskId: id, key: payload.client_request_id, revision: 0, fields: ['title'], payloadHash: await textHash(canonicalMetadata(payload)), createdAt: new Date().toISOString() });
 tasks[0] = receipt(payload).data.task; globalThis.__metadata.get = async path => path === '/tasks' ? { data: tasks } : receipt(payload, tasks[0]); await act(async () => { await store.getState().fetch(); await store.getState().verifyMetadata(id, payload.client_request_id); });
 assert.equal(store.getState().metadataNotices[id], '原请求已确认保存，当前草稿尚未保存。'); assert.equal(store.getState().metadataDrafts[id].estimatedMinutesInput, '1e2'); assert.equal(container.querySelector('input[aria-label="设置预计分钟"]').value, '1e2'); assert.ok([...container.querySelectorAll('[role="status"]')].some(el => el.textContent === '原请求已确认保存，当前草稿尚未保存。'));
});
for (const field of ['priority', 'estimated_minutes']) test(`planning bare PATCH cannot bypass guarded ${field}`, async () => { await assert.rejects(store.getState().update(id, { [field]: null }), /任务设置面板/); });

for (const route of ['fetch-list', 'fetch-query', 'verify', 'close']) test(`planning ${route} restores frozen create before comparing wrong initial planning values`, async () => {
 setWritingPreferences({ recoverDrafts: true, offlineCopies: false }); const original = { title: '冻结规划创建', prompt: '合成输入', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false, priority: 'high', estimated_minutes: 0 };
 let key; globalThis.__metadata.post = async (_, payload, config) => { key = config.headers['Idempotency-Key']; throw new Error('lost ACK'); }; await assert.rejects(store.getState().create(original)); await tick(); store.getState().cleanup();
 const wrong = makeTask({ ...original, client_request_id: key, priority: 'low', estimated_minutes: 25, metadata_revision: 0 });
 const response = { data: { status: 'succeeded', operation: 'create', client_request_id: key, task_id: id, task_deleted: false, task: wrong } };
 globalThis.__metadata.get = async path => path === '/tasks' ? { data: route === 'fetch-list' ? [wrong] : [] } : response; globalThis.__metadata.post = async () => response;
 if (route.startsWith('fetch-')) await store.getState().fetch(); else await assert.rejects(route === 'verify' ? store.getState().verifyCreate(key) : store.getState().closeCreate(key), /创建回执规划属性/);
 assert.equal(store.getState().pendingCreates[0]?.key, key); assert.equal(store.getState().canRetryCreate(key), true);
});
