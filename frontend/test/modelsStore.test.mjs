import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
globalThis.__modelsTest = { user: 'alice', get: async () => ({ data: {} }), post: async () => ({ data: {} }), put: async () => ({ data: {} }), personaReads: 0 };
const result = await build({ entryPoints: [resolve(root, 'src/stores/modelsStore.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'model-boundaries', setup(build) {
  build.onResolve({ filter: /(?:services\/api|^\.\/api)$/ }, () => ({ path: 'api', namespace: 'mock' }));
  build.onResolve({ filter: /utils\/cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock' }));
  build.onResolve({ filter: /^\.\/personasStore$/ }, () => ({ path: 'personas', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api' ? `export const axiosInstance = Object.fromEntries(['get','post','put'].map(method => [method, (...args) => globalThis.__modelsTest[method](...args)]));` : path === 'cache' ? 'export const getCacheUserId = () => globalThis.__modelsTest.user;' : 'export const usePersonasStore = {getState: () => ({fetchPersonas: async () => {globalThis.__modelsTest.personaReads++}})};', loader: 'js' }));
}}] });
const { useModelsStore: store, mergeModelDraft } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
function catalog(revision = 1) { return { revision, providers: ['a', 'b'].map(id => ({ id, name: `服务${id}`, protocol: 'openai', baseUrl: `https://${id}.example/v1`, enabled: true, keyRequired: true, apiKeyConfigured: true, ready: true })), models: [{ id:'model-a', providerId:'a', name:'测试模型', model:'example-chat', enabled:true, capabilities:['chat', 'vision', 'tts'], verifiedCapabilities:['chat'], ready:true, contextWindow:32000, maxTokens:4096, temperature:null, tokenParameter:'max_tokens', color:'#6366f1' }], defaults:{chat:null, vision:null, tts:null} }; }
const receipt = (requestId, patch = {}) => ({ requestId, modelId:'model-a', capability:'chat', status:'succeeded', healthy:true, stale:false, possibleCharge:true, replayed:false, ...patch });
const failure = (status, data) => Object.assign(new Error('request failed'), { response: { status, data } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(async () => { store.getState().cleanup(); globalThis.__modelsTest.user = 'alice'; globalThis.__modelsTest.personaReads = 0; globalThis.__modelsTest.get = async () => ({ data: catalog() }); globalThis.__modelsTest.put = async (_, value) => ({ data: { ...value, revision:value.revision + 1, providers:value.providers.map(({apiKey, ...p})=>p) } }); globalThis.__modelsTest.post = async () => ({data:{}}); await store.getState().fetch(); });

test('catalog revision never regresses, including newer requests returning older snapshots', async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  globalThis.__modelsTest.get = () => (++calls === 1 ? a.promise : b.promise);
  const one = store.getState().fetch(), two = store.getState().fetch();
  a.resolve({data:catalog(3)}); await one; b.resolve({data:catalog(2)}); await two;
  assert.equal(store.getState().catalog.revision, 3); assert.equal(store.getState().loading, false);
});
test('same-revision reads use request order so an old verified label cannot return late', async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  globalThis.__modelsTest.get = () => (++calls === 1 ? a.promise : b.promise);
  const one = store.getState().fetch(), two = store.getState().fetch();
  const next = catalog(); next.models[0].verifiedCapabilities=[];
  b.resolve({data:next}); await two; a.resolve({data:catalog()}); await one;
  assert.deepEqual(store.getState().catalog.models[0].verifiedCapabilities, []);
});
test('saving freezes the exact in-memory draft, rejects double save, and refreshes personas once', async () => {
  const draft = catalog(); draft.providers[0].name='我的草稿'; draft.providers[0].apiKey='only-in-memory'; store.getState().setDraft(draft);
  const write=deferred(); const sent=[]; globalThis.__modelsTest.put=(...args)=>{sent.push(args);return write.promise};
  const pending=store.getState().save(draft); const later=catalog(); later.providers[0].name='不得覆盖待保存版本'; store.getState().setDraft(later);
  assert.equal(store.getState().draft.providers[0].name,'我的草稿'); await assert.rejects(store.getState().save(draft),/正在保存/); assert.equal(sent.length,1);
  assert.equal(sent[0][2].headers['X-Expected-User-Id'],'alice');
  const saved=catalog(2); saved.providers[0].name='我的草稿'; write.resolve({data:saved}); await pending;
  assert.equal(store.getState().draft.providers[0].apiKey,undefined); assert.equal(store.getState().dirty,false); assert.equal(globalThis.__modelsTest.personaReads,1);
});
test('catalog refresh never replaces unsaved key/name; conflict requires explicit merge and preserves remote changes', async () => {
  const draft=catalog(); draft.providers[0].name='本地名称'; draft.providers[0].apiKey='draft-key'; store.getState().setDraft(draft);
  const remote=catalog(2); remote.providers[0].name='远端名称'; remote.models[0].maxTokens=8192; remote.models.push({...remote.models[0], id:'remote-model'});
  globalThis.__modelsTest.get=async()=>({data:remote}); globalThis.__modelsTest.put=async()=>{throw failure(409,{error:'配置已更新'})};
  await assert.rejects(store.getState().save(draft)); assert.equal(store.getState().draft.revision,1); assert.equal(store.getState().draft.providers[0].apiKey,'draft-key'); assert.equal(store.getState().conflict,true);
  await assert.rejects(store.getState().save(draft),/先合并/); await store.getState().rebaseDraft();
  assert.equal(store.getState().draft.revision,2); assert.equal(store.getState().draft.providers[0].name,'本地名称'); assert.equal(store.getState().draft.providers[0].apiKey,'draft-key'); assert.equal(store.getState().draft.models[0].maxTokens,8192); assert.equal(store.getState().draft.models.length,2); assert.equal(store.getState().dirty,true); assert.equal(store.getState().conflict,false);
});
test('three-way merge keeps remote removal of untouched model and restores locally edited model with its provider',()=>{
  const base=catalog(), local=catalog(), remote=catalog(2); remote.models=[]; remote.providers=[];
  assert.equal(mergeModelDraft(base,local,remote).models.length,0);
  local.models[0].name='本地模型'; const merged=mergeModelDraft(base,local,remote); assert.equal(merged.models[0].name,'本地模型'); assert.equal(merged.providers[0].id,'a');
});
test('discovery is provider/request bound and ignores late A after switching to B', async()=>{
  const a=deferred(), b=deferred(); let calls=0; globalThis.__modelsTest.post=()=>++calls===1?a.promise:b.promise;
  const one=store.getState().discover(); store.getState().selectProvider('b'); const two=store.getState().discover();
  b.resolve({data:{models:['b-model']}}); await two; a.resolve({data:{models:['wrong-a']}}); await one;
  assert.equal(store.getState().discovery.providerId,'b'); assert.deepEqual(store.getState().discovery.models,['b-model']);
});
test('connection edits invalidate in-flight discovery; adding a model preserves the completed list',async()=>{
  const a=deferred(); globalThis.__modelsTest.post=()=>a.promise; const pending=store.getState().discover();
  const draft=catalog(); draft.providers[0].baseUrl='https://changed.example/v1'; store.getState().setDraft(draft); a.resolve({data:{models:['old-model']}}); await pending; assert.deepEqual(store.getState().discovery.models,[]);
  store.getState().discardDraft(); globalThis.__modelsTest.post=async()=>({data:{models:['one','two']}}); await store.getState().discover();
  store.getState().setDraft({...store.getState().draft,models:[...store.getState().draft.models,{...catalog().models[0],id:'new',model:'one'}]}); assert.deepEqual(store.getState().discovery.models,['one','two']);
});
test('paid probe timeout keeps UUID, blocks repost and recovers canonical receipt by GET only',async()=>{
  const writes=[]; globalThis.__modelsTest.post=async(...args)=>{writes.push(args);throw new Error('timeout')};
  await store.getState().test('model-a','vision'); const first=store.getState().probes['model-a:vision'];
  assert.match(first.requestId,/^[a-f0-9-]{36}$/); assert.equal(first.status,'unknown'); assert.equal(writes[0][2].headers['Idempotency-Key'],first.requestId); assert.equal(writes[0][1].clientRequestId,first.requestId); assert.ok(writes[0][2].timeout>=50000);
  await store.getState().test('model-a','vision'); assert.equal(writes.length,1);
  const paths=[]; const canonical='22222222-2222-4222-8222-222222222222'; globalThis.__modelsTest.get=async path=>{paths.push(path);return {data:path.includes('/tests/')?receipt(canonical,{capability:'vision',status:'unknown',healthy:false,replayed:true}):catalog()}};
  await store.getState().queryProbe('model-a:vision'); assert.equal(store.getState().probes['model-a:vision'].requestId,canonical); await store.getState().queryProbe('model-a:vision'); assert.ok(paths.includes(`/user/model-catalog/tests/${canonical}`)); assert.equal(writes.length,1);
});
test('failed probe refreshes authoritative verification rather than leaving the old verified badge',async()=>{
  let reads=0; const revoked=catalog(); revoked.models[0].verifiedCapabilities=[]; globalThis.__modelsTest.get=async()=>{reads++;return {data:revoked}};
  globalThis.__modelsTest.post=async(_,body)=>{throw failure(502,receipt(body.clientRequestId,{status:'failed',healthy:false,error:'能力不匹配'}))};
  await store.getState().test('model-a','chat'); assert.equal(store.getState().probes['model-a:chat'].status,'failed'); assert.deepEqual(store.getState().catalog.models[0].verifiedCapabilities,[]); assert.equal(reads,1);
  await store.getState().fetch(); assert.deepEqual(store.getState().draft.models[0].verifiedCapabilities,[]);
});
test('independent capabilities can run concurrently but repeated clicks do not duplicate a probe',async()=>{
  const pending=[]; globalThis.__modelsTest.post=(_,body)=>{const wait=deferred();pending.push({wait,body});return wait.promise};
  const one=store.getState().test('model-a','chat'); const two=store.getState().test('model-a','vision'); await store.getState().test('model-a','chat'); assert.equal(pending.length,2);
  for(const p of pending) p.wait.resolve({data:receipt(p.body.clientRequestId,{capability:p.body.capability})}); await Promise.all([one,two]);
});
test('account cleanup erases secrets, discovery and probes and ignores late reads/save/probe receipts',async()=>{
  const write=deferred(), probe=deferred(); const draft=catalog(); draft.providers[0].apiKey='alice-secret';
  globalThis.__modelsTest.post=()=>probe.promise; const testRun=store.getState().test('model-a','chat');
  store.getState().setDraft(draft); globalThis.__modelsTest.put=()=>write.promise; const save=store.getState().save(draft);
  store.getState().cleanup(); globalThis.__modelsTest.user='bob'; write.resolve({data:catalog(2)}); probe.resolve({data:receipt('11111111-1111-4111-8111-111111111111')});
  await assert.rejects(save,/账号已切换/); await testRun;
  assert.equal(store.getState().draft,null); assert.deepEqual(store.getState().probes,{}); assert.equal(store.getState().catalog,null); assert.equal(globalThis.__modelsTest.personaReads,0);
});
test('failed read-only recovery retains original receipt and never releases unknown for a paid retry',async()=>{
  globalThis.__modelsTest.post=async()=>{throw new Error('lost')}; await store.getState().test('model-a','chat'); const id=store.getState().probes['model-a:chat'].requestId;
  globalThis.__modelsTest.get=async path=>{if(path.includes('/tests/'))throw failure(404,{error:'not found'});return {data:catalog()}};
  await store.getState().queryProbe('model-a:chat'); assert.equal(store.getState().probes['model-a:chat'].requestId,id); assert.equal(store.getState().probes['model-a:chat'].status,'unknown'); assert.match(store.getState().probes['model-a:chat'].queryError,/不会自动重新发起/);
});

test('conflict merge never retargets a pending plaintext key to a remote-changed endpoint',()=>{
  const base=catalog(), local=catalog(), remote=catalog(2);local.providers[0].apiKey='scoped-key';remote.providers[0].baseUrl='https://other.example/v1';remote.providers[0].protocol='anthropic';
  const merged=mergeModelDraft(base,local,remote);assert.equal(merged.providers[0].apiKey,'scoped-key');assert.equal(merged.providers[0].baseUrl,local.providers[0].baseUrl);assert.equal(merged.providers[0].protocol,'openai');
});

test('late stale probe cannot revoke newer catalog verification when refresh is unavailable',async()=>{
  const delayed=deferred();globalThis.__modelsTest.post=()=>delayed.promise;const pending=store.getState().test('model-a','chat');
  globalThis.__modelsTest.get=async()=>({data:catalog(2)});await store.getState().fetch();
  globalThis.__modelsTest.get=async()=>{throw new Error('offline')};delayed.resolve({data:receipt('11111111-1111-4111-8111-111111111111',{status:'failed',healthy:false,stale:true})});await pending;
  assert.equal(store.getState().catalog.revision,2);assert.deepEqual(store.getState().catalog.models[0].verifiedCapabilities,['chat']);
});

test('read-only capability changes are not mistaken for user edits during conflict recovery',()=>{
  const base=catalog(),local=catalog(),remote=catalog(2);local.models[0].verifiedCapabilities=[];remote.models=[];
  assert.equal(mergeModelDraft(base,local,remote).models.length,0);
});

test('reads started before and during save cannot overwrite the committed snapshot or strand loading',async()=>{
  const before=deferred(),during=deferred(),write=deferred();let reads=0;globalThis.__modelsTest.get=()=>++reads===1?before.promise:during.promise;
  const earlier=store.getState().fetch();const draft=catalog();draft.providers[0].name='新保存';store.getState().setDraft(draft);globalThis.__modelsTest.put=()=>write.promise;const save=store.getState().save(draft);const later=store.getState().fetch();
  write.resolve({data:{...draft,revision:2}});await save;before.resolve({data:catalog()});during.resolve({data:catalog()});await Promise.all([earlier,later]);
  assert.equal(store.getState().catalog.revision,2);assert.equal(store.getState().draft.providers[0].name,'新保存');assert.equal(store.getState().dirty,false);assert.equal(store.getState().loading,false);
});
test('catalog conflict read during save preserves both frozen draft and fetched revision until explicit merge',async()=>{
  const write=deferred();globalThis.__modelsTest.put=()=>write.promise;const draft=catalog();draft.models[0].name='本地模型';store.getState().setDraft(draft);const save=store.getState().save(draft);
  const remote=catalog(3);remote.providers[0].name='远端服务';globalThis.__modelsTest.get=async()=>({data:remote});await store.getState().fetch();assert.equal(store.getState().draft.models[0].name,'本地模型');assert.equal(store.getState().draft.revision,1);
  write.reject(failure(409,{error:'配置已更新'}));await assert.rejects(save);assert.equal(store.getState().catalog.revision,3);assert.equal(store.getState().draft.revision,1);assert.equal(store.getState().saving,false);assert.equal(store.getState().conflict,true);
  await store.getState().rebaseDraft();assert.equal(store.getState().draft.providers[0].name,'远端服务');assert.equal(store.getState().draft.models[0].name,'本地模型');
});
test('definitive not-sent receipt allows a deliberate new intent while unknown never does',async()=>{
  const writes=[];globalThis.__modelsTest.post=async(_,body)=>{writes.push(body);return {data:receipt(body.clientRequestId,{status:'failed',healthy:false,possibleCharge:false,code:'PROBE_NOT_SENT'})}};
  await store.getState().test('model-a','chat');await store.getState().test('model-a','chat');assert.equal(writes.length,2);assert.notEqual(writes[0].clientRequestId,writes[1].clientRequestId);
});

test('confirmed 404 permits only explicit frozen same-ID resubmission with original revision and account',async()=>{
  const calls=[];globalThis.__modelsTest.post=async(...args)=>{calls.push(args);throw new Error('timeout')};await store.getState().test('model-a','chat');
  const original=calls[0];await store.getState().resubmitProbe('model-a:chat');assert.equal(calls.length,1);
  globalThis.__modelsTest.get=async path=>{if(path.includes('/tests/'))throw failure(404,{error:'not found'});return{data:catalog()}};await store.getState().queryProbe('model-a:chat');assert.equal(calls.length,1);assert.equal(store.getState().probes['model-a:chat'].notFound,true);
  const pending=deferred();globalThis.__modelsTest.post=(...args)=>{calls.push(args);return pending.promise};const work=store.getState().resubmitProbe('model-a:chat');await store.getState().resubmitProbe('model-a:chat');assert.equal(calls.length,2);assert.deepEqual(calls[1][1],original[1]);assert.equal(calls[1][1].expectedRevision,1);assert.deepEqual(calls[1][2].headers,original[2].headers);
  pending.resolve({data:receipt(original[1].clientRequestId)});await work;assert.equal(store.getState().probes['model-a:chat'].status,'succeeded');
});
test('404 resubmission is barred for changed revision, unsaved edits, or a different account',async()=>{
  let calls=0;globalThis.__modelsTest.post=async()=>{calls++;throw new Error('timeout')};await store.getState().test('model-a','chat');
  globalThis.__modelsTest.get=async path=>{if(path.includes('/tests/'))throw failure(404,{error:'not found'});return{data:catalog()}};await store.getState().queryProbe('model-a:chat');
  store.getState().setDraft({...catalog(),defaults:{...catalog().defaults,chat:'model-a'}});await store.getState().resubmitProbe('model-a:chat');assert.equal(calls,1);store.getState().discardDraft();
  globalThis.__modelsTest.user='bob';await store.getState().resubmitProbe('model-a:chat');assert.equal(calls,1);globalThis.__modelsTest.user='alice';
  globalThis.__modelsTest.get=async()=>({data:catalog(2)});await store.getState().fetch();await store.getState().resubmitProbe('model-a:chat');assert.equal(calls,1);
});

test('a fresh authoritative same-revision verification from another tab supersedes this tab failed receipt',async()=>{
  const revoked=catalog();revoked.models[0].verifiedCapabilities=[];globalThis.__modelsTest.get=async()=>({data:revoked});globalThis.__modelsTest.post=async(_,body)=>{throw failure(502,receipt(body.clientRequestId,{status:'failed',healthy:false,error:'测试失败'}))};await store.getState().test('model-a','chat');assert.deepEqual(store.getState().catalog.models[0].verifiedCapabilities,[]);
  globalThis.__modelsTest.get=async()=>({data:catalog()});await store.getState().fetch();assert.deepEqual(store.getState().catalog.models[0].verifiedCapabilities,['chat']);assert.equal(store.getState().probes['model-a:chat'].status,'failed');
});
