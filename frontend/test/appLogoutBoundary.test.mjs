import test, {after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
const root=resolve(import.meta.dirname,'..');const window=new Window({url:'http://localhost/'});
Object.assign(globalThis,{window,document:window.document,localStorage:window.localStorage});after(()=>window.close());
const app=await readFile(resolve(root,'src/App.tsx'),'utf8');
// Exercise the production logout orchestration itself; render-only App imports
// are omitted. The HTTP interceptor is real and stores/storage are test doubles.
const start=app.indexOf('async function handleLogout('),end=app.indexOf('\nfunction App()',start);
assert.ok(start>=0&&end>start);const logout=app.slice(start,end).replace('async function handleLogout','export async function handleLogout');
const expiredStart=app.indexOf('const unsubscribe = onAuthExpired(async () => {');
const expiredEnd=app.indexOf('\n    });',expiredStart);assert.ok(expiredStart>=0&&expiredEnd>expiredStart);
const expired=app.slice(expiredStart,expiredEnd).replace('const unsubscribe = onAuthExpired(async () => {','export async function handleExpired() {')+'\n}';
const bundled=await build({stdin:{contents:`
import {api,axiosInstance,confirmAuthIdentity,getAuthGeneration} from './src/services/api';
export {axiosInstance,confirmAuthIdentity};
const state=()=>globalThis.__logout;
const getCacheUserId=()=>state().user;const setCacheUserId=user=>{state().user=user;};
const store=name=>({getState:()=>({cleanup:()=>{state().cleared.push(name);},clearAll:()=>{},clearAllTypingTimeouts:()=>{}}),setState:value=>{state().stores[name]=value;}});
const useAudioStore=store('audio'),useProfileStore=store('profile'),useTasksStore=store('tasks'),useModelsStore=store('models'),usePersonasStore=store('personas'),useUIStore=store('ui'),useGroupsStore=store('groups'),useMessagesStore=store('messages'),useAgentsStore=store('agents');
const clearDiagnostics=()=>{},destroyWebSocket=()=>{},stopPersonasAutoRefresh=()=>{},clearMemoryApiConfigs=()=>{},clearPersistedSessionInfo=()=>{},resetMessagesModuleState=()=>{};
const clearAllCachesForUser=user=>state().cacheUsers.push(user);const setIndexedDBUserId=user=>{state().indexedUser=user;};
const clearAllIndexedDBForUser=user=>{state().dbUsers.push(user);return state().cleanupPromise;};const purgeLegacyPrivateCaches=()=>state().cleanupPromise;
const wsConnectedRef={get current(){return state().wsConnected;},set current(v){state().wsConnected=v;}};
const dataInitializedRef={get current(){return state().initialized;},set current(v){state().initialized=v;}};
const setIsAuthenticated=v=>{state().authenticated=v;};const setAppPhase=v=>{state().phase=v;};
${logout}\n${expired}
`,resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'browser',write:false,define:{'import.meta.env.DEV':'false','import.meta.env.VITE_AUTH_MODE':'"session"'},plugins:[{name:'logout-fixture',setup(build){
 build.onResolve({filter:/utils\/cacheUtils$/},()=>({path:'cache',namespace:'fixture'}));build.onResolve({filter:/\.\/runtimeConfig$/},()=>({path:'runtime',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:path==='cache'?'export const getCacheUserId=()=>globalThis.__logout.user;':`export const getApiBaseUrl=()=>'/api';export const getApiBaseUrlCandidates=()=>['/api'];export const rememberBackendOrigin=()=>{};`}));
}}]});
const {handleLogout,handleExpired,axiosInstance,confirmAuthIdentity}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{globalThis.__logout={user:'alice',cleared:[],stores:{},cacheUsers:[],dbUsers:[],cleanupPromise:null};confirmAuthIdentity('alice');document.cookie='XSRF-TOKEN=synthetic-csrf';});

test('expiry clears local identity synchronously and never sends a cookie-clearing server logout',async()=>{
 let clean;let requests=0;globalThis.__logout.cleanupPromise=new Promise(resolve=>{clean=resolve;});
 axiosInstance.defaults.adapter=async()=>{requests++;throw new Error('expiry must not send logout');};
 const pending=handleLogout();assert.equal(globalThis.__logout.user,null);assert.equal(globalThis.__logout.indexedUser,null);assert.deepEqual(globalThis.__logout.cleared,['profile','tasks','models','personas']);await flush();
 assert.equal(requests,0);globalThis.__logout.user='bob';confirmAuthIdentity('bob');globalThis.__logout.stores.groups={newSession:true};
 clean();assert.equal(await pending,false);assert.equal(globalThis.__logout.user,'bob');assert.deepEqual(globalThis.__logout.stores.groups,{newSession:true});assert.deepEqual(globalThis.__logout.dbUsers,['alice']);
});
test('same-account re-login also prevents a late cleanup from applying logout UI state',async()=>{
 let clean;globalThis.__logout.cleanupPromise=new Promise(resolve=>{clean=resolve;});let calls=0;axiosInstance.defaults.adapter=async()=>{calls++;throw new Error('unexpected');};
 const pending=handleLogout();globalThis.__logout.user='alice';confirmAuthIdentity('alice');globalThis.__logout.stores.profile={nickname:'new-session'};clean();assert.equal(await pending,false);assert.equal(calls,0);assert.deepEqual(globalThis.__logout.stores.profile,{nickname:'new-session'});
});
test('ordinary completed local logout reports that its UI transition is still current',async()=>{
 globalThis.__logout.cleanupPromise=Promise.resolve();assert.equal(await handleLogout(),true);assert.equal(globalThis.__logout.user,null);
});

test('expiry releases connection flags immediately and cannot reset the newer connection after cleanup',async()=>{
 let clean;globalThis.__logout.cleanupPromise=new Promise(resolve=>{clean=resolve;});Object.assign(globalThis.__logout,{wsConnected:true,initialized:true,authenticated:true,phase:'app'});
 const pending=handleExpired();assert.equal(globalThis.__logout.wsConnected,false);assert.equal(globalThis.__logout.initialized,false);assert.equal(globalThis.__logout.phase,'auth');
 globalThis.__logout.user='bob';confirmAuthIdentity('bob');Object.assign(globalThis.__logout,{wsConnected:true,initialized:true,authenticated:true,phase:'app'});clean();await pending;
 assert.equal(globalThis.__logout.wsConnected,true);assert.equal(globalThis.__logout.initialized,true);assert.equal(globalThis.__logout.authenticated,true);assert.equal(globalThis.__logout.phase,'app');
});
