import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
process.env.NODE_ENV='test'; process.env.AUTH_MODE='session';
process.env.DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-ordered-http-'));
process.env.AUTH_DB_PATH=path.join(process.env.DATA_DIR,'auth.json');
process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
for(const name of Object.keys(process.env))if(/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(name))delete process.env[name];
const {initializeEmptyInstallation,initDatabase,getUserDb}=await import('../src/models/db.js');
const {initAuthDb}=await import('../src/models/authDb.js');
const {validateMessageOrder,prepareOrderedGroup}=await import('../src/services/messageOrder.js');
const {createTestApp}=await import('./helpers/createTestApp.js');
const request=(await import('supertest')).default(createTestApp());
await initializeEmptyInstallation();await initDatabase();await initAuthDb();
async function fixture(){
 const r=await request.post('/api/auth/register').send({username:`ordered_${randomUUID()}`,password:'SyntheticFixtureOnly2026!'});
 assert.equal(r.status,201,JSON.stringify(r.body));const user={id:r.body.user.id,cookie:r.headers['set-cookie']};
 user.db=await getUserDb(user.id);const gs=await request.get('/api/groups').set('Cookie',user.cookie);assert.equal(gs.status,200);
 user.group=gs.body[0].id;return user;
}
const post=(u,body)=>request.post(`/api/groups/${u.group}/messages`).set('Cookie',u.cookie).send(body);
async function stored(u){await u.db.read({force:true});validateMessageOrder(u.db.data,u.id);return structuredClone(u.db.data);}
async function models(u){await u.db.read();u.db.data.modelCatalog={revision:0,providers:[],models:['fixture_a','fixture_b','fixture_c'].map(id=>({id,name:id,enabled:true,capabilities:['chat']})),defaults:{chat:null,vision:null,tts:null}};await u.db.write();}

test('real user POST commits message+sequence and replays the same encrypted record without allocating another sequence',async()=>{
 const u=await fixture(),body={content:'same millisecond payload',clientMessageId:randomUUID()};
 const a=await post(u,body);assert.equal(a.status,201,JSON.stringify(a.body));assert.equal(a.body.server_order.sequence,'1');
 const first=await stored(u),raw=first.messages.find(m=>m.id===a.body.id);
 const b=await post(u,body);assert.equal(b.status,200,JSON.stringify(b.body));assert.equal(b.body.id,a.body.id);assert.deepEqual(b.body.server_order,a.body.server_order);
 const next=await stored(u);assert.equal(next.messages.length,1);assert.deepEqual(next.messages[0],raw);assert.equal(next.message_order.groups.find(g=>g.group_id===u.group).next_sequence,'2');
 const conflict=await post(u,{...body,content:'different'});assert.equal(conflict.status,409);
});
test('concurrent identical request IDs have one authoritative message and sequence',async()=>{
 const u=await fixture(),body={content:'one intent',clientMessageId:randomUUID()};const rs=await Promise.all([post(u,body),post(u,body),post(u,body)]);
 assert.deepEqual(rs.map(r=>r.status).sort(),[200,200,201]);assert.equal(new Set(rs.map(r=>r.body.id)).size,1);assert.equal((await stored(u)).messages.length,1);
});
test('all three group creation routes commit empty group order and concurrent private lookup creates one group',async()=>{
 const u=await fixture();await models(u);
 const normal=await request.post('/api/groups').set('Cookie',u.cookie).send({name:'ordered group',ai_members:['fixture_a','fixture_b']});assert.equal(normal.status,201,JSON.stringify(normal.body));
 const rs=await Promise.all([request.post('/api/private-chat/fixture_a').set('Cookie',u.cookie),request.post('/api/private-chat/fixture_a').set('Cookie',u.cookie)]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,201]);assert.equal(rs[0].body.id,rs[1].body.id);
 const multi=await request.post('/api/ai-private-chat').set('Cookie',u.cookie).send({aiMembers:['fixture_b','fixture_c']});assert.equal(multi.status,201,JSON.stringify(multi.body));
 const data=await stored(u);for(const id of [normal.body.id,rs[0].body.id,multi.body.id]){const row=data.message_order.groups.find(g=>g.group_id===id);assert.equal(row.next_sequence,'1');assert.deepEqual(row.bindings,[]);}
});
test('member join and leave each commit original system message identity with membership and order',async()=>{
 const u=await fixture();await models(u);await u.db.read();u.db.data.groups.find(g=>g.id===u.group).ai_members=['fixture_a','fixture_b'];await u.db.write();
 const add=await request.post(`/api/groups/${u.group}/members`).set('Cookie',u.cookie).send({aiId:'fixture_c'});assert.equal(add.status,200,JSON.stringify(add.body));assert.equal(add.body.systemMessage.server_order.sequence,'1');
 const remove=await request.delete(`/api/groups/${u.group}/members/fixture_c`).set('Cookie',u.cookie);assert.equal(remove.status,200,JSON.stringify(remove.body));assert.equal(remove.body.systemMessage.server_order.sequence,'2');
 const data=await stored(u);assert.deepEqual(data.groups.find(g=>g.id===u.group).ai_members,['fixture_a','fixture_b']);assert.deepEqual(data.messages.map(m=>m.id),[add.body.systemMessage.id,remove.body.systemMessage.id]);
});
test('cross-owner and anonymous writes do not disclose or consume sequence',async()=>{
 const a=await fixture(),b=await fixture();a.group=randomUUID();await a.db.read();await a.db.write({snapshot:prepareOrderedGroup(a.db.data,a.id,{id:a.group,name:'A only',created_at:new Date().toISOString()},{generation:randomUUID()})});const response=await request.post(`/api/groups/${a.group}/messages`).set('Cookie',b.cookie).send({content:'not mine'});assert.equal(response.status,404);
 assert.equal((await request.post(`/api/groups/${a.group}/messages`).send({content:'anonymous'})).status,401);assert.equal((await stored(a)).messages.length,0);assert.equal((await stored(b)).messages.length,0);
});

for (const mode of ['precommit','lost-ack','cas-twice','cas-exhausted']) {
 test(`user HTTP ${mode} never allocates a replacement ID or ciphertext inside retries`,async()=>{
  const u=await fixture(),original=u.db.write,seen=[];
  u.db.write=async function(options){seen.push(structuredClone(options.snapshot));
   if(mode==='precommit')throw new Error('synthetic before commit');
   if(mode==='cas-exhausted'||(mode==='cas-twice'&&seen.length<=2))throw Object.assign(new Error('synthetic compare conflict'),{code:'REVISION_CONFLICT',status:409});
   await original.call(this,options);if(mode==='lost-ack')throw Object.assign(new Error('synthetic lost ACK'),{code:'WRITE_ACK_UNKNOWN'});
  };
  let response;try{response=await post(u,{content:'fixed encrypted prepared bytes',clientMessageId:randomUUID()});}finally{u.db.write=original;}
  assert.equal(response.status,mode==='lost-ack'?200:mode==='cas-twice'?201:mode==='cas-exhausted'?409:503,JSON.stringify(response.body));
  assert.equal(seen.length,mode.startsWith('cas-')?3:1);
  for(const snapshot of seen.slice(1)){assert.deepEqual(snapshot.messages,seen[0].messages);assert.deepEqual(snapshot.message_order,seen[0].message_order);assert.deepEqual(snapshot.groups,seen[0].groups);assert.deepEqual(snapshot.messageIdempotency,seen[0].messageIdempotency);}
  const data=await stored(u);assert.equal(data.messages.length,mode==='lost-ack'||mode==='cas-twice'?1:0);
  if(mode==='precommit')assert.equal(response.body.code,'MESSAGE_COMMIT_UNKNOWN');
 });
}

test('committed but unreadable ACK returns unknown and later same-client replay recovers the sole original message',async()=>{
 const u=await fixture(),write=u.db.write,read=u.db.read;let committed=false,calls=0;
 u.db.write=async function(options){calls++;await write.call(this,options);committed=true;throw new Error('synthetic lost ACK');};
 u.db.read=async function(options){if(committed)throw new Error('synthetic unreadable reconciliation');return read.call(this,options);};
 const body={content:'recover later with original UUID',clientMessageId:randomUUID()};let failed;
 try{failed=await post(u,body);}finally{u.db.write=write;u.db.read=read;}
 assert.equal(failed.status,503);assert.equal(failed.body.code,'MESSAGE_COMMIT_UNKNOWN');assert.equal(calls,1);
 const data=await stored(u),original=data.messages[0];const retry=await post(u,body);assert.equal(retry.status,200);assert.equal(retry.body.id,original.id);assert.equal((await stored(u)).messages.length,1);
});

for(const kind of ['ordinary-group','private-group','multi-group','member-join','member-leave']){
 for(const mode of ['precommit','lost-ack'])test(`${kind} ${mode} atomically preserves group/message/order and does not retry the write`,async()=>{
  const u=await fixture();await models(u);await u.db.read();u.db.data.groups.find(g=>g.id===u.group).ai_members=['fixture_a','fixture_b',...(kind==='member-leave'?['fixture_c']:[])];await u.db.write();
  const before=await stored(u),write=u.db.write;let calls=0;
  u.db.write=async function(options){calls++;if(mode==='lost-ack')await write.call(this,options);throw new Error('synthetic write outcome unknown');};
  let response;try{
   const base=request[kind==='member-leave'?'delete':'post'](kind==='ordinary-group'?'/api/groups':kind==='private-group'?'/api/private-chat/fixture_a':kind==='multi-group'?'/api/ai-private-chat':`/api/groups/${u.group}/members${kind==='member-leave'?'/fixture_c':''}`).set('Cookie',u.cookie);
   response=await base.send(kind==='ordinary-group'?{name:'fixed group',ai_members:['fixture_a']}:kind==='multi-group'?{aiMembers:['fixture_a','fixture_b']}:kind==='member-join'?{aiId:'fixture_c'}:{});
  }finally{u.db.write=write;}
  assert.equal(response.status,mode==='precommit'?503:200,JSON.stringify(response.body));assert.equal(calls,1);
  const after=await stored(u);if(mode==='precommit')assert.deepEqual(after,before);
  else if(kind.includes('group')){assert.equal(after.groups.length,before.groups.length+1);assert.equal(after.message_order.groups.length,before.message_order.groups.length+1);}
  else{assert.equal(after.messages.length,1);assert.equal(response.body.systemMessage.id,after.messages[0].id);assert.equal(after.message_order.groups.find(g=>g.group_id===u.group).bindings.length,1);}
 });
}

test('deleted original same-client request returns 410 and does not reuse its consumed sequence',async()=>{
 const u=await fixture(),body={content:'remove then replay',clientMessageId:randomUUID()};const created=await post(u,body);assert.equal(created.status,201);
 assert.equal((await request.delete(`/api/messages/${created.body.id}`).set('Cookie',u.cookie)).status,200);
 const retry=await post(u,body);assert.equal(retry.status,410,JSON.stringify(retry.body));const data=await stored(u);assert.equal(data.message_order.groups.find(g=>g.group_id===u.group).next_sequence,'2');
});

test('concurrent member join commits one system record and rejects the second actual membership change',async()=>{
 const u=await fixture();await models(u);await u.db.read();u.db.data.groups.find(g=>g.id===u.group).ai_members=['fixture_a','fixture_b'];await u.db.write();
 const rs=await Promise.all(Array.from({length:2},()=>request.post(`/api/groups/${u.group}/members`).set('Cookie',u.cookie).send({aiId:'fixture_c'})));
 assert.deepEqual(rs.map(r=>r.status).sort(),[200,400]);assert.equal((await stored(u)).messages.length,1);
});
