import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
const testWindow = new Window({ url:'http://localhost' }); globalThis.localStorage = testWindow.localStorage;
const root = resolve(import.meta.dirname, '..');
globalThis.__taskTest = { user: 'alice', get: async () => ({ data: [] }), post: async () => ({ data: {} }), patch: async () => ({ data: {} }), delete: async () => ({ data: {} }) };
const result = await build({ entryPoints: [resolve(root, 'src/stores/tasksStore.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'task-boundaries', setup(build) {
  build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
  build.onResolve({ filter: /(?:utils\/|\.\/)cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
  build.onResolve({ filter: /^\.\/modelsStore$/ }, () => ({ path: 'models', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `export const getAuthGeneration=()=>globalThis.__taskTest.auth || 0; export const axiosInstance = Object.fromEntries(['get','post','patch','delete'].map(method => [method, (...args) => globalThis.__taskTest[method](...args)]));` : path === 'cache' ? 'export const getCacheUserId = () => globalThis.__taskTest.user;' : 'export const requestError = error => error.message;', loader: 'js' }));
}}] });
const { useTasksStore: store } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const input = { title: '中文任务', prompt: '私密输入不应进入诊断', category: 'work', model_id: null, group_id: null, source_message_id: null, run_at: null, repeat_minutes: null, auto_run: false };
const task = { id: 'task-a', ...input, status: 'pending', history: [], result: '', run_id: 'run-a' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { localStorage.clear(); store.getState().cleanup(); globalThis.__taskTest.user = 'alice'; for (const method of ['post', 'patch', 'delete']) globalThis.__taskTest[method] = async () => ({ data: task }); globalThis.__taskTest.get = async () => ({ data: [] }); });
test('newer task reads win over delayed polling', async () => {
  const reads = []; globalThis.__taskTest.get = () => new Promise(resolve => reads.push(resolve));
  const older = store.getState().fetch(), newer = store.getState().fetch();
  reads[1]({ data: [{ ...task, title: '新版' }] }); await newer;
  reads[0]({ data: [{ ...task, title: '旧版' }] }); await older;
  assert.equal(store.getState().tasks[0].title, '新版');
});
test('create preserves exact intent through lost acknowledgment and rejects changed replay', async () => {
  const calls = []; globalThis.__taskTest.post = async (...args) => { calls.push(args); if (calls.length === 1) throw new Error('Network error with secret'); return { data: { ...task, client_request_id: args[2].headers['Idempotency-Key'] } }; };
  await assert.rejects(store.getState().create(input));
  assert.equal(store.getState().uncertainCreate, true);
  await assert.rejects(store.getState().create({ ...input, title: '新内容' }), /先按原内容重试/);
  assert.equal(calls.length, 1);
  const saved = await store.getState().create(input);
  assert.equal(saved.id, task.id);
  assert.equal(calls[0][2].headers['Idempotency-Key'], calls[1][2].headers['Idempotency-Key']);
  assert.equal(store.getState().uncertainCreate, false);
});
test('validation rejection retains the exact key until authoritative closure before correcting input', async () => {
  const keys = []; globalThis.__taskTest.post = async (_, __, config) => { keys.push(config.headers['Idempotency-Key']); throw Object.assign(new Error('validation'), { status: 400 }); };
  await assert.rejects(store.getState().create(input));
  assert.equal(store.getState().uncertainCreate, true);
  await assert.rejects(store.getState().create({ ...input, title: '改正' }));
  assert.equal(keys.length, 1);
  globalThis.__taskTest.post = async path => ({ data: { status: 'cancelled', operation: 'create', client_request_id: keys[0], task_id: null, task_deleted: false, task: null, closed_at: '2026-10-04' } });
  await store.getState().closeCreate(keys[0]); assert.equal(store.getState().uncertainCreate, false);
  globalThis.__taskTest.post = async (_, __, config) => { keys.push(config.headers['Idempotency-Key']); throw Object.assign(new Error('validation'), { status: 400 }); };
  await assert.rejects(store.getState().create({ ...input, title: '改正' })); assert.notEqual(keys[0], keys[1]);
});
test('double create sends once; account switch rejects late receipt and does not fetch for new account', {timeout:2000}, async () => {
  let complete, writes = 0, reads = 0, entered; const dispatched=new Promise(resolve=>{entered=resolve;});
  globalThis.__taskTest.get = async () => { reads++; return { data: [] }; };
  globalThis.__taskTest.post = () => { writes++; entered(); return new Promise(resolve => { complete = resolve; }); };
  const first = store.getState().create(input);
  await assert.rejects(store.getState().create(input), /正在保存/);
  await dispatched; assert.equal(writes, 1);
  store.getState().cleanup(); globalThis.__taskTest.user = 'bob';
  complete({ data: task }); await assert.rejects(first, /账号已切换/);
  assert.equal(reads, 0); assert.deepEqual(store.getState().tasks, []); assert.equal(store.getState().composerDraft.prompt, '');
});
test('run retry reuses key after timeout and cancellation can be sent while request is pending', {timeout:2000}, async () => {
  const keys = []; let complete;
  globalThis.__taskTest.post = async (_, __, config) => { keys.push(config.headers['Idempotency-Key']); if (keys.length === 1) throw new Error('timeout'); return new Promise(resolve => { complete = resolve; }); };
  await assert.rejects(store.getState().run(task.id));
  const retry = store.getState().run(task.id); while (!complete) await tick();
  assert.equal(keys[0], keys[1]);
  await assert.rejects(store.getState().run(task.id), /正在处理/);
  let cancelled = false; globalThis.__taskTest.patch = async (path, payload) => { assert.equal(payload.status, 'cancelled'); cancelled = true; return { data: task }; };
  await store.getState().update(task.id, { status: 'cancelled' }); assert.equal(cancelled, true);
  complete({ data: { ...task, status: 'outcome_unknown' } }); await retry;
});
test('resolve unknown names the exact displayed run', async () => {
  store.setState({ tasks: [task] });
  globalThis.__taskTest.post = async (path, payload) => { assert.equal(payload.run_id, task.run_id); return { data: task }; };
  await store.getState().resolveUnknown(task.id, task.run_id, 'allow_retry');
});
test('terminal polling receipt clears admitted retry key before intentional regeneration', async () => {
  let key; const sent = [];
  globalThis.__taskTest.post = async (_, __, config) => { key = config.headers['Idempotency-Key']; sent.push(key); if (sent.length === 1) throw new Error('lost response'); return { data: { ...task, status:'running', run_request_id:key } }; };
  globalThis.__taskTest.get = async () => ({data:[]});
  await assert.rejects(store.getState().run(task.id)); await store.getState().run(task.id);
  assert.equal(sent[0], sent[1]);
  globalThis.__taskTest.get = async () => ({data:[{ ...task, status:'needs_review', run_request_id:key }]});
  await store.getState().fetch(); await store.getState().run(task.id);
  assert.notEqual(sent[1], sent[2]);
});

test('reload finds an uncertain create by durable receipt without retaining private input', async()=>{
 let key;globalThis.__taskTest.post=async(_,body,config)=>{key=config.headers['Idempotency-Key'];throw new Error('lost ACK')};await assert.rejects(store.getState().create(input));store.getState().cleanup();
 globalThis.__taskTest.get=async path=>path==='/tasks'?{data:[]}:{data:{status:'succeeded',operation:'create',client_request_id:key,task_id:task.id,task_deleted:false,task:{...task,client_request_id:key}}};await store.getState().fetch();assert.equal(store.getState().uncertainCreate,false);assert.equal(store.getState().tasks[0].id,task.id);assert.doesNotMatch(JSON.stringify(Object.values(localStorage)),/私密输入/);
});
test('deleted-create receipt is terminal evidence and never recreates its task',async()=>{
 let key;globalThis.__taskTest.post=async(_,body,config)=>{key=config.headers['Idempotency-Key'];throw new Error('lost ACK')};await assert.rejects(store.getState().create(input));store.getState().cleanup();let writes=0;globalThis.__taskTest.post=async()=>{writes++;return{data:task}};globalThis.__taskTest.get=async path=>path==='/tasks'?{data:[]}:{data:{status:'succeeded',operation:'create',client_request_id:key,task_id:task.id,task_deleted:true,task:null}};await store.getState().fetch();assert.equal(store.getState().uncertainCreate,false);assert.equal(writes,0);assert.deepEqual(store.getState().tasks,[]);
});
test('missing create receipt after reload remains unresolved instead of accepting new input',async()=>{
 globalThis.__taskTest.post=async()=>{throw new Error('lost ACK')};await assert.rejects(store.getState().create(input));store.getState().cleanup();globalThis.__taskTest.get=async path=>{if(path==='/tasks')return{data:[]};throw Object.assign(new Error('not found'),{status:404})};await store.getState().fetch();assert.equal(store.getState().uncertainCreate,true);await assert.rejects(store.getState().create(input),/正文未保存在此设备/);
});
test('legacy create cannot dispatch when the minimal durable journal cannot be stored',async()=>{
 const storage=globalThis.localStorage;let posts=0;globalThis.localStorage={length:0,getItem(){return null},setItem(){throw new Error('quota')},removeItem(){}};globalThis.__taskTest.post=async()=>{posts++;return{data:task}};try{await assert.rejects(store.getState().create(input),/尚未发送/);assert.equal(posts,0)}finally{globalThis.localStorage=storage}
});

const createReceipt = (key, createdAt='2026-10-04T10:00:00Z', user='alice') => {
 const receipt={key,action:'create',taskId:null,payloadHash:'a'.repeat(64),createdAt};localStorage.setItem(`qunthink_command_v1_${user}:${key}`,JSON.stringify(receipt));return receipt;
};
const closedCreate = key => ({data:{status:'cancelled',operation:'create',client_request_id:key,task_id:null,task_deleted:false,task:null,closed_at:'2026-10-04T11:00:00Z'}});
const missingCreates = async path => { if(path==='/tasks')return{data:[]};throw Object.assign(new Error('not found'),{status:404}); };
test('two tabs create keys are independently discoverable; one success never releases the other or erases new typing',async()=>{
 createReceipt('07f99a09-964c-5f9a-ac80-0936ea8eeaa0');createReceipt('1cf695f2-ec7d-574f-8c6b-d7bdb7b2b145','2026-10-04T10:01:00Z');store.getState().setComposerDraft({...store.getState().composerDraft,title:'新标题',prompt:'新写的用途'});
 globalThis.__taskTest.get=async path=>path==='/tasks'?{data:[{...task,client_request_id:'07f99a09-964c-5f9a-ac80-0936ea8eeaa0'}]}:missingCreates(path);
 await store.getState().fetch();assert.deepEqual(store.getState().pendingCreates.map(item=>item.key),['1cf695f2-ec7d-574f-8c6b-d7bdb7b2b145']);assert.equal(store.getState().uncertainCreate,true);assert.equal(store.getState().composerDraft.prompt,'新写的用途');assert.equal(store.getState().recoveredCreate.preserveDraft,true);
 await assert.rejects(store.getState().create(input));let sent;globalThis.__taskTest.post=async(path,payload,config)=>{sent={path,payload,config};return closedCreate('1cf695f2-ec7d-574f-8c6b-d7bdb7b2b145')};await store.getState().closeCreate('1cf695f2-ec7d-574f-8c6b-d7bdb7b2b145');assert.equal(sent.path,'/tasks/commands/1cf695f2-ec7d-574f-8c6b-d7bdb7b2b145/close');assert.deepEqual(sent.payload,{});assert.equal(sent.config.headers['X-Expected-User-Id'],'alice');assert.equal(store.getState().uncertainCreate,false);assert.equal(store.getState().composerDraft.prompt,'新写的用途');
});
test('missing create private text: closure lost ACK retains input/key and reload resolves only by authoritative GET',async()=>{
 createReceipt('9edae766-4454-5a8c-9c15-922dea8b2424');globalThis.__taskTest.get=missingCreates;await store.getState().fetch();assert.equal(store.getState().canRetryCreate('9edae766-4454-5a8c-9c15-922dea8b2424'),false);
 let release;globalThis.__taskTest.post=()=>new Promise((_,reject)=>{release=reject});const closing=store.getState().closeCreate('9edae766-4454-5a8c-9c15-922dea8b2424');await tick();store.getState().setComposerDraft({...store.getState().composerDraft,title:'新输入',prompt:'关闭时仍在写'});release(new Error('ACK lost'));await assert.rejects(closing);await tick();assert.equal(store.getState().pendingCreates[0].key,'9edae766-4454-5a8c-9c15-922dea8b2424');assert.equal(store.getState().composerDraft.prompt,'关闭时仍在写');
 store.getState().cleanup();globalThis.__taskTest.get=async path=>path==='/tasks'?{data:[]}:closedCreate('9edae766-4454-5a8c-9c15-922dea8b2424');store.getState().setComposerDraft({...store.getState().composerDraft,prompt:'重载后新写'});await store.getState().fetch();assert.equal(store.getState().pendingCreates.length,0);assert.equal(store.getState().composerDraft.prompt,'重载后新写');assert.equal(store.getState().recoveredCreate.cancelled,true);
});
test('late original create ACK cannot replace typing or release another pending intent',async()=>{
 let resolveOriginal,key;globalThis.__taskTest.get=missingCreates;globalThis.__taskTest.post=(_,__,config)=>{key=config.headers['Idempotency-Key'];return new Promise(resolve=>{resolveOriginal=resolve})};const creating=store.getState().create(input);while(!resolveOriginal)await tick();
 createReceipt('83cff255-9d41-5014-a81f-e54c86d6b96c','2026-10-04T11:00:00Z');store.getState().setComposerDraft({...store.getState().composerDraft,prompt:'正在写新的文稿要求'});await store.getState().fetch();globalThis.__taskTest.post=async()=>({data:{status:'succeeded',operation:'create',client_request_id:key,task_id:task.id,task_deleted:false,task:{...task,client_request_id:key}}});await store.getState().closeCreate(key);
 resolveOriginal({data:{...task,client_request_id:key}});await creating;await tick();assert.equal(store.getState().composerDraft.prompt,'正在写新的文稿要求');assert.deepEqual(store.getState().pendingCreates.map(item=>item.key),['83cff255-9d41-5014-a81f-e54c86d6b96c']);
});
test('closure 409/503/mismatched response never proves cancellation and foreign account keys are not sent',async()=>{
 createReceipt('90f3e774-aee6-565a-8ab7-ca99996a13f0');createReceipt('9aa6a575-61dd-5069-baef-88452221a560','2026-10-04T10:00:00Z','bob');globalThis.__taskTest.get=missingCreates;await store.getState().fetch();assert.deepEqual(store.getState().pendingCreates.map(item=>item.key),['90f3e774-aee6-565a-8ab7-ca99996a13f0']);let posts=0;
 for(const status of [409,503]){globalThis.__taskTest.post=async()=>{posts++;throw Object.assign(new Error('CAS'),{status})};await assert.rejects(store.getState().closeCreate('90f3e774-aee6-565a-8ab7-ca99996a13f0'));assert.equal(store.getState().pendingCreates[0].key,'90f3e774-aee6-565a-8ab7-ca99996a13f0')}
 globalThis.__taskTest.post=async()=>closedCreate('wrong');await assert.rejects(store.getState().closeCreate('90f3e774-aee6-565a-8ab7-ca99996a13f0'));await assert.rejects(store.getState().closeCreate('9aa6a575-61dd-5069-baef-88452221a560'));assert.equal(posts,2);assert.equal(store.getState().pendingCreates[0].key,'90f3e774-aee6-565a-8ab7-ca99996a13f0');
});
test('A-B-A auth generation rejects old close response and keeps renewed account input and key',async()=>{
 createReceipt('c7459909-1d49-557a-b2c3-e1774c7b0648');globalThis.__taskTest.get=missingCreates;await store.getState().fetch();let release;globalThis.__taskTest.post=()=>new Promise(resolve=>{release=resolve});const closing=store.getState().closeCreate('c7459909-1d49-557a-b2c3-e1774c7b0648');await tick();
 store.getState().cleanup();globalThis.__taskTest.user='bob';globalThis.__taskTest.auth=(globalThis.__taskTest.auth||0)+1;store.getState().cleanup();globalThis.__taskTest.user='alice';globalThis.__taskTest.auth++;await store.getState().fetch();store.getState().setComposerDraft({...store.getState().composerDraft,prompt:'再次登录后新文字'});release(closedCreate('c7459909-1d49-557a-b2c3-e1774c7b0648'));await assert.rejects(closing,/账号已切换/);assert.equal(store.getState().composerDraft.prompt,'再次登录后新文字');assert.equal(store.getState().pendingCreates[0].key,'c7459909-1d49-557a-b2c3-e1774c7b0648');
});

test('older create closure cannot overwrite a newer revoked task projection',async()=>{
 createReceipt('e2e4409a-b44c-5446-b857-97af4240e7b9');globalThis.__taskTest.get=missingCreates;await store.getState().fetch();let release;globalThis.__taskTest.post=()=>new Promise(resolve=>{release=resolve});const closing=store.getState().closeCreate('e2e4409a-b44c-5446-b857-97af4240e7b9');await tick();const revoked={...task,client_request_id:'e2e4409a-b44c-5446-b857-97af4240e7b9',prompt:'',source_input_stale:true};globalThis.__taskTest.get=async()=>({data:[revoked]});await store.getState().fetch();release({data:{status:'succeeded',operation:'create',client_request_id:'e2e4409a-b44c-5446-b857-97af4240e7b9',task_id:task.id,task_deleted:false,task:{...task,client_request_id:'e2e4409a-b44c-5446-b857-97af4240e7b9'}}});await closing;await tick();assert.equal(store.getState().tasks[0].prompt,'');assert.equal(store.getState().tasks[0].source_input_stale,true);
});
