import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const bundled = await build({entryPoints:[resolve(root,'src/utils/cacheUtils.ts')],bundle:true,format:'esm',platform:'browser',write:false,define:{'import.meta.env.DEV':'false'}});
const {clearAllCachesForUser,setCacheUserId,loadMessagesCacheAsync} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
function storage(behavior = 'normal') {
  const values = new Map([['app_cache_alice_messages', 'synthetic private cache'], ['app_cache_bob_messages', 'other synthetic cache']]);
  return { values, get length() { if(behavior==='unavailable')throw Error('private-storage-error');return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, removeItem(key) { if(behavior==='throw')throw Error('private-storage-error');if(behavior!=='silent')values.delete(key); } };
}
test('localStorage cleanup verifies absence and never touches another account prefix',()=>{
  globalThis.localStorage=storage(); assert.equal(clearAllCachesForUser('alice'),true);
  assert.equal(localStorage.values.has('app_cache_alice_messages'),false);assert.equal(localStorage.values.has('app_cache_bob_messages'),true);
});
test('thrown, silent and unavailable localStorage cleanup all remain incomplete without raw logs',()=>{
  const logs=[];const warn=console.warn;console.warn=(...values)=>logs.push(values);
  try {for(const failure of ['throw','silent','unavailable']) {globalThis.localStorage=storage(failure);assert.equal(clearAllCachesForUser('alice'),false);assert.equal(localStorage.values.has('app_cache_alice_messages'),true);}}
  finally {console.warn=warn;}
  assert.equal(JSON.stringify(logs).includes('private-storage-error'),false);
});

test('ownerless legacy history is never assigned to a newly signed-in account',async()=>{
  const values=new Map();globalThis.localStorage={get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const legacy=JSON.stringify({version:'1.0',timestamp:Date.now(),data:{group:[{id:'private-draft',content:'synthetic previous-owner draft',status:'failed'}]}});
  localStorage.setItem('app_cache_messages_cache',legacy);
  setCacheUserId('new-account');
  assert.equal(await loadMessagesCacheAsync(),null);
  assert.equal(localStorage.getItem('app_cache_new-account_messages_cache'),null);
  assert.equal(localStorage.getItem('app_cache_messages_cache'),legacy);
  setCacheUserId(null);
});
