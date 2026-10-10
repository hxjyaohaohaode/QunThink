import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'), win=new Window({url:'http://localhost/'});
Object.assign(globalThis,{window:win,document:win.document,HTMLElement:win.HTMLElement,Node:win.Node,Element:win.Element,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:win.navigator,configurable:true});
win.HTMLElement.prototype.scrollIntoView=()=>{};
class Channel {port1={onmessage:null};port2={postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0)};}
Object.defineProperty(globalThis,'MessageChannel',{value:Channel,configurable:true});
const state=globalThis.__agentSuggestionsTest={};
const bundle=await build({stdin:{contents:`import {createRoot} from 'react-dom/client'; import {act,StrictMode} from 'react'; import {AgentChatView} from './src/components/Layout/AgentChatView'; export {act}; export async function render(container,id='a',existing,strict=false){const root=existing||createRoot(container);await act(async()=>root.render(strict?<StrictMode><AgentChatView agentId={id} onBack={()=>{}}/></StrictMode>:<AgentChatView agentId={id} onBack={()=>{}}/>));return root;}`,resolveDir:root,sourcefile:'agent-suggestions.tsx',loader:'tsx'},bundle:true,format:'esm',platform:'browser',jsx:'automatic',write:false,plugins:[{name:'test-fixtures',setup(build){
 build.onResolve({filter:/stores\/agentsStore$/},()=>({path:'store',namespace:'fixture'}));
 build.onResolve({filter:/^framer-motion$/},()=>({path:'motion',namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',resolveDir:root,contents:path==='store'?`export const useAgentsStore=selector=>selector(globalThis.__agentSuggestionsTest.store);`:`import React from 'react';const C=React.forwardRef(({children,initial,animate,exit,transition,...props},ref)=>React.createElement('div',{...props,ref},children));const B=React.forwardRef(({children,initial,animate,exit,transition,...props},ref)=>React.createElement('button',{...props,ref},children));export const motion={div:C,button:B};export const AnimatePresence=({children})=>children;`}));
}}]});
const {act,render}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let container,mounted;
const agent=id=>({id,name:'Synthetic '+id,description:'写作助手',opening_message:'Synthetic greeting',enable_suggestions:true,created_at:'2026-10-08T00:00:00Z'});
const pending=()=>container.textContent.includes('生成建议中...');
const button=text=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
async function complete(index,values){await act(async()=>state.calls[index].resolve(values));}
async function update(){mounted=await render(container,state.store.currentAgent.id,mounted);}
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();container=document.createElement('div');document.body.append(container);mounted=null;state.calls=[];state.sends=[];state.send=async()=>{};state.store={agents:[agent('a'),agent('b')],currentAgent:agent('a'),agentMessages:new Map([['a',[]],['b',[]]]),selectAgent:()=>{},fetchAgentMessages:async()=>{},sendAgentMessage:(...args)=>{state.sends.push(args);return state.send(...args)},fetchAgentSuggestions:async()=>[]};});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());win.close();});

const input=()=>container.querySelector('input[placeholder="输入消息或上传附件..."]');
async function type(value){await act(async()=>{Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set.call(input(),value);input().dispatchEvent(new win.Event('input',{bubbles:true}));});}
async function sendTwice(){await act(async()=>{input().dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));input().dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});}
test('known failed reply restores exact original input without automatically resending',async()=>{let reject;state.send=()=>new Promise((_,no)=>reject=no);mounted=await render(container);await type('  保留我的完整原文  ');await sendTwice();assert.equal(state.sends.length,1);assert.equal(input().value,'');await act(async()=>reject(new Error('合成回复失败')));assert.equal(input().value,'  保留我的完整原文  ');assert.equal(input().disabled,false);assert.match(container.querySelector('[role="alert"]').textContent,/消息可能已经保存.*核对会话/);assert.equal(state.sends.length,1);});
test('file selection and caption are restored only in the same failed-send view',async()=>{let reject;state.send=()=>new Promise((_,no)=>reject=no);mounted=await render(container);const upload=container.querySelector('input[type="file"]');const file=new win.File(['synthetic content'],'synthetic.txt',{type:'text/plain'});Object.defineProperty(upload,'files',{value:[file],configurable:true});await act(async()=>upload.dispatchEvent(new win.Event('change',{bubbles:true})));await type('合成附件说明');await sendTwice();assert.equal(state.sends[0][2][0],file);await act(async()=>reject(new Error('合成上传失败')));assert.equal(input().value,'合成附件说明');assert.ok(container.textContent.includes('synthetic.txt'));assert.equal(state.sends.length,1);});
test('late old-agent failure cannot replace a newer agent draft',async()=>{let reject;state.send=()=>new Promise((_,no)=>reject=no);mounted=await render(container);await type('旧会话原文');await sendTwice();state.store.currentAgent=state.store.agents[1];mounted=await render(container,'b',mounted);await type('新会话草稿');await act(async()=>reject(new Error('old failure')));assert.equal(input().value,'新会话草稿');assert.equal(container.querySelector('[role="alert"]'),null);assert.equal(input().disabled,false);});
test('A-B-A navigation fences a late old failure even when agent ID matches again',async()=>{let reject;state.send=()=>new Promise((_,no)=>reject=no);mounted=await render(container);await type('旧A原文');await sendTwice();state.store.currentAgent=state.store.agents[1];mounted=await render(container,'b',mounted);state.store.currentAgent=state.store.agents[0];mounted=await render(container,'a',mounted);await type('新的A草稿');await act(async()=>reject(new Error('obsolete A failure')));assert.equal(input().value,'新的A草稿');assert.equal(container.querySelector('[role="alert"]'),null);});
test('unmounted sender cannot restore a draft or notice',async()=>{let reject;state.send=()=>new Promise((_,no)=>reject=no);mounted=await render(container);await type('原文');await sendTwice();await act(async()=>mounted.unmount());mounted=null;await act(async()=>reject(new Error('late failure')));assert.equal(container.textContent,'');});
test('partial failed reply renders preserved body and explicit incomplete label',async()=>{state.store.agentMessages.set('a',[{id:'partial',agent_id:'a',sender_type:'agent',content:'已收到片段',response_state:'incomplete',response_error:'连接中断',created_at:'2026-10-08T00:00:01Z'}]);mounted=await render(container);assert.ok(container.textContent.includes('已收到片段'));assert.match(container.querySelector('[role="status"]').textContent,/回复未完成.*连接中断/);});
test('changing to a missing agent renders a bounded empty state without hook-order failure',async()=>{mounted=await render(container);state.store.currentAgent=null;state.store.agents=[];mounted=await render(container,'missing',mounted);assert.ok(container.textContent.includes('该智能体不存在或已被删除'));});
test('same-view newer composer revision is not overwritten by an old failure',async()=>{let reject;state.send=()=>new Promise((_,no)=>reject=no);mounted=await render(container);await type('原来的输入');await sendTwice();await type('较新的输入版本');await act(async()=>reject(new Error('old failure')));assert.equal(input().value,'较新的输入版本');assert.equal(container.querySelector('[role="alert"]'),null);assert.equal(state.sends.length,1);});

test('active reply exposes a stop control and does not restore the sent composer on deliberate stop', async () => {
  let finish; state.send = () => new Promise(resolve => { finish = resolve; });
  const stops = []; state.store.stopAgentMessage = id => { stops.push(id); finish(); };
  mounted = await render(container); await type('已提交指令'); await sendTwice();
  const stop = container.querySelector('button[aria-label="停止生成"]'); assert.ok(stop);
  await act(async () => stop.click());
  assert.deepEqual(stops, ['a']); assert.equal(input().value, ''); assert.equal(input().disabled, false);
  assert.equal(container.querySelector('[role="alert"]'), null); assert.equal(state.sends.length, 1);
  assert.equal(container.querySelector('button[aria-label="停止生成"]'), null);
});
