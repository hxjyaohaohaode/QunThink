import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),window=new Window({url:'https://qunthink.test/'});
Object.assign(globalThis,{window,document:window.document,localStorage:window.localStorage,HTMLElement:window.HTMLElement,Node:window.Node,Element:window.Element,requestAnimationFrame:fn=>setTimeout(fn,0),IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
class Channel{port1={onmessage:null};port2={postMessage:()=>setTimeout(()=>this.port1.onmessage?.(),0)}};Object.defineProperty(globalThis,'MessageChannel',{value:Channel,configurable:true});
globalThis.__editor={};
const built=await build({stdin:{resolveDir:root,loader:'tsx',contents:`import{createRoot}from'react-dom/client';import{act}from'react';import{PWAInstallPrompt}from'./src/components/Common/PWAInstallPrompt';import{TaskResultEditor}from'./src/components/Writing/TaskResultEditor';import{useTaskResultsStore}from'./src/stores/taskResultsStore';export{act,useTaskResultsStore};export async function mount(el){const root=createRoot(el);await act(async()=>root.render(<><TaskResultEditor taskId="task-1"/><PWAInstallPrompt/></>));return root;}`},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[{name:'editor-ui-fixtures',setup(build){
 const routes=[[/services\/api$/,'api'],[/utils\/cacheUtils$/,'cache'],[/utils\/taskRecovery$/,'recovery'],[/stores\/tasksStore$/,'tasks'],[/stores\/modelsStore$/,'models'],[/stores\/navigationStore$/,'nav'],[/(?:Common\/|\.\/)useConfirm$/,'confirm'],[/hooks\/usePWAInstall$/,'pwa']];for(const[filter,path]of routes)build.onResolve({filter},()=>({path,namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:{
 api:`export const getAuthGeneration=()=>1;export const axiosInstance={get:(...args)=>globalThis.__editor.get(...args),post:(...args)=>globalThis.__editor.post(...args)};`,
 cache:`export const getCacheUserId=()=> 'alice';`,
 recovery:`export const writingPreferences=()=>globalThis.__editor.preferences;export const setWritingPreferences=value=>{globalThis.__editor.preferences=value};export const textHash=async value=>globalThis.__editor.hash(value);export const readTaskReceipts=()=>[...globalThis.__editor.receipts.values()];export const persistTaskReceipt=value=>globalThis.__editor.receipts.set(value.key,value);export const removeTaskReceipt=id=>globalThis.__editor.receipts.delete(id);export const saveWritingContent=async()=>true;export const loadWritingContent=async()=>null;export const removeWritingDraft=()=>{};`,
 pwa:`export const usePWAInstall=()=>({isOnline:true,isUpdateAvailable:true,canInstall:false,shouldAutoShow:false,isInstalled:false,isStandalone:false,getInstallGuidance:()=>null,acceptUpdate:async()=>{globalThis.__editor.updateCalled=true;}});`,
 tasks:`export const useTasksStore=fn=>fn({tasks:[{id:'task-1',prompt:'给朋友写活动邀请；采用明确更正的20日，不编造地点',status:'needs_review'}],pending:{}});useTasksStore.getState=()=>({pending:{},uncertainCreate:false,composerDraft:{title:'',prompt:''},run:async()=>{},fetch:async()=>{},resolveUnknown:async(...args)=>{globalThis.__editor.resolved=args;}});`,
 models:`export const useModelsStore=fn=>fn({catalog:{models:[]}});`,
 nav:`export const useNavigationStore={getState:()=>({setScrollToMessageId:()=>{}})};`,
 confirm:`export const useConfirm=()=>({confirm:(...args)=>globalThis.__editor.confirm?globalThis.__editor.confirm(...args):Promise.resolve(true),ConfirmModal:null});`
 }[path]}));
}}]});
const{act,mount,useTaskResultsStore:store}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const longBody='朋友们，欢迎参加10月20日的读书活动。\n\n'+('这是一段需要完整核对的邀请内容。'.repeat(90))+'\n最后一段：请确认是否参加。';
const version=(id='v1',content=longBody)=>({id,sequence:1,kind:'generated',parent_version_id:null,run_id:'run-1',content,content_hash:'hash-'+id,created_at:'2026-10-04T12:00:00Z',source_hash:'source-20',source_messages:[],source_status:'current',content_hidden:false});
const sourceMessages=[{id:'m18',revision:1,edited_at:null,sender_type:'user',content:'初定10月18日读书活动',created_at:'2026-10-01',change:'unchanged'},{id:'m20',revision:1,edited_at:null,sender_type:'user',content:'明确更正：活动改为10月20日，原18日作废',created_at:'2026-10-02',change:'unchanged'}];
const doc=(extra={})=>({task_id:'task-1',title:'读书活动邀请',group_id:'group-1',revision:1,head_version_id:'v1',accepted_version_id:null,accepted_content_hash:null,accepted_at:null,versions:[version()],source:{status:'current',hash:'source-20',messages:sourceMessages,missing_message_ids:[],message:null},generation:{status:'needs_review',run_id:'run-1',source_input_stale:false},...extra});
let container,mounted,currentDocument;
const button=text=>[...container.querySelectorAll('button')].find(item=>item.textContent===text);
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
async function type(value){await act(async()=>{const el=container.querySelector('textarea[aria-label="文稿正文"]');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));});}
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();store.getState().cleanup();currentDocument=doc();globalThis.__editor={preferences:{recoverDrafts:false,offlineCopies:false},receipts:new Map(),hash:s=>createHash('sha256').update(s).digest('hex'),get:async()=>({data:currentDocument}),post:async()=>{throw new Error('unexpected')}};container=document.createElement('div');document.body.append(container);mounted=await mount(container);await act(async()=>{await flush();});});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());window.close();});

test('independent PWA guard must protect edited existing-document purpose',async()=>{
 currentDocument=doc({generation:{status:'needs_review',run_id:'run-1',source_input_stale:true}});
 await act(async()=>store.getState().fetch('task-1'));
 const purpose=[...container.querySelectorAll('textarea')].find(el=>el.getAttribute('aria-label')!=='文稿正文');
 assert.ok(purpose);
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(purpose,'新写的未保存任务用途');purpose.dispatchEvent(new window.Event('input',{bubbles:true}));});
 assert.equal(purpose.value,'新写的未保存任务用途');
 assert.equal(store.getState().editors['task-1'].dirty,false);
 await act(async()=>{button('立即更新').click();await flush();});
 assert.notEqual(globalThis.__editor.updateCalled,true,'app update must not discard the unsaved purpose');
});
test('independent local purpose stays reachable after another page reviews generation input',async()=>{
 currentDocument=doc({generation:{status:'needs_review',run_id:'run-1',source_input_stale:true}});
 await act(async()=>store.getState().fetch('task-1'));
 const purpose=[...container.querySelectorAll('textarea')].find(el=>el.getAttribute('aria-label')!=='文稿正文');
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(purpose,'本页未保存用途');purpose.dispatchEvent(new window.Event('input',{bubbles:true}));});
 currentDocument=doc({revision:2,generation:{status:'needs_review',run_id:'run-1',source_input_stale:false}});
 await act(async()=>store.getState().fetch('task-1'));
 assert.equal(store.getState().briefs['task-1'],'本页未保存用途');
 await act(async()=>{button('立即更新').click();await flush();});
 assert.notEqual(globalThis.__editor.updateCalled,true);
 assert.ok([...container.querySelectorAll('textarea')].some(el=>el.value==='本页未保存用途'),'blocked local purpose must still be editable or explicitly discardable');
});
test('independent discard permits empty purpose but never erases typing during confirmation',async()=>{
 currentDocument=doc({generation:{status:'needs_review',run_id:'run-1',source_input_stale:true}});await act(async()=>store.getState().fetch('task-1'));
 const purpose=[...container.querySelectorAll('textarea')].find(el=>el.getAttribute('aria-label')!=='文稿正文');
 const typePurpose=async(value)=>act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(purpose,value);purpose.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await typePurpose('');let approve;
 globalThis.__editor.confirm=()=>new Promise(resolve=>{approve=resolve;});
 await act(async()=>button('放弃未保存的用途修改').click());
 await typePurpose('确认期间新写的用途');
 await act(async()=>{approve(true);await flush();});
 assert.equal(store.getState().briefs['task-1'],'确认期间新写的用途');
 await typePurpose('');globalThis.__editor.confirm=async()=>true;
 await act(async()=>{button('放弃未保存的用途修改').click();await flush();});
 assert.equal(store.getState().briefs['task-1'],undefined);
 await act(async()=>{button('立即更新').click();await flush();});assert.equal(globalThis.__editor.updateCalled,true);
});
