import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const frontend = resolve(process.env.QUNTHINK_FRONTEND_ROOT || resolve(import.meta.dirname, '..'));
const require = createRequire(resolve(frontend, 'package.json'));
const { build } = require('esbuild');
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href);
const browser = new Window({ url: 'http://127.0.0.1:3210' });
Object.assign(globalThis, { window: browser, document: browser.document, localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Node: browser.Node, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: browser.navigator, configurable: true });
class Channel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
Object.defineProperty(browser.HTMLElement.prototype, 'getClientRects', { value() { return this.isConnected ? [{}] : []; } });
// Real LoginPage/React/API and actual test adapter; controlled DOM/transport,
// not native browser coverage. Decoration and login-completion transport are controlled.
const output = await mkdtemp(resolve(tmpdir(), 'qunthink-phone-commit-'));
// Replay only the exact AppContent history effect, not the full App. CDP and
// Playwright event transport are controlled below; this is not native Chrome.
const appSource = await readFile(resolve(frontend, 'src/App.tsx'), 'utf8');
const effectStart = appSource.indexOf("  useEffect(() => {\n    window.history.replaceState({ mobileView: 'main' }, '', '');");
const effectEndText = '  }, [handlePopStateBack]);';
const effectEnd = appSource.indexOf(effectEndText, effectStart);
assert.ok(effectStart >= 0 && effectEnd > effectStart);
const actualAppHistoryEffect = appSource.slice(effectStart, effectEnd + effectEndText.length);
const component = await build({ stdin: { resolveDir: frontend, loader: 'tsx', contents: `
import {createRoot} from 'react-dom/client'; import {act,useEffect,StrictMode} from 'react';
import {LoginPage} from './src/components/Layout/LoginPage';
export {axiosInstance,confirmAuthIdentity} from './src/services/api'; export {act};
function AppHistoryEffect(){const handlePopStateBack=()=>{};${actualAppHistoryEffect}return null;}
export async function mountAppHistory(el){const root=createRoot(el);await act(async()=>root.render(<StrictMode><AppHistoryEffect/></StrictMode>));return root;}
export async function mount(el, complete) { const root=createRoot(el); await act(async()=>root.render(<LoginPage onLoginSuccess={complete}/>)); return root; }
` }, bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_AUTH_MODE': '"session"' }, plugins: [{ name: 'visual-boundaries-only', setup(b) {
  for (const [filter, path] of [[/^framer-motion$/, 'motion'], [/^\.\.\/Common$/, 'toast'], [/^\.\.\/Visual\/Lightfall$/, 'lightfall'], [/\.\/runtimeConfig$/, 'runtime']]) b.onResolve({ filter }, () => ({ path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ resolveDir: frontend, loader: 'tsx', contents: {
    motion: `import {forwardRef,createElement} from 'react'; const cache=new Map(); export const motion=new Proxy({}, {get:(_,tag)=>{if(!cache.has(tag)) cache.set(tag,forwardRef(({children,initial,animate,exit,variants,transition,custom,whileHover,whileTap,...props},ref)=>createElement(tag,{...props,ref},children)));return cache.get(tag);}}); export const AnimatePresence=({children})=>children;`,
    toast: `export const useToast=()=>({showToast:()=>{},Toast:()=>null});`, lightfall: `export const Lightfall=()=>null;`,
    runtime: `export const getApiBaseUrl=()=>'/api';export const getApiBaseUrlCandidates=()=>['/api'];export const rememberBackendOrigin=()=>{};`,
  }[path] }));
} }] });
const adapter = await build({ stdin: { resolveDir: frontend, loader: 'ts', contents: `export * from './e2e/phoneLoginRecovery';export * from './e2e/sessionBootstrapRecovery';` }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'controlled-page-assertions', setup(b) {
  b.onResolve({ filter: /^@playwright\/test$/ }, () => ({ path: 'playwright', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export function expect(locator){return {toBeVisible:async()=>{if(!await locator.isVisible())throw new Error('workspace not visible');}}};expect.poll=read=>({toBe:async wanted=>{for(let i=0;i<100;i++){if(await read()===wanted)return;await Promise.resolve();}throw new Error('controlled state pending');}});` }));
} }] });
await writeFile(resolve(output, 'component.mjs'), component.outputFiles[0].text); await writeFile(resolve(output, 'adapter.mjs'), adapter.outputFiles[0].text);
const { act, mount, mountAppHistory, axiosInstance, confirmAuthIdentity } = await import(pathToFileURL(resolve(output, 'component.mjs')).href);
const { uiPhoneLogin, beginSessionBootstrapRecovery } = await import(pathToFileURL(resolve(output, 'adapter.mjs')).href);
const fixtureSource = await readFile(resolve(frontend, 'e2e/authFixture.ts'), 'utf8');
const password = fixtureSource.match(/password: '([^']+)'/)[1], phone = '13800000001', owner = 'synthetic-A', origin = 'http://127.0.0.1:3210';
class Handle {
  constructor(page, value) { this.page = page; this.value = value; }
  async $(selector) { const value = this.value.querySelector(selector); return value ? new Handle(this.page, value) : null; }
  async evaluateHandle(fn, arg) { return new Handle(this.page, fn(this.value, arg)); }
  async evaluate(fn) { return fn(this.value); }
  async click() { await this.page.click(this.value); }
  async dispose() {}
}
class Page extends EventEmitter {
  frame = {}; currentDocument = document; historyMode = false; historyOrder = 'raw-first'; destination = false; posts = 0; clicks = 0; events = []; mutate = null;
  context() { return { newCDPSession: async () => {
    const session = new EventEmitter(); this.cdp = session;
    session.send = async command => command === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', loaderId: 'original', url: this.url() } } } : {};
    session.detach = async () => { session.emit('close'); }; return session;
  } }; }
  async evaluateHandle() { return new Handle(this, this.currentDocument); }
  async evaluate(fn, handle) { const previous = globalThis.document; globalThis.document = this.currentDocument; try { return fn(handle.value); } finally { globalThis.document = previous; } }
  url() { return origin + '/'; } mainFrame() { return this.frame; }
  field(name) { return document.querySelector(`input[placeholder="${name}"]`); }
  getByRole() { return {}; }
  getByTestId() { return { isVisible: async () => this.destination }; }
  getByPlaceholder(name) { return { fill: async value => { await act(async () => {
    const field = this.field(name), previous = document.activeElement;
    if (previous?.tagName === 'INPUT' && previous !== field) { previous.dispatchEvent(new browser.Event('change', { bubbles: true })); previous.blur(); }
    field.focus(); Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(field, value); field.dispatchEvent(new browser.Event('input', { bubbles: true }));
  }); } }; }
  locator() { return { filter: () => ({ elementHandle: async () => new Handle(this, document.querySelector('form')) }) }; }
  request(path, method='GET', body) { return { url:()=>origin+path, method:()=>method, postDataJSON:()=>body, headers:()=>({'x-expected-user-id':owner}),frame:()=>this.frame }; }
  emitResponse(path, method='GET', body) { const req=this.request(path,method,body);this.emit('request',req);const response={request:()=>req,url:()=>req.url(),status:()=>200,headers:()=>({}),json:async()=>{
    if(path==='/api/bootstrap'&&this.historyMode){
      if(this.historyMode==='reload') { this.currentDocument={}; this.cdp.emit('Page.frameNavigated',{frame:{id:'main',loaderId:'replacement',url:this.url()},type:'Navigation'});this.emit('framenavigated',this.frame); }
      else { historyMounted=await mountAppHistory(historyContainer); await act(async()=>mounted.unmount()); }
    }
    return {user:{id:path==='/api/bootstrap'?(this.bootstrapOwner??owner):owner}};
  }};this.emit('response',response);this.emit('requestfinished',req); }
  async click(button) {
    this.clicks++;
    await act(async () => {
      const input=this.field('请输入密码');assert.equal(document.activeElement,input);
      this.mutate?.();
      this.events.push({event:'deferred-change',sameIntent:this.field('请输入手机号').value===phone&&input.value===password});
      input.dispatchEvent(new browser.Event('change',{bubbles:true}));input.blur();button.focus();
      const event=new browser.Event('submit',{bubbles:true,cancelable:true});document.querySelector('form').dispatchEvent(event);
      this.events.push({event:'submit',defaultPrevented:event.defaultPrevented});
      await Promise.resolve();await Promise.resolve();
    });
  }
  async screenshot() {}
}
let page, mounted, container, historyMounted, historyContainer;
const originalReplaceState=browser.history.replaceState.bind(browser.history);
browser.history.replaceState=(...args)=>{
  originalReplaceState(...args);
  if(page){
    page.events.push({event:'actual-App-history-effect'});
    const raw=()=>page.cdp.emit('Page.navigatedWithinDocument',{frameId:'main',url:page.url(),navigationType:'historyApi'});
    const publicEvent=()=>page.emit('framenavigated',page.frame);
    if(page.historyOrder==='raw-first'){raw();publicEvent();}else{publicEvent();raw();}
  }
};
beforeEach(async()=>{
  historyMounted=null;historyContainer=document.createElement('div');document.body.append(historyContainer);
  confirmAuthIdentity(null);document.cookie='XSRF-TOKEN=synthetic-csrf';page=new Page();container=document.createElement('div');document.body.append(container);
  axiosInstance.defaults.adapter=async config=>{
    if(config.url==='/csrf-token')return {config,data:{csrfToken:'synthetic-csrf'},status:200,statusText:'OK',headers:{}};
    assert.equal(config.url,'/auth/login-phone');const body=typeof config.data==='string'?JSON.parse(config.data):config.data;assert.ok(body.phone===phone,'POST matches the frozen phone intent');assert.ok(body.password===password,'POST matches the frozen password intent');page.posts++;page.emitResponse('/api/auth/login-phone','POST',body);
    return {config,data:{user:{id:owner}},status:200,statusText:'OK',headers:{}};
  };
  mounted=await mount(container,async()=>{page.emitResponse('/api/bootstrap');page.destination=true;});
});
afterEach(async()=>{if(historyMounted)await act(async()=>historyMounted.unmount());await act(async()=>mounted.unmount());container.remove();historyContainer.remove();});after(async()=>{browser.close();await rm(output,{recursive:true,force:true});});
const run=()=>{const info={timeout:20000,attach:async()=>{},outputPath:name=>name};beginSessionBootstrapRecovery(page,info);return uiPhoneLogin(page,info,phone,owner);};
test('real LoginPage plus real API and actual adapter allow unchanged deferred blur-change before submit',async()=>{
  await run();
  assert.equal(page.posts,1);assert.equal(page.destination,true);
});
for(const target of ['phone','password'])test(`real ${target} A-B-A value edits remain sticky and cannot submit`,async()=>{
  page.mutate=()=>{const input=page.field(target==='phone'?'请输入手机号':'请输入密码'),value=input.value;const setter=Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype,'value').set;setter.call(input,target==='phone'?'13900000002':value+'x');input.dispatchEvent(new browser.Event('input',{bubbles:true}));setter.call(input,value);input.dispatchEvent(new browser.Event('input',{bubbles:true}));};
  await assert.rejects(run(),/changed|did not submit/);assert.equal(page.posts,0);
});

for(const order of ['raw-first','public-first'])test(`actual App StrictMode double-history during bootstrap body read preserves original Document (${order})`,async()=>{
  page.historyMode=true;page.historyOrder=order;const original=document;
  await run();assert.equal(page.posts,1);assert.equal(page.currentDocument,original);assert.equal(page.destination,true);
  assert.equal(page.events.filter(event=>event.event==='actual-App-history-effect').length,2);
  assert.equal(document.querySelector('form'),null,'successful LoginPage unmount is not a document change');
});
test('actual App history cannot excuse a wrong bootstrap user body',async()=>{
  page.historyMode=true;page.bootstrapOwner='synthetic-other';await assert.rejects(run(),/expected user/);assert.equal(page.posts,1);
  assert.equal(page.events.filter(event=>event.event==='actual-App-history-effect').length,2);
});
test('same-URL cross-document protocol event remains terminal during bootstrap body read',async()=>{
  page.historyMode='reload';await assert.rejects(run(),/changed/);assert.equal(page.posts,1);assert.notEqual(page.currentDocument,document);
});
