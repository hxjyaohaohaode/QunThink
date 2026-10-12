import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session'; process.env.TRUST_PROXY = '1';
process.env.CORS_ORIGINS = 'http://localhost:3210';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-ws-revoke-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
const { initDatabase, getUserDb } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { setupWebSocket, broadcastToGroup } = await import('../src/websocket/index.js');
const { WebSocketServer, WebSocket } = await import('ws');
const supertest = (await import('supertest')).default;
await initDatabase(); await initAuthDb();
const app = createTestApp(); const request = supertest(app); const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' }); setupWebSocket(wss);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${server.address().port}/ws`;
const sockets = new Set(); let ip = 0; let phone = 200;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function nextMessage(ws, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`missing WS ${kind}`)); }, 3000);
    function cleanup() { clearTimeout(timer); ws.off('message', listen); }
    function listen(data) { const value = JSON.parse(data); if (!kind || value.type === kind) { cleanup(); resolve(value); } }
    ws.on('message', listen);
  });
}
async function account() {
  const response = await request.post('/api/auth/register').send({ username: `ws_${randomUUID().slice(0,8)}`, password: 'Passw0rd123', phone: `13900000${++phone}` });
  assert.equal(response.status, 201); return { id: response.body.user.id, cookie: response.headers['set-cookie'], phone: `13900000${phone}` };
}
async function connect(cookie, origin = 'http://localhost:3210', accepted = true) {
  const headers = { 'x-forwarded-for': `127.1.0.${++ip}` }; if (cookie) headers.Cookie = cookie.map(c => c.split(';')[0]).join('; '); if (origin) headers.Origin = origin;
  const ws = new WebSocket(url, { headers }); sockets.add(ws);
  if (accepted) await nextMessage(ws, 'connected');
  return ws;
}
async function group(user, ws, id = 'identical-group-id') {
  const db = await getUserDb(user.id); await db.read(); db.data.groups.push({ id, name: 'synthetic', ai_members: [] }); await db.write();
  const joined = nextMessage(ws, 'joined_group'); ws.send(JSON.stringify({ type: 'join_group', group_id: id })); await joined; return id;
}
async function closed(ws) { if (ws.readyState === WebSocket.CLOSED) return; await Promise.race([once(ws, 'close'), wait(3000).then(() => { throw new Error('WS not closed'); })]); }
after(async () => { for (const ws of sockets) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); });
test('A/B identical group IDs remain isolated; logout closes only its session and rejects cached reconnection', async () => {
  const a = await account(), b = await account(); const wa = await connect(a.cookie), wb = await connect(b.cookie);
  const second = await request.post('/api/auth/login-phone').send({ phone: a.phone, password: 'Passw0rd123' }); assert.equal(second.status, 200);
  const wa2 = await connect(second.headers['set-cookie']); await group(a, wa); await group(b, wb);
  const joined = nextMessage(wa2, 'joined_group'); wa2.send(JSON.stringify({ type: 'join_group', group_id: 'identical-group-id' })); await joined;
  const otherMessages = []; wb.on('message', data => otherMessages.push(JSON.parse(data)));
  const own = nextMessage(wa, 'marker'); broadcastToGroup('identical-group-id', { type: 'marker' }, a.id); await own; await wait(25);
  assert.equal(otherMessages.some(m => m.type === 'marker'), false);
  const closing = closed(wa); assert.equal((await request.post('/api/auth/logout').set('Cookie', a.cookie)).status, 200); await closing;
  assert.equal(wa2.readyState, WebSocket.OPEN); assert.equal(wb.readyState, WebSocket.OPEN);
  const stale = await connect(a.cookie, undefined, false); await closed(stale);
  assert.equal((await request.get('/api/auth/me').set('Cookie', a.cookie)).status, 401);
});
test('the oldest session is closed immediately when a sixth login prunes it', async () => {
  const a = await account(); const ws = await connect(a.cookie); const closing = closed(ws);
  for (let i = 0; i < 5; i++) assert.equal((await request.post('/api/auth/login-phone').send({ phone: a.phone, password: 'Passw0rd123' })).status, 200);
  await closing; assert.equal((await request.get('/api/auth/me').set('Cookie', a.cookie)).status, 401);
});
test('wrong Origin and missing cookie cannot receive connected admission', async () => {
  const a = await account(); const wrong = await connect(a.cookie, 'https://untrusted.invalid', false); await closed(wrong);
  const missing = await connect(undefined, undefined, false); await closed(missing);
});
for (const mode of ['precommit', 'lost-ack', 'unknown']) {
  test(`logout ${mode} failure closes the socket and re-reads authority rather than assuming success`, async () => {
    const a = await account(); const ws = await connect(a.cookie); const closing = closed(ws);
    const db = getAuthDb(); const write = db.write.bind(db), read = db.read.bind(db); let failed = false;
    db.write = async () => { if (mode !== 'precommit') await write(); failed = true; throw new Error(`synthetic ${mode}`); };
    if (mode === 'unknown') db.read = async (...args) => { if (failed) throw new Error('synthetic unreadable authority'); return read(...args); };
    let result; try { result = await request.post('/api/auth/logout').set('Cookie', a.cookie); } finally { db.write = write; db.read = read; }
    await closing; assert.equal(result.status, mode === 'unknown' ? 503 : 500);
    if (mode === 'unknown') assert.equal(result.body.code, 'SESSION_UPDATE_UNKNOWN');
    await read({ force: true });
    assert.equal((await request.get('/api/auth/me').set('Cookie', a.cookie)).status, mode === 'precommit' ? 200 : 401);
  });
}

async function deadlineFor(user, milliseconds) {
  const token = user.cookie.find(c=>c.startsWith('session_token=')).split(';')[0].split('=')[1];
  const db=getAuthDb();await db.read();const expiresAt=Date.now()+milliseconds;
  db.data.sessions.find(s=>s.token===token).expires_at=new Date(expiresAt).toISOString();await db.write();return expiresAt;
}
test('natural idle expiry terminates its socket without affecting another session of the same user', async () => {
  const a=await account();await deadlineFor(a,1000);const first=await connect(a.cookie);await group(a,first);
  const second=await request.post('/api/auth/login-phone').send({phone:a.phone,password:'Passw0rd123'});assert.equal(second.status,200);
  const live=await connect(second.headers['set-cookie']);let joining=nextMessage(live,'joined_group');live.send(JSON.stringify({type:'join_group',group_id:'identical-group-id'}));await joining;
  const leaked=[];first.on('message',data=>leaked.push(JSON.parse(data)));await closed(first);
  const delivered=nextMessage(live,'after_expiry');broadcastToGroup('identical-group-id',{type:'after_expiry'},a.id);await delivered;
  assert.equal(leaked.some(m=>m.type==='after_expiry'),false);assert.equal(live.readyState,WebSocket.OPEN);
});
test('forward wall-clock jump rejects an outbound message before the natural timer wakes', async () => {
  const a=await account();const expires=await deadlineFor(a,60000);const ws=await connect(a.cookie);await group(a,ws);
  const seen=[];ws.on('message',data=>seen.push(JSON.parse(data)));const now=Date.now;
  try { Date.now=()=>expires;broadcastToGroup('identical-group-id',{type:'jumped'},a.id);await closed(ws); }
  finally { Date.now=now; }
  assert.equal(seen.some(m=>m.type==='jumped'),false);
});
test('buffered data queued before expiry is dropped when the flush deadline has passed', async () => {
  const a=await account();const expires=await deadlineFor(a,60000);const ws=await connect(a.cookie);await group(a,ws);
  const seen=[];ws.on('message',data=>seen.push(JSON.parse(data)));const now=Date.now;
  try { broadcastToGroup('identical-group-id',{type:'buffered'},a.id);Date.now=()=>expires;await closed(ws); }
  finally { Date.now=now; }
  assert.equal(seen.some(m=>m.type==='buffered'),false);
});
test('default thirty-day expiry is segmented instead of overflowing Node timers', async () => {
  const warnings=[];const onWarning=warning=>warnings.push(warning.name);process.on('warning',onWarning);
  try { const a=await account();const ws=await connect(a.cookie);await wait(80);assert.equal(ws.readyState,WebSocket.OPEN);assert.ok(!warnings.includes('TimeoutOverflowWarning')); }
  finally { process.off('warning',onWarning); }
});
test('expiry while join_group awaits storage cannot reinsert a stale subscription', async () => {
  const a=await account();await deadlineFor(a,1000);const ws=await connect(a.cookie);const db=await getUserDb(a.id);await db.read();
  db.data.groups.push({id:'slow-join',name:'slow',ai_members:[]});await db.write();
  const original=db.read.bind(db);let release,entered;const started=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
  db.read=async(...args)=>{entered();await gate;return original(...args);};
  const seen=[];ws.on('message',data=>seen.push(JSON.parse(data)));
  const debug=console.debug;const diagnostics=[];console.debug=(...args)=>{diagnostics.push(args.join(' '));debug(...args);};
  try {ws.send(JSON.stringify({type:'join_group',group_id:'slow-join'}));await started;await closed(ws);release();await wait(25);broadcastToGroup('slow-join',{type:'ghost'},a.id);await wait(20);
    assert.ok(diagnostics.some(line=>line.includes('Group slow-join')&&line.includes('subscribers: 0')),'no stale subscription may survive delayed storage');}
  finally {release();db.read=original;console.debug=debug;}
  assert.equal(seen.some(m=>m.type==='joined_group'||m.type==='ghost'),false);
});
test('logout cancels its expiry timer and leaves the other session live across the old deadline', async () => {
  const schedule=globalThis.setTimeout, cancel=globalThis.clearTimeout;
  const handles=new Set(), cancelled=new Set();
  globalThis.setTimeout=(callback,delay,...args)=>{const handle=schedule(callback,delay,...args);if(delay>0&&delay<800&&String(callback).includes('isClientActive'))handles.add(handle);return handle;};
  globalThis.clearTimeout=handle=>{if(handles.has(handle))cancelled.add(handle);return cancel(handle);};
  try {
    const a=await account();await deadlineFor(a,700);const ws=await connect(a.cookie);assert.equal(handles.size,1);
    const second=await request.post('/api/auth/login-phone').send({phone:a.phone,password:'Passw0rd123'});assert.equal(second.status,200);const live=await connect(second.headers['set-cookie']);
    const end=closed(ws);assert.equal((await request.post('/api/auth/logout').set('Cookie',a.cookie)).status,200);await end;
    assert.equal(cancelled.size,1,'logout must cancel the actual admitted expiry handle');await wait(750);
    assert.equal(live.readyState,WebSocket.OPEN);const pong=nextMessage(live,'pong');live.send(JSON.stringify({type:'ping'}));await pong;
  } finally {globalThis.setTimeout=schedule;globalThis.clearTimeout=cancel;}
});

test('authoritative recheck refreshes a still-live session deadline', async () => {
  const a=await account();const oldExpiry=await deadlineFor(a,120000);const ws=await connect(a.cookie);await group(a,ws);
  const token=a.cookie.find(c=>c.startsWith('session_token=')).split(';')[0].split('=')[1];const db=getAuthDb();await db.read();
  db.data.sessions.find(s=>s.token===token).expires_at=new Date(oldExpiry+120000).toISOString();await db.write();const now=Date.now;
  try {
    Date.now=()=>oldExpiry-59000;const pong=nextMessage(ws,'pong');ws.send(JSON.stringify({type:'ping'}));await pong;
    Date.now=()=>oldExpiry+1000;const delivered=nextMessage(ws,'renewed');broadcastToGroup('identical-group-id',{type:'renewed'},a.id);await delivered;
    assert.equal(ws.readyState,WebSocket.OPEN);
  } finally { Date.now=now; }
});
