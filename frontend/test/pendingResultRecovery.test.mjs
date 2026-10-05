import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..'), window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true });
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
globalThis.__orphan = { user: 'alice' };
const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import{act}from'react';import{create}from'zustand';import{PendingResultRecovery}from'./src/components/Writing/PendingResultRecovery';export{act};export{useTaskResultsStore as results}from'./src/stores/taskResultsStore';export{useTasksStore as tasks}from'./src/stores/tasksStore';export function mount(el){const root=createRoot(el);root.render(<PendingResultRecovery/>);return root}`, resolveDir: root, sourcefile: 'orphan.tsx', loader: 'tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', plugins: [{ name: 'orphan-boundaries', setup(build) {
  build.onResolve({ filter: /stores\/taskResultsStore$/ }, () => ({ path: 'results', namespace: 'mock' }));
  build.onResolve({ filter: /stores\/tasksStore$/ }, () => ({ path: 'tasks', namespace: 'mock' }));
  build.onResolve({ filter: /\.\/TaskResultEditor$/ }, () => ({ path: 'editor', namespace: 'mock' }));
  build.onResolve({ filter: /(?:utils\/|\.\/)cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
  build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ resolveDir: root, loader: 'tsx', contents: path === 'results' ? `import{create}from'zustand';export const useTaskResultsStore=create(()=>({uncertainQueues:{},notices:{}}));` : path === 'tasks' ? `import{create}from'zustand';export const useTasksStore=create(()=>({tasks:[]}));` : path === 'editor' ? `export function TaskResultEditor({taskId}){return <div data-original-task={taskId}>原请求恢复编辑器</div>}` : path === 'cache' ? `export const getCacheUserId=()=>globalThis.__orphan.user;` : 'export const getAuthGeneration=()=>0;' }));
} }] });
const { mount, act, results, tasks } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const key = '11111111-1111-4111-8111-111111111111', taskId = 'missing-task';
const receipt = { key, action: 'save_revision', taskId, payloadHash: 'a'.repeat(64), createdAt: '2026-10-04T23:00:00Z' };
let container, mounted;
const button = text => [...container.querySelectorAll('button')].find(item => item.textContent === text);
beforeEach(async () => { if (mounted) await act(async () => mounted.unmount()); container?.remove(); localStorage.clear(); globalThis.__orphan.user = 'alice'; results.setState({ uncertainQueues: {}, notices: {} }); tasks.setState({ tasks: [] }); container = document.createElement('div'); document.body.appendChild(container); });
after(async () => { if (mounted) await act(async () => mounted.unmount()); window.close(); });
function save(user, record) { localStorage.setItem(`qunthink_command_v1_${user}:${record.key}`, JSON.stringify(record)); }
test('missing document receipts remain directly reachable without a task card or private title', async () => {
  save('alice', receipt); await act(async () => { mounted = mount(container); });
  assert.match(container.textContent, /未列出的文稿 1.*1 次待确认操作/); assert.ok(button('核对这份文稿的原请求'));
  await act(async () => button('核对这份文稿的原请求').click()); assert.equal(container.querySelector('[data-original-task]').getAttribute('data-original-task'), taskId);
  assert.doesNotMatch(container.textContent, new RegExp(key));
});
test('one missing document groups multiple keys, does not show another account, and ignores an old success notice', async () => {
  save('alice', receipt); save('alice', { ...receipt, key: '22222222-2222-4222-8222-222222222222' }); save('bob', { ...receipt, taskId: 'foreign' });
  results.setState({ notices: { [taskId]: '之前的旧成功' } }); await act(async () => { mounted = mount(container); });
  assert.match(container.textContent, /2 次待确认操作/); assert.equal([...container.querySelectorAll('button')].filter(item => item.textContent === '核对这份文稿的原请求').length, 1);
  await act(async () => button('核对这份文稿的原请求').click()); assert.ok(container.querySelector('[data-original-task]')); assert.doesNotMatch(container.textContent, /foreign|之前的旧成功/);
});
test('authoritative terminal notice survives removal of the last orphan record', async () => {
  save('alice', receipt); await act(async () => { mounted = mount(container); }); await act(async () => button('核对这份文稿的原请求').click());
  await act(async () => { localStorage.removeItem(`qunthink_command_v1_alice:${key}`); results.setState({ uncertainQueues: { [taskId]: [] }, notices: { [taskId]: '原请求已结束，没有重新创建文稿' } }); });
  assert.equal(container.querySelector('[data-original-task]'), null); assert.match(container.textContent, /原请求已结束，没有重新创建文稿/);
  await act(async () => button('收起请求核验').click()); assert.equal(container.textContent, '');
});
test('account switch removes the prior selection and malformed own journal displays a safe error', async () => {
  save('alice', receipt); await act(async () => { mounted = mount(container); }); await act(async () => button('核对这份文稿的原请求').click());
  await act(async () => { globalThis.__orphan.user = 'bob'; tasks.setState({ tasks: [] }); }); assert.equal(container.querySelector('[data-original-task]'), null);
  localStorage.setItem('qunthink_command_v1_bob:'+key, '{"private":"DO_NOT_DISPLAY","action":"typo"}'); await act(async () => tasks.setState({ tasks: [] }));
  assert.match(container.textContent, /待核验记录不完整/); assert.doesNotMatch(container.textContent, /DO_NOT_DISPLAY|typo/);
});
test('a receipt retained by this tab remains reachable after another tab removes the durable key', async () => {
  save('alice', receipt); results.setState({ uncertainQueues: { [taskId]: [receipt] } }); await act(async () => { mounted = mount(container); });
  await act(async () => button('核对这份文稿的原请求').click());
  await act(async () => { localStorage.removeItem(`qunthink_command_v1_alice:${key}`); window.dispatchEvent(new window.Event('storage')); });
  await act(async () => button('收起请求核验').click()); assert.ok(button('核对这份文稿的原请求'));
  await act(async () => button('核对这份文稿的原请求').click()); assert.equal(container.querySelector('[data-original-task]').getAttribute('data-original-task'), taskId);
});
