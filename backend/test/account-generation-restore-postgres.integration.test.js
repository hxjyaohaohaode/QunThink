import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPostgresTlsConfig } from '../src/models/postgresTls.js';
import { ensureKvSchema } from '../src/models/supabaseAdapter.js';
import { installPostgresLedger } from '../src/services/memory/postgresLedgerInstallation.js';
import { createPostgresDeletionLedger } from '../src/services/memory/postgresDeletionLedger.js';
import { buildRestoreTarget } from '../src/services/accountGenerationRestore.js';
const url=process.env.QUNTHINK_TEST_RESTORE_PG_URL,ledgerUrl=process.env.QUNTHINK_TEST_RESTORE_LEDGER_URL,ca=process.env.QUNTHINK_TEST_RESTORE_PG_CA;
const cwd=fileURLToPath(new URL('..',import.meta.url));
test('isolated real PostgreSQL restoration: existing-only factories, CAS, lease and independent-process receipts', {skip:!url||!ledgerUrl||!ca},async t=>{
  for(const [value,name]of[[url,'qunthink_restore'],[ledgerUrl,'qunthink_restore_ledger']]){const parsed=new URL(value);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.pathname,`/${name}`);}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-restore-pg-')),installationId=randomUUID();
  const ProductionPool=pg.Pool,business=new ProductionPool(buildPostgresTlsConfig(url,ca)),journal=new ProductionPool(buildPostgresTlsConfig(ledgerUrl,ca));
  const originalEnv={...process.env};Object.assign(process.env,{DATA_DIR:directory,SUPABASE_DB_URL:url,SUPABASE_DB_CA_FILE:ca,MEMORY_DELETION_DATABASE_URL:ledgerUrl,MEMORY_DELETION_DATABASE_CA_FILE:ca,MEMORY_DELETION_INSTALLATION_ID:installationId,MEMORY_DELETION_CONNECTION_MODE:'session',MEMORY_DELETION_MODE:'independent'});
  delete process.env.MONGODB_URI;
  await ensureKvSchema(business);await business.query('TRUNCATE kv_store');
  // These exact fixture databases are dedicated to this file, never runtime data.
  await journal.query('DROP TABLE IF EXISTS memory_deletion_tombstones,memory_deletion_accounts,memory_deletion_installation');
  await installPostgresLedger({businessPool:business,ledgerPool:journal,installationId});
  const ledger=createPostgresDeletionLedger({businessPool:business,ledgerPool:journal,installationId,requireBusinessMarker:true});
  const {restoreAccountGenerations}=await import('../src/models/db.js');
  let state={sql:[],updates:0,created:0,closed:0};
  const originalQuery=pg.Client.prototype.query;
  pg.Client.prototype.query=function(sql,...args){state.sql.push(typeof sql==='string'?sql:sql.text);return originalQuery.call(this,sql,...args);};
  pg.Pool=class extends ProductionPool{
    constructor(config){assert.equal(config.ssl.rejectUnauthorized,true);assert.ok(config.ssl.ca);super(config);state.created++;}
    async query(sql,...args){
      if(String(sql).startsWith('UPDATE kv_store')){
        state.updates++;
        if(state.beforeUpdate)await state.beforeUpdate();
        if(state.precommit)throw new Error('synthetic precommit failure');
        const value=await super.query(sql,...args);state.committed=value.rowCount===1;
        if(state.lostAck)throw new Error('synthetic lost ACK');return value;
      }
      if(state.committed&&String(sql).startsWith('SELECT data, revision')&&state.readFailure)throw new Error('synthetic confirmation unavailable');
      if(state.committed&&String(sql).includes("key='memory:deletion-installation'")){state.postMarkerChecks=(state.postMarkerChecks||0)+1;if(state.failFinal&&state.postMarkerChecks===2)throw new Error('synthetic final lease failure');}
      return super.query(sql,...args);
    }
    async end(){state.closed++;return super.end();}
  };
  const reset=extra=>{state={sql:[],updates:0,created:0,closed:0,...extra};};
  const noWrites=()=>assert.equal(state.sql.some(sql=>/^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i.test(sql)),false,state.sql.join('\n'));
  async function fixture(){
    reset();
    const owner=randomUUID(),planFile=path.join(directory,`${owner}.json`),data={groups:[{id:'empty'}],messages:[],preserved:{ciphertext:'synthetic-pg',receipt:['exact',2]},message_order:{version:1,owner_id:owner,groups:[{group_id:'empty',generation:randomUUID(),next_sequence:'1',bindings:[]},{group_id:'deleted',generation:randomUUID(),next_sequence:'9',bindings:[{message_id:'old',sequence:'8'}]}]}};
    await business.query('INSERT INTO kv_store(key,data,revision) VALUES($1,$2,0)',[`user:${owner}`,data]);await ledger.registerNewAccount(owner);await ledger.markDeleted(owner,'deleted-source');
    const execute=(operation,extra={})=>restoreAccountGenerations(owner,{operation,planFile,writersStopped:true,...extra});
    const read=async()=>(await business.query('SELECT data,revision FROM kv_store WHERE key=$1',[`user:${owner}`])).rows[0];
    const prepare=async()=>{const p=await execute('prepare');return {...p,plan:JSON.parse(await fs.readFile(planFile,'utf8'))};};
    const run=(...args)=>spawnSync(process.execPath,['scripts/account-store-maintenance.mjs',...args],{cwd,env:process.env,encoding:'utf8'});
    return{owner,planFile,data,execute,read,prepare,run};
  }
  const ledgerState=async()=>{const value={};for(const table of['memory_deletion_installation','memory_deletion_accounts','memory_deletion_tombstones'])value[table]=(await journal.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;return value;};
  try{
    await t.test('prepare and verify issue no DDL/DML; first CAS advances once and fresh-process retry is read-only',async()=>{
      const f=await fixture(),journalBefore=await ledgerState();reset();const p=await f.prepare();noWrites();assert.equal(state.created,2);assert.equal(state.closed,2);
      reset();assert.equal((await f.execute('verify')).outcome,'unconfirmed');noWrites();
      reset();assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'confirmed');assert.equal(state.updates,1);assert.equal(state.closed,2);
      const row=await f.read();assert.equal(row.revision,'1');assert.deepEqual(row.data,buildRestoreTarget(f.data,p.plan));assert.deepEqual(await ledgerState(),journalBefore);
      const copy=f.planFile+'.copy';await fs.copyFile(f.planFile,copy);const result=f.run('apply-restore-rotation',f.owner,copy,'--apply',p.planSha,'--writers-stopped');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).businessWriteAttempted,false);assert.deepEqual(await f.read(),row);
    });
    for(const marker of[null,{version:2,installationId},{version:1,installationId:randomUUID()}])await t.test(`missing or invalid existing business marker blocks all initialization (${marker?.version??'missing'})`,async()=>{
      const f=await fixture(),saved=(await business.query("SELECT data FROM kv_store WHERE key='memory:deletion-installation'")).rows[0].data;
      if(marker===null)await business.query("DELETE FROM kv_store WHERE key='memory:deletion-installation'");else await business.query("UPDATE kv_store SET data=$1 WHERE key='memory:deletion-installation'",[marker]);
      reset();try{await assert.rejects(f.prepare(),{code:'MEMORY_BARRIER_UNAVAILABLE'});noWrites();assert.equal(state.closed,2);}finally{await business.query("INSERT INTO kv_store(key,data) VALUES('memory:deletion-installation',$1) ON CONFLICT(key) DO UPDATE SET data=$1",[saved]);}
      assert.deepEqual((await f.read()).data,f.data);
    });
    for(const kind of['table','revision'])await t.test(`missing ${kind} never repaired by factory`,async()=>{
      const f=await fixture(),p=await f.prepare();
      await business.query(kind==='table'?'ALTER TABLE kv_store RENAME TO restore_hidden_store':'ALTER TABLE kv_store RENAME COLUMN revision TO restore_hidden_revision');reset();
      try{await assert.rejects(f.execute('verify'));noWrites();assert.equal(state.closed,2);}finally{await business.query(kind==='table'?'ALTER TABLE restore_hidden_store RENAME TO kv_store':'ALTER TABLE kv_store RENAME COLUMN restore_hidden_revision TO revision');}
      assert.deepEqual((await f.read()).data,f.data);
    });
    for(const fault of['lostAck','readFailure','failFinal'])await t.test(`${fault}: one write, exact original target, later read-only confirmation`,async()=>{
      const f=await fixture(),p=await f.prepare();reset({[fault]:true});
      if(fault==='lostAck')assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'confirmed');else await assert.rejects(f.execute('apply',{expectedPlanSha:p.planSha}),{code:'RESTORE_OUTCOME_UNKNOWN'});
      assert.equal(state.updates,1);assert.equal(state.closed,2);const row=await f.read();assert.equal(row.revision,'1');assert.deepEqual(row.data,buildRestoreTarget(f.data,p.plan));
      reset();assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'confirmed');noWrites();assert.deepEqual(await f.read(),row);
    });
    await t.test('two prepared requests cannot bypass first unknown attempt, including another process',async()=>{
      const f=await fixture(),p=await f.prepare(),second=f.planFile+'.second';const p2=await restoreAccountGenerations(f.owner,{operation:'prepare',planFile:second,writersStopped:true});
      reset({precommit:true});assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'unconfirmed');assert.equal(state.updates,1);
      const other=f.run('apply-restore-rotation',f.owner,second,'--apply',p2.planSha,'--writers-stopped');assert.equal(other.status,1);assert.match(other.stderr,/RESTORE_ATTEMPT_EXISTS/);assert.equal((await f.read()).revision,'0');
    });
    for(const kind of['delete','revision'])await t.test(`independent process ${kind} races revision-zero CAS without any fallback INSERT`,async()=>{
      const f=await fixture(),p=await f.prepare();reset({beforeUpdate:async()=>{
        const code=`import pg from 'pg';import {buildPostgresTlsConfig} from './src/models/postgresTls.js';const p=new pg.Pool(buildPostgresTlsConfig(process.env.SUPABASE_DB_URL,process.env.SUPABASE_DB_CA_FILE));await p.query(${JSON.stringify(kind==='delete'?'DELETE FROM kv_store WHERE key=$1':'UPDATE kv_store SET revision=revision+1 WHERE key=$1')},[${JSON.stringify(`user:${f.owner}`)}]);await p.end();`;
        const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd,env:process.env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
      }});
      if(kind==='delete')await assert.rejects(f.execute('apply',{expectedPlanSha:p.planSha}),{code:'RESTORE_OUTCOME_UNKNOWN'});else assert.equal((await f.execute('apply',{expectedPlanSha:p.planSha})).outcome,'unconfirmed');
      assert.equal(state.updates,1);assert.equal(state.sql.some(sql=>/^\s*INSERT/i.test(sql)),false);
      const row=await f.read();if(kind==='delete')assert.equal(row,undefined);else {assert.equal(row.revision,'1');assert.deepEqual(row.data,f.data);}
    });
  }finally{pg.Pool=ProductionPool;pg.Client.prototype.query=originalQuery;await Promise.all([business.end(),journal.end()]);for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv);await fs.rm(directory,{recursive:true,force:true});}
});
