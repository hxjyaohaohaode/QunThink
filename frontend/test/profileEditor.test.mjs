import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');const window=new Window({url:'http://localhost/'});
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Node:window.Node,Element:window.Element,FileReader:window.FileReader,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.hidden?0:100;}});
class Channel{port1={onmessage:null};port2={postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0)};}
Object.defineProperty(globalThis,'MessageChannel',{value:Channel,configurable:true});
after(()=>window.close());
const profile={nickname:'原昵称',avatar_url:'',gender:'',age:null,height:null,weight:null,occupation:'',education:'',hobbies:[],personality:[],goals:'',bio:''};
globalThis.__profileUi={profile,toasts:[],saves:[],close:0,save:async()=>{}};
const bundled=await build({stdin:{contents:`import {createRoot} from 'react-dom/client'; import {act,useState} from 'react'; import {UserProfileEditor} from './src/components/Layout/UserProfileEditor'; import {useProfileStore} from './src/stores/profileStore'; export {act,useProfileStore}; function Harness(){const [open,setOpen]=useState(true);globalThis.__profileUi.setOpen=setOpen;return <UserProfileEditor isOpen={open} onClose={()=>{globalThis.__profileUi.close++;setOpen(false);}}/>;} export async function mount(el){const root=createRoot(el);await act(async()=>root.render(<Harness/>));return root;}`,resolveDir:root,sourcefile:'profile-editor.tsx',loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',write:false,plugins:[{name:'profile-boundaries',setup(build){
 build.onResolve({filter:/stores\/profileStore$/},()=>({path:'profile',namespace:'mock'}));build.onResolve({filter:/hooks\/useReducedMotion$/},()=>({path:'reduced',namespace:'mock'}));build.onResolve({filter:/^\.\.\/Common$/},()=>({path:'common',namespace:'mock'}));
 build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:{profile:`import {create} from 'zustand';export const useProfileStore=create(set=>({profile:globalThis.__profileUi.profile,fetchProfile:async()=>{},updateProfile:async value=>{globalThis.__profileUi.saves.push(value);await globalThis.__profileUi.save(value);set({profile:value});}}));`,reduced:'export const useReducedMotion=()=>true;',common:`export {useConfirm} from './src/components/Common/useConfirm'; export const useToast=()=>({showToast:toast=>globalThis.__profileUi.toasts.push(toast),Toast:<div data-toast/>});`}[path],loader:'tsx',resolveDir:root}));
}}]});
const {act,mount,useProfileStore:store}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
let container,mounted;const wait=()=>new Promise(r=>setTimeout(r,5));const button=text=>[...document.body.querySelectorAll('button')].find(el=>el.textContent===text);const nickname=()=>document.body.querySelector('input[id$="-nickname"]');
async function type(el,value){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));});}
async function escape(){await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));}
async function click(text){await act(async()=>{button(text).click();await wait();});}
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();container=document.createElement('div');document.body.append(container);globalThis.__profileUi={profile,toasts:[],saves:[],close:0,save:async()=>{}};store.setState({profile});mounted=await mount(container);});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());});
test('fresh profile receipts cannot overwrite a dirty draft and Escape asks before discarding',async()=>{
 assert.equal(document.body.querySelector('[data-profile-layer]').parentElement,document.body);
 assert.ok(document.body.querySelector('button[aria-label="选择头像"]'));
 await type(nickname(),'正在输入');await act(async()=>store.setState({profile:{...profile,nickname:'较晚读取'}}));assert.equal(nickname().value,'正在输入');
 await escape();assert.match(document.body.textContent,/放弃未保存的资料修改/);assert.equal(globalThis.__profileUi.close,0);
 await click('继续编辑');assert.equal(nickname().value,'正在输入');assert.equal(globalThis.__profileUi.close,0);
 await escape();await click('放弃修改');assert.equal(globalThis.__profileUi.close,1);
});
test('save freezes its snapshot, rejects same-frame duplicate clicks and keeps failed edits available',async()=>{
 await type(nickname(),'本次保存');let reject;globalThis.__profileUi.save=()=>new Promise((_,r)=>{reject=r;});
 await act(async()=>{button('保存').click();button('保存').click();});assert.equal(globalThis.__profileUi.saves.length,1);assert.equal(document.body.querySelector('fieldset').disabled,true);await type(nickname(),'不应覆盖冻结内容');assert.equal(nickname().value,'本次保存');
 await escape();await click('关闭');assert.equal(globalThis.__profileUi.close,0);
 await act(async()=>{reject(new Error('连接失败'));await wait();});assert.equal(nickname().value,'本次保存');assert.equal(document.body.querySelector('fieldset').disabled,false);assert.match(globalThis.__profileUi.toasts.at(-1).message,/连接失败/);assert.ok(document.body.querySelector('[data-toast]'));
 globalThis.__profileUi.save=async()=>{};await click('保存');assert.equal(globalThis.__profileUi.close,1);assert.equal(globalThis.__profileUi.saves[1].nickname,'本次保存');
});
test('mobile swipe dismissal uses the same unsaved-change protection',async()=>{
 await type(nickname(),'滑动不丢失');const handle=document.body.querySelector('.cursor-grab');
 const event=(type,y)=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:[{clientY:y}]});return e;};
 await act(async()=>handle.dispatchEvent(event('touchstart',0)));await act(async()=>handle.dispatchEvent(event('touchmove',170)));await act(async()=>handle.dispatchEvent(event('touchend',170)));
 assert.match(document.body.textContent,/放弃未保存的资料修改/);await click('继续编辑');assert.equal(nickname().value,'滑动不丢失');assert.equal(globalThis.__profileUi.close,0);
});
test('invalid input is announced and every basic profile field has an associated label',async()=>{
 await type(nickname(),'');await click('保存');assert.match(document.body.querySelector('[role="alert"]').textContent,/昵称不能为空/);assert.equal(globalThis.__profileUi.saves.length,0);
 for(const key of ['nickname','gender','age','height','weight','occupation','education','goals','bio']){const control=document.body.querySelector(`[id$="-${key}"]`);assert.ok(control);assert.ok([...document.body.querySelectorAll('label')].some(label=>label.htmlFor===control.id));}
});

test('a confirmation from a hidden editor cannot close a new editing session',async()=>{
 await type(nickname(),'旧会话修改');await escape();assert.match(document.body.textContent,/放弃未保存的资料修改/);
 await act(async()=>{globalThis.__profileUi.setOpen(false);await wait();});
 await act(async()=>{globalThis.__profileUi.setOpen(true);await wait();});
 assert.equal(document.body.querySelector('[aria-label="放弃未保存的资料修改？"]'),null);assert.equal(nickname().value,'原昵称');
 await type(nickname(),'新会话修改');await escape();await click('继续编辑');assert.equal(nickname().value,'新会话修改');assert.equal(globalThis.__profileUi.close,0);
});

test('late avatar reads cannot restore a discarded editing session or overwrite newer text',async()=>{
 const readers=[];const OriginalReader=globalThis.FileReader;
 class DeferredReader { readAsDataURL(){readers.push(this);} abort(){this.aborted=true;} }
 globalThis.FileReader=DeferredReader;
 const choose=async()=>{const input=document.body.querySelector('input[type="file"]');Object.defineProperty(input,'files',{configurable:true,value:[new window.File(['image'],'avatar.png',{type:'image/png'})]});await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));};
 try{
  await choose();assert.equal(button('保存').disabled,true);await type(nickname(),'图片读取期间的新昵称');
  await act(async()=>readers[0].onload({target:{result:'data:image/png;base64,c3ludGhldGlj'}}));assert.equal(nickname().value,'图片读取期间的新昵称');assert.equal(button('保存').disabled,false);
  await choose();const stale=readers[1];await act(async()=>{globalThis.__profileUi.setOpen(false);await wait();});await act(async()=>{globalThis.__profileUi.setOpen(true);await wait();});
  await act(async()=>stale.onload({target:{result:'data:image/png;base64,b2xk'}}));assert.equal(nickname().value,'原昵称');assert.equal(button('移除头像'),undefined);assert.equal(stale.aborted,true);
 }finally{globalThis.FileReader=OriginalReader;}
});

test('the most recently selected avatar wins even when older FileReader callbacks arrive last',async()=>{
 const readers=[];const OriginalReader=globalThis.FileReader;class DeferredReader{readAsDataURL(){readers.push(this);}abort(){this.aborted=true;}}globalThis.FileReader=DeferredReader;
 try{
  const input=document.body.querySelector('input[type="file"]');Object.defineProperty(input,'files',{configurable:true,value:[new window.File(['image'],'avatar.png',{type:'image/png'})]});
  await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));await act(async()=>input.dispatchEvent(new window.Event('change',{bubbles:true})));
  await act(async()=>readers[1].onload({target:{result:'data:image/png;base64,bmV3'}}));await act(async()=>readers[0].onload({target:{result:'data:image/png;base64,b2xk'}}));
  await click('保存');assert.equal(globalThis.__profileUi.saves[0].avatar_url,'data:image/png;base64,bmV3');assert.equal(readers[0].aborted,true);
 }finally{globalThis.FileReader=OriginalReader;}
});

test('a late save acknowledgment does not close or unlock a newer editing session',async()=>{
 let complete;globalThis.__profileUi.save=()=>new Promise(resolve=>{complete=resolve;});await type(nickname(),'旧会话已提交');await click('保存');
 await act(async()=>{globalThis.__profileUi.setOpen(false);await wait();});await act(async()=>{globalThis.__profileUi.setOpen(true);await wait();});await type(nickname(),'新会话仍在输入');
 await act(async()=>{complete();await wait();});assert.equal(nickname().value,'新会话仍在输入');assert.equal(globalThis.__profileUi.close,0);assert.equal(globalThis.__profileUi.toasts.length,0);
});

test('an unmounted editor ignores late save feedback and close callbacks',async()=>{
 let complete;globalThis.__profileUi.save=()=>new Promise(resolve=>{complete=resolve;});await type(nickname(),'卸载前提交');await click('保存');
 await act(async()=>mounted.unmount());mounted=null;await act(async()=>{complete();await wait();});assert.equal(globalThis.__profileUi.close,0);assert.equal(globalThis.__profileUi.toasts.length,0);
});

test('unfinished custom tags count as a draft and Save includes them without an extra Enter step',async()=>{
 const input=document.body.querySelector('input[placeholder="自定义标签，按回车添加"]');await type(input,'徒步');await escape();assert.ok(document.body.querySelector('[aria-label="放弃未保存的资料修改？"]'));await click('继续编辑');
 await click('保存');assert.deepEqual(globalThis.__profileUi.saves[0].hobbies,['徒步']);
 await act(async()=>{globalThis.__profileUi.setOpen(true);await wait();});assert.equal(document.body.querySelector('input[placeholder="自定义标签，按回车添加"]').value,'');
});
