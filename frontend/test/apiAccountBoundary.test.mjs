import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { resolve } from 'node:path';
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage });
after(() => window.close());
globalThis.__apiAccount = 'alice';
const root = resolve(import.meta.dirname, '..');
const result = await build({ stdin: { contents: `export { axiosInstance, onAuthExpired, api, confirmAuthIdentity } from './src/services/api'; export { default as axios } from 'axios';`, resolveDir:root, loader:'ts' }, bundle:true, format:'esm', platform:'browser', write:false, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_AUTH_MODE': '"session"' }, plugins:[{name:'api-runtime-fixture',setup(build){
  build.onResolve({filter:/utils\/cacheUtils$/},()=>({path:'cache',namespace:'mock'}));
  build.onResolve({filter:/\.\/runtimeConfig$/},()=>({path:'runtime',namespace:'mock'}));
  build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='cache'?'export const getCacheUserId = () => globalThis.__apiAccount;':`export const getApiBaseUrl = () => '/api'; export const getApiBaseUrlCandidates = () => ['/api','http://fallback.test/api']; export const rememberBackendOrigin = () => {};`}));
}}]});
const { axiosInstance, axios, onAuthExpired, api, confirmAuthIdentity } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const response = (config, data) => ({config,data,status:200,statusText:'OK',headers:{}});
test('account identity is frozen before CSRF wait; superseded request cannot log out the new account', async () => {
  let resolveCsrf, sent;
  axios.defaults.adapter = config => new Promise(resolve => { resolveCsrf = () => resolve(response(config,{csrfToken:'synthetic-csrf'})); });
  axiosInstance.defaults.adapter = async config => { sent = config; throw Object.assign(new Error('changed'), {config,response:{status:409,data:{code:'ACCOUNT_CHANGED'}}}); };
  const events = []; const off = onAuthExpired(reason => events.push(reason));
  const pending = axiosInstance.post('/tasks',{prompt:'alice-private-input'});
  await new Promise(resolve => setTimeout(resolve,0));
  globalThis.__apiAccount = 'bob'; resolveCsrf();
  await assert.rejects(pending,error => error.code==='ACCOUNT_CHANGED');
  assert.equal(sent.headers['X-Expected-User-Id'],'alice');
  assert.deepEqual(events,[]); off();
});
test('read fallback advances once rather than resetting to the failed origin', async () => {
  const origins = [];
  axiosInstance.defaults.adapter = async config => { origins.push(config.baseURL); if(origins.length===1) throw Object.assign(new Error('network'),{config,code:'ERR_NETWORK'}); return response(config,[]); };
  await axiosInstance.get('/tasks');
  assert.deepEqual(origins,['/api','http://fallback.test/api']);
});

test('deliberate login binds bootstrap to newly authenticated identity instead of expired cache', async () => {
  globalThis.__apiAccount = 'alice'; document.cookie = 'XSRF-TOKEN=synthetic-csrf';
  const sent = [];
  axiosInstance.defaults.adapter = async config => { sent.push(config); return response(config,{ user:{id:'bob'} }); };
  await api.loginPhone('13800000000','synthetic-password'); await api.getBootstrap();
  assert.equal(sent[0].headers['X-Expected-User-Id'],undefined);
  assert.equal(sent[1].headers['X-Expected-User-Id'],'bob');
});

test('current stale tab receives reauthentication signal when shared cookie changes account', async () => {
  globalThis.__apiAccount = 'bob';
  const events = []; const off = onAuthExpired(reason => events.push(reason));
  axiosInstance.defaults.adapter = async config => { throw Object.assign(new Error('changed'), {config,response:{status:409,data:{code:'ACCOUNT_CHANGED'}}}); };
  await assert.rejects(axiosInstance.get('/tasks'), error => error.code==='ACCOUNT_CHANGED');
  assert.deepEqual(events,['account_changed']); off();
});

test('a successful old-account response is rejected before any store can consume it', async () => {
  globalThis.__apiAccount = 'alice';
  let finish;
  axiosInstance.defaults.adapter = config => new Promise(resolve => { finish = () => resolve(response(config,{nickname:'private-alice'})); });
  const pending = axiosInstance.get('/user/profile'); await new Promise(resolve => setTimeout(resolve,0));
  globalThis.__apiAccount = 'bob'; finish();
  await assert.rejects(pending,error => error.code==='STALE_ACCOUNT_RESPONSE');
});


test('A-B-A session generations reject old success, auth errors and retryable failures before side effects', async () => {
  for (const status of [200,401,409,503]) {
    globalThis.__apiAccount='alice';confirmAuthIdentity('alice');document.cookie='XSRF-TOKEN=synthetic-csrf';
    let finish;let calls=0;const events=[];const off=onAuthExpired(reason=>events.push(reason));
    axiosInstance.defaults.adapter=config=>{calls++;return new Promise((resolve,reject)=>{finish=()=>status===200?resolve(response(config,{private:'old-session'})):reject(Object.assign(new Error('old'),{config,response:{status,data:{code:status===409?'ACCOUNT_CHANGED':'OLD_ERROR',error:'obsolete'}}}));});};
    const pending=axiosInstance.get('/profile');await new Promise(resolve=>setTimeout(resolve,0));
    globalThis.__apiAccount='bob';confirmAuthIdentity('bob');globalThis.__apiAccount='alice';confirmAuthIdentity('alice');finish();
    await assert.rejects(pending,error=>error.code==='STALE_ACCOUNT_RESPONSE');assert.equal(calls,1);assert.deepEqual(events,[]);off();
  }
});
test('session replacement while obtaining CSRF cancels old write before transport', async () => {
  globalThis.__apiAccount='alice';confirmAuthIdentity('alice');
  Object.defineProperty(document,'cookie',{configurable:true,get:()=>'',set:()=>{}});
  let finishCsrf;let calls=0;axios.defaults.adapter=config=>new Promise(resolve=>{finishCsrf=()=>resolve(response(config,{csrfToken:'synthetic-new-session'}));});
  axiosInstance.defaults.adapter=async config=>{calls++;return response(config,{});};
  const pending=axiosInstance.post('/memory/store',{content:'old-session-input'});await new Promise(resolve=>setTimeout(resolve,0));
  confirmAuthIdentity(null);confirmAuthIdentity('alice');finishCsrf();await assert.rejects(pending,error=>error.code==='STALE_ACCOUNT_RESPONSE');assert.equal(calls,0);delete document.cookie;
});

test('request identity is captured at API invocation, before the async interceptor microtask', async () => {
  globalThis.__apiAccount='alice';confirmAuthIdentity('alice');document.cookie='XSRF-TOKEN=synthetic-csrf';
  let calls=0;axiosInstance.defaults.adapter=async config=>{calls++;return response(config,{ok:true});};
  const pending=axiosInstance.post('/memory/store',{content:'alice-only-calltime-input'});
  globalThis.__apiAccount='bob';confirmAuthIdentity('bob');
  await assert.rejects(pending,error=>error.code==='STALE_ACCOUNT_RESPONSE');assert.equal(calls,0);
});

test('all Axios request entry forms preserve call-time identity and explicit headers', async () => {
  const calls = [
    () => axiosInstance.get('/profile'), () => axiosInstance.delete('/tasks/id'),
    () => axiosInstance.put('/profile',{nickname:'alice'}), () => axiosInstance.patch('/tasks/id',{title:'alice'}),
    () => axiosInstance.request({url:'/profile',method:'get'}), () => axiosInstance.request('/profile',{method:'get'}),
    () => axiosInstance({url:'/profile',method:'get'}), () => axiosInstance('/profile',{method:'get'}),
  ];
  for(const call of calls){
    globalThis.__apiAccount='alice';confirmAuthIdentity('alice');let sent=0;
    axiosInstance.defaults.adapter=async config=>{sent++;return response(config,{});};const pending=call();
    globalThis.__apiAccount='bob';confirmAuthIdentity('bob');await assert.rejects(pending,error=>error.code==='STALE_ACCOUNT_RESPONSE');assert.equal(sent,0);
  }
  globalThis.__apiAccount='alice';confirmAuthIdentity('alice');const headers=new axios.AxiosHeaders({'X-Expected-User-Id':'alice'});let expected;
  axiosInstance.defaults.adapter=async config=>{expected=config.headers['X-Expected-User-Id'];return response(config,{});};const pending=axiosInstance.get('/profile',{headers});headers.set('X-Expected-User-Id','bob');await pending;assert.equal(expected,'alice');
});

test('explicit account guards are case-insensitive and cannot be overwritten by the current account',async()=>{
 globalThis.__apiAccount='bob';confirmAuthIdentity('bob');let sent;
 axiosInstance.defaults.adapter=async config=>{sent=config.headers.get('x-expected-user-id');return response(config,{private:'unexpected-user'});};
 await assert.rejects(axiosInstance.get('/profile',{headers:{'x-expected-user-id':'alice'}}),error=>error.code==='STALE_ACCOUNT_RESPONSE');assert.equal(sent,'alice');
});
