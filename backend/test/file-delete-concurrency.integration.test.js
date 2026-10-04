import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-file-delete-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase, getUserDb, getUploadsDir, withWriteLock } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();
const request = supertest(createTestApp());

async function fixture() {
  const username = `filedelete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const registered = await request.post('/api/auth/register').send({ username, password: 'Passw0rd123', nickname: '文件删除测试' });
  assert.equal(registered.status, 201);
  const cookie = registered.headers['set-cookie'];
  const groups = await request.get('/api/groups').set('Cookie', cookie);
  assert.equal(groups.status, 200);
  const groupId = groups.body[0].id;
  const userId = registered.body.user?.id || registered.body.id;
  const fileId = `file_${Math.random().toString(36).slice(2)}`;
  const filename = `${fileId}.txt`;
  const filePath = path.join(getUploadsDir(), userId, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'retained until authoritative deletion', 'utf8');
  const db = await getUserDb(userId);
  await withWriteLock(userId, async () => {
    await db.read();
    db.data.files.push({ id: fileId, group_id: groupId, owner_user_id: userId, uploader_id: userId,
      stored_filename: filename, filename, original_path: filePath, created_at: new Date().toISOString() });
    await db.write();
  });
  return { cookie, db, groupId, userId, fileId, filePath };
}

test('a lost file write acknowledgement keeps the tombstone and refuses a blind retry', async () => {
  const f = await fixture();
  const originalWrite = f.db.write.bind(f.db);
  f.db.write = async () => { throw new Error('injected write failure'); };
  try {
    const response = await request.delete(`/api/files/${f.fileId}`).set('Cookie', f.cookie).send({ group_id: f.groupId });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'SOURCE_CHANGE_UNCERTAIN');
  } finally {
    f.db.write = originalWrite;
  }
  await f.db.read();
  assert.equal(f.db.data.files.filter(file => file.id === f.fileId).length, 1);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'retained until authoritative deletion');
  const read = await request.get(`/api/files/${f.fileId}`).set('Cookie', f.cookie)
    .query({ group_id: f.groupId });
  assert.equal(read.status, 404, 'prewritten tombstone must block restored metadata and bytes');

  const retry = await request.delete(`/api/files/${f.fileId}`).set('Cookie', f.cookie).send({ group_id: f.groupId });
  assert.equal(retry.status, 404, 'unknown write result cannot be reported as a fresh deletion');
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'retained until authoritative deletion');
});

test('concurrent delete requests serialize access checks and only one succeeds', async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 4 }, () =>
    request.delete(`/api/files/${f.fileId}`).set('Cookie', f.cookie).send({ group_id: f.groupId })));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 404).length, 3);
  await f.db.read();
  assert.equal(f.db.data.files.some(file => file.id === f.fileId), false);
  await assert.rejects(fs.access(f.filePath), { code: 'ENOENT' });
});
