import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalAccountRegistry } from '../src/services/memory/localAccountRegistry.js';
import { restoreDigest, buildRestoreTarget } from '../src/services/accountGenerationRestore.js';
import { restoreOwnerDirectory } from '../src/services/accountGenerationRestoreFiles.js';
const directory = await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-restore-contract-'));
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_)/.test(key)) delete process.env[key];
Object.assign(process.env,{DATA_DIR:directory,AUTH_DB_PATH:path.join(directory,'auth.json')});
const { restoreAccountGenerations, CustomLow, getUserDb }=await import('../src/models/db.js');
const cwd=fileURLToPath(new URL('..',import.meta.url));
const root=path.join(directory,'memory-deletions');
await fs.mkdir(path.join(directory,'users'));
await fs.writeFile(process.env.AUTH_DB_PATH,JSON.stringify({users:[],memoryBarrierInstallation:{version:1,root}}));
const registry=createLocalAccountRegistry({directory:path.join(root,'registry'),createIfMissing:true}); await registry.initialize();
test.after(()=>fs.rm(directory,{recursive:true,force:true}));
async function fixture(t) {
  const owner=randomUUID(), file=path.join(directory,'users',`db_${owner}.json`), planFile=path.join(directory,`${owner}-plan.json`);
  const data={groups:[{id:'empty'},{id:'live'}],messages:[{id:'m',group_id:'live',content:'synthetic sealed ciphertext',created_at:'2026-10-13T00:00:00Z'}],receipt:{source_hash:'f'.repeat(64)},
    message_order:{version:1,owner_id:owner,groups:[{group_id:'empty',generation:randomUUID(),next_sequence:'1',bindings:[]},{group_id:'live',generation:randomUUID(),next_sequence:'2',bindings:[{message_id:'m',sequence:'1'}]},{group_id:'deleted',generation:randomUUID(),next_sequence:'4',bindings:[{message_id:'old',sequence:'3'}]}]}};
  await fs.writeFile(file,JSON.stringify(data));
  const ledgerDirectory=path.join(root,restoreDigest(JSON.stringify(owner)));
  const {barrier}=await registry.openAccount(owner,{ledgerDirectory,allowNew:true}); await barrier.markDeleted(owner,'old-source');
  const run=(...args)=>spawnSync(process.execPath,['scripts/account-store-maintenance.mjs',...args],{cwd,env:process.env,encoding:'utf8'});
  const execute=(operation,extra={})=>restoreAccountGenerations(owner,{operation,planFile,writersStopped:true,...extra});
  const prepare=async()=>{const report=await execute('prepare');return {...report,plan:JSON.parse(await fs.readFile(planFile,'utf8'))};};
  const read=async()=>JSON.parse(await fs.readFile(file,'utf8'));
  return {owner,file,planFile,data,ledgerDirectory,run,execute,prepare,read};
}
async function protectedBytes(f) {
  const files=[f.file,process.env.AUTH_DB_PATH,...['registry',path.basename(f.ledgerDirectory)].flatMap(dir=>['deletions.v1.log','deletions.v1.receipts'].map(name=>path.join(root,dir,name)))];
  return Object.fromEntries(await Promise.all(files.map(async file=>[file,await fs.readFile(file,'utf8')])));
}
test('real CLI first green: prepare/verify preserve all original bytes; apply rotates once across process restart and plan copy',async t=>{
  const f=await fixture(t), before=await protectedBytes(f);
  const prepared=f.run('prepare-restore-rotation',f.owner,f.planFile,'--writers-stopped');assert.equal(prepared.status,0,prepared.stderr);
  const report=JSON.parse(prepared.stdout), plan=JSON.parse(await fs.readFile(f.planFile,'utf8'));
  assert.deepEqual(await protectedBytes(f),before);
  const verify=f.run('verify-restore-rotation',f.owner,f.planFile,'--writers-stopped');assert.equal(verify.status,2,verify.stderr);assert.equal(JSON.parse(verify.stdout).outcome,'unconfirmed');
  assert.deepEqual(await protectedBytes(f),before);
  const applied=f.run('apply-restore-rotation',f.owner,f.planFile,'--apply',report.planSha,'--writers-stopped');assert.equal(applied.status,0,applied.stderr);
  assert.deepEqual(await f.read(),buildRestoreTarget(f.data,plan));
  const after=await protectedBytes(f);for(const filename of Object.keys(before)) if(filename!==f.file) assert.equal(after[filename],before[filename]);
  const copy=path.join(directory,`${f.owner}-copy.json`);await fs.copyFile(f.planFile,copy);
  const twice=f.run('apply-restore-rotation',f.owner,copy,'--apply',report.planSha,'--writers-stopped');assert.equal(twice.status,0,twice.stderr);
  assert.equal(JSON.parse(twice.stdout).businessWriteAttempted,false);assert.deepEqual(await protectedBytes(f),after);
  const restart=spawnSync(process.execPath,['--input-type=module','-e',`const {getUserDb}=await import('./src/models/db.js');await (await getUserDb(${JSON.stringify(f.owner)})).read({force:true});`],{cwd,env:process.env,encoding:'utf8'});
  assert.equal(restart.status,0,restart.stderr);assert.deepEqual(await protectedBytes(f),after);
  assert.equal(f.run('prepare-restore-rotation',f.owner,path.join(directory,`${f.owner}-new.json`),'--writers-stopped').status,1);
});
test('old live handle retires; prepare cannot overwrite a plan; malformed flags never act',async t=>{
  const f=await fixture(t), handle=await getUserDb(f.owner);await f.prepare();
  await assert.rejects(handle.read(),{code:'USER_DB_REPLACED'});
  const before=await protectedBytes(f);await assert.rejects(f.prepare(),{code:'EEXIST'});
  assert.equal(f.run('apply-restore-rotation',f.owner,f.planFile,'--apply','0'.repeat(64)).status,1);
  assert.deepEqual(await protectedBytes(f),before);
});
test('wrong owner/hash, changed source and forged target produce zero writes and preserve source',async t=>{
  const f=await fixture(t), p=await f.prepare(), before=await protectedBytes(f);
  await assert.rejects(restoreAccountGenerations('other',{operation:'apply',planFile:f.planFile,writersStopped:true,expectedPlanSha:p.planSha}),{code:'RESTORE_PLAN_INVALID'});
  await assert.rejects(f.execute('apply',{expectedPlanSha:'0'.repeat(64)}),{code:'RESTORE_PLAN_HASH_MISMATCH'});
  assert.deepEqual(await protectedBytes(f),before);
  const changed=structuredClone(f.data);changed.receipt.extra=true;await fs.writeFile(f.file,JSON.stringify(changed));
  const changedBytes=await fs.readFile(f.file,'utf8');await assert.rejects(f.execute('apply',{expectedPlanSha:p.planSha}),{code:'RESTORE_TARGET_CONFLICT'});
  assert.equal(await fs.readFile(f.file,'utf8'),changedBytes);
  await assert.rejects(fs.stat(restoreOwnerDirectory(directory,f.owner)),{code:'ENOENT'});
});
test('unknown precommit attempt blocks same-request rewrites, copied plan and another already-prepared request',async t=>{
  const f=await fixture(t), p=await f.prepare(), second=path.join(directory,`${f.owner}-second.json`);
  const p2=await restoreAccountGenerations(f.owner,{operation:'prepare',planFile:second,writersStopped:true});
  const original=CustomLow.prototype.write;let writes=0;CustomLow.prototype.write=async function(){writes++;throw new Error('synthetic precommit failure');};
  t.after(()=>{CustomLow.prototype.write=original;});
  const first=await f.execute('apply',{expectedPlanSha:p.planSha});assert.equal(first.outcome,'unconfirmed');assert.equal(writes,1);
  const same=await f.execute('apply',{expectedPlanSha:p.planSha});assert.equal(same.outcome,'unconfirmed');assert.equal(writes,1);
  await assert.rejects(restoreAccountGenerations(f.owner,{operation:'apply',planFile:second,writersStopped:true,expectedPlanSha:p2.planSha}),{code:'RESTORE_ATTEMPT_EXISTS'});
  assert.deepEqual(await f.read(),f.data);assert.equal(writes,1);
});
test('postcommit lost ACK is confirmed only by read and never triggers another write',async t=>{
  const f=await fixture(t), p=await f.prepare(), original=CustomLow.prototype.write;let writes=0;
  CustomLow.prototype.write=async function(...args){writes++;await original.apply(this,args);throw new Error('synthetic lost ACK');};t.after(()=>{CustomLow.prototype.write=original;});
  assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'confirmed');
  assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).businessWriteAttempted,false);assert.equal(writes,1);
});
test('failed confirmation read stays unknown; later apply only verifies original committed generations',async t=>{
  const f=await fixture(t),p=await f.prepare(),write=CustomLow.prototype.write,read=CustomLow.prototype.read;let wrote=false,writes=0;
  CustomLow.prototype.write=async function(...args){writes++;await write.apply(this,args);wrote=true;};
  CustomLow.prototype.read=async function(...args){if(wrote)throw new Error('synthetic read unavailable');return read.apply(this,args);};
  t.after(()=>{CustomLow.prototype.write=write;CustomLow.prototype.read=read;});
  await assert.rejects(f.execute('apply',{expectedPlanSha:p.planSha}),{code:'RESTORE_OUTCOME_UNKNOWN'});
  CustomLow.prototype.read=read;
  assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'confirmed');assert.equal(writes,1);
});
for(const fault of ['missing-auth','corrupt-auth','missing-ledger','corrupt-ledger','symlink-plan','symlink-source','access-source']) test(`${fault} fails closed with zero business writes`,async t=>{
  const f=await fixture(t),p=await f.prepare(),sourceBytes=await fs.readFile(f.file,'utf8'),authBytes=await fs.readFile(process.env.AUTH_DB_PATH,'utf8');
  t.after(()=>fs.writeFile(process.env.AUTH_DB_PATH,authBytes));
  if(fault==='missing-auth')await fs.unlink(process.env.AUTH_DB_PATH);
  if(fault==='corrupt-auth')await fs.writeFile(process.env.AUTH_DB_PATH,'{}');
  if(fault==='missing-ledger')await fs.unlink(path.join(f.ledgerDirectory,'deletions.v1.log'));
  if(fault==='corrupt-ledger')await fs.writeFile(path.join(f.ledgerDirectory,'deletions.v1.log'),'{}');
  if(fault==='symlink-plan'||fault==='symlink-source'){const file=fault==='symlink-plan'?f.planFile:f.file;await fs.rename(file,file+'.actual');await fs.symlink(file+'.actual',file);}
  if(fault==='access-source')await fs.chmod(f.file,0);
  await assert.rejects(f.execute('apply',{expectedPlanSha:p.planSha}));
  if(fault==='access-source')await fs.chmod(f.file,0o600);
  assert.equal(await fs.readFile(f.file,'utf8'),sourceBytes);
  await assert.rejects(fs.stat(restoreOwnerDirectory(directory,f.owner)),{code:'ENOENT'});
});
test('corrupt attempt remains on disk and denies verification/retry',async t=>{
  const f=await fixture(t),p=await f.prepare();await f.execute('apply',{expectedPlanSha:p.planSha});
  const attempt=path.join(restoreOwnerDirectory(directory,f.owner),`${p.plan.request_id}.json`);await fs.writeFile(attempt,'{"partial":');
  const before=await protectedBytes(f);await assert.rejects(f.execute('apply',{expectedPlanSha:p.planSha}),{code:'RESTORE_ATTEMPT_INVALID'});
  assert.equal(await fs.readFile(attempt,'utf8'),'{"partial":');assert.deepEqual(await protectedBytes(f),before);
});
for(const phase of ['plan-file','plan-directory','attempt-file','attempt-directory']) test(`${phase} fsync failure permits zero business write and never removes partial evidence`,async t=>{
  const f=await fixture(t),p=phase.startsWith('attempt')?await f.prepare():null,before=await protectedBytes(f),open=fs.open;let failed=false;
  fs.open=async function(filename,...args){const handle=await open.call(this,filename,...args),isDirectory=(await handle.stat()).isDirectory();
    const targeted=phase.startsWith('plan')?String(filename)=== (phase==='plan-file'?f.planFile:directory):String(filename).includes('account-restore-attempts-v1');
    if(targeted&&isDirectory===phase.endsWith('directory')){const sync=handle.sync.bind(handle);handle.sync=async()=>{failed=true;throw Object.assign(new Error('synthetic fsync failure'),{code:'EIO'});};}
    return handle;};
  t.after(()=>{fs.open=open;});
  await assert.rejects(f.execute(p?'apply':'prepare',p?{expectedPlanSha:p.planSha}:{}));fs.open=open;
  assert.equal(failed,true);assert.deepEqual(await protectedBytes(f),before);
  if(phase==='plan-file'||phase==='plan-directory')assert.ok(await fs.stat(f.planFile));
  if(phase==='attempt-file') {const names=await fs.readdir(restoreOwnerDirectory(directory,f.owner));assert.equal(names.length,1);const r=await f.execute('apply',{expectedPlanSha:p.planSha});assert.equal(r.outcome,'unconfirmed');assert.equal(r.businessWriteAttempted,false);}
});
test('unknown attempt is also read-only in a new CLI process using a copied plan',async t=>{
  const f=await fixture(t),p=await f.prepare(),original=CustomLow.prototype.write;CustomLow.prototype.write=async()=>{throw new Error('prewrite synthetic failure');};
  try{assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'unconfirmed');}finally{CustomLow.prototype.write=original;}
  const copy=f.planFile+'.copy';await fs.copyFile(f.planFile,copy);const before=await protectedBytes(f);
  const result=f.run('apply-restore-rotation',f.owner,copy,'--apply',p.planSha,'--writers-stopped');assert.equal(result.status,2,result.stderr);assert.equal(JSON.parse(result.stdout).businessWriteAttempted,false);
  assert.deepEqual(await protectedBytes(f),before);
});
for(const kind of ['missing-account','corrupt-account','missing-registry','symlink-auth','symlink-attempt','hardlink-plan','unsupported-mongo','missing-independent-pg'])test(`${kind} rejects without a business replacement`,async t=>{
  const f=await fixture(t),p=await f.prepare(),before=await fs.readFile(f.file,'utf8');
  const restore=[];
  try{
    if(kind==='missing-account'){await fs.rename(f.file,f.file+'.saved');restore.push(()=>fs.rename(f.file+'.saved',f.file));}
    if(kind==='corrupt-account'){await fs.writeFile(f.file,'{"partial":');restore.push(()=>fs.writeFile(f.file,before));}
    if(kind==='missing-registry'){const file=path.join(root,'registry','deletions.v1.receipts');await fs.rename(file,file+'.saved');restore.push(()=>fs.rename(file+'.saved',file));}
    if(kind==='symlink-auth'){const file=process.env.AUTH_DB_PATH;await fs.rename(file,file+'.saved');await fs.symlink(file+'.saved',file);restore.push(async()=>{await fs.unlink(file);await fs.rename(file+'.saved',file);});}
    if(kind==='symlink-attempt'){const ownerDir=restoreOwnerDirectory(directory,f.owner);await fs.mkdir(ownerDir,{recursive:true});await fs.symlink(f.planFile,path.join(ownerDir,`${p.plan.request_id}.json`));}
    if(kind==='hardlink-plan'){await fs.link(f.planFile,f.planFile+'.link');}
    if(kind==='unsupported-mongo'){process.env.MONGODB_URI='mongodb://127.0.0.1:1/synthetic-unused';restore.push(()=>delete process.env.MONGODB_URI);}
    if(kind==='missing-independent-pg'){process.env.SUPABASE_DB_URL='postgresql://127.0.0.1:1/synthetic-unused';restore.push(()=>delete process.env.SUPABASE_DB_URL);}
    await assert.rejects(f.execute('apply',{expectedPlanSha:p.planSha}));
  }finally{for(const fn of restore.reverse())await fn();}
  assert.equal(await fs.readFile(f.file,'utf8'),before);
});
test('same owner concurrent maintenance serializes without reverse lock wait and retires handles',async t=>{
  const f=await fixture(t),p=await f.prepare();
  const reports=await Promise.all(Array.from({length:4},()=>f.execute('apply',{expectedPlanSha:p.planSha})));
  assert.ok(reports.every(r=>r.outcome==='confirmed'));assert.equal(reports.filter(r=>r.businessWriteAttempted).length,1);
});
