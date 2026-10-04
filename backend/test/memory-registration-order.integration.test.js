import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-ledger-registration-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;
await initDatabase();
await initAuthDb();
const request = supertest(createTestApp());

test('auth write failure after ledger provisioning does not expose a half-registered account', async () => {
  const db = getAuthDb();
  const originalWrite = db.write.bind(db);
  const username = `ledger_${randomUUID().slice(0, 8)}`;
  db.write = async () => { throw new Error('injected auth commit failure'); };
  let failed;
  try {
    failed = await request.post('/api/auth/register')
      .send({ username, password: 'Passw0rd123' });
  } finally {
    db.write = originalWrite;
  }
  assert.equal(failed.status, 500);
  assert.equal(db.data.users.some(user => user.username === username), false);
  assert.equal(db.data.sessions.some(session =>
    db.data.users.some(user => user.id === session.userId && user.username === username)), false);
  await db.read();
  assert.equal(db.data.users.some(user => user.username === username), false);

  const retry = await request.post('/api/auth/register')
    .send({ username, password: 'Passw0rd123' });
  assert.equal(retry.status, 201);
  assert.equal(db.data.users.filter(user => user.username === username).length, 1);
});

test('registration returns a usable session when the auth write committed but its receipt was lost', async () => {
  const db = getAuthDb();
  const originalWrite = db.write.bind(db);
  const username = `receipt_${randomUUID().slice(0, 8)}`;
  db.write = async () => {
    await originalWrite();
    throw new Error('injected lost auth receipt');
  };
  let response;
  try {
    response = await request.post('/api/auth/register')
      .send({ username, password: 'Passw0rd123' });
  } finally {
    db.write = originalWrite;
  }
  assert.equal(response.status, 201);
  assert.equal(db.data.users.filter(user => user.username === username).length, 1);
  assert.equal(db.data.sessions.filter(session => session.userId === response.body.user.id).length, 1);
  const me = await request.get('/api/auth/me').set('Cookie', response.headers['set-cookie']);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, response.body.user.id);
});
