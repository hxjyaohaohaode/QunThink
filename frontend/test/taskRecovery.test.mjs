import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),window=new Window({url:'https://qunthink.test/'});
Object.assign(globalThis,{window,localStorage:window.localStorage});after(()=>window.close());
const databases=new Map();
// Protocol-only IndexedDB stand-in. WebCrypto below is real; native browser persistence is tested separately in CI.
globalThis.indexedDB={open(name){const request={};queueMicrotask(()=>{let values=databases.get(name),fresh=!values;if(!values){values=new Map();databases.set(name,values)};const db={close(){},createObjectStore(){},transaction(){const tx={};tx.objectStore=()=>({get(key){const r={};queueMicrotask(()=>{r.result=values.get(key);r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.())});return r},put(value,key){values.set(key,value)}});return tx}};request.result=db;if(fresh)request.onupgradeneeded?.();request.onsuccess?.()});return request}};
const setCrypto=(extra={})=>Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>webcrypto.randomUUID(),getRandomValues:value=>webcrypto.getRandomValues(value),subtle:{generateKey:(...x)=>webcrypto.subtle.generateKey(...x),encrypt:(...x)=>webcrypto.subtle.encrypt(...x),decrypt:(...x)=>webcrypto.subtle.decrypt(...x),digest:(...x)=>webcrypto.subtle.digest(...x),...extra}}});setCrypto();
globalThis.__recovery={user:'alice',auth:1};
const built=await build({entryPoints:[resolve(root,'src/utils/taskRecovery.ts')],bundle:true,write:false,platform:'browser',format:'esm',plugins:[{name:'recovery-account',setup(build){build.onResolve({filter:/services\/api$/},()=>({path:'api',namespace:'mock'}));build.onResolve({filter:/\.\/cacheUtils$/},()=>({path:'cache',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='api'?`export const getAuthGeneration=()=>globalThis.__recovery.auth;`:`export const getCacheUserId=()=>globalThis.__recovery.user;`}))}}]});
const recovery=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const secondRecovery=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text+'\n// second isolated tab').toString('base64')}`);
const value={body:'私密邀请：10月20日，人工备注',baseRevisionId:'version-1',savedAt:'2026-10-04'};
const receipt={key:'4abc6c19-d370-49b8-8bc5-e6172bf12c5c',action:'save_revision',taskId:'task-1',baseRevisionId:'d44c8f45-11a3-4521-9368-f23f7b27c45a',payloadHash:'a'.repeat(64),createdAt:'2026-10-04'};
const keys=()=>Object.keys(localStorage);const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{localStorage.clear();databases.clear();globalThis.__recovery={user:'alice',auth:globalThis.__recovery.auth+1};setCrypto();recovery.clearWritingContent();});

test('private content is off until separately chosen; minimal receipts contain only allowlisted metadata',async()=>{
 assert.deepEqual(recovery.writingPreferences(),{recoverDrafts:false,offlineCopies:false});assert.equal(await recovery.saveWritingContent('task-1',value),false);assert.equal(keys().some(key=>key.startsWith('qunthink_writing_v1_')),false);
 recovery.persistTaskReceipt({...receipt,body:'must-not-save',title:'must-not-save',payload:{content:'must-not-save'}});const raw=localStorage.getItem(keys()[0]);assert.doesNotMatch(raw,/must-not-save|body|title|payload"/);assert.deepEqual(recovery.readTaskReceipts(),[receipt]);
});
test('opted-in draft round-trips through real AES-GCM with a nonextractable stored key',async()=>{
 recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});assert.equal(await recovery.saveWritingContent('task-1',value),true);const raw=localStorage.getItem(keys().find(key=>key.includes('writing_v1')));assert.doesNotMatch(raw,/私密|人工|20日/);assert.deepEqual(await recovery.loadWritingContent('task-1'),value);const key=[...databases.values()][0].get('key');assert.equal(key.extractable,false);await assert.rejects(webcrypto.subtle.exportKey('raw',key));
});
test('account-bound encryption rejects copied ciphertext and another account cannot list receipts',async()=>{
 recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});await recovery.saveWritingContent('task-1',value);recovery.persistTaskReceipt(receipt);const aKey=keys().find(key=>key.includes('writing_v1'));const raw=localStorage.getItem(aKey);globalThis.__recovery.user='bob';globalThis.__recovery.auth++;recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});localStorage.setItem(aKey.replace('alice','bob'),raw);assert.equal(await recovery.loadWritingContent('task-1'),null);assert.deepEqual(recovery.readTaskReceipts(),[]);
});
test('turning off private copies never discards command recovery IDs or the independent draft choice',async()=>{
 recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:true});await recovery.saveWritingContent('task-1',value);await recovery.saveWritingContent('task-1',value,'offline');recovery.persistTaskReceipt(receipt);recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});assert.ok(await recovery.loadWritingContent('task-1'));assert.equal(await recovery.loadWritingContent('task-1','offline'),null);assert.equal(recovery.readTaskReceipts()[0].key,receipt.key);recovery.setWritingPreferences({recoverDrafts:false,offlineCopies:false});assert.equal(await recovery.loadWritingContent('task-1'),null);assert.equal(recovery.readTaskReceipts()[0].key,receipt.key);
});
test('out-of-order encryption writes keep only the latest editor bytes',async()=>{
 recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});await recovery.saveWritingContent('task-1',value);const encrypted=[];setCrypto({encrypt:(...args)=>new Promise(resolve=>encrypted.push(async()=>resolve(await webcrypto.subtle.encrypt(...args))))});const old=recovery.saveWritingContent('task-1',{...value,body:'旧输入'});while(!encrypted.length)await tick();const newest=recovery.saveWritingContent('task-1',{...value,body:'新输入'});while(encrypted.length<2)await tick();await encrypted[1]();await encrypted[0]();assert.equal(await old,false);assert.equal(await newest,true);assert.equal((await recovery.loadWritingContent('task-1')).body,'新输入');
});
test('A→B→A and logout content cleanup fence encryption completion; receipts survive reauthentication',async()=>{
 recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});let release;setCrypto({encrypt:(...args)=>new Promise(resolve=>{release=async()=>resolve(await webcrypto.subtle.encrypt(...args))})});const saving=recovery.saveWritingContent('task-1',value);while(!release)await tick();recovery.persistTaskReceipt(receipt);globalThis.__recovery.user='bob';globalThis.__recovery.auth++;globalThis.__recovery.user='alice';globalThis.__recovery.auth++;recovery.clearWritingContent('alice');await release();assert.equal(await saving,false);assert.equal(keys().some(key=>key.startsWith('qunthink_writing_v1_')),false);assert.equal(recovery.readTaskReceipts()[0].key,receipt.key);
});
test('failed durable write throws before a caller is allowed to dispatch',()=>{
 const original=globalThis.localStorage;globalThis.localStorage={setItem(){throw new Error('QuotaExceededError')},getItem(){return null},length:0};try{assert.throws(()=>recovery.persistTaskReceipt(receipt),/尚未发送/);assert.equal(recovery.readTaskReceipts().length,0)}finally{globalThis.localStorage=original}
});


test('one tab clearing content retires an in-flight encrypted write in another tab',async()=>{
 recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});let release;setCrypto({encrypt:(...args)=>new Promise(resolve=>{release=async()=>resolve(await webcrypto.subtle.encrypt(...args))})});const saving=secondRecovery.saveWritingContent('task-1',value);while(!release)await tick();assert.equal(recovery.clearWritingContent('alice'),true);await release();assert.equal(await saving,false);assert.equal(await recovery.loadWritingContent('task-1'),null);assert.equal(keys().some(key=>key.startsWith('qunthink_writing_v1_')),false);
});
test('revoking one document retires its cross-tab writes without deleting unrelated drafts',async()=>{
 recovery.setWritingPreferences({recoverDrafts:true,offlineCopies:false});await recovery.saveWritingContent('unrelated',value);let release;setCrypto({encrypt:(...args)=>new Promise(resolve=>{release=async()=>resolve(await webcrypto.subtle.encrypt(...args))})});const saving=secondRecovery.saveWritingContent('task-1',value);while(!release)await tick();assert.equal(recovery.removeWritingDraft('task-1'),true);await release();assert.equal(await saving,false);assert.equal(await recovery.loadWritingContent('task-1'),null);assert.deepEqual(await recovery.loadWritingContent('unrelated'),value);
});

const ownedReceiptKey = key => `qunthink_command_v1_alice:${key}`;
const corruptions = {
 null:()=>null, array:()=>[], primitive:()=>42, actionMissing:value=>{delete value.action;return value}, actionTypo:value=>({...value,action:'save_revison'}), keyMissing:value=>{delete value.key;return value}, keyType:value=>({...value,key:12}), keyInvalid:value=>({...value,key:'not-uuid'}), keyMismatch:value=>({...value,key:'13392498-3319-4a0e-ab22-3551a0438203'}), hashMissing:value=>{delete value.payloadHash;return value}, hashType:value=>({...value,payloadHash:12}), hashInvalid:value=>({...value,payloadHash:'nope'}), timeMissing:value=>{delete value.createdAt;return value}, timeType:value=>({...value,createdAt:12}), timeInvalid:value=>({...value,createdAt:'never'}), taskMissing:value=>{delete value.taskId;return value}, taskNull:value=>({...value,taskId:null}), taskType:value=>({...value,taskId:12}), taskEmpty:value=>({...value,taskId:''}), taskLong:value=>({...value,taskId:'x'.repeat(101)}), taskPath:value=>({...value,taskId:'../foreign-task'}), createWrongTask:value=>({...value,action:'create',taskId:'wrong'}), baseType:value=>({...value,baseRevisionId:12}), baseInvalid:value=>({...value,baseRevisionId:'not-uuid'}), versionType:value=>({...value,revisionId:12}), versionInvalid:value=>({...value,revisionId:'not-uuid'}), versionNull:value=>({...value,revisionId:null}), contentHashType:value=>({...value,contentHash:12}), contentHashInvalid:value=>({...value,contentHash:'nope'}), acceptMissingVersion:value=>({...value,action:'accept_revision'}), adoptMissingVersion:value=>({...value,action:'adopt_revision'}), privateUnexpectedField:value=>({...value,body:'PRIVATE_MUST_NOT_LEAK'})
};
for(const [name,corrupt]of Object.entries(corruptions))test(`owned malformed receipt fails closed without losing bytes: ${name}`,()=>{
 const key=ownedReceiptKey(receipt.key),raw=JSON.stringify(corrupt(structuredClone(receipt)));localStorage.setItem(key,raw);assert.throws(()=>recovery.readTaskReceipts(),error=>/待核验记录不完整/.test(error.message)&&!/PRIVATE_MUST_NOT_LEAK|save_revison|not-uuid/.test(error.message));assert.equal(localStorage.getItem(key),raw);
});
test('foreign malformed records are ignored without reading their bytes and corrected owned storage is recoverable',()=>{
 localStorage.setItem('qunthink_command_v1_bob:private-key','NOT_JSON_PRIVATE');localStorage.setItem('qunthink_command_v1_alice-other:private-key','NOT_JSON_PRIVATE');recovery.persistTaskReceipt(receipt);assert.deepEqual(recovery.readTaskReceipts(),[receipt]);const key=ownedReceiptKey(receipt.key);localStorage.setItem(key,'{"action":"save_revison"}');assert.throws(()=>recovery.readTaskReceipts());localStorage.setItem(key,JSON.stringify(receipt));assert.deepEqual(recovery.readTaskReceipts(),[receipt]);assert.equal(localStorage.getItem('qunthink_command_v1_bob:private-key'),'NOT_JSON_PRIVATE');
});
