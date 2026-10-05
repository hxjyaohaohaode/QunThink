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
const built=await build({stdin:{resolveDir:root,loader:'tsx',contents:`import{createRoot}from'react-dom/client';import{act}from'react';import{TaskResultEditor}from'./src/components/Writing/TaskResultEditor';import{MessageContent}from'./src/components/Chat/MessageContent';import{useTaskResultsStore}from'./src/stores/taskResultsStore';export{act,useTaskResultsStore};export async function mountMessage(el,props){const root=createRoot(el);await act(async()=>root.render(<MessageContent {...props}/>));return root;}export async function mount(el){const root=createRoot(el);await act(async()=>root.render(<TaskResultEditor taskId="task-1"/>));return root;}`},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[{name:'editor-ui-fixtures',setup(build){
 const routes=[[/services\/api$/,'api'],[/utils\/cacheUtils$/,'cache'],[/utils\/taskRecovery$/,'recovery'],[/stores\/tasksStore$/,'tasks'],[/stores\/modelsStore$/,'models'],[/stores\/navigationStore$/,'nav'],[/Common\/useConfirm$/,'confirm']];for(const[filter,path]of routes)build.onResolve({filter},()=>({path,namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:{
 api:`export const getAuthGeneration=()=>1;export const axiosInstance={get:(...args)=>globalThis.__editor.get(...args),post:(...args)=>globalThis.__editor.post(...args)};`,
 cache:`export const getCacheUserId=()=> 'alice';`,
 recovery:`export const writingPreferences=()=>globalThis.__editor.preferences;export const setWritingPreferences=value=>{globalThis.__editor.preferences=value};export const textHash=async value=>globalThis.__editor.hash(value);export const readTaskReceipts=()=>[...globalThis.__editor.receipts.values()];export const persistTaskReceipt=value=>globalThis.__editor.receipts.set(value.key,value);export const removeTaskReceipt=id=>globalThis.__editor.receipts.delete(id);export const saveWritingContent=async()=>true;export const loadWritingContent=async()=>null;export const removeWritingDraft=()=>{};`,
 tasks:`export const useTasksStore=fn=>fn({tasks:[{id:'task-1',prompt:globalThis.__editor.hiddenPurpose?'':'给朋友写活动邀请；采用明确更正的20日，不编造地点',status:'needs_review'}],pending:{}});useTasksStore.getState=()=>({run:async()=>{},fetch:async()=>{},resolveUnknown:async(...args)=>{globalThis.__editor.resolved=args;}});`,
 models:`export const useModelsStore=fn=>fn({catalog:{models:[]}});`,
 nav:`export const useNavigationStore={getState:()=>({setScrollToMessageId:()=>{}})};`,
 confirm:`export const useConfirm=()=>({confirm:options=>globalThis.__editor.confirm?globalThis.__editor.confirm(options):Promise.resolve(true),ConfirmModal:null});`
 }[path]}));
}}]});
const{act,mount,mountMessage,useTaskResultsStore:store}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const longBody='朋友们，欢迎参加10月20日的读书活动。\n\n'+('这是一段需要完整核对的邀请内容。'.repeat(90))+'\n最后一段：请确认是否参加。';
const version=(id='11111111-1111-4111-8111-111111111111',content=longBody)=>({id,sequence:1,kind:'generated',parent_version_id:null,run_id:'run-1',content,content_hash:'hash-'+id,created_at:'2026-10-04T12:00:00Z',source_hash:'source-20',source_messages:[],source_status:'current',content_hidden:false});
const sourceMessages=[{id:'m18',revision:1,edited_at:null,sender_type:'user',content:'初定10月18日读书活动',created_at:'2026-10-01',change:'unchanged'},{id:'m20',revision:1,edited_at:null,sender_type:'user',content:'明确更正：活动改为10月20日，原18日作废',created_at:'2026-10-02',change:'unchanged'}];
const doc=(extra={})=>({task_id:'task-1',title:'读书活动邀请',group_id:'group-1',revision:1,head_version_id:'11111111-1111-4111-8111-111111111111',accepted_version_id:null,accepted_content_hash:null,accepted_at:null,versions:[version()],source:{status:'current',hash:'source-20',messages:sourceMessages,missing_message_ids:[],message:null},generation:{status:'needs_review',run_id:'run-1',source_input_stale:false},...extra});
let container,mounted,currentDocument;
const button=text=>[...container.querySelectorAll('button')].find(item=>item.textContent===text);
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
async function type(value){await act(async()=>{const el=container.querySelector('textarea[aria-label="文稿正文"]');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));});}
beforeEach(async()=>{if(mounted)await act(async()=>mounted.unmount());container?.remove();store.getState().cleanup();currentDocument=doc();globalThis.__editor={preferences:{recoverDrafts:false,offlineCopies:false},receipts:new Map(),hash:s=>createHash('sha256').update(s).digest('hex'),get:async()=>({data:currentDocument}),post:async()=>{throw new Error('unexpected')}};container=document.createElement('div');document.body.append(container);mounted=await mount(container);await act(async()=>{await flush();});});
after(async()=>{if(mounted)await act(async()=>mounted.unmount());window.close();});

test('actual body is editable and full preview never truncates before acceptance',async()=>{
 assert.equal(container.querySelector('textarea[aria-label="文稿正文"]').value,longBody);await act(async()=>button('全文预览').click());const preview=container.querySelector('[aria-label="文稿全文预览"]');assert.match(preview.textContent,/最后一段：请确认是否参加/);assert.equal(preview.querySelector('button') === null,true, 'an always-expanded preview must not advertise a fake expansion toggle');assert.match(container.textContent,/明确更正：活动改为10月20日/);assert.match(container.textContent,/给朋友写活动邀请/);
});
test('manual save and exact version acceptance use real editor state, not task requirements',async()=>{
 const manual='亲爱的朋友，邀请你10月20日参加读书活动。落款：小林';await type(manual);assert.equal(button('验收版本 1').disabled,true);const calls=[];
 globalThis.__editor.post=async(path,payload)=>{calls.push({path,payload});if(path.endsWith('/versions')){currentDocument=doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version(),{...version('22222222-2222-4222-8222-222222222222',payload.content),kind:'manual',sequence:2}]});}else{currentDocument={...currentDocument,revision:3,accepted_version_id:'22222222-2222-4222-8222-222222222222',accepted_content_hash:'hash-22222222-2222-4222-8222-222222222222'}};return{data:{receipt:{id:payload.client_request_id,task_id:'task-1',version_id:'22222222-2222-4222-8222-222222222222',operation:path.endsWith('/versions')?'save':'accept',status:'succeeded',committed_revision:currentDocument.revision,committed_at:'2026-10-04T12:00:00Z'},document:currentDocument}}};
 await act(async()=>{button('保存为新版本').click();await flush()});assert.equal(calls[0].payload.content,manual);assert.equal(calls[0].payload.base_version_id,'11111111-1111-4111-8111-111111111111');await act(async()=>{button('验收版本 2').click();await flush()});assert.equal(calls[1].payload.version_id,'22222222-2222-4222-8222-222222222222');assert.equal(calls[1].payload.content_hash,'hash-22222222-2222-4222-8222-222222222222');assert.ok(button('已验收版本 2'));
});
test('copy denial shows local humane feedback plus real selection and download controls',async()=>{
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Clipboard Write permission denied')}}});await act(async()=>{button('复制全文').click();await flush()});const feedback=container.querySelector('.writing-feedback');assert.match(feedback.textContent,/浏览器未允许自动复制/);assert.doesNotMatch(feedback.textContent,/Clipboard Write/);assert.ok(button('下载文本'));await act(async()=>{button('选择全文').click();await flush()});const body=container.querySelector('textarea[aria-label="文稿正文"]');assert.equal(body.selectionStart,0);assert.equal(body.selectionEnd,longBody.length);assert.equal(document.activeElement,body);
});
test('22-day source update preserves manual input and blocks stale acceptance',async()=>{
 await type('人工修改保留：10月20日邀请');currentDocument=doc({revision:2,source:{...doc().source,status:'changed',hash:'source-22',messages:[sourceMessages[0],{...sourceMessages[1],content:'再次更正：活动改为10月22日',change:'changed'}]}});await act(async()=>store.getState().fetch('task-1'));assert.equal(container.querySelector('textarea[aria-label="文稿正文"]').value,'人工修改保留：10月20日邀请');assert.match(container.textContent,/再次更正：活动改为10月22日/);assert.match(container.textContent,/人工文字已保留/);assert.equal(button('验收版本 1').disabled,true);
});
test('revoked source hides body, blocks copy and does not leak history text',async()=>{
 currentDocument=doc({revision:2,source:{...doc().source,status:'blocked',messages:[],missing_message_ids:['m18']},versions:[{...version(),content:'',content_hidden:true,source_status:'blocked'}]});await act(async()=>store.getState().fetch('task-1'));assert.equal(container.querySelector('textarea[aria-label="文稿正文"]'),null);assert.equal(button('复制全文'),undefined);assert.doesNotMatch(container.textContent,/最后一段：请确认是否参加/);assert.match(container.textContent,/正文暂不显示/);
});
test('composition input does not trigger save keyboard shortcut',async()=>{
 await type('中文输入');let writes=0;globalThis.__editor.post=async()=>{writes++;throw new Error('lost')};const body=container.querySelector('textarea[aria-label="文稿正文"]');await act(async()=>{body.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));body.dispatchEvent(new window.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,isComposing:true}));await flush()});assert.equal(writes,0);
});


test('unknown generation offers actionable original-run recovery without requiring a connected model',async()=>{
 currentDocument=doc({generation:{status:'outcome_unknown',run_id:'original-run',source_input_stale:false}});await act(async()=>store.getState().fetch('task-1'));assert.equal(button('已核验，允许重试').disabled,false);await act(async()=>{button('已核验，允许重试').click();await flush()});assert.deepEqual(globalThis.__editor.resolved,['task-1','original-run','allow_retry']);assert.ok(button('停止后续生成'));
});


test('ordinary chat long messages still support a real expand and collapse toggle',async()=>{
 await act(async()=>mounted.unmount());mounted=await mountMessage(container,{content:longBody,isUser:false});
 assert.doesNotMatch(container.textContent,/最后一段：请确认是否参加/);assert.ok(button('展开全文 ↓'));
 await act(async()=>button('展开全文 ↓').click());assert.match(container.textContent,/最后一段：请确认是否参加/);assert.ok(button('收起 ↑'));
 await act(async()=>button('收起 ↑').click());assert.doesNotMatch(container.textContent,/最后一段：请确认是否参加/);
});

test('pending result recovery is visible and captures the original key through async confirmation and typing',async()=>{
 const receipt={key:'first-ui',action:'save_revision',taskId:'task-1',payloadHash:'minimum',createdAt:'2026-10-04T09:30:00Z'};globalThis.__editor.receipts.set(receipt.key,receipt);await act(async()=>store.getState().recover('task-1'));
 assert.match(container.textContent,/原文字未保存在此设备/);assert.equal(button('保存为新版本').disabled,true);let answer,options,closeResponse,called;
 globalThis.__editor.confirm=value=>{options=value;return new Promise(resolve=>{answer=resolve})};
 await act(async()=>{button('核对并结束这次请求').click();await flush()});assert.equal(options.title,'核对并结束这次待确认的文稿保存请求');assert.match(options.description,/若原请求已提交/);assert.doesNotMatch(options.title,/未保存/);
 await type('等待确认期间新写的段落');globalThis.__editor.receipts.set('second-ui',{...receipt,key:'second-ui',createdAt:'2026-10-04T08:00:00Z'});await act(async()=>store.getState().recover('task-1'));
 globalThis.__editor.post=(path,payload)=>{called={path,payload};return new Promise(resolve=>{closeResponse=resolve})};await act(async()=>{answer(true);await flush()});assert.equal(called.path,'/tasks/task-1/result/commands/first-ui/close');assert.deepEqual(called.payload,{operation:'save'});
 await type('等待结束回复时又新增一句');await act(async()=>{closeResponse({data:{receipt:{id:'first-ui',task_id:'task-1',operation:'save',status:'cancelled',version_id:null,committed_revision:null,committed_at:null,closed_at:'2026-10-04'},document:currentDocument}});await flush()});assert.equal(container.querySelector('textarea[aria-label="文稿正文"]').value,'等待结束回复时又新增一句');assert.equal(store.getState().uncertain['task-1'].key,'second-ui');assert.equal(button('保存为新版本').disabled,true);
});
test('stale result confirmation cannot close a newly pending key after the displayed one settled',async()=>{
 const receipt={key:'old-ui',action:'save_revision',taskId:'task-1',payloadHash:'minimum',createdAt:'2026-10-04T09:30:00Z'};globalThis.__editor.receipts.set(receipt.key,receipt);await act(async()=>store.getState().recover('task-1'));let answer;globalThis.__editor.confirm=()=>new Promise(resolve=>{answer=resolve});await act(async()=>{button('核对并结束这次请求').click();await flush()});
 globalThis.__editor.get=async()=>({data:{receipt:{id:'old-ui',task_id:'task-1',operation:'save',status:'cancelled',version_id:null,committed_revision:null,committed_at:null,closed_at:'2026-10-04'},document:currentDocument}});await act(async()=>store.getState().verify('task-1'));globalThis.__editor.receipts.set('new-ui',{...receipt,key:'new-ui'});await act(async()=>store.getState().recover('task-1'));let writes=0;globalThis.__editor.post=async()=>{writes++;throw new Error('must not send')};await act(async()=>{answer(true);await flush()});assert.equal(writes,0);assert.equal(store.getState().uncertain['task-1'].key,'new-ui');
});

test('hidden stale purpose has a visible next step rather than an empty purpose heading',async()=>{
 globalThis.__editor.hiddenPurpose=true;currentDocument=doc({generation:{status:'needs_review',run_id:'run-1',source_input_stale:true}});await act(async()=>store.getState().fetch('task-1'));assert.match(container.textContent,/原用途待重新确认，展开用途与来源核对/);assert.doesNotMatch(container.textContent,/用途：用途与来源/);
});
