import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
process.env.NODE_ENV = 'production';
process.env.AUTH_MODE = 'session';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-sms-registration-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
// Synthetic SDK settings; the returned SDK method is replaced before requests.
process.env.ALIYUN_ACCESS_KEY_ID = 'synthetic-test';
process.env.ALIYUN_ACCESS_KEY_SECRET = 'synthetic-test';
const { initDatabase, getUserDb } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb } = await import('../src/models/authDb.js');
const { initSmsClient } = await import('../src/services/sms/index.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const smsRouter = (await import('../src/routes/sms.js')).default;
const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const supertest = (await import('supertest')).default;
await initDatabase(); await initAuthDb();
const client = initSmsClient();
let verifyCalls = 0;
client.checkSmsVerifyCodeWithOptions = async () => { verifyCalls++; return { body: { code: 'OK', model: { verifyResult: 'PASS' } } }; };
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api', smsRouter); app.use(errorHandler);
const request = supertest(app);
const api = supertest(createTestApp());
const verify = phone => request.post('/api/sms/verify').send({ phone, code: '123456' });
async function usable(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const cookie = response.headers['set-cookie'];
  assert.match(cookie[0], /Secure/); assert.match(cookie[0], /HttpOnly/);
  const groups = await api.get('/api/groups').set('Cookie', cookie);
  assert.equal(groups.status, 200, JSON.stringify(groups.body));
  const db = await getUserDb(response.body.user.id);
  assert.ok(db.data.groups.length);
}
test('first production SMS login provisions the ledger before returning a usable account', async () => {
  const response = await verify('13900000101');
  await usable(response); assert.equal(response.body.isNewUser, true);
});
test('three concurrent same-phone verifications publish one authoritative account with three sessions', { timeout: 15000 }, async () => {
  const responses = await Promise.all(Array.from({ length: 3 }, () => verify('13900000102')));
  for (const response of responses) await usable(response);
  assert.equal(new Set(responses.map(r => r.body.user.id)).size, 1);
  assert.equal(responses.filter(r => r.body.isNewUser).length, 1);
  const db = getAuthDb(); await db.read({ force: true });
  assert.equal(db.data.users.filter(u => u.phone === '13900000102').length, 1);
  assert.equal(db.data.sessions.filter(s => s.userId === responses[0].body.user.id).length, 3);
});
test('different concurrent registrations do not deadlock auth and memory initialization locks', { timeout: 15000 }, async () => {
  const responses = await Promise.all(['13900000103','13900000104','13900000105'].map(verify));
  for (const response of responses) await usable(response);
  assert.equal(new Set(responses.map(r => r.body.user.id)).size, 3);
});
test('precommit auth failure is re-read and cannot publish a half registered user', async () => {
  const db = getAuthDb(); const original = db.write.bind(db);
  db.write = async () => { throw new Error('synthetic precommit failure'); };
  let response; try { response = await verify('13900000106'); } finally { db.write = original; }
  assert.equal(response.status, 500); assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(db.data.users.some(u => u.phone === '13900000106'), false);
  await usable(await verify('13900000106'));
});
test('commit with lost acknowledgement returns the existing authoritative account/session', async () => {
  const db = getAuthDb(); const original = db.write.bind(db);
  db.write = async () => { await original(); throw new Error('synthetic lost acknowledgement'); };
  let response; try { response = await verify('13900000107'); } finally { db.write = original; }
  await usable(response);
  await db.read({ force: true }); assert.equal(db.data.users.filter(u => u.phone === '13900000107').length, 1);
});
test('missing SMS configuration is a controlled 503 and never invokes a provider', async () => {
  delete process.env.ALIYUN_ACCESS_KEY_ID; delete process.env.ALIYUN_ACCESS_KEY_SECRET;
  initSmsClient(); const before = verifyCalls;
  assert.equal((await verify('13900000108')).status, 503);
  assert.equal((await request.post('/api/sms/send').send({ phone: '13900000108' })).status, 503);
  assert.equal(verifyCalls, before);
});
