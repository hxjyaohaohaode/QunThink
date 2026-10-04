import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
globalThis.__profileTest = { user:'alice', writes:[], get:async()=>({nickname:'alice'}), update:async()=>({nickname:'alice'}), cached:null };
const result = await build({entryPoints:[resolve(import.meta.dirname,'../src/stores/profileStore.ts')],bundle:true,format:'esm',platform:'browser',write:false,plugins:[{name:'profile-boundaries',setup(build){
 build.onResolve({filter:/services\/api$/},()=>({path:'api',namespace:'mock'}));
 build.onResolve({filter:/utils\/cacheUtils$/},()=>({path:'cache',namespace:'mock'}));
 build.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='api'?`export const api = {getProfile:()=>globalThis.__profileTest.get(),updateProfile:(data)=>globalThis.__profileTest.update(data)};`:`export const getCacheUserId=()=>globalThis.__profileTest.user; export const loadProfileCache=()=>globalThis.__profileTest.cached; export const saveProfileCache=data=>globalThis.__profileTest.writes.push({user:globalThis.__profileTest.user,data});`}));
}}]});
const {useProfileStore:store}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
beforeEach(()=>{store.getState().cleanup();globalThis.__profileTest.user='alice';globalThis.__profileTest.writes=[];globalThis.__profileTest.cached=null;});
test('late old-account fetch never enters new-account profile or encrypted cache',async()=>{
 let resolveOld; globalThis.__profileTest.get=()=>new Promise(resolve=>{resolveOld=resolve;});
 const old=store.getState().fetchProfile();
 store.getState().cleanup();globalThis.__profileTest.user='bob';globalThis.__profileTest.get=async()=>({nickname:'bob'});
 await store.getState().fetchProfile();resolveOld({nickname:'alice-private-profile'});await old;
 assert.equal(store.getState().profile.nickname,'bob');
 assert.deepEqual(globalThis.__profileTest.writes,[{user:'bob',data:{nickname:'bob'}}]);
});
test('late update cannot change a new account; A-B-A sessions retain generation fence',async()=>{
 let resolveOld;globalThis.__profileTest.update=()=>new Promise(resolve=>{resolveOld=resolve;});
 const old=store.getState().updateProfile({nickname:'old-alice'});
 store.getState().cleanup();globalThis.__profileTest.user='bob';store.getState().cleanup();globalThis.__profileTest.user='alice';
 globalThis.__profileTest.get=async()=>({nickname:'new-alice'});await store.getState().fetchProfile();
 resolveOld({nickname:'old-alice'});await assert.rejects(old,/账号已切换/);
 assert.equal(store.getState().profile.nickname,'new-alice');assert.equal(globalThis.__profileTest.writes.length,1);
});
test('a delayed read cannot overwrite a newer successful profile edit',async()=>{
 let resolveRead;globalThis.__profileTest.get=()=>new Promise(resolve=>{resolveRead=resolve;});
 const read=store.getState().fetchProfile();globalThis.__profileTest.update=async()=>({nickname:'updated'});
 await store.getState().updateProfile({nickname:'updated'});resolveRead({nickname:'stale'});await read;
 assert.equal(store.getState().profile.nickname,'updated');assert.equal(globalThis.__profileTest.writes.length,1);
});
test('duplicate profile saves are rejected until receipt, and read loading is released',async()=>{
 let finish;globalThis.__profileTest.update=()=>new Promise(resolve=>{finish=resolve;});
 store.setState({loading:true});const first=store.getState().updateProfile({nickname:'first'});
 await assert.rejects(store.getState().updateProfile({nickname:'second'}),/正在保存/);
 finish({nickname:'first'});await first;assert.equal(store.getState().loading,false);
});
test('read started during save cannot overwrite its newer committed receipt',async()=>{
 let finishWrite,finishRead;
 globalThis.__profileTest.update=()=>new Promise(resolve=>{finishWrite=resolve;});
 globalThis.__profileTest.get=()=>new Promise(resolve=>{finishRead=resolve;});
 const write=store.getState().updateProfile({nickname:'new-alice'});
 const read=store.getState().fetchProfile();
 finishWrite({nickname:'new-alice'});await write;
 finishRead({nickname:'old-alice'});await read;
 assert.equal(store.getState().profile.nickname,'new-alice');
 assert.deepEqual(globalThis.__profileTest.writes,[{user:'alice',data:{nickname:'new-alice'}}]);
});
