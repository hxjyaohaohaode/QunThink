import test, {after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {Window} from 'happy-dom';
const root=resolve(import.meta.dirname,'..');const window=new Window({url:'http://localhost/'});Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator});class Channel{port1={onmessage:null};port2={postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0)};}Object.defineProperty(globalThis,'MessageChannel',{configurable:true,value:Channel});after(()=>window.close());
globalThis.__clear={user:'alice',generation:1,toasts:[],targets:[],confirmations:[]};
const bundled=await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import {act} from 'react';import {useLocalCacheClear} from './src/hooks/useLocalCacheClear';export {act};function Harness({tick}){const state=useLocalCacheClear();globalThis.__clear.action=state.clear;return <button disabled={state.clearing}>clear</button>;}export async function render(el,existing,tick=0){const root=existing||createRoot(el);await act(async()=>root.render(<Harness tick={tick}/>));return root;}`,resolveDir:root,loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',write:false,plugins:[{name:'cache-ui-boundaries',setup(build){
 const routes=[[/components\/Common\/useConfirm$/,'confirm'],[/components\/Common\/useToast$/,'toast'],[/services\/api$/,'auth'],[/utils\/cacheUtils$|^\.\/cacheUtils$/,'cache'],[/^\.\/indexedDB$/,'indexed']];for(const[filter,path]of routes)build.onResolve({filter},()=>({path,namespace:'mock'}));
 build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'tsx',contents:{confirm:`export const useConfirm=()=>({confirm:globalThis.__clear.confirm,cancelPending:globalThis.__clear.cancel,ConfirmModal:null});`,toast:`const showToast=value=>globalThis.__clear.toasts.push(value);export const useToast=()=>({showToast});`,auth:`export const getAuthGeneration=()=>globalThis.__clear.generation;`,cache:`export const getCacheUserId=()=>globalThis.__clear.user;export const clearAllCachesForUser=()=>true;`,indexed:`export const clearAllIndexedDBForUser=async user=>{globalThis.__clear.targets.push(user);return globalThis.__clear.indexed;};`}[path],resolveDir:root}));
}}]});
const{act,render}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);let container,mounted;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();container=document.createElement('div');document.body.append(container);let answer;globalThis.__clear={user:'alice',generation:1,toasts:[],targets:[],confirmations:[],indexed:true,confirm:options=>{globalThis.__clear.confirmations.push(options);return new Promise(resolve=>{answer=resolve;globalThis.__clear.answer=resolve;});},cancel:()=>{answer?.(false);answer=undefined;}};globalThis.caches={delete:async()=>false};mounted=await render(container);});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());});
async function accept(){await act(async()=>{globalThis.__clear.answer(true);await flush();});}
async function request(){await act(async()=>{void globalThis.__clear.action();});}

test('one confirmation/operation at a time; false deletion produces error rather than success and remains retryable',async()=>{
 const blocked=deferred();globalThis.__clear.indexed=blocked.promise;await act(async()=>{void globalThis.__clear.action();void globalThis.__clear.action();});assert.equal(globalThis.__clear.confirmations.length,1);assert.match(globalThis.__clear.confirmations[0].description,/未发送消息/);await accept();assert.equal(container.querySelector('button').disabled,true);
 await act(async()=>{blocked.resolve(false);await flush();});assert.equal(globalThis.__clear.toasts.at(-1).type,'error');assert.equal(container.querySelector('button').disabled,false);
 globalThis.__clear.indexed=true;await request();await accept();assert.equal(globalThis.__clear.toasts.at(-1).type,'success');
});
test('an account transition cancels the old confirmation before any destructive action',async()=>{
 await request();const oldAnswer=globalThis.__clear.answer;globalThis.__clear.user='bob';globalThis.__clear.generation++;mounted=await render(container,mounted,1);await act(async()=>{oldAnswer(true);await flush();});assert.deepEqual(globalThis.__clear.targets,[]);assert.deepEqual(globalThis.__clear.toasts,[]);
});
test('late A completion cannot toast into B or release a newer B operation',async()=>{
 const a=deferred(),b=deferred();globalThis.__clear.indexed=a.promise;await request();await accept();globalThis.__clear.user='bob';globalThis.__clear.generation++;mounted=await render(container,mounted,1);globalThis.__clear.indexed=b.promise;await request();await accept();
 await act(async()=>{a.resolve(true);await flush();});assert.equal(container.querySelector('button').disabled,true);assert.deepEqual(globalThis.__clear.toasts,[]);await act(async()=>{b.resolve(true);await flush();});assert.equal(globalThis.__clear.toasts.length,1);assert.equal(globalThis.__clear.toasts[0].type,'success');assert.deepEqual(globalThis.__clear.targets,['alice','bob']);
});
test('unmounting a cleanup surface suppresses its late notifications',async()=>{
 const pending=deferred();globalThis.__clear.indexed=pending.promise;await request();await accept();await act(async()=>mounted.unmount());mounted=null;await act(async()=>{pending.resolve(false);await flush();});assert.deepEqual(globalThis.__clear.toasts,[]);
});
