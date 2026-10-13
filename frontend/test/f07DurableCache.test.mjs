import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SyntheticIndexedDB } from './fixtures/f07SyntheticStorage.mjs';
import { createLegacyEncryptedDraft } from './fixtures/f07LegacyEncryptedDraft.mjs';
const compiled = await build({ entryPoints:[resolve(import.meta.dirname,'../src/utils/crypto.ts')], bundle:true,write:false,format:'esm',platform:'browser',define:{'import.meta.env.DEV':'false'} });
const compiledAll = await build({stdin:{resolveDir:resolve(import.meta.dirname,'..'),loader:'ts',contents:`
export * from './src/utils/crypto';export * from './src/utils/cacheUtils';export * from './src/utils/indexedDB';
`},bundle:true,write:false,format:'esm',platform:'browser',define:{'import.meta.env.DEV':'false'}});
let nonce = 0;
const originalWarn=console.warn;console.warn=(message)=>originalWarn(String(message));
after(()=>{console.warn=originalWarn;});
async function setup(bundle = compiled) {
  const idb = new SyntheticIndexedDB(); globalThis.indexedDB = idb;
  globalThis.window = { crypto: webcrypto };
  const values = new Map(); globalThis.localStorage = { getItem:key=>values.get(key)||null, setItem:(key,value)=>values.set(key,value), removeItem:key=>values.delete(key) };
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + `\n// ${++nonce}`).toString('base64')}`);
  return {api,idb,values};
}
afterEach(()=>{ delete globalThis.window; delete globalThis.indexedDB; delete globalThis.localStorage; });
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
test('real WebCrypto + synthetic IDB: decryption without an existing key never creates replacement key material',async()=>{
 const {api,idb}=await setup();api.setCryptoUserId('alice');
 assert.equal(await api.decryptData(JSON.stringify({iv:Array(12).fill(0),data:[1,2,3]})),null);
 assert.equal(idb.writes.length,0,'read-only decryption must not create master or wrapping keys');
});
test('real WebCrypto + synthetic IDB: delayed A key access is obsolete across A to B to A',async()=>{
 const {api,idb}=await setup();api.setCryptoUserId('alice');idb.holdOpen('ai-chat-crypto-alice');
 const old=api.encryptData('obsolete A private draft');await tick();api.setCryptoUserId('bob');
 const bob=await api.encryptData('B private draft');assert.ok(bob);
 api.setCryptoUserId('alice');idb.releaseOpen('ai-chat-crypto-alice');
 assert.equal(await old,null,'A -> B -> A cannot revive an old key operation');
 const fresh=await api.encryptData('fresh A private draft');assert.equal(await api.decryptData(fresh),'fresh A private draft');
 api.setCryptoUserId('bob');assert.equal(await api.decryptData(bob),'B private draft');
});
test('real WebCrypto + synthetic IDB: first concurrent encryption uses one committed key without rewriting existing bytes',async()=>{
 const {api,idb}=await setup();api.setCryptoUserId('alice');
 const [a,b]=await Promise.all([api.encryptData('first'),api.encryptData('second')]);assert.ok(a&&b);
 api.setCryptoUserId('bob');api.setCryptoUserId('alice');
 assert.equal(await api.decryptData(a),'first');assert.equal(await api.decryptData(b),'second');
 const writes=idb.writes.length;const again=await api.encryptData('third');assert.equal(await api.decryptData(again),'third');
 assert.equal(idb.writes.length,writes,'normal subsequent encrypt/decrypt does not replace stored key bytes');
});


test('real WebCrypto + synthetic committed storage: global legacy key bytes remain readable under owner-fenced cache namespaces',async()=>{
 const {api,idb,values}=await setup(compiledAll);
 // Before owner binding, the original application wrote the global key DB.
 const payload=JSON.stringify({data:'旧账号原草稿',timestamp:Date.now(),version:'1.0'});
 const oldCiphertext=await api.encryptData(payload);assert.ok(oldCiphertext);
 const keys=idb.data.get('ai-chat-crypto').get('encryption_keys');
 const prior=JSON.stringify([...keys].map(([key,value])=>[key,[...new Uint8Array(value)]]));
 values.set('app_cache_alice_message_draft_alice_room',`enc_v1_${oldCiphertext}`);
 api.setCacheUserId('alice');assert.equal(await api.loadCacheAsync('message_draft_alice_room'),'旧账号原草稿');
 const receipt=await api.saveCacheWithDurability('message_draft_alice_other','new draft');assert.deepEqual(receipt,{durable:true});
 assert.ok(JSON.stringify([...keys].map(([key,value])=>[key,[...new Uint8Array(value)]]))===prior,'existing random key records remain byte-for-byte unchanged');
 assert.ok(values.get('app_cache_alice_message_draft_alice_room')===`enc_v1_${oldCiphertext}`,'existing random ciphertext remains byte-for-byte unchanged');
 assert.deepEqual([...idb.data.keys()],['ai-chat-crypto'],'cache owner binding does not introduce or migrate per-owner key databases');
 api.setCacheUserId('bob');assert.equal(await api.loadCacheAsync('message_draft_alice_room'),null);
 assert.equal(await api.decryptDataWithPersistedKey(oldCiphertext,'alice'),null,'a proof cannot claim an inactive owner');
 api.setCacheUserId('alice');assert.equal(await api.loadCacheAsync('message_draft_alice_room'),'旧账号原草稿');
});
test('real WebCrypto + synthetic IDB: cold proof does not trust memoryKey when persisted key records are unavailable',async()=>{
 const {api,idb}=await setup(compiledAll);api.setCacheUserId('alice');
 assert.deepEqual(await api.saveCacheWithDurability('draft','first'),{durable:true});
 const keys=idb.data.get('ai-chat-crypto').get('encryption_keys');keys.delete('master_key');const writes=idb.writes.length;
 const receipt=await api.saveCacheWithDurability('draft','retain in memory');assert.equal(receipt.durable,false);
 assert.equal(api.loadCache('draft'),'retain in memory');assert.equal(idb.writes.length,writes,'proof never recreates a missing key');
});
test('real WebCrypto + synthetic IDB: failed key access preserves existing ciphertext bytes without replacement generation',async()=>{
 const {api,idb,values}=await setup(compiledAll);api.setCacheUserId('alice');
 const raw='enc_v1_'+JSON.stringify({iv:Array(12).fill(0),data:[1,2,3]});values.set('app_cache_alice_draft',raw);
 assert.equal(await api.loadCacheAsync('draft'),null);assert.ok(values.get('app_cache_alice_draft')===raw,'protected ciphertext remains unchanged');assert.equal(idb.writes.length,0);
});
test('real WebCrypto + synthetic IDB: old owner cold decrypt cannot populate a newer cache after A to B to A',async()=>{
 const {api,idb,values}=await setup(compiledAll);api.setCacheUserId('alice');
 await api.saveCacheWithDurability('draft','old private A');const raw=values.get('app_cache_alice_draft');
 api.setCacheUserId('bob');api.setCacheUserId('alice');idb.holdOpen('ai-chat-crypto');
 const oldRead=api.loadCacheAsync('draft');await tick();api.setCacheUserId('bob');api.setCacheUserId('alice');
 idb.releaseOpen('ai-chat-crypto');assert.equal(await oldRead,null);assert.equal(api.loadCache('draft'),null);assert.ok(values.get('app_cache_alice_draft')===raw,'protected ciphertext remains unchanged');
});
test('proof failures for missing IndexedDB, WebCrypto, and localStorage never lose the current in-memory text',async()=>{
 for(const failure of ['idb','crypto','localStorage']){
  const {api,idb}=await setup(compiledAll);api.setCacheUserId('alice');
  if(failure==='idb')idb.failOpen=true;
  if(failure==='crypto')window.crypto=undefined;
  if(failure==='localStorage')localStorage.setItem=()=>{throw new Error('synthetic quota exhausted');};
  const receipt=await api.saveCacheWithDurability('draft','preserve '+failure);assert.equal(receipt.durable,false,failure);assert.equal(api.loadCache('draft'),'preserve '+failure);
 }
});
test('synthetic committed IDB: exact unknown UUID and complete reply/attachments survive cold module read, isolated by owner',async()=>{
 const {api,idb}=await setup(compiledAll);api.setIndexedDBUserId('alice');
 const row={id:'temp_00000000-0000-4000-8000-000000000001',tempId:'temp_00000000-0000-4000-8000-000000000001',group_id:'room',sender_type:'user',sender_id:'alice',content:'unknown request original content',content_type:'text',created_at:'2026-10-13T00:00:00Z',status:'failed',reply_to:['original-reply'],attachments:[{id:'original-attachment',name:'file.txt',type:'text/plain',size:7,url:'/file',media_description:'synthetic'}],metadata:{send_unknown:true}};
 assert.deepEqual(await api.saveMessagesWithDurability([row]),{durable:true});
 const cold=await import(`data:text/javascript;base64,${Buffer.from(compiledAll.outputFiles[0].text+`\n// cold ${++nonce}`).toString('base64')}`);
 cold.setIndexedDBUserId('alice');assert.deepEqual(await cold.loadMessagesFromIndexedDB('room'),[row]);
 cold.setIndexedDBUserId('bob');assert.deepEqual(await cold.loadMessagesFromIndexedDB('room'),[]);
 idb.failWrite=true;assert.equal((await cold.saveMessagesWithDurability([{...row,id:'bob-only'}])).durable,false);
 globalThis.indexedDB=undefined;const fallback=await import(`data:text/javascript;base64,${Buffer.from(compiledAll.outputFiles[0].text+`\n// fallback ${++nonce}`).toString('base64')}`);fallback.setIndexedDBUserId('alice');
 assert.deepEqual(await fallback.saveMessagesWithDurability([row]),{durable:false,reason:'memory_only'});assert.deepEqual(await fallback.loadMessagesFromIndexedDB('room'),[row]);
});

test('read-only decrypt and proof retain legacy localStorage key bytes on missing-key failure',async()=>{
 const {api,values}=await setup(compiledAll);api.setCacheUserId('alice');
 values.set('app_cache_key','synthetic-legacy-global-key');values.set('app_cache_key_alice','synthetic-legacy-owner-key');
 const bad=JSON.stringify({iv:Array(12).fill(0),data:[1,2,3]});assert.equal(await api.decryptData(bad),null);
 assert.equal(await api.decryptDataWithPersistedKey(bad,'alice'),null);
 assert.equal(values.get('app_cache_key'),'synthetic-legacy-global-key');assert.equal(values.get('app_cache_key_alice'),'synthetic-legacy-owner-key');
});

test('existing ciphertext with missing persisted key is never replaced by an autosave success or a newly generated key',async()=>{
 const {api,idb,values}=await setup(compiledAll);api.setCacheUserId('alice');
 const raw='enc_v1_'+JSON.stringify({iv:Array(12).fill(0),data:[1,2,3]});values.set('app_cache_alice_draft',raw);
 assert.equal(await api.loadCacheAsync('draft'),null);
 const receipt=await api.saveCacheWithDurability('draft','');
 assert.equal(receipt.durable,false);assert.ok(values.get('app_cache_alice_draft')===raw,'protected ciphertext remains unchanged');assert.equal(idb.writes.length,0);
 assert.equal(api.loadCache('draft'),'');
});


test('pinned historical producer creates independent runtime keys and ciphertext without touching test globals',async()=>{
 const windowBefore=globalThis.window,indexedDBBefore=globalThis.indexedDB,storageBefore=globalThis.localStorage;
 const first=await createLegacyEncryptedDraft(),second=await createLegacyEncryptedDraft();
 for(const key of ['master_key','wrapping_key_material'])assert.ok(!isDeepStrictEqual(first.keys[key],second.keys[key]),'each historical producer invocation must generate fresh random key records');
 assert.ok(first.ciphertext!==second.ciphertext,'runtime ciphertext must not be a fixed historical vector');
 assert.ok(globalThis.window===windowBefore,'producer leaves window untouched');assert.ok(globalThis.indexedDB===indexedDBBefore,'producer leaves IndexedDB untouched');assert.ok(globalThis.localStorage===storageBefore,'producer leaves localStorage untouched');
});
test('pinned historical producer runtime ciphertext decrypts without modifying its AES format or persisted key bytes',async()=>{
 const legacy=await createLegacyEncryptedDraft();
 const {api,idb,values}=await setup(compiledAll);
 const keys=new Map(Object.entries(legacy.keys).map(([key,value])=>[key,new Uint8Array(value).buffer]));idb.data.set('ai-chat-crypto',new Map([['encryption_keys',keys]]));
 values.set('app_cache_alice_draft','enc_v1_'+legacy.ciphertext);api.setCacheUserId('alice');
 // Fix the runtime sample's TTL; this proves historical format compatibility,
 // not equality with any cross-run fixed historical ciphertext bytes.
 const now=Date.now;try{Date.now=()=>legacy.timestamp+1000;assert.equal(await api.loadCacheAsync('draft'),legacy.data);assert.deepEqual(await api.saveCacheWithDurability('other','ordinary new encrypted draft'),{durable:true});}finally{Date.now=now;}
 assert.ok(values.get('app_cache_alice_draft')==='enc_v1_'+legacy.ciphertext,'reading does not replace historical-format ciphertext');assert.equal(idb.writes.length,0);
 assert.ok(isDeepStrictEqual(Object.fromEntries([...keys].map(([key,value])=>[key,[...new Uint8Array(value)]])),legacy.keys),'consumer must not alter historical producer key records');
});
test('production global-key owner binding rejects late A encryption after A to B to A without writing or rotating keys',async()=>{
 const {api,idb}=await setup(compiledAll);api.setCacheUserId('alice');idb.holdOpen('ai-chat-crypto');
 const old=api.encryptData('old A pending');await tick();api.setCacheUserId('bob');api.setCacheUserId('alice');
 idb.releaseOpen('ai-chat-crypto');assert.equal(await old,null);
 api.setCacheUserId('bob');const freshB=await api.encryptData('B draft');assert.ok(freshB);const writes=idb.writes.length;
 api.setCacheUserId('alice');assert.equal(await api.decryptData(freshB),'B draft','global key compatibility is not per-owner key isolation');
 assert.equal(idb.writes.length,writes);assert.deepEqual([...idb.data.keys()],['ai-chat-crypto']);
});
test('synthetic IDB retention never prunes a not-saved preview as confirmed history',async()=>{
 const {api}=await setup(compiledAll);api.setIndexedDBUserId('alice');
 const preview={id:'preview-original',group_id:'room',content:'not persisted by server',created_at:'2020-01-01T00:00:00Z',confirmation:'preview',preview_reason:'not_saved'};
 const history={id:'confirmed-one',group_id:'room',content:'confirmed',created_at:'2026-10-13T00:00:00Z',confirmation:'confirmed'};
 assert.equal((await api.saveMessagesWithDurability([preview,history])).durable,true);
 assert.equal(await api.clearOldMessagesFromIndexedDB('room',0),true);assert.deepEqual(await api.loadMessagesFromIndexedDB('room'),[preview]);
});

test('a failed durable-proof write does not delete the previously readable ciphertext during quota recovery',async()=>{
 const {api,values}=await setup(compiledAll);api.setCacheUserId('alice');assert.deepEqual(await api.saveCacheWithDurability('draft','old saved'),{durable:true});
 const old=values.get('app_cache_alice_draft');localStorage.setItem=()=>{throw new Error('synthetic quota exhausted');};
 assert.equal((await api.saveCacheWithDurability('draft','new text still in memory')).durable,false);
 assert.ok(values.get('app_cache_alice_draft')===old,'original ciphertext survives the failed save');assert.equal(api.loadCache('draft'),'new text still in memory');
});

test('concurrent durable draft receipts cannot attest an older value after a newer intent replaces it',async()=>{
 const {api}=await setup(compiledAll);api.setCacheUserId('alice');assert.deepEqual(await api.saveCacheWithDurability('draft','seed'),{durable:true});
 const [old,newer]=await Promise.all([api.saveCacheWithDurability('draft','old'),api.saveCacheWithDurability('draft','newest')]);
 assert.equal(old.durable,false);assert.equal(newer.durable,true);assert.equal(api.loadCache('draft'),'newest');
 api.setCacheUserId('bob');api.setCacheUserId('alice');assert.equal(await api.loadCacheAsync('draft'),'newest');
});

test('two independent crypto modules never overwrite the global key pair established by the other first encryption',async()=>{
 const {api:a,idb}=await setup(compiledAll);a.setCacheUserId('alice');
 const b=await import(`data:text/javascript;base64,${Buffer.from(compiledAll.outputFiles[0].text+`\n// independent tab ${++nonce}`).toString('base64')}`);b.setCacheUserId('alice');
 let release,announce;const held=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{announce=resolve;});let first=true;
 window.crypto={getRandomValues:webcrypto.getRandomValues.bind(webcrypto),subtle:new Proxy(webcrypto.subtle,{get(target,key){if(key==='generateKey')return async(...args)=>{const pause=first;first=false;const result=await target.generateKey(...args);if(pause){announce();await held;}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}})};
 const oldA=a.encryptData('tab A first text');await started;
 const firstB=await b.encryptData('tab B first text');assert.ok(firstB);const keys=idb.data.get('ai-chat-crypto').get('encryption_keys');
 const established=Object.fromEntries([...keys].map(([key,value])=>[key,[...new Uint8Array(value)]]));release();const firstA=await oldA;assert.ok(firstA);
 const cold=await import(`data:text/javascript;base64,${Buffer.from(compiledAll.outputFiles[0].text+`\n// cold verify ${++nonce}`).toString('base64')}`);cold.setCacheUserId('alice');
 assert.equal(await cold.decryptData(firstB),'tab B first text');assert.equal(await cold.decryptData(firstA),'tab A first text');
 assert.ok(isDeepStrictEqual(Object.fromEntries([...keys].map(([key,value])=>[key,[...new Uint8Array(value)]])),established),'a delayed first creator must use, not replace, the already-committed key pair');
});

test('read-only decrypt/proof do not join a pending first-encryption key-creation flight',async()=>{
 const {api,idb}=await setup(compiledAll);api.setCacheUserId('alice');let release,announce;
 const held=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{announce=resolve;});
 window.crypto={getRandomValues:webcrypto.getRandomValues.bind(webcrypto),subtle:new Proxy(webcrypto.subtle,{get(target,key){if(key==='generateKey')return async(...args)=>{const result=await target.generateKey(...args);announce();await held;return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}})};
 const creating=api.encryptData('explicit new write');await started;const bad=JSON.stringify({iv:Array(12).fill(0),data:[1,2,3]});
 let readSettled=false;const reading=api.decryptData(bad).then(value=>{readSettled=true;return value;});
 try{assert.equal(await api.decryptDataWithPersistedKey(bad,'alice'),null);for(let i=0;i<5;i++)await tick();assert.equal(idb.writes.length,0);assert.equal(readSettled,true,'read-only decryption must inspect existing keys instead of awaiting a creator flight');}
 finally{release();await creating;await reading;}
});

test('partial existing key records fail closed for encrypt/read/proof without filling or replacing either record',async()=>{
 for(const missing of ['master_key','wrapping_key_material']){
  const legacy=await createLegacyEncryptedDraft();const {api,idb}=await setup(compiledAll);api.setCacheUserId('alice');
  const keys=new Map(Object.entries(legacy.keys).filter(([name])=>name!==missing).map(([key,value])=>[key,new Uint8Array(value).buffer]));idb.data.set('ai-chat-crypto',new Map([['encryption_keys',keys]]));
  const before=Object.fromEntries([...keys].map(([key,value])=>[key,[...new Uint8Array(value)]]));
  assert.ok(await api.encryptData('must stay in memory')===null,'partial key records reject encryption');assert.equal(await api.decryptData(legacy.ciphertext),null);assert.equal(await api.decryptDataWithPersistedKey(legacy.ciphertext,'alice'),null);
  assert.equal(idb.writes.length,0);assert.ok(isDeepStrictEqual(Object.fromEntries([...keys].map(([key,value])=>[key,[...new Uint8Array(value)]])),before),'partial key records remain unchanged');
 }
});
