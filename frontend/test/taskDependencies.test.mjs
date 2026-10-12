import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
const root = resolve(import.meta.dirname, '..'), window = new Window({ url: 'https://qunthink.test/' });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, HTMLElement: window.HTMLElement, Node: window.Node, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
globalThis.__deps = {};
const built = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import {createRoot} from 'react-dom/client'; import {act} from 'react'; import {TaskDependencies,DependencyPicker,DependencySummary} from './src/components/Writing/TaskDependencies'; import {useTasksStore} from './src/stores/tasksStore'; export {act,useTasksStore}; export async function mount(el,id){const root=createRoot(el);await act(async()=>root.render(<TaskDependencies taskId={id}/>));return root;} export async function picker(el,tasks,ids){const root=createRoot(el);await act(async()=>root.render(<DependencyPicker tasks={tasks} value={ids} onChange={()=>{}}/>));return root;} export async function summary(el,state){const root=createRoot(el);await act(async()=>root.render(<DependencySummary state={state}/>));return root;}` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', plugins: [{ name: 'dependency-fixture', setup(build) {
 build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
 build.onResolve({ filter: /(?:utils\/|\.\/)cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
 build.onResolve({ filter: /^\.\/modelsStore$/ }, () => ({ path: 'models', namespace: 'mock' }));
 build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ loader: 'js', contents: path === 'api' ? `export const getAuthGeneration=()=>globalThis.__deps.auth; export const axiosInstance=Object.fromEntries(['get','post','put','patch','delete'].map(method=>[method,(...args)=>globalThis.__deps[method](...args)]));` : path === 'cache' ? `export const getCacheUserId=()=>globalThis.__deps.user;` : `export const requestError=error=>error.response?.data?.error || error.message;` }));
} }] });
const { act, mount, picker, summary, useTasksStore: store } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const id = '10000000-0000-4000-8000-000000000001', prior = '20000000-0000-4000-8000-000000000002', other = '30000000-0000-4000-8000-000000000003';
const state = (extra = {}) => ({ blocked: false, reasons: [], signature: null, result_stale: false, ...extra });
const makeTask = (taskId, title, extra = {}) => ({ id: taskId, title, prompt: 'PRIVATE-PROMPT-NEVER-JOURNALED', status: 'pending', category: 'work', history: [], result: 'PRIVATE-BODY-NEVER-SENT', dependency_ids: [], dependency_revision: 0, dependency_state: state(), ...extra });
const receipt = (payload, task = makeTask(id, '下游', { dependency_ids: payload.dependency_ids, dependency_revision: payload.expected_revision + 1 })) => ({ data: { receipt: { id: payload.client_request_id, task_id: id, operation: 'dependencies', status: 'succeeded', committed_revision: payload.expected_revision + 1 }, task, ...(task ? {} : { task_deleted: true }) } });
const failure = (status, code = '', message = '请求失败') => Object.assign(new Error(message), { response: { status, data: { code, error: message } } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
let tasks, container, mounted;
const button = label => [...container.querySelectorAll('button')].find(el => el.textContent === label);
const check = label => [...container.querySelectorAll('label')].find(el => el.textContent === label)?.querySelector('input');
async function open() { mounted = await mount(container, id); }
async function close() { if (mounted) await act(async () => mounted.unmount()); mounted = null; }
async function draft(ids = [prior]) { await act(async () => store.getState().editDependencies(id, ids)); }
beforeEach(async () => {
 await close(); container?.remove(); localStorage.clear(); store.getState().cleanup(); tasks = [makeTask(id, '下游'), makeTask(prior, '前置甲'), makeTask(other, '前置乙')];
 globalThis.__deps = { user: 'alice', auth: 1, get: async path => { if (path === '/tasks') return { data: tasks }; throw failure(404); }, put: async (_, payload) => { const result = receipt(payload); tasks[0] = result.data.task; return result; }, post: async () => { throw new Error('MODEL-MUST-NOT-RUN'); } };
 store.setState({ tasks }); container = document.createElement('div'); document.body.append(container);
});
after(async () => { await close(); window.close(); });
test('picker excludes itself, explains no AI context, and unsaved choices survive close/reopen', async () => {
 await open(); assert.equal(check('下游'), undefined); assert.ok(check('前置甲')); assert.match(container.textContent, /不会把前置任务正文发送给 AI/);
 await act(async () => check('前置甲').click()); await close(); await open(); assert.equal(check('前置甲').checked, true); assert.equal(button('保存前置任务').disabled, false); assert.equal(localStorage.length, 0);
});
test('double click is one write, freezes inputs, sends only IDs with exact account guard', async () => {
 let resolve, calls = []; globalThis.__deps.put = (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); };
 await open(); await draft(); await act(async () => { button('保存前置任务').click(); button('保存前置任务')?.click(); });
 assert.equal(calls.length, 1); assert.equal(container.querySelector('fieldset').disabled, true); assert.equal(calls[0][2].headers['X-Expected-User-Id'], 'alice'); assert.deepEqual(Object.keys(calls[0][1]).sort(), ['client_request_id', 'dependency_ids', 'expected_revision']);
 assert.doesNotMatch(JSON.stringify(Object.values(localStorage)), /PRIVATE|前置甲|下游/);
 await act(async () => { tasks[0] = receipt(calls[0][1]).data.task; resolve(receipt(calls[0][1])); await tick(); }); assert.equal(store.getState().dependencyIntents[id], undefined); assert.equal(localStorage.length, 0);
});
test('lost ACK survives reload; 404 cannot authorize replacement; retry preserves exact body and key', async () => {
 const writes = []; globalThis.__deps.put = async (...args) => { writes.push(args); throw new Error('offline'); };
 await draft(); await assert.rejects(store.getState().saveDependencies(id)); const first = structuredClone(writes[0][1]); store.getState().cleanup(); await store.getState().fetch(); assert.deepEqual(store.getState().dependencyIntents[id].payload, first);
 await assert.rejects(store.getState().verifyDependencies(id, first.client_request_id)); await assert.rejects(store.getState().saveDependencies(id), /不能换编号覆盖/); store.getState().editDependencies(id, [other]); assert.equal(store.getState().dependencyDrafts[id], undefined);
 globalThis.__deps.put = async (...args) => { writes.push(args); tasks[0] = receipt(args[1]).data.task; return receipt(args[1]); }; await store.getState().retryDependencies(id, first.client_request_id); assert.deepEqual(writes[1][1], first); assert.equal(store.getState().dependencyIntents[id], undefined);
});
test('lookup success settles without another PUT; deleted task is never recreated', async () => {
 let payload, writes = 0; globalThis.__deps.put = async (_, body) => { payload = body; writes++; throw new Error('lost'); }; await draft(); await assert.rejects(store.getState().saveDependencies(id)); tasks = tasks.filter(task => task.id !== id);
 globalThis.__deps.get = async path => path === '/tasks' ? { data: tasks } : receipt(payload, null); await store.getState().verifyDependencies(id, payload.client_request_id); assert.equal(writes, 1); assert.equal(store.getState().dependencyIntents[id], undefined); assert.equal(store.getState().tasks.some(task => task.id === id), false);
});
test('wrong request/task/operation/revision receipts remain uncertain', async () => {
 for (const patch of [{ id: 'wrong' }, { task_id: other }, { operation: 'save' }, { committed_revision: 0 }]) {
  localStorage.clear(); store.getState().cleanup(); store.setState({ tasks }); await draft(); globalThis.__deps.put = async (_, payload) => { const reply = receipt(payload); Object.assign(reply.data.receipt, patch); return reply; }; await assert.rejects(store.getState().saveDependencies(id), /回执不匹配/); assert.ok(store.getState().dependencyIntents[id]);
 }
});
test('revision conflict refreshes but cannot rebase silently; explicit selection uses new revision', async () => {
 let writes = 0; globalThis.__deps.put = async () => { writes++; tasks[0] = { ...tasks[0], dependency_revision: 1, dependency_ids: [other] }; throw failure(409, 'TASK_DEPENDENCY_REVISION_CONFLICT'); };
 await open(); await draft(); await act(async () => { button('保存前置任务').click(); await tick(); }); assert.ok(store.getState().dependencyIntents[id]); assert.equal(button('保存前置任务'), undefined); assert.match(container.textContent, /不会自动覆盖/);
 await act(async () => assert.rejects(store.getState().saveDependencies(id), /不能换编号覆盖/)); assert.equal(writes, 1); const intent=store.getState().dependencyIntents[id]; globalThis.__deps.post=async()=>({data:{receipt:{...receipt(intent.payload).data.receipt,status:'cancelled',committed_revision:null},task:tasks[0]}}); await act(async()=>store.getState().closeDependencies(id,intent.payload.client_request_id)); await act(async () => { button('读取最新关系并重新选择').click(); await tick(); }); assert.equal(check('前置乙').checked, true); await draft([prior]); assert.equal(store.getState().dependencyDrafts[id].revision, 1);
});
test('cycle rejection is actionable; idempotency conflicts preserve original key', async () => {
 await draft(); globalThis.__deps.put = async () => { throw failure(409, 'TASK_DEPENDENCY_CYCLE', '不能形成循环依赖'); }; await assert.rejects(store.getState().saveDependencies(id)); assert.match(store.getState().dependencyErrors[id], /循环依赖/); assert.ok(store.getState().dependencyIntents[id]); const intent=store.getState().dependencyIntents[id]; globalThis.__deps.post=async()=>({data:{receipt:{...receipt(intent.payload).data.receipt,status:'cancelled',committed_revision:null},task:tasks[0]}}); await store.getState().closeDependencies(id,intent.payload.client_request_id);
 globalThis.__deps.put = async () => { throw failure(409, 'TASK_DEPENDENCY_IDEMPOTENCY_CONFLICT'); }; await assert.rejects(store.getState().saveDependencies(id)); assert.ok(store.getState().dependencyIntents[id]);
});
test('503 and later 403 retain frozen request for explicit verification', async () => {
 await draft(); globalThis.__deps.put = async () => { throw failure(503, 'TASK_DEPENDENCY_STORAGE_UNCERTAIN'); }; await assert.rejects(store.getState().saveDependencies(id)); const key = store.getState().dependencyIntents[id].payload.client_request_id;
 globalThis.__deps.put = async () => { throw failure(403); }; await assert.rejects(store.getState().retryDependencies(id, key)); assert.equal(store.getState().dependencyIntents[id].payload.client_request_id, key);
});
test('A-B-A generation fences late response and cannot restore old account state or reads', async () => {
 let resolve, payload, reads = 0; globalThis.__deps.put = (_, body) => { payload = body; return new Promise(done => { resolve = done; }); }; await draft(); const pending = store.getState().saveDependencies(id);
 store.getState().cleanup(); globalThis.__deps.user = 'bob'; globalThis.__deps.auth++; globalThis.__deps.get = async () => { reads++; return { data: [] }; }; await store.getState().fetch(); assert.deepEqual(store.getState().dependencyIntents, {});
 store.getState().cleanup(); globalThis.__deps.user = 'alice'; globalThis.__deps.auth++; const before = reads; resolve(receipt(payload)); await assert.rejects(pending, /账号已切换/); assert.equal(reads, before); assert.deepEqual(store.getState().tasks, []); assert.deepEqual(store.getState().dependencyDrafts, {});
});
test('newer server dependency projection wins over delayed historical ACK', async () => {
 let complete, payload; globalThis.__deps.put = (_, body) => { payload = body; return new Promise(resolve => { complete = resolve; }); }; await draft(); const work = store.getState().saveDependencies(id);
 tasks[0] = { ...tasks[0], dependency_revision: 2, dependency_ids: [other], dependency_state: state({ blocked: true }) }; await store.getState().fetch(); complete(receipt(payload)); await work; assert.equal(store.getState().tasks[0].dependency_revision, 2); assert.deepEqual(store.getState().tasks[0].dependency_ids, [other]);
});
test('running/unknown disable editing; server-blocked tasks cannot run or accept', async () => {
 for (const status of ['running', 'outcome_unknown']) { tasks[0] = { ...tasks[0], status }; store.setState({ tasks }); await open(); assert.equal(container.querySelector('fieldset').disabled, true); await draft(); assert.equal(store.getState().dependencyDrafts[id], undefined); await close(); }
 tasks[0] = { ...tasks[0], status: 'pending', dependency_state: state({ blocked: true }) }; store.setState({ tasks }); await assert.rejects(store.getState().run(id), /前置任务/); await assert.rejects(store.getState().accept(id, 'run'), /前置任务/);
});
test('picker caps at32; removed prerequisite uses no guessed title or raw ID', async () => {
 const choices = Array.from({ length: 33 }, (_, i) => makeTask(`40000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `任务${i}`)); mounted = await picker(container, choices, choices.slice(0, 32).map(task => task.id)); assert.equal(check('任务32').disabled, true); assert.equal(check('任务0').disabled, false); await close();
 tasks[0] = { ...tasks[0], dependency_ids: ['99999999-9999-4999-8999-999999999999'] }; store.setState({ tasks }); await open(); assert.match(container.textContent, /不可用的前置任务/); assert.doesNotMatch(container.textContent, /99999999/);
});
test('corrupt or unavailable journal fails closed before PUT but ordinary task reads work', async () => {
 let writes = 0; globalThis.__deps.put = async () => { writes++; }; localStorage.setItem('qunthink_dependency_command_v1_alice:' + id + ':bad-key', '{broken'); await store.getState().fetch(); assert.equal(store.getState().tasks.length, 3); assert.ok(store.getState().dependencyRecoveryError); await draft(); await assert.rejects(store.getState().saveDependencies(id), /无法读取/); assert.equal(writes, 0);
 localStorage.clear(); const original = globalThis.localStorage; globalThis.localStorage = { length: 0, key() {}, getItem() { return null; }, setItem() { throw new Error('quota'); } }; try { await assert.rejects(store.getState().saveDependencies(id), /尚未发送/); assert.equal(writes, 0); } finally { globalThis.localStorage = original; }
});
test('all server reason codes readable; stale result does not claim old acceptance remains current', async () => {
 mounted = await summary(container, state({ blocked: true, result_stale: true, reasons: ['missing', 'unaccepted', 'failed', 'cancelled', 'outcome_unknown', 'running', 'source_changed', 'dependency_changed', 'invalid', 'future_code'].map(code => ({ task_id: prior, code })) })); assert.match(container.textContent, /旧验收不再有效/); assert.match(container.textContent, /仍可编辑和保存正文/); assert.match(container.textContent, /需要重新核验/); assert.doesNotMatch(container.textContent, /future_code|20000000/);
});
test('deleted or temporarily missing task still exposes exact frozen command recovery controls', async () => {
 globalThis.__deps.put = async () => { throw new Error('lost ACK'); }; await draft(); await assert.rejects(store.getState().saveDependencies(id)); tasks = tasks.filter(task => task.id !== id); await store.getState().fetch(); await open();
 assert.match(container.textContent, /不会重新创建任务/); assert.ok(button('核验前置任务请求')); assert.ok(button('按原选择同号重试')); assert.equal(container.querySelector('fieldset').disabled, true);
});
test('deterministic two-tab read-empty race keeps both UUID keys; deleting one cannot delete a third interleaved intent', async () => {
 const { useTasksStore: otherTab } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text + '\n// independent tab').toString('base64')}`);
 otherTab.getState().cleanup(); otherTab.setState({ tasks }); otherTab.getState().editDependencies(id, [other]); await draft([prior]);
 const originalStorage = globalThis.localStorage, writes = [], firstPayloads = [];
 let secondWrite, interleaved = false;
 globalThis.__deps.put = async (_, payload) => { writes.push(structuredClone(payload)); throw new Error('lost ACK'); };
 globalThis.localStorage = {
  get length() { return originalStorage.length; }, key: n => originalStorage.key(n), getItem: key => originalStorage.getItem(key), removeItem: key => originalStorage.removeItem(key),
  setItem(key, value) { if (!interleaved) { interleaved = true; secondWrite = otherTab.getState().saveDependencies(id).catch(() => {}); } originalStorage.setItem(key, value); }
 };
 try { await assert.rejects(store.getState().saveDependencies(id)); await secondWrite; } finally { globalThis.localStorage = originalStorage; }
 assert.equal(writes.length, 2); assert.equal(localStorage.length, 2); assert.notEqual(writes[0].client_request_id, writes[1].client_request_id);
 store.getState().cleanup(); await store.getState().fetch(); assert.equal(store.getState().dependencyQueues[id].length, 2); await open(); assert.match(container.textContent, /还有 1 笔请求/); assert.equal(container.querySelector('fieldset').disabled, true);
 await close(); const first = store.getState().dependencyIntents[id]; firstPayloads.push(first.payload);
 const third = { taskId: id, payload: { client_request_id: '40000000-0000-4000-8000-000000000004', expected_revision: 1, dependency_ids: [] } };
 let deletedKey;
 globalThis.localStorage = {
  get length() { return originalStorage.length; }, key: n => originalStorage.key(n), getItem: key => originalStorage.getItem(key), setItem: (key, value) => originalStorage.setItem(key, value),
  removeItem(key) { deletedKey = key; originalStorage.setItem(`qunthink_dependency_command_v1_alice:${id}:${third.payload.client_request_id}`, JSON.stringify(third)); originalStorage.removeItem(key); }
 };
 globalThis.__deps.get = async path => path === '/tasks' ? { data: tasks } : receipt(first.payload);
 try { await act(async () => store.getState().verifyDependencies(id, first.payload.client_request_id)); } finally { globalThis.localStorage = originalStorage; }
 assert.ok(deletedKey.endsWith(first.payload.client_request_id)); assert.equal(localStorage.length, 2); assert.equal(store.getState().dependencyQueues[id].length, 2); assert.notEqual(store.getState().dependencyIntents[id].payload.client_request_id, first.payload.client_request_id);
 await assert.rejects(store.getState().saveDependencies(id), /不能换编号覆盖/); await assert.rejects(store.getState().verifyDependencies(id, first.payload.client_request_id), /原请求已变化/);
 const next = store.getState().dependencyIntents[id]; globalThis.__deps.put = async (_, payload) => { firstPayloads.push(structuredClone(payload)); throw new Error('still unknown'); };
 await act(async () => store.getState().retryDependencies(id, next.payload.client_request_id).catch(() => {})); assert.deepEqual(firstPayloads[1], next.payload); assert.equal(store.getState().dependencyIntents[id].payload.client_request_id, next.payload.client_request_id);
 otherTab.getState().cleanup();
});
test('explicit close preserves choices, loses no key on disconnect, and settles only authoritative cancellation', async () => {
 globalThis.__deps.put = async () => { throw new Error('request never arrived'); }; await draft(); await assert.rejects(store.getState().saveDependencies(id)); const intent = store.getState().dependencyIntents[id];
 globalThis.__deps.post = async () => { throw new Error('close lost ACK'); }; await assert.rejects(store.getState().closeDependencies(id, intent.payload.client_request_id)); assert.equal(store.getState().dependencyIntents[id].payload.client_request_id, intent.payload.client_request_id);
 for (const patch of [{ id: 'wrong' }, { committed_revision: 0 }, { status: 'unknown' }]) {
  globalThis.__deps.post = async () => ({ data: { receipt: { ...receipt(intent.payload).data.receipt, status: 'cancelled', committed_revision: null, ...patch }, task: tasks[0] } }); await assert.rejects(store.getState().closeDependencies(id, intent.payload.client_request_id)); assert.ok(store.getState().dependencyIntents[id]);
 }
 let called; globalThis.__deps.post = async (...args) => { called = args; return { data: { receipt: { ...receipt(intent.payload).data.receipt, status: 'cancelled', committed_revision: null }, task: tasks[0] } }; };
 await store.getState().closeDependencies(id, intent.payload.client_request_id); assert.equal(called[0], `/tasks/${id}/dependencies/commands/${intent.payload.client_request_id}/close`); assert.deepEqual(called[1], {}); assert.equal(store.getState().dependencyIntents[id], undefined); assert.deepEqual(store.getState().dependencyDrafts[id].ids, [prior]); assert.deepEqual(tasks[0].dependency_ids, []);
});
test('closing an already successful command preserves its committed relationship instead of undoing it', async () => {
 let sent; globalThis.__deps.put = async (_, payload) => { sent = payload; tasks[0] = receipt(payload).data.task; throw new Error('committed ACK lost'); }; await draft(); await assert.rejects(store.getState().saveDependencies(id));
 globalThis.__deps.post = async () => receipt(sent, tasks[0]); await store.getState().closeDependencies(id, sent.client_request_id); assert.equal(store.getState().dependencyIntents[id], undefined); assert.deepEqual(store.getState().tasks[0].dependency_ids, [prior]);
});
test('same revision with wrong dependency IDs and generic storage revision conflict never clear original request', async () => {
 await draft(); globalThis.__deps.put = async (_, payload) => receipt(payload, makeTask(id, '下游', { dependency_revision: 1, dependency_ids: [other] })); await assert.rejects(store.getState().saveDependencies(id), /关系不匹配/); assert.ok(store.getState().dependencyIntents[id]);
 localStorage.clear(); store.getState().cleanup(); store.setState({ tasks }); await draft(); globalThis.__deps.put = async () => { throw failure(409, 'REVISION_CONFLICT'); }; await assert.rejects(store.getState().saveDependencies(id)); assert.ok(store.getState().dependencyIntents[id]);
});
test('other tab durable pending dependency intent blocks both run and legacy acceptance before any POST', async () => {
 const intent = { taskId: id, payload: { client_request_id: '50000000-0000-4000-8000-000000000005', expected_revision: 0, dependency_ids: [prior] } };
 localStorage.setItem(`qunthink_dependency_command_v1_alice:${id}:${intent.payload.client_request_id}`, JSON.stringify(intent)); assert.equal(store.getState().dependencyIntents[id], undefined); let calls = 0; globalThis.__deps.post = async () => { calls++; };
 await assert.rejects(store.getState().run(id), /前置任务/); await assert.rejects(store.getState().accept(id, 'run'), /前置任务/); assert.equal(calls, 0);
});
test('foreign successful dependency receipt preserves this tabs unsent choices and original revision', async () => {
 await open(); await act(async () => check('前置甲').click());
 const payload = { client_request_id: crypto.randomUUID(), expected_revision: 0, dependency_ids: [other] };
 localStorage.setItem(`qunthink_dependency_command_v1_alice:${id}:${payload.client_request_id}`, JSON.stringify({ taskId: id, payload }));
 tasks[0] = makeTask(id, '下游', { dependency_ids: [other], dependency_revision: 1 }); globalThis.__deps.get = async path => path === '/tasks' ? { data: tasks } : receipt(payload, tasks[0]);
 await act(async () => store.getState().fetch()); await act(async () => { button('核验前置任务请求').click(); await tick(); });
 assert.deepEqual(store.getState().dependencyDrafts[id].ids, [prior]); assert.equal(store.getState().dependencyDrafts[id].revision, 0); assert.equal(store.getState().dependencyConflicts[id], true); assert.equal(check('前置甲').checked, true); assert.equal(button('保存前置任务').disabled, true); await assert.rejects(store.getState().saveDependencies(id), /读取最新/);
});
