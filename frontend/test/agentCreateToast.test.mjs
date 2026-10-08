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
export { pushGlobalToast } from './src/components/Common/Toast'; export { act }; export async function render(container,open=true,existing) { const root=existing||createRoot(container); await act(async()=>root.render(<AgentCreateModal isOpen={open} onClose={()=>globalThis.__agentModalTest.closed++}/>)); return root; }
`,resolveDir:root,sourcefile:'agent-modal-test.tsx',loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',write:false,plugins:[{name:'stores',setup(build){
 build.onResolve({filter:/stores\/agentsStore$/},()=>({path:'agents',namespace:'mock'}));
 build.onResolve({filter:/stores\/modelsStore$/},()=>({path:'models',namespace:'mock'}));
 build.onResolve({filter:/^\.\.\/Common$/},()=>({path:'toast',namespace:'mock'}));
 build.onResolve({filter:/hooks\/useReducedMotion$/},()=>({path:'reduced',namespace:'mock'}));
 build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',resolveDir:root,contents:path==='reduced'?'export const useReducedMotion=()=>true;':path==='agents'?`export const useAgentsStore=selector=>selector({generateQuestions:async()=>{globalThis.__agentModalTest.questionsCalls++;return [{id:'web',question:'需要搜索吗？'}]},createAgent:async data=>{globalThis.__agentModalTest.creates.push(data);return globalThis.__agentModalTest.create(data)},creatingAgent:false});`:path==='models'?`export const useModelsStore=selector=>selector({catalog:{models:[{id:'fixture',name:'Fixture',ready:true,capabilities:['chat']}]}});export const requestError=()=> '创建失败';`:`export {useToast} from './src/components/Common/useToast';` }));
}}]});
const {act,render,pushGlobalToast}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
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

test('rapid failed create then retry/success removes only its own error toast',async()=>{
 let reject,resolve;state.create=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});
 await fill();await next();await act(async()=>button('创建智能体').click());
 await act(async()=>reject(new Error('synthetic create failure')));
 assert.ok(document.body.textContent.includes('创建失败'));
 // Same message from another operation must not be removed by message matching.
 let unrelated;await act(async()=>{unrelated=pushGlobalToast({message:'创建失败',type:'warning',duration:10000});pushGlobalToast({message:'其他操作失败',type:'error',duration:10000});});
 assert.equal([...document.querySelectorAll('[data-global-toast-host] .text-sm.font-medium')].filter(e=>e.textContent==='创建失败').length,2);
 await act(async()=>button('创建智能体').click());
 // Allow exit animation, well before the 2500ms toast auto-expiry.
 await act(async()=>new Promise(resolve=>setTimeout(resolve,200)));
 assert.ok(button('创建中...'));
 assert.equal(document.querySelectorAll('[data-global-toast-host] .border-l-red-500').length,1,'retry clears only its own error before success');
 assert.equal([...document.querySelectorAll('[data-global-toast-host] .text-sm.font-medium')].filter(e=>e.textContent==='创建失败').length,1);
 await act(async()=>resolve({id:'success',name:'测试助手',model_selection_reasoning:'根据用户说明创建'}));
 assert.ok(button('完成'));
 // Allow the existing reduced-motion exit, well before 2500ms auto-expiry.
 await act(async()=>new Promise(resolve=>setTimeout(resolve,200)));
 const textNodes=[...document.querySelectorAll('[data-global-toast-host] .text-sm.font-medium')].filter(e=>e.textContent==='创建失败');
 assert.equal(textNodes.length,1,'failed-create toast must be gone while unrelated identical text remains');
 const cards=[...document.querySelectorAll('[data-global-toast-host] .border-l-red-500')];
 assert.equal(cards.length,1,'only the unrelated red error remains');
 assert.ok(document.body.textContent.includes('其他操作失败'));
 // Normal toast auto-expiry is not a valid reason for this rapid result.
 await act(async()=>{for(const close of document.querySelectorAll('[data-global-toast-host] button'))close.click();});
});
