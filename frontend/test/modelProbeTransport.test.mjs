import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { resolve } from 'node:path';
const window = new Window({url:'http://localhost/'});
Object.assign(globalThis,{window,document:window.document,localStorage:window.localStorage});
after(()=>window.close());
globalThis.__probeAccount='alice';
const root=resolve(import.meta.dirname,'..');
const built=await build({stdin:{contents:`export {axiosInstance, onAuthExpired} from './src/services/api'; export {useModelsStore} from './src/stores/modelsStore';`,resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'browser',write:false,define:{'import.meta.env.DEV':'false','import.meta.env.VITE_AUTH_MODE':'"session"'},plugins:[{name:'probe-transport-fixture',setup(build){
  build.onResolve({filter:/utils\/cacheUtils$/},()=>({path:'cache',namespace:'mock'}));
  build.onResolve({filter:/^\.\/runtimeConfig$/},()=>({path:'runtime',namespace:'mock'}));
  build.onResolve({filter:/^\.\/personasStore$/},()=>({path:'personas',namespace:'mock'}));
  build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='cache'?'export const getCacheUserId=()=>globalThis.__probeAccount;':path==='personas'?'export const usePersonasStore={getState:()=>({fetchPersonas:async()=>{}})};':`export const getApiBaseUrl=()=>'/api';export const getApiBaseUrlCandidates=()=>['/api'];export const rememberBackendOrigin=()=>{};`}));
}}]});
const {axiosInstance,onAuthExpired,useModelsStore:store}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
function catalog(){return{revision:4,providers:[{id:'p',name:'测试服务',protocol:'openai',baseUrl:'https://example.test/v1',enabled:true,keyRequired:false,ready:true}],models:[{id:'m',providerId:'p',name:'测试模型',model:'example',enabled:true,capabilities:['chat'],verifiedCapabilities:[],ready:true,contextWindow:32000,maxTokens:4096,temperature:null,tokenParameter:'max_tokens',color:'#6366f1'}],defaults:{chat:null,vision:null,tts:null}}}
function reply(config,status,data){const response={config,status,data,headers:{},statusText:String(status)};return !config.validateStatus||config.validateStatus(status)?Promise.resolve(response):Promise.reject(Object.assign(new Error('adapter rejection'),{config,response}));}
const receipt=(id,patch={})=>({requestId:id,modelId:'m',capability:'chat',status:'failed',healthy:false,stale:false,possibleCharge:true,replayed:false,code:'PROBE_FAILED',error:'raw upstream secret must never enter state',apiKey:'never-retain',providerResponse:{secret:'never-retain'},...patch});
beforeEach(async()=>{store.getState().cleanup();globalThis.__probeAccount='alice';document.cookie='XSRF-TOKEN=synthetic';axiosInstance.defaults.adapter=config=>reply(config,200,catalog());await store.getState().fetch()});

test('real Axios error interceptor retains only safe failed probe receipt and one POST',async()=>{
  const posts=[];axiosInstance.defaults.adapter=config=>{if(config.method==='post'){const body=JSON.parse(config.data);posts.push(body);return reply(config,502,receipt(body.clientRequestId))}return reply(config,200,catalog())};
  await store.getState().test('m','chat');const result=store.getState().probes['m:chat'];assert.equal(result.status,'failed');assert.equal(result.code,'PROBE_FAILED');assert.match(result.error,/本次能力测试未通过/);assert.equal(result.apiKey,undefined);assert.doesNotMatch(JSON.stringify(result),/raw upstream|never-retain/);assert.equal(posts.length,1);assert.equal(posts[0].expectedRevision,4);
});
test('real interceptor preserves known 409 configuration-change rejection without admitting new work',async()=>{
  axiosInstance.defaults.adapter=config=>config.method==='post'?reply(config,409,receipt(JSON.parse(config.data).clientRequestId,{code:'PROBE_CONFIG_CHANGED',stale:true,possibleCharge:false})):reply(config,200,catalog());
  await store.getState().test('m','chat');const result=store.getState().probes['m:chat'];assert.equal(result.status,'failed');assert.equal(result.stale,true);assert.equal(result.possibleCharge,false);assert.equal(result.code,'PROBE_CONFIG_CHANGED');
});
test('real 404 stays unknown and explicit same-ID replay includes frozen revision',async()=>{
  const posts=[];let attempt=0;axiosInstance.defaults.adapter=config=>{if(config.method==='post'){posts.push(JSON.parse(config.data));if(++attempt===1)return Promise.reject(Object.assign(new Error('lost'),{config,code:'ERR_NETWORK'}));return reply(config,200,receipt(posts[0].clientRequestId,{status:'succeeded',healthy:true,code:undefined}))}if(config.url.includes('/tests/'))return reply(config,404,{error:'未找到测试请求'});return reply(config,200,catalog())};
  await store.getState().test('m','chat');await store.getState().queryProbe('m:chat');assert.equal(store.getState().probes['m:chat'].status,'unknown');assert.equal(store.getState().probes['m:chat'].notFound,true);assert.equal(posts.length,1);await store.getState().resubmitProbe('m:chat');assert.equal(posts.length,2);assert.deepEqual(posts[0],posts[1]);assert.equal(store.getState().probes['m:chat'].status,'succeeded');
});
test('receipt preservation is limited to exact probe paths and strips raw upstream fields from errors',async()=>{
  const id='11111111-1111-4111-8111-111111111111';axiosInstance.defaults.adapter=config=>reply(config,502,receipt(id));
  await assert.rejects(axiosInstance.post('/user/model-catalog/test',{}),error=>{assert.equal(error.status,502);assert.equal(error.response,undefined);assert.equal(error.probeReceipt.requestId,id);assert.doesNotMatch(error.message,/raw upstream/);assert.doesNotMatch(JSON.stringify(error),/never-retain/);return true});
  await assert.rejects(axiosInstance.post('/user/model-catalog/test-extra',{}),error=>{assert.equal(error.probeReceipt,undefined);return true});
});
test('real ACCOUNT_CHANGED still reaches original identity handler and clears account-scoped probe state',async()=>{
  const events=[];const off=onAuthExpired(reason=>{events.push(reason);store.getState().cleanup()});
  axiosInstance.defaults.adapter=config=>reply(config,409,{code:'ACCOUNT_CHANGED',error:'登录账号已变化'});
  await store.getState().test('m','chat');assert.deepEqual(events,['account_changed']);assert.deepEqual(store.getState().probes,{});assert.equal(store.getState().catalog,null);off();
});
test('successful probe receipt arriving after account switch is rejected before any store consumes it',async()=>{
  let finish;axiosInstance.defaults.adapter=config=>new Promise(resolve=>{finish=()=>resolve({config,status:200,headers:{},data:receipt(JSON.parse(config.data).clientRequestId,{status:'succeeded',healthy:true})})});
  const pending=store.getState().test('m','chat');await new Promise(resolve=>setTimeout(resolve,0));store.getState().cleanup();globalThis.__probeAccount='bob';finish();await pending;assert.deepEqual(store.getState().probes,{});assert.equal(store.getState().catalog,null);
});

test('structured GET status error also survives the real interceptor without another paid POST',async()=>{
  let posts=0;axiosInstance.defaults.adapter=config=>{if(config.method==='post'){posts++;return Promise.reject(Object.assign(new Error('lost'),{config,code:'ERR_NETWORK'}))}if(config.url.includes('/tests/'))return reply(config,409,receipt(config.url.split('/').at(-1),{code:'PROBE_STALE',stale:true}));return reply(config,200,catalog())};
  await store.getState().test('m','chat');await store.getState().queryProbe('m:chat');assert.equal(posts,1);assert.equal(store.getState().probes['m:chat'].status,'failed');assert.equal(store.getState().probes['m:chat'].stale,true);assert.doesNotMatch(JSON.stringify(store.getState().probes),/raw upstream|never-retain/);
});
