import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-file-restore-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase, getUserDb, getUploadsDir, withWriteLock, clearUserDbCache } =
  await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();
const request = supertest(createTestApp());

async function account(prefix) {
  const response = await request.post('/api/auth/register').send({
    username: `${prefix}_${randomUUID().slice(0, 8)}`,
    password: 'Passw0rd123', nickname: prefix
  });
  assert.equal(response.status, 201);
  const id = response.body.user?.id || response.body.id;
  const cookie = response.headers['set-cookie'];
  const groups = await request.get('/api/groups').set('Cookie', cookie);
  assert.equal(groups.status, 200);
  return { id, cookie, groupId: groups.body[1].id };
}

async function addFile(owner) {
  const fileId = randomUUID();
  const filename = `${fileId}.txt`;
  const filePath = path.join(getUploadsDir(), owner.id, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'private file bytes', 'utf8');
  const record = {
    id: fileId, group_id: owner.groupId, owner_user_id: owner.id,
    uploader_id: owner.id, filename, stored_filename: filename,
    original_path: filePath, mime_type: 'text/plain', file_size: 18,
    parsed_content: 'private parsed content', media_description: 'private preview',
    created_at: new Date().toISOString()
  };
  const db = await getUserDb(owner.id);
  await withWriteLock(owner.id, async () => {
    await db.read();
    db.data.files.push(record);
    await db.write();
  });
  return { record, filePath };
}

test('another account cannot read an injected foreign file record or use a protected token download', async () => {
  const owner = await account('owner_file');
  const other = await account('other_file');
  const { record } = await addFile(owner);
  const ownerFile = await request.get(`/api/files/${record.id}`).set('Cookie', owner.cookie)
    .query({ group_id: owner.groupId });
  assert.equal(ownerFile.status, 200);
  const publicUrl = ownerFile.body.url;
  assert.equal((await request.get(publicUrl)).status, 200);

  const foreignDb = await getUserDb(other.id);
  await withWriteLock(other.id, async () => {
    await foreignDb.read();
    foreignDb.data.files.push({ ...record, group_id: other.groupId });
    await foreignDb.write();
  });
  for (const suffix of ['', '/content', '/media-description', '/download']) {
    const response = await request.get(`/api/files/${record.id}${suffix}`)
      .set('Cookie', other.cookie).query({ group_id: other.groupId });
    assert.equal(response.status, 403, suffix);
  }
  const protectedToken = await request.get(`/api/files/${record.id}/download`)
    .set('Cookie', other.cookie)
    .query({ group_id: other.groupId, token: new URL(`http://localhost${publicUrl}`).searchParams.get('token') });
  assert.equal(protectedToken.status, 403);
  assert.equal((await request.get(`/api/files/${record.id}/content`)
    .set('Cookie', owner.cookie).query({ group_id: owner.groupId })).status, 200);
});

test('restoring an older user JSON and file bytes cannot revive deleted-group file metadata, content, preview or downloads', async () => {
  const owner = await account('restore_file');
  const { record, filePath } = await addFile(owner);
  const before = await request.get(`/api/files/${record.id}`).set('Cookie', owner.cookie)
    .query({ group_id: owner.groupId });
  assert.equal(before.status, 200);
  const oldJsonPath = path.join(process.env.DATA_DIR, 'users', `db_${owner.id}.json`);
  const oldJson = await fs.readFile(oldJsonPath);
  const oldBytes = await fs.readFile(filePath);

  const deleted = await request.delete(`/api/groups/${owner.groupId}`).set('Cookie', owner.cookie);
  assert.equal(deleted.status, 200);
  await fs.writeFile(oldJsonPath, oldJson);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, oldBytes);
  clearUserDbCache(owner.id);

  for (const suffix of ['', '/content', '/media-description', '/download']) {
    const response = await request.get(`/api/files/${record.id}${suffix}`)
      .set('Cookie', owner.cookie).query({ group_id: owner.groupId });
    assert.equal(response.status, 404, suffix);
  }
  const signed = await request.get(before.body.url);
  assert.equal(signed.status, 404);
  const analyze = await request.post(`/api/files/${record.id}/analyze`)
    .set('Cookie', owner.cookie).send({ group_id: owner.groupId });
  assert.equal(analyze.status, 404);
  const reindex = await request.post('/api/files/reindex').set('Cookie', owner.cookie);
  assert.equal(reindex.status, 200);
  assert.equal(reindex.body.reindexed, 0);
  assert.equal(reindex.body.total, 0);
  const newUploadSource = path.join(process.env.DATA_DIR, 'post-delete-upload.txt');
  await fs.writeFile(newUploadSource, 'must not attach to a deleted group', 'utf8');
  const newUpload = await request.post('/api/files/upload').set('Cookie', owner.cookie)
    .field('group_id', owner.groupId).attach('files', newUploadSource);
  assert.equal(newUpload.status, 404);
  assert.equal((await request.get(`/api/files/${record.id}`)
    .set('Cookie', owner.cookie).query({ group_id: 'other-group' })).status, 403);
});

test('restoring an older user JSON and upload bytes cannot revive a separately deleted file', async () => {
  const owner = await account('restore_single_file');
  const { record, filePath } = await addFile(owner);
  const before = await request.get(`/api/files/${record.id}`).set('Cookie', owner.cookie)
    .query({ group_id: owner.groupId });
  assert.equal(before.status, 200);
  const oldJsonPath = path.join(process.env.DATA_DIR, 'users', `db_${owner.id}.json`);
  const oldJson = await fs.readFile(oldJsonPath);
  const oldBytes = await fs.readFile(filePath);

  const deleted = await request.delete(`/api/files/${record.id}`)
    .set('Cookie', owner.cookie).send({ group_id: owner.groupId });
  assert.equal(deleted.status, 200);
  assert.equal((await request.get(before.body.url)).status, 404);
  await fs.writeFile(oldJsonPath, oldJson);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, oldBytes);
  clearUserDbCache(owner.id);

  for (const suffix of ['', '/content', '/media-description', '/download']) {
    const response = await request.get(`/api/files/${record.id}${suffix}`)
      .set('Cookie', owner.cookie).query({ group_id: owner.groupId });
    assert.equal(response.status, 404, suffix);
  }
  assert.equal((await request.get(before.body.url)).status, 404);
  const analyze = await request.post(`/api/files/${record.id}/analyze`)
    .set('Cookie', owner.cookie).send({ group_id: owner.groupId });
  assert.equal(analyze.status, 404);
  const reindex = await request.post('/api/files/reindex').set('Cookie', owner.cookie);
  assert.equal(reindex.status, 200);
  assert.equal(reindex.body.reindexed, 0);
});

test('an unacknowledged file metadata write leaves bytes intact but revokes file reads and reports uncertainty', async () => {
  const owner = await account('uncertain_file');
  const { record, filePath } = await addFile(owner);
  const db = await getUserDb(owner.id);
  const originalWrite = db.write.bind(db);
  db.write = async () => { throw new Error('injected file write failure'); };
  let response;
  try {
    response = await request.delete(`/api/files/${record.id}`)
      .set('Cookie', owner.cookie).send({ group_id: owner.groupId });
  } finally {
    db.write = originalWrite;
  }
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'SOURCE_CHANGE_UNCERTAIN');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'private file bytes');
  const content = await request.get(`/api/files/${record.id}/content`)
    .set('Cookie', owner.cookie).query({ group_id: owner.groupId });
  assert.equal(content.status, 404);
});

test('missing local deletion receipt fails file metadata and public downloads closed', async () => {
  const owner = await account('missing_receipt_file');
  const { record } = await addFile(owner);
  const file = await request.get(`/api/files/${record.id}`).set('Cookie', owner.cookie)
    .query({ group_id: owner.groupId });
  assert.equal(file.status, 200);
  const accountHash = createHash('sha256').update(JSON.stringify(owner.id)).digest('hex');
  const receiptPath = path.join(process.env.DATA_DIR, 'memory-deletions', accountHash,
    'deletions.v1.receipts');
  await fs.rename(receiptPath, `${receiptPath}.unavailable`);
  const content = await request.get(`/api/files/${record.id}/content`)
    .set('Cookie', owner.cookie).query({ group_id: owner.groupId });
  assert.equal(content.status, 503);
  const signed = await request.get(file.body.url);
  assert.equal(signed.status, 503);
});
