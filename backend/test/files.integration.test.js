import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-file-data-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { getUploadsDir, initDatabase } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();

const request = supertest(createTestApp());

function uniqueUsername(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function createSessionAndGroup() {
  const username = uniqueUsername('filecase');
  const registerResponse = await request
    .post('/api/auth/register')
    .send({
      username,
      password: 'Passw0rd123',
      nickname: 'File Case'
    });

  assert.equal(registerResponse.status, 201);
  const cookies = registerResponse.headers['set-cookie'];

  const groupsResponse = await request
    .get('/api/groups')
    .set('Cookie', cookies);
  assert.equal(groupsResponse.status, 200);

  return {
    cookies,
    groupId: groupsResponse.body[0].id
  };
}

test('uploaded file is stored under configured uploads directory and parsed successfully', async () => {
  const { cookies, groupId } = await createSessionAndGroup();
  const tempFile = path.join(process.env.DATA_DIR, 'sample.txt');
  await fs.writeFile(tempFile, 'hello upload test', 'utf8');

  const uploadResponse = await request
    .post('/api/files/upload')
    .set('Cookie', cookies)
    .field('group_id', groupId)
    .field('uploader_id', 'spoofed-user')
    .attach('files', tempFile);

  assert.equal(uploadResponse.status, 201);
  assert.ok(uploadResponse.body.file);

  const uploadedFile = uploadResponse.body.file;
  assert.ok(uploadedFile.original_path.startsWith(getUploadsDir()));
  assert.notEqual(uploadedFile.uploader_id, 'spoofed-user');
  assert.equal(uploadedFile.owner_user_id, uploadedFile.uploader_id);

  const contentResponse = await request
    .get(`/api/files/${uploadedFile.id}/content`)
    .set('Cookie', cookies)
    .query({ group_id: groupId });

  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.body.content.trim(), 'hello upload test');
});

test('file upload rejects nonexistent group and cleanup/delete endpoints remove file access', async () => {
  const { cookies, groupId } = await createSessionAndGroup();
  const tempFile = path.join(process.env.DATA_DIR, 'sample-delete.txt');
  await fs.writeFile(tempFile, 'delete me', 'utf8');

  const missingGroupUpload = await request
    .post('/api/files/upload')
    .set('Cookie', cookies)
    .field('group_id', 'missing-group')
    .attach('files', tempFile);

  assert.equal(missingGroupUpload.status, 404);

  const uploadResponse = await request
    .post('/api/files/upload')
    .set('Cookie', cookies)
    .field('group_id', groupId)
    .attach('files', tempFile);

  assert.equal(uploadResponse.status, 201);
  const uploadedFile = uploadResponse.body.file;

  const deleteResponse = await request
    .delete(`/api/files/${uploadedFile.id}`)
    .set('Cookie', cookies)
    .send({ group_id: groupId });

  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteResponse.body.success, true);

  const contentAfterDelete = await request
    .get(`/api/files/${uploadedFile.id}/content`)
    .set('Cookie', cookies)
    .query({ group_id: groupId });

  assert.equal(contentAfterDelete.status, 404);
});
