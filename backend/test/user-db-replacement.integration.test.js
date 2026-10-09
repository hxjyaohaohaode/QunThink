// Real LowDB/JSONFile instances and isolated temporary files. Storage waits are
// explicit test faults; no provider, real account or external database is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const keep=Object.fromEntries(['PATH','HOME','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
for(const k of Object.keys(process.env))delete process.env[k];
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-db-replacement-test-'));
Object.assign(process.env,keep,{NODE_ENV:'test',DATA_DIR:dir,AI_HEALTH_PROBES:'0',QUNTHINK_SHARED_PROVIDER_KEYS:'0'});
const {initDatabase,initUserDatabase,getUserDb,clearUserDbCache}=await import('../src/models/db.js');
const {JSONFile}=await import('lowdb/node');
await initDatabase();
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
const disk=id=>fs.readFile(path.join(dir,'users',`db_${id}.json`),'utf8').then(JSON.parse);
const settle=p=>p.then(value=>({value}),error=>({error}));
const isRetired=r=>{assert.ok(r.error instanceof Error,'invalidated operation must reject');assert.match(r.error.message,/失效|刷新|未确认|retir|invalid/i);};
let n=0;
async function fresh(){const id=`lifecycle-${++n}`;await initUserDatabase(id);return {id,db:await getUserDb(id)};}

test('concurrent cache misses share one live object and one durable read',{timeout:5000},async()=>{
 const {id}=await fresh();clearUserDbCache(id);const original=JSONFile.prototype.read;let reads=0;
 JSONFile.prototype.read=async function(){reads++;return original.call(this);};
 try{const all=await Promise.all(Array.from({length:24},()=>getUserDb(id)));assert.equal(new Set(all).size,1);assert.equal(reads,1);assert.equal(await getUserDb(id),all[0]);}
 finally{JSONFile.prototype.read=original;}
});

test('clear during old and new loads prevents stale registration and old-finally deletion',{timeout:5000},async()=>{
 const {id}=await fresh();clearUserDbCache(id);const original=JSONFile.prototype.read;const entered1=deferred(),entered2=deferred(),release1=deferred(),release2=deferred();let reads=0;
 JSONFile.prototype.read=async function(){const data=await original.call(this),i=reads++;if(i===0){entered1.resolve();await release1.promise;}if(i===1){entered2.resolve();await release2.promise;}return data;};
 let old,newer,joined;
 try{
  old=settle(getUserDb(id));await entered1.promise;clearUserDbCache(id);newer=settle(getUserDb(id));await entered2.promise;
  release1.resolve();const obsolete=await old;isRetired(obsolete);
  joined=settle(getUserDb(id));await tick();assert.equal(reads,2,'old flight must not delete or replace current pending flight');
  release2.resolve();const [a,b]=await Promise.all([newer,joined]);assert.ok(a.value);assert.equal(a.value,b.value);assert.equal(await getUserDb(id),a.value);assert.equal(reads,2);
 }finally{release1.resolve();release2.resolve();await Promise.all([old,newer,joined].filter(Boolean));JSONFile.prototype.read=original;}
});

test('global clear retires a loader that has never entered cache',{timeout:5000},async()=>{
 const {id}=await fresh();clearUserDbCache(id);const original=JSONFile.prototype.read;const entered=deferred(),release=deferred();let reads=0,pending;
 JSONFile.prototype.read=async function(){const data=await original.call(this);if(reads++===0){entered.resolve();await release.promise;}return data;};
 try{pending=settle(getUserDb(id));await entered.promise;clearUserDbCache();release.resolve();isRetired(await pending);const current=await getUserDb(id);assert.ok(current);assert.equal(reads,2);}
 finally{release.resolve();await pending;JSONFile.prototype.read=original;}
});

test('mid-read invalidation rejects old read and every later write',{timeout:5000},async()=>{
 const {id,db}=await fresh();const original=db.adapter.read.bind(db.adapter),entered=deferred(),release=deferred();
 db.adapter.read=async()=>{const snapshot=await original();entered.resolve();await release.promise;return snapshot;};
 const pending=settle(db.read({force:true}));await entered.promise;clearUserDbCache(id);const replacement=await getUserDb(id);release.resolve();isRetired(await pending);
 db.data.userProfile.nickname='retired phantom';isRetired(await settle(db.write()));assert.equal((await disk(id)).userProfile.nickname,'');assert.notEqual(db,replacement);
});

for(const committed of [false,true])test(`new loader waits for retired in-flight write, commit=${committed}`,{timeout:5000},async()=>{
 const {id,db}=await fresh();const original=db.adapter.write.bind(db.adapter),entered=deferred(),release=deferred();let writes=0,newSettled=false;
 db.data.userProfile.nickname='late durable value';
 db.adapter.write=async data=>{writes++;entered.resolve();await release.promise;if(committed)return original(data);throw Error('synthetic write not committed');};
 const old=settle(db.write());await entered.promise;clearUserDbCache(id);
 const originalPrototypeRead=JSONFile.prototype.read;let durableReads=0;JSONFile.prototype.read=function(){durableReads++;return originalPrototypeRead.call(this);};
 const replacement=settle(getUserDb(id)).then(r=>{newSettled=true;return r;});
 await tick();await tick();const readBeforeDrain=durableReads,settledBeforeDrain=newSettled;release.resolve();const oldResult=await old;const next=await replacement;JSONFile.prototype.read=originalPrototypeRead;
 assert.equal(readBeforeDrain,0,'replacement must not start durable read before old write outcome');assert.equal(settledBeforeDrain,false);assert.ok(oldResult.error instanceof Error);assert.ok(next.value);assert.equal(writes,1);
 const expected=committed?'late durable value':'';assert.equal(next.value.data.userProfile.nickname,expected);assert.equal((await disk(id)).userProfile.nickname,expected);assert.equal(await getUserDb(id),next.value);
});

test('replacement load cleared while draining cannot regain cache or erase newest flight',{timeout:5000},async()=>{
 const {id,db}=await fresh();const original=db.adapter.write.bind(db.adapter),entered=deferred(),release=deferred();
 db.data.userProfile.nickname='committed before replacement';db.adapter.write=async data=>{entered.resolve();await release.promise;return original(data);};
 const old=settle(db.write());await entered.promise;clearUserDbCache(id);const obsolete=settle(getUserDb(id));await tick();clearUserDbCache(id);const current=settle(getUserDb(id));release.resolve();await old;isRetired(await obsolete);
 const newest=await current;assert.ok(newest.value);assert.equal(newest.value.data.userProfile.nickname,'committed before replacement');assert.equal(await getUserDb(id),newest.value);
});

test('LRU eviction of a mid-read handle retires it rather than authorizing stale writes',{timeout:10000},async()=>{
 clearUserDbCache();const {id,db}=await fresh();const original=db.adapter.read.bind(db.adapter),entered=deferred(),release=deferred();
 db.adapter.read=async()=>{const data=await original();entered.resolve();await release.promise;return data;};const old=settle(db.read({force:true}));await entered.promise;
 try{for(let i=0;i<51;i++)await fresh();release.resolve();isRetired(await old);db.data.userProfile.nickname='evicted phantom';isRetired(await settle(db.write()));assert.equal((await disk(id)).userProfile.nickname,'');}
 finally{release.resolve();await old;}
});

test('retirement suppresses a new rename fallback write after the first write failed',{timeout:5000},async()=>{
 const {id,db}=await fresh();const entered=deferred(),release=deferred();let attempts=0;
 db.data.userProfile.nickname='retired fallback phantom';
 db.adapter.write=async()=>{attempts++;entered.resolve();await release.promise;throw Object.assign(Error('synthetic failed rename'),{code:'ENOENT',syscall:'rename',dest:path.join(dir,'users',`db_${id}.json`)});};
 const old=settle(db.write());await entered.promise;clearUserDbCache(id);const replacement=settle(getUserDb(id));release.resolve();const [result,next]=await Promise.all([old,replacement]);
 isRetired(result);assert.ok(next.value);assert.equal(attempts,1);assert.equal(next.value.data.userProfile.nickname,'');assert.equal((await disk(id)).userProfile.nickname,'');
});

test('LRU retains a physical-write handle until its operation settles',{timeout:10000},async()=>{
 clearUserDbCache();const {id,db}=await fresh();const original=db.adapter.write.bind(db.adapter),entered=deferred(),release=deferred();
 db.data.userProfile.nickname='committed through LRU';db.adapter.write=async data=>{entered.resolve();await release.promise;return original(data);};
 const old=settle(db.write());await entered.promise;for(let i=0;i<51;i++)await fresh();
 const originalRead=JSONFile.prototype.read;let reads=0;JSONFile.prototype.read=function(){reads++;return originalRead.call(this);};
 const replacement=settle(getUserDb(id));await tick();await tick();const readsBeforeDrain=reads;release.resolve();const [result,next]=await Promise.all([old,replacement]);JSONFile.prototype.read=originalRead;
 assert.ok(!result.error,'active write must remain live because LRU skips it');assert.equal(readsBeforeDrain,0);assert.equal(next.value,db);assert.equal(next.value.data.userProfile.nickname,'committed through LRU');assert.equal((await disk(id)).userProfile.nickname,'committed through LRU');
});

test('clear after physical commit but before acknowledgement rejects old receipt and reloads durable result',{timeout:5000},async()=>{
 const {id,db}=await fresh();const original=db.adapter.write.bind(db.adapter),committed=deferred(),ack=deferred();
 db.data.userProfile.nickname='saved before clear';db.adapter.write=async data=>{await original(data);committed.resolve();await ack.promise;};
 const old=settle(db.write());await committed.promise;assert.equal((await disk(id)).userProfile.nickname,'saved before clear');clearUserDbCache(id);
 const originalRead=JSONFile.prototype.read;let reads=0;JSONFile.prototype.read=function(){reads++;return originalRead.call(this);};
 const replacement=settle(getUserDb(id));await tick();await tick();const beforeAck=reads;ack.resolve();const [result,next]=await Promise.all([old,replacement]);JSONFile.prototype.read=originalRead;
 isRetired(result);assert.equal(beforeAck,0);assert.ok(next.value);assert.equal(next.value.data.userProfile.nickname,'saved before clear');
});

test('retired recovery loader cannot resurrect old concatenated JSON after an external restore',{timeout:5000},async()=>{
 const {id}=await fresh(),file=path.join(dir,'users',`db_${id}.json`);const original=await disk(id);const old={...original,userProfile:{...original.userProfile,nickname:'obsolete restore source'}};
 await fs.writeFile(file,JSON.stringify(old)+JSON.stringify({second:true}));clearUserDbCache(id);
 const actualRead=fs.readFile,entered=deferred(),release=deferred();let intercepted=false;
 fs.readFile=async function(target,...args){const raw=await actualRead.call(this,target,...args);if(String(target)===file&&!intercepted){intercepted=true;entered.resolve();await release.promise;}return raw;};
 let stale;
 try{
  stale=settle(getUserDb(id));await entered.promise;clearUserDbCache(id);
  const restored={...original,userProfile:{...original.userProfile,nickname:'authoritative restored source'}};
  await fs.writeFile(file,JSON.stringify(restored));const current=await getUserDb(id);release.resolve();isRetired(await stale);
  assert.equal(current.data.userProfile.nickname,'authoritative restored source');assert.deepEqual(await disk(id),restored);
  const files=await fs.readdir(path.dirname(file));assert.ok(!files.some(name=>name.startsWith(path.basename(file)+'.corrupted.')),'retired error must not create corrupt backups or run repair writes');
 }finally{release.resolve();await stale;fs.readFile=actualRead;}
});
