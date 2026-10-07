import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Element: window.Element, FileReader: window.FileReader, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable:true, get() { return this.hidden ? 0 : 100; } });
class Channel { port1 = { onmessage:null }; port2 = { postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0) }; }
Object.defineProperty(globalThis,'MessageChannel',{value:Channel,configurable:true});
const state = globalThis.__agentModalTest = {};
const bundled = await build({ stdin: { contents:`
import { createRoot } from 'react-dom/client'; import { act } from 'react';
import { AgentCreateModal } from './src/components/Layout/AgentCreateModal';
export { act }; export async function render(container,open=true,existing) { const root=existing||createRoot(container); await act(async()=>root.render(<AgentCreateModal isOpen={open} onClose={()=>globalThis.__agentModalTest.closed++}/>)); return root; }
`,resolveDir:root,sourcefile:'agent-modal-test.tsx',loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',write:false,plugins:[{name:'stores',setup(build){
 build.onResolve({filter:/stores\/agentsStore$/},()=>({path:'agents',namespace:'mock'}));
 build.onResolve({filter:/stores\/modelsStore$/},()=>({path:'models',namespace:'mock'}));
 build.onResolve({filter:/^\.\.\/Common$/},()=>({path:'toast',namespace:'mock'}));
 build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='agents'?`export const useAgentsStore=selector=>selector({generateQuestions:async()=>{globalThis.__agentModalTest.questionsCalls++;return [{id:'web',question:'需要搜索吗？'}]},createAgent:async data=>{globalThis.__agentModalTest.creates.push(data);return globalThis.__agentModalTest.create(data)},creatingAgent:false});`:path==='models'?`export const useModelsStore=selector=>selector({catalog:{models:[{id:'fixture',name:'Fixture',ready:true,capabilities:['chat']}]}});export const requestError=()=> '创建失败';`:`export const useToast=()=>({showToast:()=>{},Toast:null});` }));
}}]});
const {act,render}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let container,mounted;
const button=text=>[...container.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
const close=()=>container.querySelector('[aria-label="关闭创建智能体"]');
const overlay=()=>container.querySelector('[role="dialog"]');
async function input(el,value){await act(async()=>{const proto=el.tagName==='SELECT'?window.HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
async function fill(){await input(container.querySelector('input[type="text"]'),'测试助手');const textareas=container.querySelectorAll('textarea');await input(textareas[0],'保留完整简介');await input(textareas[1],'你好，这是开场白');}
async function dismiss(route){await act(async()=>{if(route==='escape')close().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));else (route==='backdrop'?overlay():close()).click();});}
async function next(){await act(async()=>button('下一步').click());assert.ok(button('上一步'));}
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();container=document.createElement('div');document.body.append(container);mounted=null;Object.assign(state,{closed:0,confirms:0,allow:false,creates:[],questionsCalls:0,create:async()=>({id:'new',name:'测试助手'})});window.confirm=()=>{state.confirms++;return state.allow;};mounted=await render(container);});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());window.close();});
for(const route of ['x','backdrop','escape']){
 test(`pristine ${route} closes without confirmation`,async()=>{await dismiss(route);assert.equal(state.closed,1);assert.equal(state.confirms,0);});
 for(const step of [1,2])test(`step ${step} ${route} preserves all edits on decline and clears on discard`,async()=>{
  await fill();await input(container.querySelector('select'),'fixture');await act(async()=>container.querySelector('button[type="button"]').click());
  if(step===2){await next();await input(container.querySelector('input[type="text"]'),'是，需要保留');}
  await dismiss(route);assert.equal(state.closed,0);assert.equal(state.confirms,1);
  if(step===2){assert.equal(container.querySelector('input[type="text"]').value,'是，需要保留');await act(async()=>button('上一步').click());}
  assert.equal(container.querySelector('input[type="text"]').value,'测试助手');assert.equal(container.querySelectorAll('textarea')[0].value,'保留完整简介');assert.equal(container.querySelectorAll('textarea')[1].value,'你好，这是开场白');assert.equal(container.querySelector('select').value,'fixture');
  if(step===2)await next();state.allow=true;await dismiss(route);assert.equal(state.closed,1);assert.equal(state.confirms,2);
  assert.equal(container.querySelector('input[type="text"]').value,'');assert.equal(container.querySelector('select').value,'');assert.equal(container.querySelectorAll('textarea')[0].value,'');
 });
}
test('model-only and suggestions-only changes require confirmation',async()=>{await input(container.querySelector('select'),'fixture');await dismiss('escape');assert.equal(state.closed,0);assert.equal(state.confirms,1);await input(container.querySelector('select'),'');await act(async()=>container.querySelector('button[type="button"]').click());await dismiss('escape');assert.equal(state.closed,0);assert.equal(state.confirms,2);});
test('pending creation blocks all dismissal and same-frame duplicate creates; failed create retains draft',async()=>{
 let reject;state.create=()=>new Promise((_,no)=>{reject=no;});await fill();await next();await input(container.querySelector('input[type="text"]'),'是');
 await act(async()=>{const create=button('创建智能体');create.click();overlay().click();create.click();});
 for(const route of ['x','backdrop','escape'])await dismiss(route);
 assert.equal(state.creates.length,1);assert.equal(state.closed,0);assert.equal(state.confirms,0);assert.ok(button('创建中...'));
 await act(async()=>reject(new Error('synthetic failure')));assert.ok(button('上一步'));assert.equal(container.querySelector('input[type="text"]').value,'是');await dismiss('backdrop');assert.equal(state.confirms,1);assert.equal(state.closed,0);
 await act(async()=>button('上一步').click());assert.equal(container.querySelector('input[type="text"]').value,'测试助手');
});
test('successful completion closes without a discard prompt and resets selected model',async()=>{await fill();await input(container.querySelector('select'),'fixture');await next();await act(async()=>button('创建智能体').click());assert.ok(button('完成'));await act(async()=>button('完成').click());assert.equal(state.closed,1);assert.equal(state.confirms,0);assert.equal(container.querySelector('select').value,'');});
test('avatar-only draft is preserved on declined discard and cleared on accepted discard',async()=>{
 const fileInput=container.querySelector('input[type="file"]');
 Object.defineProperty(fileInput,'files',{configurable:true,value:[new window.File(['synthetic image'],'avatar.png',{type:'image/png'})]});
 await act(async()=>{fileInput.dispatchEvent(new window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,15));});
 const source=container.querySelector('img')?.getAttribute('src');assert.ok(source?.startsWith('data:image/png;base64,'));
 await dismiss('escape');assert.equal(state.closed,0);assert.equal(state.confirms,1);assert.equal(container.querySelector('img').getAttribute('src'),source);
 state.allow=true;await dismiss('backdrop');assert.equal(state.closed,1);assert.equal(container.querySelector('img'),null);
});
test('declined discard preserves suggestion setting in submitted draft; hidden/reopened modal starts clean after successful completion',async()=>{
 await fill();await input(container.querySelector('select'),'fixture');await act(async()=>container.querySelector('button[type="button"]').click());await next();await dismiss('escape');
 await act(async()=>button('创建智能体').click());assert.equal(state.creates[0].enableSuggestions,false);assert.equal(state.creates[0].modelId,'fixture');
 await act(async()=>button('完成').click());mounted=await render(container,false,mounted);assert.equal(overlay(),null);mounted=await render(container,true,mounted);
 assert.equal(container.querySelector('select').value,'');assert.equal(container.querySelector('input[type="text"]').value,'');await fill();await next();await act(async()=>button('创建智能体').click());assert.equal(state.creates[1].enableSuggestions,true);
});
