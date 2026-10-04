import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');globalThis.__cacheClear={user:'alice',indexed:true,local:[],deleted:[]};
const bundled=await build({entryPoints:[resolve(root,'src/utils/privateCache.ts')],bundle:true,format:'esm',platform:'browser',write:false,plugins:[{name:'cache-clear-fixture',setup(build){
 build.onResolve({filter:/\.\/cacheUtils$/},()=>({path:'cache',namespace:'mock'}));build.onResolve({filter:/\.\/indexedDB$/},()=>({path:'indexed',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='cache'?`export const getCacheUserId=()=>globalThis.__cacheClear.user;export const clearAllCachesForUser=id=>{globalThis.__cacheClear.local.push(id);return globalThis.__cacheClear.localSuccess!==false;};`:`export const clearAllIndexedDBForUser=async id=>{globalThis.__cacheClear.target=id;return globalThis.__cacheClear.indexed;};`}));
}}]});
const {clearCurrentUserCache,purgeLegacyPrivateCaches}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
beforeEach(()=>{globalThis.__cacheClear={user:'alice',indexed:true,local:[],deleted:[]};globalThis.caches={delete:async name=>{globalThis.__cacheClear.deleted.push(name);return false;}};});
test('absence of a legacy cache is verified success and cleanup targets the captured user',async()=>{await clearCurrentUserCache();assert.equal(globalThis.__cacheClear.target,'alice');assert.deepEqual(globalThis.__cacheClear.local,['alice']);assert.deepEqual(globalThis.__cacheClear.deleted,['tts-audio-cache','file-download-cache']);});
test('blocked or failed IndexedDB deletion cannot be reported as successful cache cleanup',async()=>{globalThis.__cacheClear.indexed=false;await assert.rejects(clearCurrentUserCache(),error=>error.code==='CACHE_CLEAR_INCOMPLETE');});
test('missing or rejected CacheStorage cleanup stays explicitly incomplete',async()=>{delete globalThis.caches;assert.equal(await purgeLegacyPrivateCaches(),false);await assert.rejects(clearCurrentUserCache(),error=>error.code==='CACHE_CLEAR_INCOMPLETE');globalThis.caches={delete:async()=>{throw new Error('private-browser-error');}};await assert.rejects(clearCurrentUserCache(),error=>error.code==='CACHE_CLEAR_INCOMPLETE'&&!error.message.includes('private-browser-error'));});

test('localStorage cleanup failure also prevents success',async()=>{globalThis.__cacheClear.localSuccess=false;await assert.rejects(clearCurrentUserCache(),error=>error.code==='CACHE_CLEAR_INCOMPLETE');});
