import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
process.env.NODE_ENV='test';process.env.AUTH_MODE='session';process.env.CORS_ORIGINS='http://localhost:3210';
process.env.DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'qunthink-order-ws-'));
process.env.AUTH_DB_PATH=path.join(process.env.DATA_DIR,'auth.json');process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
for(const name of Object.keys(process.env))if(/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(name))delete process.env[name];
const {initializeEmptyInstallation,initDatabase,getUserDb}=await import('../src/models/db.js');
const {initAuthDb}=await import('../src/models/authDb.js');
const {createTestApp}=await import('./helpers/createTestApp.js');
const {setupWebSocket}=await import('../src/websocket/index.js');
const {WebSocketServer,WebSocket}=await import('ws');
await initializeEmptyInstallation();await initDatabase();await initAuthDb();
const app=createTestApp(),server=http.createServer(app),wss=new WebSocketServer({server,path:'/ws'});setupWebSocket(wss);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const request=(await import('supertest')).default(server),sockets=[];
after(async()=>{for(const socket of sockets)socket.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function packet(socket,type){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off('message',listen);reject(new Error(`missing ${type}`));},3000);function listen(bytes){const item=JSON.parse(bytes);if(item.type===type){clearTimeout(timer);socket.off('message',listen);resolve(item);}}socket.on('message',listen);});}
async function fixture(){
 const r=await request.post('/api/auth/register').send({username:`ws_order_${randomUUID()}`,password:'SyntheticFixtureOnly2026!'});assert.equal(r.status,201);
 const user={id:r.body.user.id,cookie:r.headers['set-cookie'],group:'group-presidential'};user.db=await getUserDb(user.id);
 const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`,{headers:{Cookie:user.cookie.map(c=>c.split(';')[0]).join('; '),Origin:'http://localhost:3210'}});sockets.push(socket);await packet(socket,'connected');
 const joined=packet(socket,'joined_group');socket.send(JSON.stringify({type:'join_group',group_id:user.group}));await joined;
 user.socket=socket;user.seen=[];socket.on('message',bytes=>user.seen.push(JSON.parse(bytes)));return user;
}
const post=(user,body)=>request.post(`/api/groups/${user.group}/messages`).set('Cookie',user.cookie).send(body);

test('HTTP candidate is invisible to concurrent reader and live WS until actual durable ACK; saved envelope preserves original identity',async()=>{
 const user=await fixture(),write=user.db.write;let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 user.db.write=async function(options){entered();await gate;return write.call(this,options);};
 let readFinished=false;
 try{
  const pending=post(user,{content:'held until ACK',clientMessageId:randomUUID()}).then(r=>r);await started;
  const reading=request.get(`/api/groups/${user.group}/messages`).set('Cookie',user.cookie).then(r=>{readFinished=true;return r;});
  await wait(30);assert.equal(readFinished,false);assert.equal(user.db.data.messages.length,0);assert.equal(user.seen.filter(p=>p.type==='new_message').length,0);
  release();const response=await pending;assert.equal(response.status,201,JSON.stringify(response.body));const read=await reading;assert.equal(read.status,200);await wait(30);
  const messages=user.seen.filter(p=>p.type==='new_message');assert.equal(messages.length,1);const event=messages[0];
  assert.equal(event.id,response.body.id);assert.equal(event.created_at,response.body.created_at);assert.deepEqual(event.server_order,response.body.server_order);assert.equal(event.durable,true);assert.equal(event.persistence_status,'confirmed');assert.equal(read.body.messages[0].id,event.id);
 }finally{release();user.db.write=write;}
});

for(const mode of ['precommit','lost-ack'])test(`HTTP ${mode} creates no duplicate live event and preserves authoritative outcome`,async()=>{
 const user=await fixture(),write=user.db.write;let writes=0;
 user.db.write=async function(options){writes++;if(mode==='lost-ack')await write.call(this,options);throw new Error('synthetic ACK unknown');};
 let response;try{response=await post(user,{content:'no false publication',clientMessageId:randomUUID()});}finally{user.db.write=write;}
 assert.equal(response.status,mode==='precommit'?503:200);assert.equal(writes,1);await wait(30);assert.equal(user.seen.filter(p=>p.type==='new_message').length,0);
 await user.db.read({force:true});assert.equal(user.db.data.messages.length,mode==='precommit'?0:1);
});

test('two actual owner sockets with identical preset group IDs receive only their own persisted events',async()=>{
 const a=await fixture(),b=await fixture();const response=await post(a,{content:'A scope only',clientMessageId:randomUUID()});assert.equal(response.status,201);await wait(35);
 assert.equal(a.seen.filter(p=>p.type==='new_message').length,1);assert.equal(b.seen.filter(p=>p.type==='new_message').length,0);
 assert.equal(a.seen.find(p=>p.type==='new_message').id,response.body.id);
});
