// Actual React components and Virtuoso, with happy-dom sizing and synthetic IO.
// These tests are DOM/component evidence, not native browser or persistence proof.
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { resolve } from 'node:path';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const frontend=resolve(import.meta.dirname,'..');
const realNow=Date.now;let clockOffset=0;Date.now=()=>realNow()+clockOffset;
const window=new Window({url:'https://f07-dom.invalid/'});
Object.assign(globalThis,{window,document:window.document,localStorage:window.localStorage,HTMLElement:window.HTMLElement,HTMLTextAreaElement:window.HTMLTextAreaElement,Element:window.Element,Node:window.Node,SVGElement:window.SVGElement,ResizeObserver:window.ResizeObserver,getComputedStyle:window.getComputedStyle.bind(window),requestAnimationFrame:window.requestAnimationFrame.bind(window),cancelAnimationFrame:window.cancelAnimationFrame.bind(window),IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
Object.defineProperty(window,'crypto',{value:undefined,configurable:true});
class Channel {port1={onmessage:null};port2={postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0)};}
Object.defineProperty(globalThis,'MessageChannel',{value:Channel,configurable:true});
const bundle=await build({stdin:{resolveDir:frontend,loader:'tsx',contents:`
import React,{act} from 'react';import {AnimatePresence,usePresence} from 'framer-motion';import {createRoot} from 'react-dom/client';import {VirtuosoMockContext} from 'react-virtuoso';
import {MessageList} from './src/components/Chat/MessageList';import {MessageInput} from './src/components/Chat/MessageInput';
export {act}; export {api,axiosInstance,confirmAuthIdentity} from './src/services/api';
export {useMessagesStore,resetMessagesModuleState} from './src/stores/messagesStore';
export {useNavigationStore} from './src/stores/navigationStore';export {useGroupsStore} from './src/stores/groupsStore';export {useUIStore} from './src/stores/uiStore';
export {setCacheUserId,saveCacheAsync,loadCacheAsync} from './src/utils/cacheUtils';export {setIndexedDBUserId} from './src/utils/indexedDB';
function RetainedChat(){usePresence();return <section data-exiting-chat="true"><VirtuosoMockContext.Provider value={{viewportHeight:800,itemHeight:100}}><MessageList isActive={true}/></VirtuosoMockContext.Provider></section>;}
export async function mountExit(el){const root=createRoot(el);const render=(show)=>root.render(<AnimatePresence>{show&&<RetainedChat key="chat"/>}</AnimatePresence>);await act(async()=>render(true));return {unmount:()=>root.unmount(),render};}
export async function mount(el,list=false,active=true){const root=createRoot(el);const render=(active)=>root.render(<VirtuosoMockContext.Provider value={{viewportHeight:800,itemHeight:100}}>{list&&<MessageList isActive={active}/>}<MessageInput/></VirtuosoMockContext.Provider>);await act(async()=>render(active));return {unmount:()=>root.unmount(),render};}
`},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',define:{'import.meta.env':JSON.stringify({DEV:false,VITE_AUTH_MODE:'session'})},plugins:[{name:'unused-pwa',setup(b){b.onResolve({filter:/^virtual:pwa-register\/react$/},()=>({path:'pwa',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const useRegisterSW=()=>({});',loader:'js'}));}}]});
const output=await mkdtemp(resolve(tmpdir(),'f07-ui-'));await writeFile(resolve(output,'bundle.mjs'),bundle.outputFiles[0].text);const s=await import(pathToFileURL(resolve(output,'bundle.mjs')).href);
const nativeSend=s.useMessagesStore.getState().sendMessage;const nativeLoadMore=s.useMessagesStore.getState().loadMoreMessages;
let root,container,finishSend,sends,requests,readMode;
const unknown={id:'temp_00000000-0000-4000-8000-000000000009',tempId:'temp_00000000-0000-4000-8000-000000000009',group_id:'room-a',sender_type:'user',sender_id:'alice',content:'original unknown request',content_type:'text',created_at:'2026-10-13T00:00:00Z',status:'failed',reply_to:['original-reply'],attachments:[{id:'attachment-a',name:'file.txt',type:'text/plain',size:1,url:'/synthetic'}],metadata:{send_unknown:true}};
const group=id=>({id,name:id,ai_members:[],space_category:'work'});
const drain=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(resolve=>setTimeout(resolve,10));};
async function setup({owner='alice',id='room-a',list=false,mode='success',rows=[],history=[],holdOlder=false}={}){
 s.resetMessagesModuleState();s.setCacheUserId(owner);s.setIndexedDBUserId(owner);s.confirmAuthIdentity(owner);localStorage.clear();s.setCacheUserId(owner);sends=[];requests=[];readMode=mode;
 s.useMessagesStore.setState({loadMoreMessages:holdOlder?async()=> 'blocked':nativeLoadMore,messages:{[id]:rows},pagination:{},recovery:{},durability:{},loading:false,sending:{},error:null,sendMessage:async(...args)=>{sends.push(args);return new Promise(resolve=>{finishSend=resolve;});}});
 s.useNavigationStore.setState({scrollToMessageId:null});
 s.useGroupsStore.setState({groups:[group(id)],currentGroup:group(id),chatStatus:new Map(),debateStatus:new Map()});s.useUIStore.setState({connectionStatus:'connected',replyingTo:[],typingIndicators:{}});
 s.axiosInstance.defaults.adapter=async config=>{
  requests.push({method:config.method,url:config.url,params:config.params});
  if(readMode==='428')throw Object.assign(new Error('消息分页协议已更新'),{config,response:{config,status:428,headers:{},data:{code:'MESSAGE_CURSOR_REQUIRED',error:'消息分页协议已更新'}}});
  const generation='00000000-0000-4000-8000-000000000001';const g=config.url.split('/')[2];
  const q=config.params;const before=q.before_cursor?JSON.parse(Buffer.from(q.before_cursor,'base64url')):null;const after=q.after_cursor?JSON.parse(Buffer.from(q.after_cursor,'base64url')):null;
  const all=history.map(n=>({id:'m'+n,group_id:g,sender_type:'ai',sender_id:'ai',content:'history '+n,content_type:'text',created_at:'2026-10-13T00:00:00Z',server_order:{generation,sequence:String(n)}}));
  let selected=all.filter(m=>(!before||BigInt(m.server_order.sequence)<BigInt(before.at))&&(!after||BigInt(m.server_order.sequence)>BigInt(after.at)));
  const hasMore=selected.length>q.limit;selected=after?selected.slice(0,q.limit):selected.slice(-q.limit);
  const H=String(history.at(-1)||0);const cursor=(kind,at,until)=>Buffer.from(JSON.stringify({v:1,owner,group:g,generation,kind,at,...(until?{until}:{})})).toString('base64url');
  return {config,status:200,statusText:'OK',headers:{},data:{messages:selected,hasMore,order:'sequence_v1',generation,high_watermark:H,consumed_through:before?null:H,before_cursor:!after&&hasMore?cursor('before',selected[0].server_order.sequence,H):null,after_cursor:before?null:cursor('after',H)}};
 };
 container=document.createElement('div');document.body.append(container);root=await s.mount(container,list);await s.act(drain);
}
async function type(text){await s.act(async()=>{const input=container.querySelector('textarea');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new window.Event('input',{bubbles:true}));await drain();});assert.equal(container.querySelector('textarea').value,text);}
async function send(){await s.act(async()=>{container.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await drain();});assert.equal(sends.length,1);}
afterEach(async()=>{if(root)await s.act(async()=>root.unmount());root=null;container?.remove();s.resetMessagesModuleState();s.useMessagesStore.setState({sendMessage:nativeSend,loadMoreMessages:nativeLoadMore});});
after(async()=>{Date.now=realNow;window.close();await rm(output,{recursive:true,force:true});});

test('actual composer DOM: a late success receipt never clears a newer same-group text and reply intent',async()=>{
 await setup();await type('first intended message');await send();await type('different new draft');await s.act(async()=>s.useUIStore.getState().addReplyingTo('new-reply'));
 await s.act(async()=>{finishSend({success:true,tempId:'original-uuid'});await drain();});
 assert.equal(container.querySelector('textarea').value,'different new draft');assert.deepEqual(s.useUIStore.getState().replyingTo,['new-reply']);
 assert.equal(await s.loadCacheAsync('message_draft_alice_room-a'),'different new draft');
});
test('actual composer DOM: A to B to A navigation cannot let an old receipt erase a returned draft',async()=>{
 await setup();await type('old submitted text');await send();
 await s.act(async()=>{s.useGroupsStore.setState({currentGroup:group('room-b')});await drain();});await type('room B draft');
 await s.act(async()=>{s.useGroupsStore.setState({currentGroup:group('room-a')});await drain();});await type('new room A draft');
 await s.act(async()=>{finishSend({success:true,tempId:'original-uuid'});await drain();});
 assert.equal(container.querySelector('textarea').value,'new room A draft');assert.equal(await s.loadCacheAsync('message_draft_alice_room-a'),'new room A draft');
});
test('actual composer DOM: account A to B to A rejects late send receipt even in the same group',async()=>{
 await setup();await type('owner A old');await send();
 for(const owner of ['bob','alice'])await s.act(async()=>{s.setCacheUserId(owner);s.confirmAuthIdentity(owner);s.useGroupsStore.setState({currentGroup:group('room-a')});await drain();});
 await type('owner A fresh');await s.act(async()=>{finishSend({success:true,tempId:'original-uuid'});await drain();});
 assert.equal(container.querySelector('textarea').value,'owner A fresh');assert.equal(await s.loadCacheAsync('message_draft_alice_room-a'),'owner A fresh');
});


test('actual full list and Virtuoso DOM: protocol failure is visible while connected and explicit rebuild preserves unknown UUID',async()=>{
 await setup({list:true,mode:'428',rows:[unknown]});
 assert.equal(s.useUIStore.getState().connectionStatus,'connected');assert.match(container.textContent,/消息分页协议已更新/);assert.match(container.textContent,/重新读取历史/);
 assert.ok(!container.textContent.includes('刷新可恢复'));const before=structuredClone(s.useMessagesStore.getState().messages['room-a']);
 await s.act(async()=>{[...container.querySelectorAll('button')].find(button=>button.textContent==='重新读取历史').click();await drain();});
 assert.deepEqual(s.useMessagesStore.getState().messages['room-a'],before);assert.equal(requests.filter(r=>r.method==='post').length,0);assert.equal(requests.filter(r=>r.url.endsWith('/messages')).length,1,'explicit recovery respects the retained retry deadline');
 assert.match(container.textContent,/等待可用的读取时机/);
 try{clockOffset=31000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});}finally{clockOffset=0;}
 assert.equal(requests.filter(r=>r.url.endsWith('/messages')).length,2);
 let copied;Object.defineProperty(navigator.clipboard,'writeText',{value:async text=>{copied=text;},configurable:true});
 await s.act(async()=>{[...container.querySelectorAll('button')].find(button=>button.textContent==='复制未保存内容').click();await drain();});
 const saved=JSON.parse(copied);assert.equal(saved[0].tempId,unknown.tempId);assert.deepEqual(saved[0].reply_to,unknown.reply_to);assert.deepEqual(saved[0].attachments,unknown.attachments);
});
test('actual full list DOM: remaining page budget says still catching up; preview never claims sent or refresh durable',async()=>{
 await setup({list:true});
 await s.act(async()=>{s.useMessagesStore.setState({messages:{'room-a':[{...unknown,status:'sent',confirmation:'preview',preview_reason:'not_saved'},{...unknown,id:'system-preview',tempId:undefined,sender_type:'system',content_type:'system',content:'system preview',status:undefined,confirmation:'preview',preview_reason:'not_saved'}]},recovery:{'room-a':{phase:'catching_up',pending:true,bootstrapComplete:true,nextAllowedAt:Date.now()+30000,failures:0}},durability:{'room-a':{durable:false,reason:'memory_only'}}});await drain();});
 assert.match(container.textContent,/仍在补齐/);assert.match(container.textContent,/尚未保存/);assert.match(container.querySelector('[data-message-id="system-preview"]').textContent,/尚未保存/);assert.equal(container.querySelectorAll('.message-status.sent').length,0);assert.ok(!container.textContent.includes('刷新可恢复'));
 await s.act(async()=>{s.useMessagesStore.setState({durability:{'room-a':{durable:true}}});await drain();});assert.match(container.textContent,/刷新可恢复/);
});
test('actual full list DOM: explicit inactive prop releases recovery lease while currentGroup remains selected',async()=>{
 await setup({list:true});const count=requests.length;assert.ok(count>0);
 await s.act(async()=>{root.render(false);await drain();});assert.equal(s.useGroupsStore.getState().currentGroup.id,'room-a');
 await s.act(async()=>{s.useMessagesStore.setState(state=>({recovery:{...state.recovery,'room-a':{...state.recovery['room-a'],nextAllowedAt:0}}}));await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});assert.equal(requests.length,count);
 await s.act(async()=>{root.render(true);await drain();});assert.ok(requests.length>count);
});


test('actual composer DOM: a success receipt clears the unchanged submitted intention',async()=>{
 await setup();await type('same original intention');await send();await s.act(async()=>{finishSend({success:true,tempId:'original-uuid'});await drain();});
 assert.equal(container.querySelector('textarea').value,'');assert.equal(await s.loadCacheAsync('message_draft_alice_room-a'),'');
});
test('actual composer DOM: a new attachment selected during an old send is retained by the late receipt',async()=>{
 await setup();await type('original submitted text');await send();
 const original=s.api.uploadFile;s.api.uploadFile=async()=>({file:{id:'fresh-attachment',original_name:'fresh.txt',mime_type:'text/plain',file_size:5,url:'/synthetic-fresh'}});
 try{await s.act(async()=>{const control=container.querySelector('input[type="file"]');Object.defineProperty(control,'files',{value:[new window.File(['fresh'],'fresh.txt',{type:'text/plain'})],configurable:true});control.dispatchEvent(new window.Event('change',{bubbles:true}));await drain();});}
 finally{s.api.uploadFile=original;}
 assert.match(container.textContent,/fresh.txt/);await s.act(async()=>{finishSend({success:true,tempId:'original-uuid'});await drain();});
 assert.match(container.textContent,/fresh.txt/);assert.equal(container.querySelector('textarea').value,'original submitted text');
});
test('actual AnimatePresence DOM with controlled exit retention: the chat releases its lease before unmount',async()=>{
 await setup({rows:[unknown]});await s.act(async()=>root.unmount());root=await s.mountExit(container);await s.act(drain);const count=requests.length;
 await s.act(async()=>{root.render(false);await drain();});assert.ok(container.querySelector('[data-exiting-chat]'),'the official presence lifecycle still retains the real MessageList DOM');
 await s.act(async()=>{s.useMessagesStore.setState(state=>({recovery:{...state.recovery,'room-a':{...state.recovery['room-a'],nextAllowedAt:0}}}));await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});assert.equal(requests.length,count,'exiting content is not an active background reader');
});


test('ordered search waits through an in-flight after round, then loads the unconsumed before cursor',async()=>{
 await setup({list:true,history:Array.from({length:90},(_,i)=>i+1),holdOlder:true});
 const original=s.api.getOrderedMessages;let finishAfter;let afterQuery;
 s.api.getOrderedMessages=(g,q,signal)=>q.after_cursor?new Promise(resolve=>{afterQuery=q;finishAfter=()=>original(g,q,signal).then(resolve);}):original(g,q,signal);
 try{
  await s.act(async()=>{s.useMessagesStore.setState(state=>({recovery:{...state.recovery,'room-a':{...state.recovery['room-a'],nextAllowedAt:0}}}));void s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.ok(afterQuery);await s.act(async()=>{s.useMessagesStore.setState({loadMoreMessages:nativeLoadMore});s.useNavigationStore.getState().setScrollToMessageId('m1');await drain();});
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,'m1');
  assert.ok(!requests.some(r=>r.params?.before_cursor),'busy is not an accepted before page');
  await s.act(async()=>{await finishAfter();await drain();});
  assert.ok(s.useMessagesStore.getState().messages['room-a'].some(m=>m.id==='m1'),'search resumes after the mutex releases');
  assert.ok(!container.textContent.includes('该消息已删除或不再可见'));
 }finally{if(finishAfter)await finishAfter();s.api.getOrderedMessages=original;await s.act(async()=>s.useNavigationStore.getState().setScrollToMessageId(null));}
});
test('ordered search keeps its intent while bootstrap has not established any history frontier',async()=>{
 await setup({list:true,mode:'428'});
 await s.act(async()=>{await s.useMessagesStore.getState().resumeOrderedMessages('room-a');s.useNavigationStore.getState().setScrollToMessageId('not-yet-verified');await drain();});
 assert.equal(s.useMessagesStore.getState().recovery['room-a'].bootstrapComplete,false);
 assert.equal(s.useNavigationStore.getState().scrollToMessageId,'not-yet-verified');
 assert.ok(!container.textContent.includes('该消息已删除或不再可见'));
 await s.act(async()=>s.useNavigationStore.getState().setScrollToMessageId(null));
});

test('ordered search does not consume an inactive view and only verified exhaustion ends the target',async()=>{
 await setup({list:true});await s.act(async()=>{root.render(false);await drain();});
 await s.act(async()=>{s.useNavigationStore.getState().setScrollToMessageId('absent');await drain();});
 assert.equal(s.useNavigationStore.getState().scrollToMessageId,'absent');
 assert.ok(!container.textContent.includes('该消息已删除或不再可见'));
 await s.act(async()=>{root.render(true);await drain();});
 assert.equal(s.useMessagesStore.getState().recovery['room-a'].bootstrapComplete,true);
 assert.equal(s.useNavigationStore.getState().scrollToMessageId,'absent','the old exhausted snapshot is not a fresh absence proof');
 try{clockOffset=31000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});}finally{clockOffset=0;}
 assert.equal(s.useNavigationStore.getState().scrollToMessageId,null);
 assert.match(document.body.textContent,/该消息已删除或不再可见/);
});
test('ordered search cancel stays cancelled when an outstanding history page completes',async()=>{
 await setup({list:true,history:Array.from({length:90},(_,i)=>i+1),holdOlder:true});
 const original=s.api.getOrderedMessages;let finishBefore;
 s.api.getOrderedMessages=(g,q,signal)=>q.before_cursor?new Promise(resolve=>{finishBefore=()=>original(g,q,signal).then(resolve);}):original(g,q,signal);
 try{
  await s.act(async()=>{s.useMessagesStore.setState({loadMoreMessages:nativeLoadMore});s.useNavigationStore.getState().setScrollToMessageId('m1');await drain();});
  assert.ok(finishBefore);
  await s.act(async()=>{[...container.querySelectorAll('button')].find(button=>button.textContent==='取消定位').click();await drain();});
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,null);
  await s.act(async()=>{await finishBefore();await drain();});
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,null);
  assert.ok(!container.textContent.includes('定位未完成'));assert.ok(!container.querySelector('.search-highlight'));
 }finally{if(finishBefore)await finishBefore();s.api.getOrderedMessages=original;}
});


test('a newer search result survives old H exhaustion and catches up on the existing budget',async()=>{
 const history=[1,2];await setup({list:true,history,holdOlder:true});history.push(3);
 const count=requests.length;
 await s.act(async()=>{s.useNavigationStore.getState().setScrollToMessageId('m3');await drain();});
 assert.equal(s.useNavigationStore.getState().scrollToMessageId,'m3');assert.equal(requests.length,count,'search does not bypass the ordered read deadline');
 try{
  clockOffset=31000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.equal(s.useMessagesStore.getState().ordered['room-a'].consumedThrough,'3');
  assert.ok(s.useMessagesStore.getState().messages['room-a'].some(m=>m.id==='m3'));
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,'m3','the loaded result proceeds to visible-row positioning, not missing-result error');
 }finally{clockOffset=0;await s.act(async()=>s.useNavigationStore.getState().setScrollToMessageId(null));}
});
test('a round already in flight before the search intent cannot prove the newer result absent',async()=>{
 const history=[1,2];await setup({list:true,history,holdOlder:true});
 const original=s.api.getOrderedMessages;let finishOld;
 s.api.getOrderedMessages=async(g,q,signal)=>{const page=await original(g,q,signal);if(q.after_cursor&&!finishOld)return new Promise(resolve=>{finishOld=()=>resolve(page);});return page;};
 try{
  clockOffset=31000;await s.act(async()=>{void s.useMessagesStore.getState().wakeOrderedMessages();await drain();});assert.ok(finishOld);
  history.push(3);await s.act(async()=>{s.useNavigationStore.getState().setScrollToMessageId('m3');await drain();});
  await s.act(async()=>{finishOld();await drain();});
  assert.equal(s.useMessagesStore.getState().ordered['room-a'].consumedThrough,'2');
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,'m3','pre-intent snapshot completion cannot terminate this intent');
  clockOffset=62000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.equal(s.useMessagesStore.getState().ordered['room-a'].consumedThrough,'3');
 }finally{finishOld?.();clockOffset=0;s.api.getOrderedMessages=original;await s.act(async()=>s.useNavigationStore.getState().setScrollToMessageId(null));}
});

test('a fixed-H continuation preserves the search intent until a fresh post-intent snapshot',async()=>{
 await setup({list:true,history:[],holdOlder:true});
 const original=s.api.getOrderedMessages;const owner='alice';const generation='00000000-0000-4000-8000-000000000001';
 let count=601;const calls=[];
 const cursor=(kind,at,until)=>Buffer.from(JSON.stringify({v:1,owner,group:'room-a',generation,kind,at:String(at),...(until===undefined?{}:{until:String(until)})})).toString('base64url');
 s.api.getOrderedMessages=async(g,q)=>{
  calls.push(q);const after=q.after_cursor?JSON.parse(Buffer.from(q.after_cursor,'base64url')):null;
  const H=String(after?.until??count);
  let selected=Array.from({length:count},(_,i)=>i+1).filter(n=>n<=Number(H)&&n>Number(after?.at??0));
  const more=selected.length>q.limit;selected=selected.slice(0,q.limit);const C=more?String(selected.at(-1)):H;
  return {messages:selected.map(n=>({id:'m'+n,group_id:g,sender_type:'ai',content:'history '+n,content_type:'text',created_at:'2026-10-13T00:00:00Z',server_order:{generation,sequence:String(n)}})),hasMore:more,order:'sequence_v1',generation,high_watermark:H,consumed_through:C,before_cursor:null,after_cursor:cursor('after',C,more?H:undefined)};
 };
 try{
  clockOffset=31000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.equal(s.useMessagesStore.getState().ordered['room-a'].consumedThrough,'500');
  assert.equal(s.useMessagesStore.getState().recovery['room-a'].reason,'PAGE_BUDGET');
  count=602;await s.act(async()=>{s.useNavigationStore.getState().setScrollToMessageId('m602');await drain();});
  clockOffset=62000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.equal(s.useMessagesStore.getState().ordered['room-a'].consumedThrough,'601');
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,'m602','resuming fixed H=601 must retain the m602 target until a genuinely fresh-H batch completes');
  clockOffset=93000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.equal(s.useMessagesStore.getState().ordered['room-a'].consumedThrough,'602');
  assert.ok(s.useMessagesStore.getState().messages['room-a'].some(message=>message.id==='m602'));
  assert.equal(calls.length,8,'five pages, two continuation pages and one new-snapshot page respect the existing budget');
 }finally{clockOffset=0;s.api.getOrderedMessages=original;await s.act(async()=>s.useNavigationStore.getState().setScrollToMessageId(null));}
});

test('reopening the same search ID requires a new absence proof after the previous intent ended',async()=>{
 const history=[1];await setup({list:true,history,holdOlder:true});
 try{
  await s.act(async()=>{s.useNavigationStore.getState().setScrollToMessageId('m3');await drain();});
  clockOffset=31000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,null,'the first verified absence ends that intent');
  history.push(3);const count=requests.length;
  await s.act(async()=>{s.useNavigationStore.getState().setScrollToMessageId('m3');await drain();});
  assert.equal(s.useNavigationStore.getState().scrollToMessageId,'m3','the reopened ID is a new intent, not a reuse of old freshness');
  assert.equal(requests.length,count);
  clockOffset=62000;await s.act(async()=>{await s.useMessagesStore.getState().wakeOrderedMessages();await drain();});
  assert.ok(s.useMessagesStore.getState().messages['room-a'].some(message=>message.id==='m3'));
 }finally{clockOffset=0;await s.act(async()=>s.useNavigationStore.getState().setScrollToMessageId(null));}
});
