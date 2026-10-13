import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-account-http-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
for (const name of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(name)) delete process.env[name];
const { initializeEmptyInstallation, initDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb } = await import('../src/models/authDb.js');
const { validateMessageOrder } = await import('../src/services/messageOrder.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;
await initializeEmptyInstallation(); await initDatabase(); await initAuthDb();
const request = supertest(createTestApp());
let sequence = 0;
const register = phone => request.post('/api/auth/register').send({ username:`lifecycle_${++sequence}`, password:'SyntheticFixtureOnly2026!', ...(phone ? {phone} : {}) });
const userFile = id => path.join(process.env.DATA_DIR,'users',`db_${id}.json`);
async function admitted() {
  const response = await register(); assert.equal(response.status,201,JSON.stringify(response.body));
  return { id:response.body.user.id, cookie:response.headers['set-cookie'] };
}
const groups = user => request.get('/api/groups').set('Cookie',user.cookie);

test('real HTTP admission publishes required default groups and a usable independent deletion ledger', async () => {
  const user = await admitted(), response = await groups(user);
  assert.equal(response.status,200,JSON.stringify(response.body)); assert.equal(response.body.length,3);
  const db = await getUserDb(user.id); validateMessageOrder(db.data,user.id);
  assert.equal(db.data.message_order.groups.length,3);
  assert.ok(db.data.message_order.groups.every(row=>row.next_sequence==='1' && row.bindings.length===0));
});

test('concurrent same-phone HTTP registration publishes one account/session and one business document', { timeout:15000 }, async () => {
  const phone='13900000501', responses=await Promise.all(Array.from({length:3},()=>register(phone)));
  assert.deepEqual(responses.map(response=>response.status).sort(),[201,409,409]);
  const auth=getAuthDb(); await auth.read({force:true});
  const accounts=auth.data.users.filter(user=>user.phone===phone); assert.equal(accounts.length,1);
  assert.equal(auth.data.sessions.filter(session=>session.userId===accounts[0].id).length,1);
  const winner=responses.find(response=>response.status===201);
  assert.equal((await groups({cookie:winner.headers['set-cookie']})).status,200);
  const stored=JSON.parse(await fs.readFile(userFile(accounts[0].id),'utf8')); validateMessageOrder(stored,accounts[0].id);
});

test('deleting every real group remains empty after cache retirement and a fresh process while B retains its own groups', async () => {
  const a=await admitted(),b=await admitted();
  const initial=await groups(a);assert.equal(initial.status,200);
  const original=JSON.parse(await fs.readFile(userFile(a.id),'utf8')).message_order;
  for (const group of initial.body) {
    const removed=await request.delete(`/api/groups/${group.id}`).set('Cookie',a.cookie);
    assert.equal(removed.status,200,JSON.stringify(removed.body));
  }
  clearUserDbCache(a.id); const empty=await groups(a);
  assert.equal(empty.status,200,JSON.stringify(empty.body));assert.deepEqual(empty.body,[]);
  const db=await getUserDb(a.id);assert.deepEqual(db.data.groups,[]);assert.deepEqual(db.data.message_order,original);
  const code=`const {getUserDb}=await import(${JSON.stringify(new URL('../src/models/db.js',import.meta.url).href)});const db=await getUserDb(process.argv[1]);process.stdout.write(JSON.stringify({groups:db.data.groups,order:db.data.message_order}));`;
  const child=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,a.id],{encoding:'utf8',env:process.env,stdio:['ignore','pipe','pipe']}));
  assert.deepEqual(child,{groups:[],order:original});
  const bGroups=await request.get(`/api/groups?userId=${a.id}`).set('Cookie',b.cookie);
  assert.equal(bGroups.status,200);assert.equal(bGroups.body.length,3);
  assert.equal((await request.get('/api/groups')).status,401);
});

for (const [name, replacement, expectedCode] of [['missing',undefined,'ACCOUNT_DATA_MISSING'],['null','null','ACCOUNT_DATA_INVALID'],['corrupt','{}{}','ACCOUNT_DATA_CORRUPT'],['legacy-without-order','{"groups":[],"messages":[]}','MESSAGE_ORDER_UNAVAILABLE']]) {
  test(`existing authenticated account with ${name} store cannot become a new empty account through HTTP`,async()=>{
    const user=await admitted(),file=userFile(user.id),original=await fs.readFile(file,'utf8'),backup=file+'.fixture-original';
    await fs.rename(file,backup); if(replacement!==undefined)await fs.writeFile(file,replacement,{flag:'wx'});
    clearUserDbCache(user.id);
    try {
      const response=await groups(user);assert.equal(response.status,503,JSON.stringify(response.body));assert.equal(response.body.code,expectedCode);
      if(replacement===undefined)await assert.rejects(fs.stat(file),error=>error.code==='ENOENT');
      else assert.equal(await fs.readFile(file,'utf8'),replacement);
      assert.equal(await fs.readFile(backup,'utf8'),original);
      const auth=getAuthDb();await auth.read({force:true});assert.equal(auth.data.users.filter(entry=>entry.id===user.id).length,1);
    } finally {
      if(replacement!==undefined)await fs.unlink(file);
      await fs.rename(backup,file);clearUserDbCache(user.id);
    }
    assert.equal((await groups(user)).status,200);
  });
}
