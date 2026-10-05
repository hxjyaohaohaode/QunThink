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
const version=(id='11111111-1111-4111-8111-111111111111',content='活动定于10月20日',extra={})=>({id,sequence:1,kind:'generated',parent_version_id:null,run_id:'run-1',content,content_hash:`hash-${id}`,created_at:'2026-10-01T12:00:00Z',source_hash:'source-20',source_messages:[],source_status:'current',content_hidden:false,...extra});
const doc=(extra={})=>({task_id:'task-1',title:'活动邀请',group_id:'group-1',revision:1,head_version_id:'11111111-1111-4111-8111-111111111111',accepted_version_id:null,accepted_content_hash:null,accepted_at:null,versions:[version()],source:{status:'current',hash:'source-20',messages:[],missing_message_ids:[],message:null},generation:{status:'needs_review',run_id:'run-1',source_input_stale:false},...extra});
function response(key, document, operation='save', versionId=document?.head_version_id) {return {data:{receipt:{id:key,operation,task_id:'task-1',version_id:versionId,committed_revision:document?.revision||1,committed_at:'2026-10-04',status:'succeeded'},document}};}
beforeEach(()=>{store.getState().cleanup();globalThis.__result={user:'alice',auth:1,receipts:new Map(),drafts:new Map(),recovery:false,storageFailure:false,hash:s=>createHash('sha256').update(s).digest('hex'),get:async()=>({data:doc()}),post:async()=>{throw new Error('unexpected POST')},loadDraft:async id=>globalThis.__result.drafts.get(id)||null};});
async function open(){await store.getState().select('task-1');}

test('late save ACK never overwrites edits typed during the request',async()=>{
 await open();store.getState().edit('task-1','人工稿一');const pending=deferred();let payload;
 globalThis.__result.post=(_,body)=>{payload=body;return pending.promise;};const saving=store.getState().save('task-1');await tick();
 store.getState().edit('task-1','人工稿二，还在继续');pending.resolve(response(payload.client_request_id,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version(),version('22222222-2222-4222-8222-222222222222','人工稿一',{kind:'manual',sequence:2})]})));await saving;
 assert.equal(store.getState().editors['task-1'].body,'人工稿二，还在继续');assert.equal(store.getState().editors['task-1'].dirty,true);assert.equal(store.getState().editors['task-1'].baseVersionId,'22222222-2222-4222-8222-222222222222');assert.equal(globalThis.__result.receipts.size,0);
});
test('old fetch cannot undo a new committed version or local edit',async()=>{
 await open();const reading=deferred();globalThis.__result.get=()=>reading.promise;const oldFetch=store.getState().fetch('task-1');store.getState().edit('task-1','人工稿');globalThis.__result.post=async(_,body)=>response(body.client_request_id,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222','人工稿',{kind:'manual'})]}));await store.getState().save('task-1');reading.resolve({data:doc()});await oldFetch;assert.equal(store.getState().documents['task-1'].revision,2);assert.equal(store.getState().editors['task-1'].body,'人工稿');
});
test('acceptance dispatch freezes the exact displayed version and hash',async()=>{
 await open();let sent;const waiting=deferred();globalThis.__result.post=(_,body)=>{sent=body;return waiting.promise;};const accepting=store.getState().accept('task-1','11111111-1111-4111-8111-111111111111','hash-11111111-1111-4111-8111-111111111111','source-20');await tick();
 globalThis.__result.get=async()=>({data:doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version(),version('22222222-2222-4222-8222-222222222222','别处新稿')]})});await store.getState().fetch('task-1');assert.equal(sent.version_id,'11111111-1111-4111-8111-111111111111');assert.equal(sent.content_hash,'hash-11111111-1111-4111-8111-111111111111');assert.equal(sent.source_hash,'source-20');waiting.resolve(response(sent.client_request_id,doc({revision:1,accepted_version_id:'11111111-1111-4111-8111-111111111111',accepted_content_hash:'hash-11111111-1111-4111-8111-111111111111'}),'accept','11111111-1111-4111-8111-111111111111'));await accepting;assert.equal(store.getState().documents['task-1'].head_version_id,'22222222-2222-4222-8222-222222222222');assert.equal(store.getState().documents['task-1'].accepted_version_id,null);
});
test('version conflict preserves manual text and requires explicit comparison/rebase',async()=>{
 await open();store.getState().edit('task-1','我的修改');globalThis.__result.post=async()=>{throw Object.assign(new Error('conflict'),{status:409})};globalThis.__result.get=async()=>({data:doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222','另一设备修改')]})});await store.getState().save('task-1');assert.equal(store.getState().editors['task-1'].body,'我的修改');assert.equal(store.getState().editors['task-1'].conflict,true);assert.equal(globalThis.__result.receipts.size,1);const key=store.getState().uncertain['task-1'].key;globalThis.__result.post=async()=>cancelled(key,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222','别人新版本')]}));await store.getState().closeCommand('task-1',key);assert.equal(globalThis.__result.receipts.size,0);store.getState().rebase('task-1');assert.equal(store.getState().editors['task-1'].baseVersionId,'22222222-2222-4222-8222-222222222222');assert.equal(store.getState().editors['task-1'].body,'我的修改');
});
test('new source date invalidates prior review without touching manual text',async()=>{
 await open();store.getState().edit('task-1','人工保留20日');store.getState().reviewSources('task-1','source-20');globalThis.__result.get=async()=>({data:doc({revision:2,source:{...doc().source,status:'changed',hash:'source-22',messages:[{id:'m1',content:'改为22日',change:'changed'}]}})});await store.getState().fetch('task-1');assert.equal(store.getState().editors['task-1'].body,'人工保留20日');assert.equal(store.getState().editors['task-1'].reviewedSourceHash,null);let called=false;globalThis.__result.post=async()=>{called=true};await store.getState().accept('task-1','11111111-1111-4111-8111-111111111111','hash-11111111-1111-4111-8111-111111111111','source-20');assert.equal(called,false);
});
test('lost ACK is resolved after reload using only durable IDs, not replaying changed input',async()=>{
 await open();store.getState().edit('task-1','已发送稿');let key;globalThis.__result.post=async(_,body)=>{key=body.client_request_id;throw new Error('lost ACK')};await store.getState().save('task-1');store.getState().edit('task-1','后写的文字');assert.equal(store.getState().uncertain['task-1'].key,key);assert.equal('body' in globalThis.__result.receipts.get(key),false);
 store.getState().cleanup();await open();assert.equal(store.getState().uncertain['task-1'].key,key);globalThis.__result.get=async path=>{assert.match(path,new RegExp(`/commands/${key}$`));return response(key,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222','已发送稿',{kind:'manual'})]}))};await store.getState().verify('task-1');assert.equal(store.getState().uncertain['task-1'],undefined);assert.equal(globalThis.__result.receipts.size,0);
});
test('missing receipt stays unresolved and cannot send a new write',async()=>{
 await open();globalThis.__result.post=async()=>{throw new Error('lost')};await store.getState().save('task-1');let count=0;globalThis.__result.get=async()=>{throw Object.assign(new Error('not found'),{status:404})};await store.getState().verify('task-1');globalThis.__result.post=async()=>{count++};await assert.rejects(store.getState().save('task-1'),/先核验/);assert.equal(count,0);assert.ok(store.getState().uncertain['task-1']);
});
test('failed durable journal prevents dispatch',async()=>{
 await open();globalThis.__result.storageFailure=true;let calls=0;globalThis.__result.post=async()=>{calls++};await store.getState().save('task-1');assert.equal(calls,0);assert.match(store.getState().errors['task-1'],/尚未发送/);
});
test('A→B→A generation fences delayed mutation and leaves newer pending operation alone',async()=>{
 await open();const old=deferred();let first;globalThis.__result.post=(_,body)=>{first=body;return old.promise};const saving=store.getState().save('task-1');await tick();store.getState().cleanup();globalThis.__result.user='bob';globalThis.__result.auth++;store.getState().cleanup();globalThis.__result.user='alice';globalThis.__result.auth++;globalThis.__result.receipts.clear();await open();store.getState().edit('task-1','新会话文字');const newer=deferred();let second;globalThis.__result.post=(_,body)=>{second=body;return newer.promise};const saveNew=store.getState().save('task-1');await tick();old.resolve(response(first.client_request_id,doc({revision:8})));await saving;assert.equal(store.getState().editors['task-1'].body,'新会话文字');assert.equal(store.getState().pending['task-1'],'保存版本中');newer.resolve(response(second.client_request_id,doc({revision:2})));await saveNew;
});
test('delayed device draft recovery cannot overwrite typing',async()=>{
 const delayed=deferred();globalThis.__result.loadDraft=()=>delayed.promise;const opening=store.getState().select('task-1');await tick();store.getState().edit('task-1','刚写的新文字');delayed.resolve({body:'设备旧副本',baseRevisionId:'11111111-1111-4111-8111-111111111111'});await opening;assert.equal(store.getState().editors['task-1'].body,'刚写的新文字');
});
test('generating a candidate leaves an existing manual head untouched',async()=>{
 const manual=version('11111111-1111-4111-8111-111111111111','我自己的邀请',{kind:'manual'});globalThis.__result.get=async()=>({data:doc({versions:[manual]})});await open();globalThis.__result.get=async()=>({data:doc({revision:2,versions:[manual,version('22222222-2222-4222-8222-222222222222','新的AI候选')]})});await store.getState().fetch('task-1');assert.equal(store.getState().editors['task-1'].body,'我自己的邀请');assert.equal(store.getState().documents['task-1'].head_version_id,'11111111-1111-4111-8111-111111111111');
});
test('adopt ACK cannot overwrite typing that began during adoption',async()=>{
 await open();const pending=deferred();let payload;globalThis.__result.post=(_,body)=>{payload=body;return pending.promise};const adopting=store.getState().adopt('task-1','22222222-2222-4222-8222-222222222222');await tick();store.getState().edit('task-1','刚写的人工稿');pending.resolve(response(payload.client_request_id,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222','候选')]}),'adopt'));await adopting;assert.equal(store.getState().editors['task-1'].body,'刚写的人工稿');assert.equal(store.getState().editors['task-1'].conflict,true);
});

test('device recovery retries a lost-ACK save with original frozen content and UUID after reload',async()=>{
 globalThis.__result.recovery=true;await open();store.getState().edit('task-1','原始发送文字');let original;
 globalThis.__result.post=async(_,payload)=>{original=structuredClone(payload);throw new Error('lost ACK')};await store.getState().save('task-1');store.getState().edit('task-1','发送后继续改的文字');await tick();store.getState().cleanup();await open();assert.equal(store.getState().canRetry('task-1'),true);let replay;
 globalThis.__result.post=async(_,payload)=>{replay=payload;return response(payload.client_request_id,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222',payload.content,{kind:'manual'})]}))};await store.getState().retry('task-1');assert.deepEqual(replay,original);assert.equal(replay.content,'原始发送文字');assert.equal(store.getState().editors['task-1'].body,'发送后继续改的文字');assert.equal(store.getState().editors['task-1'].dirty,true);
});
test('a source revoke read hides every cached version and removes device content without dropping unknown IDs',async()=>{
 await open();store.getState().edit('task-1','私有文字');globalThis.__result.post=async()=>{throw new Error('lost')};await store.getState().save('task-1');globalThis.__result.get=async()=>{throw Object.assign(new Error('forbidden'),{status:403})};await store.getState().fetch('task-1');assert.equal(store.getState().documents['task-1'].source.status,'blocked');assert.equal(store.getState().documents['task-1'].versions[0].content,'');assert.ok(store.getState().uncertain['task-1']);
});

test('a late save ACK cannot clear a newer source review at the same document revision',async()=>{
 await open();store.getState().edit('task-1','人工邀请20日');const delayed=deferred();let sent;globalThis.__result.post=(_,body)=>{sent=body;return delayed.promise};const saving=store.getState().save('task-1');await tick();
 const saved=doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222','人工邀请20日',{kind:'manual'})]});globalThis.__result.get=async()=>({data:{...saved,source:{...saved.source,status:'changed',hash:'source-22',messages:[{id:'m22',content:'更正22日',change:'changed'}]}}});await store.getState().fetch('task-1');delayed.resolve(response(sent.client_request_id,saved));await saving;assert.equal(store.getState().documents['task-1'].source.hash,'source-22');assert.equal(store.getState().documents['task-1'].source.status,'changed');assert.equal(store.getState().editors['task-1'].body,'人工邀请20日');
});
test('blocked save settlement cannot recreate an encrypted device draft',async()=>{
 globalThis.__result.recovery=true;await open();store.getState().edit('task-1','将撤权的人工文字');await tick();globalThis.__result.post=async(_,body)=>response(body.client_request_id,doc({revision:2,source:{...doc().source,status:'blocked',messages:[]},versions:[{...version(),content:'',content_hidden:true,source_status:'blocked'}]}));await store.getState().save('task-1');await tick();assert.equal(globalThis.__result.drafts.has('task-1'),false);assert.equal(store.getState().documents['task-1'].source.status,'blocked');
});

test('typing during frozen-command recovery cannot be overwritten by the recovered save receipt',async()=>{
 const key='4abc6c19-d370-49b8-8bc5-e6172bf12c5c',payload={client_request_id:key,expected_revision:1,base_version_id:'11111111-1111-4111-8111-111111111111',content:'最早已发送正文'};
 const receipt={key,action:'save_revision',taskId:'task-1',payloadHash:globalThis.__result.hash(JSON.stringify(payload)),createdAt:'2026-10-04'};globalThis.__result.receipts.set(key,receipt);const frozen=deferred();globalThis.__result.loadDraft=id=>id.startsWith('result-intent:')?frozen.promise:Promise.resolve(null);const opening=store.getState().select('task-1');await tick();store.getState().edit('task-1','重载后已经新写的私人段落');frozen.resolve({body:JSON.stringify({payload}),baseRevisionId:'11111111-1111-4111-8111-111111111111'});await opening;globalThis.__result.get=async()=>response(key,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222',payload.content,{kind:'manual'})]}));await store.getState().verify('task-1');assert.equal(store.getState().editors['task-1'].body,'重载后已经新写的私人段落');assert.equal(store.getState().editors['task-1'].dirty,true);
});

test('a newer deletion or permission barrier cannot be undone by an older higher-revision save ACK',async()=>{
 await open();store.getState().edit('task-1','删除前的人工正文');const pending=deferred();let sent;globalThis.__result.post=(_,body)=>{sent=body;return pending.promise};const saving=store.getState().save('task-1');await tick();globalThis.__result.get=async()=>{throw Object.assign(new Error('deleted'),{status:404})};await store.getState().fetch('task-1');pending.resolve(response(sent.client_request_id,doc({revision:2,head_version_id:'22222222-2222-4222-8222-222222222222',versions:[version('22222222-2222-4222-8222-222222222222','删除前的人工正文',{kind:'manual'})]})));await saving;assert.equal(store.getState().documents['task-1'].source.status,'blocked');assert.equal(store.getState().documents['task-1'].versions.every(version=>version.content_hidden&&version.content===''),true);
});

function cancelled(key, document=doc(), operation='save') { return { data: { receipt: { id:key, task_id:'task-1', operation, status:'cancelled', version_id:null, committed_revision:null, committed_at:null, closed_at:'2026-10-04T15:00:00Z' }, document } }; }

function pendingResult(key,action='save_revision',time='2026-10-04T10:00:00Z'){const receipt={key,action,taskId:'task-1',payloadHash:'minimum-only',createdAt:time};globalThis.__result.receipts.set(key,receipt);return receipt;}
test('same-account multi-tab result keys remain a queue; closing one cannot unlock new submissions',async()=>{
 pendingResult('first');pendingResult('second','accept_revision','2026-10-04T11:00:00Z');await open();store.getState().edit('task-1','新人工稿');let calls=[];
 globalThis.__result.post=async(path,payload,config)=>{calls.push({path,payload,config});return cancelled(path.includes('first')?'first':'second',doc(),payload.operation)};
 await store.getState().closeCommand('task-1','first');assert.equal(store.getState().uncertain['task-1'].key,'second');assert.equal(store.getState().uncertainQueues['task-1'].length,1);assert.equal(store.getState().editors['task-1'].body,'新人工稿');await assert.rejects(store.getState().save('task-1'),/先核验/);
 await store.getState().closeCommand('task-1','second');assert.equal(store.getState().uncertain['task-1'],undefined);assert.deepEqual(calls.map(call=>call.payload),[{operation:'save'},{operation:'accept'}]);assert.ok(calls.every(call=>call.path.endsWith('/close')&&call.config.headers['X-Expected-User-Id']==='alice'));assert.equal(store.getState().editors['task-1'].body,'新人工稿');
});
test('unadmitted result close preserves typing, exact saved versions and acceptance',async()=>{
 pendingResult('unadmitted');const acceptedDoc=doc({accepted_version_id:'11111111-1111-4111-8111-111111111111',accepted_content_hash:'hash-11111111-1111-4111-8111-111111111111',accepted_at:'2026-10-03'});globalThis.__result.get=async()=>({data:acceptedDoc});await open();const waiting=deferred();globalThis.__result.post=(path,payload)=>{assert.equal(path,'/tasks/task-1/result/commands/unadmitted/close');assert.deepEqual(payload,{operation:'save'});return waiting.promise};const closing=store.getState().closeCommand('task-1','unadmitted');store.getState().edit('task-1','等待回复时继续写');waiting.resolve(cancelled('unadmitted',acceptedDoc));await closing;assert.equal(store.getState().editors['task-1'].body,'等待回复时继续写');assert.equal(store.getState().editors['task-1'].dirty,true);assert.deepEqual(store.getState().documents['task-1'],acceptedDoc);assert.equal(globalThis.__result.receipts.size,0);
});
test('result close lost ACK reload uses minimal key; current new input is never replayed or removed',async()=>{
 pendingResult('close-ack');await open();globalThis.__result.post=async()=>{throw new Error('lost close ACK')};await store.getState().closeCommand('task-1','close-ack');assert.equal(globalThis.__result.receipts.size,1);store.getState().cleanup();await open();store.getState().edit('task-1','重载后新文字');globalThis.__result.get=async path=>{assert.equal(path,'/tasks/task-1/result/commands/close-ack');return cancelled('close-ack')};await store.getState().verify('task-1');assert.equal(store.getState().editors['task-1'].body,'重载后新文字');assert.equal(globalThis.__result.receipts.size,0);
});
test('close success returns original save without replacing newer local typing or implying latest acceptance',async()=>{
 pendingResult('committed');await open();store.getState().edit('task-1','新的私人句');globalThis.__result.post=async()=>response('committed',doc({revision:3,head_version_id:'33333333-3333-4333-8333-333333333333',accepted_version_id:'11111111-1111-4111-8111-111111111111',accepted_content_hash:'hash-11111111-1111-4111-8111-111111111111',versions:[version(),version('22222222-2222-4222-8222-222222222222','原请求保存稿'),version('33333333-3333-4333-8333-333333333333','更新服务器稿')]}),'save','22222222-2222-4222-8222-222222222222');await store.getState().closeCommand('task-1','committed');assert.equal(store.getState().editors['task-1'].body,'新的私人句');assert.equal(store.getState().editors['task-1'].baseVersionId,'22222222-2222-4222-8222-222222222222');assert.equal(store.getState().editors['task-1'].conflict,true);assert.equal(store.getState().documents['task-1'].accepted_version_id,'11111111-1111-4111-8111-111111111111');
});
test('404/409/503 and invalid closure receipts keep pending key and typed text',async()=>{
 pendingResult('keep');await open();store.getState().edit('task-1','保留输入');for(const status of [404,409,503]){globalThis.__result.post=async()=>{throw Object.assign(new Error('not terminal'),{status})};await store.getState().closeCommand('task-1','keep');assert.equal(store.getState().uncertain['task-1'].key,'keep')}
 globalThis.__result.post=async()=>cancelled('wrong');await store.getState().closeCommand('task-1','keep');assert.equal(store.getState().uncertain['task-1'].key,'keep');assert.equal(store.getState().editors['task-1'].body,'保留输入');await assert.rejects(store.getState().closeCommand('task-1','different'),/不在待核验/);
});
test('late close response cannot undo a newer source-revocation barrier',async()=>{
 pendingResult('older-close');await open();const closingReply=deferred();globalThis.__result.post=()=>closingReply.promise;const closing=store.getState().closeCommand('task-1','older-close');globalThis.__result.get=async()=>{throw Object.assign(new Error('revoked'),{status:404})};await store.getState().fetch('task-1');closingReply.resolve(cancelled('older-close',doc({revision:9})));await closing;assert.equal(store.getState().documents['task-1'].source.status,'blocked');assert.ok(store.getState().documents['task-1'].versions.every(item=>item.content_hidden));assert.equal(store.getState().uncertain['task-1'],undefined);
});
test('A-B-A result close response cannot settle the renewed auth generation key',async()=>{
 pendingResult('auth-key');await open();const waiting=deferred();globalThis.__result.post=()=>waiting.promise;const closing=store.getState().closeCommand('task-1','auth-key');store.getState().cleanup();globalThis.__result.user='bob';globalThis.__result.auth++;store.getState().cleanup();globalThis.__result.user='alice';globalThis.__result.auth++;await open();store.getState().edit('task-1','新会话的文字');waiting.resolve(cancelled('auth-key'));await closing;assert.equal(store.getState().uncertain['task-1'].key,'auth-key');assert.equal(store.getState().editors['task-1'].body,'新会话的文字');
});

test('historical accept recovery names the accepted version without claiming current sources are valid',async()=>{
 pendingResult('historical-accept','accept_revision');await open();globalThis.__result.post=async()=>response('historical-accept',doc({revision:3,head_version_id:'22222222-2222-4222-8222-222222222222',accepted_version_id:'11111111-1111-4111-8111-111111111111',versions:[version(),version('22222222-2222-4222-8222-222222222222','新正文',{sequence:2})],source:{...doc().source,status:'changed',hash:'source-22'}}),'accept','11111111-1111-4111-8111-111111111111');await store.getState().closeCommand('task-1','historical-accept');assert.match(store.getState().notices['task-1'],/版本 1/);assert.match(store.getState().notices['task-1'],/来源状态请以上方标记为准/);assert.equal(store.getState().documents['task-1'].source.status,'changed');
});

for(const returnOrder of ['close-first','read-first'])for(const barrier of [403,404,410,'blocked-200'])test(`a newer source read survives older close settlement: ${barrier}, ${returnOrder}`,async()=>{
 pendingResult('ordering');await open();const closeReply=deferred(),newRead=deferred();globalThis.__result.post=()=>closeReply.promise;const closing=store.getState().closeCommand('task-1','ordering');globalThis.__result.get=()=>newRead.promise;const reading=store.getState().fetch('task-1');
 const finishClose=async()=>{closeReply.resolve(cancelled('ordering',doc()));await closing};const finishRead=async()=>{if(barrier==='blocked-200')newRead.resolve({data:doc({source:{...doc().source,status:'blocked',messages:[]},versions:[{...version(),content:'',content_hidden:true,source_status:'blocked'}]})});else newRead.reject(Object.assign(new Error('source inaccessible'),{status:barrier}));await reading};
 if(returnOrder==='close-first'){await finishClose();assert.equal(store.getState().loading['task-1'],true);await finishRead()}else{await finishRead();await finishClose()}
 assert.equal(store.getState().loading['task-1'],false);assert.equal(store.getState().documents['task-1'].source.status,'blocked');assert.equal(store.getState().documents['task-1'].versions.filter(item=>!item.content_hidden).length,0);assert.equal(store.getState().uncertain['task-1'],undefined);
});

for (const [label,corrupt] of Object.entries({
 missingVersion:r=>{delete r.version_id},invalidVersion:r=>{r.version_id='not-uuid'},missingRevision:r=>{delete r.committed_revision},nullRevision:r=>{r.committed_revision=null},fractionalRevision:r=>{r.committed_revision=1.2},negativeRevision:r=>{r.committed_revision=-1},missingTime:r=>{delete r.committed_at},invalidTime:r=>{r.committed_at='unknown'},wrongClosedField:r=>{r.closed_at='2026-10-04'},futureRevision:r=>{r.committed_revision=900},unlistedVersion:r=>{r.version_id='99999999-9999-4999-8999-999999999999'}
})) test(`incomplete succeeded receipt never releases original intent: ${label}`,async()=>{
 await open();globalThis.__result.post=async()=>{throw new Error('lost original ACK')};store.getState().edit('task-1','原保存');await store.getState().save('task-1');const key=store.getState().uncertain['task-1'].key;store.getState().edit('task-1','现在的人工输入');
 const answer=response(key,doc());corrupt(answer.data.receipt);globalThis.__result.post=async()=>answer;await store.getState().closeCommand('task-1',key);
 assert.equal(store.getState().uncertain['task-1'].key,key);assert.ok(globalThis.__result.receipts.has(key));assert.equal(store.getState().editors['task-1'].body,'现在的人工输入');
});

test('closing a deleted document command never promises retained text or continued saving', async()=>{
 await open();globalThis.__result.post=async()=>{throw new Error('lost ACK')};store.getState().edit('task-1','旧文字');await store.getState().save('task-1');const key=store.getState().uncertain['task-1'].key;
 globalThis.__result.post=async()=>({data:{receipt:{id:key,task_id:'task-1',operation:'save',status:'cancelled',version_id:null,committed_revision:null,committed_at:null,closed_at:'2026-10-05T00:00:00Z'},document:null,task_deleted:true}});
 await store.getState().closeCommand('task-1',key);assert.match(store.getState().notices['task-1'],/文稿已删除，未恢复旧正文/);assert.doesNotMatch(store.getState().notices['task-1'],/当前输入仍在|继续保存/);assert.equal(store.getState().editors['task-1'],undefined);
});
