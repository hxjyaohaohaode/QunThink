import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-search-scope-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
const { initDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
await initDatabase(); await initAuthDb();
const request = (await import('supertest')).default(createTestApp());
async function account() {
  const response = await request.post('/api/auth/register').send({ username: `search_${randomUUID()}`, password: 'SyntheticPass123!', nickname: 'Search fixture' });
  assert.equal(response.status, 201);
  return { id: response.body.user.id, cookie: response.headers['set-cookie'] };
}
async function group(owner, name) {
  const response = await request.post('/api/groups').set('Cookie', owner.cookie).send({ name, ai_members: [] });
  assert.equal(response.status, 201);
  return response.body;
}
async function seed(owner, fn) {
  const db = await getUserDb(owner.id);
  await withWriteLock(owner.id, async () => { await db.read(); fn(db.data); await db.write(); });
}
function search(owner, q, type, groupId) {
  return request.get('/api/search').set('Cookie', owner.cookie).query({ q, ...(type ? { type } : {}), ...(groupId ? { groupId } : {}) });
}
async function upload(owner, groupId, name) {
  const response = await request.post('/api/files/upload').set('Cookie', owner.cookie)
    .field('group_id', groupId).attach('files', Buffer.from('Synthetic search scope text'), { filename: name, contentType: 'text/plain' });
  assert.equal(response.status, 201);
  return response.body.file;
}

test('members and all-type search reject restored deleted groups before deduplication and totals', async () => {
  const owner = await account(); const other = await account();
  const deleted = await group(owner, 'Deleted synthetic member source');
  const live = await group(owner, 'Live synthetic member source');
  const marker = `member-${randomUUID()}`;
  // The current UI cannot create historical user_members. Explicit old-record
  // fixture only; HTTP still performs group creation, deletion and every read.
  await seed(owner, data => {
    for (const id of [deleted.id, live.id]) {
      const row = data.groups.find(item => item.id === id);
      row.ai_members = [`${marker}-ai`]; row.user_members = [`${marker}-user`];
    }
  });
  assert.equal((await search(owner, marker, 'members', deleted.id)).body.members.length, 2);
  const file = path.join(process.env.DATA_DIR, 'users', `db_${owner.id}.json`);
  const saved = await fs.readFile(file);
  assert.equal((await request.delete(`/api/groups/${deleted.id}`).set('Cookie', owner.cookie)).status, 200);
  await fs.writeFile(file, saved); clearUserDbCache(owner.id);
  assert.equal((await request.get(`/api/groups/${deleted.id}`).set('Cookie', owner.cookie)).status, 404);
  for (const type of ['members', undefined]) {
    const scoped = await search(owner, marker, type, deleted.id);
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.body.members, []);
    const global = await search(owner, marker, type);
    assert.equal(global.status, 200);
    assert.equal(global.body.members.length, 2);
    assert.ok(global.body.members.every(item => item.group_id === live.id && item.group_name === live.name));
    assert.equal(JSON.stringify(global.body).includes(deleted.name), false);
    const total = Object.entries(global.body).filter(([, value]) => Array.isArray(value)).reduce((sum, [, value]) => sum + value.length, 0);
    assert.equal(global.body.total, total);
  }
  assert.equal((await search(owner, marker, 'members', live.id)).body.members.length, 2);
  const foreign = await search(other, marker, 'members', deleted.id);
  assert.equal(foreign.status, 200); assert.equal(foreign.body.total, 0);
  assert.equal((await request.get('/api/search').query({ q: marker, type: 'members', groupId: deleted.id })).status, 401);
});

test('files share authoritative group scope with media without widening legacy or foreign ownership reads', async () => {
  const owner = await account(); const other = await account();
  const a = await group(owner, 'Scope group A'); const b = await group(owner, 'Scope group B');
  const marker = `file-${randomUUID()}`;
  const fa = await upload(owner, a.id, `${marker}-a.txt`);
  const fb = await upload(owner, b.id, `${marker}-b.txt`);
  const legacyId = randomUUID();
  await seed(owner, data => {
    data.files.push({ ...data.files.find(file => file.id === fb.id), id: legacyId, group_id: null, filename: `${marker}-legacy.txt` });
    data.files.push({ ...data.files.find(file => file.id === fb.id), id: randomUUID(), filename: `${marker}-foreign.txt`, owner_user_id: other.id, uploader_id: other.id });
  });
  for (const [groupId, expected] of [[a.id, [fa.id]], [b.id, [fb.id]], [randomUUID(), []]]) {
    const response = await search(owner, marker, 'files,media', groupId);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.files.map(file => file.id), expected);
    assert.deepEqual(response.body.media, []);
    assert.equal(response.body.total, expected.length);
  }
  const unscoped = await search(owner, marker, 'files');
  assert.deepEqual(new Set(unscoped.body.files.map(file => file.id)), new Set([fa.id, fb.id]));
  const foreign = await search(other, marker, 'files,media', b.id);
  assert.equal(foreign.status, 200); assert.equal(foreign.body.total, 0);
});

test('search fails closed when the independent source ledger configuration is unavailable', async () => {
  const owner = await account(); const target = await group(owner, 'Unavailable ledger group');
  const marker = `blocked-${randomUUID()}`;
  await seed(owner, data => { data.groups.find(row => row.id === target.id).ai_members = [marker]; });
  assert.equal((await search(owner, marker, 'members', target.id)).body.members.length, 1);
  const before = process.env.MEMORY_DELETION_DIR;
  process.env.MEMORY_DELETION_DIR = path.join(process.env.DATA_DIR, 'unregistered-ledger');
  try {
    for (const type of ['members', 'files,media', undefined]) {
      const response = await search(owner, marker, type, target.id);
      assert.equal(response.status, 503);
      assert.equal(JSON.stringify(response.body).includes(marker), false);
      assert.equal(JSON.stringify(response.body).includes(target.name), false);
      assert.equal(response.body.members, undefined);
    }
  } finally {
    if (before === undefined) delete process.env.MEMORY_DELETION_DIR;
    else process.env.MEMORY_DELETION_DIR = before;
  }
  assert.equal((await search(owner, marker, 'members', target.id)).body.members.length, 1);
});
