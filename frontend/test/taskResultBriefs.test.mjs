import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve,0));
globalThis.__result = {};
const built = await build({ entryPoints:[resolve(root,'src/stores/taskResultsStore.ts')],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'result-protocol-boundaries',setup(build){
  for (const [filter,path] of [[/services\/api$/,'api'],[/utils\/cacheUtils$/,'cache'],[/utils\/taskRecovery$/,'recovery']]) build.onResolve({filter},()=>({path,namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:{
    api:`export const getAuthGeneration=()=>globalThis.__result.auth; export const axiosInstance={get:(...args)=>globalThis.__result.get(...args),post:(...args)=>globalThis.__result.post(...args)};`,
    cache:`export const getCacheUserId=()=>globalThis.__result.user;`,
    recovery:`export const writingPreferences=()=>({recoverDrafts:globalThis.__result.recovery,offlineCopies:false});export const textHash=value=>Promise.resolve(globalThis.__result.hash(value));export const readTaskReceipts=()=>[...globalThis.__result.receipts.values()];export const persistTaskReceipt=item=>{if(globalThis.__result.storageFailure)throw new Error('尚未发送：存储失败');globalThis.__result.receipts.set(item.key,item)};export const removeTaskReceipt=key=>globalThis.__result.receipts.delete(key);export const saveWritingContent=(id,value)=>{globalThis.__result.drafts.set(id,value);return Promise.resolve(globalThis.__result.recovery)};export const loadWritingContent=id=>globalThis.__result.loadDraft(id);export const removeWritingDraft=id=>globalThis.__result.drafts.delete(id);`
  }[path]}));
}}]});
const {useTaskResultsStore:store} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const version=(id='v1',content='活动定于10月20日',extra={})=>({id,sequence:1,kind:'generated',parent_version_id:null,run_id:'run-1',content,content_hash:`hash-${id}`,created_at:'2026-10-01T12:00:00Z',source_hash:'source-20',source_messages:[],source_status:'current',content_hidden:false,...extra});
const doc=(extra={})=>({task_id:'task-1',title:'活动邀请',group_id:'group-1',revision:1,head_version_id:'v1',accepted_version_id:null,accepted_content_hash:null,accepted_at:null,versions:[version()],source:{status:'current',hash:'source-20',messages:[],missing_message_ids:[],message:null},generation:{status:'needs_review',run_id:'run-1',source_input_stale:false},...extra});
function response(key, document, operation='save', versionId=document?.head_version_id) {return {data:{receipt:{id:key,operation,task_id:'task-1',version_id:versionId,committed_revision:document?.revision||1,committed_at:'2026-10-04',status:'succeeded'},document}};}
beforeEach(()=>{store.getState().cleanup();globalThis.__result={user:'alice',auth:1,receipts:new Map(),drafts:new Map(),recovery:false,storageFailure:false,hash:s=>createHash('sha256').update(s).digest('hex'),get:async()=>({data:doc()}),post:async()=>{throw new Error('unexpected POST')},loadDraft:async id=>globalThis.__result.drafts.get(id)||null};});
async function open(){await store.getState().select('task-1');}

test('independent brief receipt only clears matching submitted purpose',async()=>{
 await open();store.getState().editBrief('task-1','已发送用途');let sent;const pending=deferred();
 globalThis.__result.post=(_,body)=>{sent=body;return pending.promise;};
 const saving=store.getState().updateBrief('task-1','已发送用途','source-20');await tick();
 store.getState().editBrief('task-1','后来用途');pending.resolve(response(sent.client_request_id,doc({revision:2}),'brief'));await saving;
 assert.equal(store.getState().briefs['task-1'],'后来用途');
 globalThis.__result.post=async(_,body)=>response(body.client_request_id,doc({revision:3}),'brief');
 await store.getState().updateBrief('task-1','后来用途','source-20');assert.equal(store.getState().briefs['task-1'],undefined);
});
test('independent brief account cleanup fences old receipt from new session',async()=>{
 await open();store.getState().editBrief('task-1','A用途');let sent;const pending=deferred();
 globalThis.__result.post=(_,body)=>{sent=body;return pending.promise;};
 const saving=store.getState().updateBrief('task-1','A用途','source-20');await tick();
 store.getState().cleanup();globalThis.__result.user='bob';globalThis.__result.auth++;
 store.getState().editBrief('task-1','B用途');pending.resolve(response(sent.client_request_id,doc({revision:8}),'brief'));await saving;
 assert.equal(store.getState().briefs['task-1'],'B用途');assert.equal(store.getState().documents['task-1'],undefined);
});
test('independent source revoke removes account document purpose draft',async()=>{
 await open();store.getState().editBrief('task-1','将被撤回来源的用途');
 globalThis.__result.get=async()=>{throw Object.assign(new Error('revoked'),{status:410});};
 await store.getState().fetch('task-1');assert.equal(store.getState().briefs['task-1'],undefined);
});
