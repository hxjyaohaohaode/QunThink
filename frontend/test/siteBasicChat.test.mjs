import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
globalThis.__site = { user: 'alice', epoch: 0, get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
const bundled = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {act} from 'react'; import {SiteBasicChat} from './src/components/Layout/SiteBasicChat'; export {act}; export async function mount(element){const root=createRoot(element);await act(async()=>root.render(<SiteBasicChat/>));return root;}`, resolveDir: root, sourcefile: 'site-test.tsx', loader: 'tsx' }, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false, plugins: [{ name: 'mocks', setup(build) {
  build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
  build.onResolve({ filter: /utils\/cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `export const getAuthGeneration=()=>globalThis.__site.epoch;export const axiosInstance={get:(...args)=>globalThis.__site.get(...args),post:(...args)=>globalThis.__site.post(...args)};` : `export const getCacheUserId=()=>globalThis.__site.user;` }));
} }] });
const { mount, act } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let element, mounted;
const available = { available: true, providerOrigin: 'https://provider.example', model: 'chosen', consentToken: 'current' };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(async () => { if (mounted) await act(async () => mounted.unmount()); document.body.innerHTML = ''; element = document.createElement('div'); document.body.append(element); globalThis.__site.user = 'alice'; globalThis.__site.get = async () => ({ data: available }); globalThis.__site.post = async () => ({ data: { content: '生成文本' } }); mounted = await mount(element); });
after(async () => { if (mounted) await act(async () => mounted.unmount()); await window.happyDOM.abort(); });
const button = () => element.querySelector('button');
async function fill() { await act(async () => { const input = element.querySelector('textarea'); Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, '本次输入'); input.dispatchEvent(new window.Event('input', { bubbles: true })); }); }
async function consent() { await act(async () => element.querySelector('input[type=checkbox]').click()); }
test('collapsed default, explicit consent and exactly one single-turn send', async () => {
  assert.equal(element.querySelector('details').open, false); assert.equal(button().disabled, true); assert.match(element.textContent, /https:\/\/provider.example/);
  await fill(); assert.equal(button().disabled, true); await consent(); assert.equal(button().disabled, false);
  const calls = []; let finish; globalThis.__site.post = (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  await act(async () => { button().click(); button().click(); }); assert.equal(calls.length, 1); assert.deepEqual(calls[0][1], { prompt: '本次输入', consent: true, consentToken: 'current' });
  await act(async () => { finish({ data: { content: '生成文本' } }); await settle(); }); assert.match(element.textContent, /AI 生成/); assert.equal(element.querySelector('input').checked, false); assert.equal(window.localStorage.length, 0);
});
test('unavailable feature leaves a clear non-AI/BYOK path', async () => { await act(async () => mounted.unmount()); globalThis.__site.get = async () => ({ data: { available: false } }); mounted = await mount(element); assert.equal(element.querySelector('textarea'), null); assert.match(element.textContent, /配置自己的模型/); });
test('failure never retries automatically and retains input', async () => { let count = 0; globalThis.__site.post = async () => { count++; throw new Error('private response'); }; await fill(); await consent(); await act(async () => { button().click(); await settle(); }); assert.equal(count, 1); assert.equal(element.querySelector('textarea').value, '本次输入'); assert.match(element.textContent, /不会自动重试/); assert.doesNotMatch(element.textContent, /private response/); });
test('late prior-account response is not displayed', async () => { let finish; globalThis.__site.post = () => new Promise(resolve => { finish = resolve; }); await fill(); await consent(); await act(async () => button().click()); globalThis.__site.user = 'bob'; await act(async () => { finish({ data: { content: 'ALICE_PRIVATE' } }); await settle(); }); assert.doesNotMatch(element.textContent, /ALICE_PRIVATE/); });
test('unmount aborts pending work and drops late response', async () => { let finish, signal; globalThis.__site.post = (_path, _body, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }; await fill(); await consent(); await act(async () => button().click()); await act(async () => mounted.unmount()); mounted = null; assert.equal(signal.aborted, true); await act(async () => { finish({ data: { content: 'LATE' } }); await settle(); }); assert.doesNotMatch(element.textContent, /LATE/); });

test('account switch blocks old draft dispatch, including A to B to A', async () => {
  let calls = 0; globalThis.__site.post = async () => { calls++; return { data: {} }; };
  await fill(); await consent(); globalThis.__site.user = 'bob';
  await act(async () => button().click()); assert.equal(calls, 0);
  globalThis.__site.user = 'alice'; globalThis.__site.epoch++;
  await act(async () => button().click()); assert.equal(calls, 0);
});
