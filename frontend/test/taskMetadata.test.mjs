import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Window } from 'happy-dom';
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
const fixture = await import(join(folder, 'fixture.mjs'));
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
beforeEach(async () => {
 await close(); container?.remove(); localStorage.clear(); databases.clear(); store.getState().cleanup(); tasks = [makeTask()];
 globalThis.__metadata = { user: 'alice', auth: 1, get: async path => { if (path === '/tasks') return { data: tasks }; throw failure(404); }, put: async (_, payload) => { const result = receipt(payload); tasks[0] = result.data.task; return result; }, post: async () => { throw new Error('MODEL-MUST-NOT-RUN'); }, patch: async () => { throw new Error('NO-BARE-PATCH'); } };
 store.setState({ tasks }); container = document.createElement('div'); document.body.append(container);
});
after(async () => { await close(); window.close(); await rm(folder, { recursive: true, force: true }); });
test('React panel edits three values and retains draft across close/reopen without persisting text', async () => {
 await open(); await act(async () => draft()); assert.equal(container.querySelectorAll('input').length, 3); await close(); await open(); assert.equal(container.querySelector('input').value, '私密标题-NEW'); assert.equal(button('保存任务设置').disabled, false); assert.equal(localStorage.length, 0);
});
test('double click sends one guarded command, freezes controls, never writes private plaintext', async () => {
 let resolve, calls = []; globalThis.__metadata.put = (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); };
 await open(); await act(async () => draft()); await act(async () => { button('保存任务设置').click(); button('保存任务设置')?.click(); await until(() => calls.length); });
 assert.equal(calls.length, 1); assert.equal(container.querySelector('fieldset').disabled, true); assert.equal(calls[0][2].headers['X-Expected-User-Id'], 'alice'); assert.deepEqual(Object.keys(calls[0][1].changes).sort(), ['auto_run', 'run_at', 'title']); assert.doesNotMatch(JSON.stringify(Object.values(localStorage)), /私密标题|2030-02|PRIVATE/);
 await act(async () => { tasks[0] = receipt(calls[0][1]).data.task; resolve(receipt(calls[0][1])); await until(() => !store.getState().pending[id]); }); assert.equal(store.getState().metadataIntents[id], undefined);
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
 const item = await lost(); tasks = []; await store.getState().fetch(); await open(); assert.match(container.textContent, /不会重新创建/); assert.ok(button('核对并结束原设置请求')); globalThis.__metadata.get = async path => path === '/tasks' ? { data: [] } : receipt(item.payload, null); await act(async () => store.getState().verifyMetadata(id, item.key)); assert.deepEqual(store.getState().tasks, []); assert.equal(store.getState().metadataIntents[id], undefined);
});
test('close lost ACK/malformed cancel retain key; authoritative close cannot alter saved values', async () => {
 const item = await lost(); globalThis.__metadata.post = async () => { throw new Error('lost close'); }; await assert.rejects(store.getState().closeMetadata(id, item.key)); globalThis.__metadata.post = async () => { const reply = cancelled(item); reply.data.receipt.committed_revision = 1; return reply; }; await assert.rejects(store.getState().closeMetadata(id, item.key)); globalThis.__metadata.post = async (path, body) => { assert.equal(path, `/tasks/${id}/metadata/commands/${item.key}/close`); assert.deepEqual(body, {}); return cancelled(item); }; await store.getState().closeMetadata(id, item.key); assert.equal(tasks[0].title, '原任务'); assert.equal(readMetadataJournal().length, 0);
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
 await writeFile(join(folder, 'tab2.mjs'), built.outputFiles[0].text); const { useTasksStore: tab } = await import(join(folder, 'tab2.mjs')); tab.setState({ tasks }); tab.getState().editMetadata(id, { title: '第二标签私密文字' }); draft(); globalThis.__metadata.put = async () => { throw new Error('lost'); }; await Promise.all([assert.rejects(store.getState().saveMetadata(id)), assert.rejects(tab.getState().saveMetadata(id))]); assert.equal(readMetadataJournal().length, 2); store.getState().cleanup(); await store.getState().fetch(); assert.equal(store.getState().metadataQueues[id].length, 2);
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
 draft({ title: '本标签尚未提交的私密草稿' });
 const payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, changes: { title: '另一标签已经提交' } };
 persistMetadataJournal({ taskId: id, key: payload.client_request_id, revision: 0, fields: ['title'], payloadHash: await textHash(canonicalMetadata(payload)), createdAt: new Date().toISOString() });
 tasks[0] = receipt(payload).data.task; globalThis.__metadata.get = async path => path === '/tasks' ? { data: tasks } : receipt(payload, tasks[0]);
 await store.getState().fetch(); await store.getState().verifyMetadata(id, payload.client_request_id);
 assert.equal(store.getState().metadataDrafts[id].values.title, '本标签尚未提交的私密草稿'); assert.equal(store.getState().metadataDrafts[id].revision, 0); assert.equal(store.getState().metadataConflicts[id], true); await assert.rejects(store.getState().saveMetadata(id), /读取最新/);
});
