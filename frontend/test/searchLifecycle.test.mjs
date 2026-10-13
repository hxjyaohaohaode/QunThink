import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';

const root = resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
globalThis.__searchTest = { user: 'alice', generation: 1, calls: [] };
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import {createRoot} from 'react-dom/client'; import {act} from 'react';
  import {useGlobalSearch} from './src/hooks/useGlobalSearch';
  export * from './src/utils/searchHistory'; export {act};
  function Probe(){ globalThis.__searchTest.state=useGlobalSearch(); return null; }
  export async function mount(el){const root=createRoot(el);await act(async()=>root.render(<Probe/>));return root;}
` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', plugins: [{ name: 'boundaries', setup(build) {
  build.onResolve({ filter: /(?:services\/api|utils\/cacheUtils|\.\/cacheUtils)$/ }, ({ path }) => ({ path: path.endsWith('api') ? 'api' : 'cache', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api'
    ? `export const getAuthGeneration=()=>globalThis.__searchTest.generation;export const api={globalSearch:(query,options)=>new Promise((resolve,reject)=>globalThis.__searchTest.calls.push({query,options,resolve,reject}))};`
    : `export const getCacheUserId=()=>globalThis.__searchTest.user;`, loader: 'js' }));
} }] });
const { mount, act, readSearchHistory, rememberSearch, clearSearchHistory } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const fixture = globalThis.__searchTest, state = () => fixture.state;
const waitDebounce = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 340)); });
const result = (query, total = 45) => ({ query, total, counts: { messages: total }, groups: [], messages: [{ id: query }], files: [], agents: [], personas: [], comments: [], members: [], media: [], pagination: { offset: 0, limit: 20, hasMore: total > 20 } });
let mounted, element;
beforeEach(async () => {
  if (mounted) await act(async () => mounted.unmount()); element?.remove();
  Object.assign(fixture, { user: 'alice', generation: 1, calls: [] }); clearSearchHistory();
  element = document.createElement('div'); document.body.append(element); mounted = await mount(element);
});
after(async () => { await act(async () => mounted.unmount()); await window.close(); });

test('changing the raw query immediately invalidates the previous response, before debounce', async () => {
  await act(async () => state().setQuery('first')); await waitDebounce();
  await act(async () => { state().setQuery('second'); fixture.calls[0].resolve(result('first')); });
  assert.equal(state().searchData, null); await waitDebounce();
  await act(async () => fixture.calls[1].resolve(result('second')));
  assert.equal(state().searchData.query, 'second'); assert.equal(state().loading, false);
});

test('clicking the already active filter does not strand an in-flight request', async () => {
  await act(async () => state().setQuery('same')); await waitDebounce();
  await act(async () => { state().setActiveTab('all'); state().setQuickFilter('all'); state().setQuery('same'); });
  await act(async () => fixture.calls[0].resolve(result('same')));
  assert.equal(state().searchData.query, 'same'); assert.equal(state().loading, false); assert.equal(fixture.calls.length, 1);
});

test('pagination counts every match, coalesces duplicate clicks, and retries the same page', async () => {
  await act(async () => state().setQuery('pages')); await waitDebounce();
  await act(async () => fixture.calls[0].resolve(result('pages')));
  await act(async () => { state().nextPage(); state().nextPage(); });
  assert.equal(fixture.calls[1].options.offset, 20);
  await act(async () => fixture.calls[1].reject(new Error('offline')));
  assert.match(state().error, /重试/); assert.equal(state().offset, 20);
  await act(async () => state().retry());
  assert.equal(fixture.calls[2].options.offset, 20);
  await act(async () => fixture.calls[2].resolve(result('pages')));
  assert.equal(state().total, 45); assert.equal(state().hasMore, true);
});

test('account switch and same-account reauthentication fence both responses and history', async () => {
  rememberSearch('private term'); await act(async () => state().setQuery('private term')); await waitDebounce();
  fixture.generation++;
  await act(async () => fixture.calls[0].resolve(result('private term')));
  assert.equal(state().searchData, null); assert.deepEqual(readSearchHistory(), []);
  rememberSearch('new term'); fixture.user = 'bob'; assert.deepEqual(readSearchHistory(), []);
});

test('changing categories on the first page reuses the authorized results without flicker or another request', async () => {
  await act(async () => state().setQuery('category')); await waitDebounce();
  await act(async () => fixture.calls[0].resolve(result('category')));
  await act(async () => state().setActiveTab('messages'));
  assert.equal(state().searchData.query, 'category'); assert.equal(state().loading, false); assert.equal(fixture.calls.length, 1);
});

test('calendar dates use local day boundaries; reversed ranges do not issue requests', async () => {
  await act(async () => { state().setQuery('dates'); state().setDateFrom('2026-10-13'); state().setDateTo('2026-10-13'); });
  await waitDebounce();
  assert.equal(fixture.calls[0].options.dateFrom, new Date('2026-10-13T00:00:00.000').toISOString());
  assert.equal(fixture.calls[0].options.dateTo, new Date('2026-10-13T23:59:59.999').toISOString());
  await act(async () => state().setDateFrom('2026-10-14'));
  assert.match(state().error, /开始日期/); assert.equal(fixture.calls.length, 1);
});
