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

test('search counts all matches before pagination and returns the newest page with stable scope', async () => {
  const owner = await account(); const target = await group(owner, 'Pagination needle');
  await group(owner, 'Other needle');
  await seed(owner, data => {
    for (let index = 0; index < 55; index++) data.messages.push({ id: `page-${String(index).padStart(3, '0')}`, group_id: target.id,
      sender_type: 'user', sender_id: owner.id, content: `needle ${index}`, created_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() });
  });
  const first = await request.get('/api/search').set('Cookie', owner.cookie).query({ q: 'needle', type: 'messages,groups', groupId: target.id });
  assert.equal(first.status, 200); assert.equal(first.body.counts.messages, 55);
  assert.equal(first.body.groups.length, 1); assert.equal(first.body.groups[0].id, target.id);
  assert.equal(first.body.total, 56); assert.equal(first.body.messages.length, 20);
  assert.equal(first.body.messages[0].id, 'page-054'); assert.equal(first.body.pagination.hasMore, true);
  const second = await request.get('/api/search').set('Cookie', owner.cookie).query({ q: 'needle', type: 'messages', groupId: target.id, offset: 20 });
  assert.equal(second.body.messages[0].id, 'page-034');
  assert.equal(second.body.messages.some(item => first.body.messages.some(before => before.id === item.id)), false);
  const last = await request.get('/api/search').set('Cookie', owner.cookie).query({ q: 'needle', type: 'messages', groupId: target.id, offset: 40 });
  assert.equal(last.body.messages.length, 15); assert.equal(last.body.pagination.hasMore, false);
});

test('link search matches encrypted plain text without attachments and media filter excludes plain text', async () => {
  const owner = await account(); const target = await group(owner, 'Link search');
  const { default: encryption } = await import('../src/utils/encryption.js');
  await seed(owner, data => {
    data.messages.push({ id: randomUUID(), group_id: target.id, sender_type: 'user', sender_id: owner.id,
      content: encryption.encryptText('needle https://example.com/source'), metadata: { encryption: { encrypted: true } }, created_at: new Date().toISOString() });
    data.messages.push({ id: randomUUID(), group_id: target.id, sender_type: 'user', sender_id: owner.id,
      content: 'needle plain text', created_at: new Date().toISOString() });
  });
  const links = await request.get('/api/search').set('Cookie', owner.cookie).query({ q: 'needle', quickFilter: 'links' });
  assert.equal(links.status, 200); assert.equal(links.body.messages.length, 1);
  assert.match(links.body.messages[0].content, /https:\/\/example.com/);
  const media = await request.get('/api/search').set('Cookie', owner.cookie).query({ q: 'needle', quickFilter: 'media' });
  assert.equal(media.body.messages.length, 0);
});

test('search validates malformed query shapes and date ranges instead of failing with 500', async () => {
  const owner = await account();
  for (const params of [{ q: ['a', 'b'] }, { q: 'a', type: ['messages', 'files'] }, { q: 'a', limit: '-1' },
    { q: 'a', limit: '5abc' }, { q: 'a', offset: '-1' }, { q: 'a', dateFrom: '2026-02-30' },
    { q: 'a', dateFrom: '2026-10-14', dateTo: '2026-10-13' }, { q: 'a', quickFilter: 'invalid' }]) {
    assert.equal((await request.get('/api/search').set('Cookie', owner.cookie).query(params)).status, 400, JSON.stringify(params));
  }
});

test('calendar boundaries accept local UTC offsets and apply to file and comment results', async () => {
  const owner = await account(); const target = await group(owner, 'Date range');
  const file = await upload(owner, target.id, 'date-needle.txt');
  await seed(owner, data => {
    data.files.find(item => item.id === file.id).created_at = '2026-10-12T16:30:00.000Z';
    data.messages.push({ id: randomUUID(), group_id: target.id, content: 'date-needle', sender_type: 'user', sender_id: owner.id,
      created_at: '2026-10-12T16:30:00.000Z', comments: [
        { id: 'in-day', content: 'date-needle', created_at: '2026-10-12T16:30:00.000Z' },
        { id: 'outside-day', content: 'date-needle', created_at: '2026-10-13T16:30:00.000Z' }] });
  });
  const response = await request.get('/api/search').set('Cookie', owner.cookie).query({ q: 'date-needle', type: 'files,comments,messages',
    dateFrom: '2026-10-13T00:00:00+08:00', dateTo: '2026-10-13T23:59:59.999+08:00' });
  assert.equal(response.status, 200); assert.equal(response.body.files.length, 1); assert.equal(response.body.messages.length, 1);
  assert.deepEqual(response.body.comments.map(item => item.id), ['in-day']);
});

test('comment scope is enforced before global chronological ordering, counts and pagination', async () => {
  const owner = await account(); const a = await group(owner, 'Comment scope A'); const b = await group(owner, 'Comment scope B');
  await seed(owner, data => {
    for (const [groupId, id, date] of [[a.id, 'a-old', '2026-10-01'], [b.id, 'b-new', '2026-10-03'], [a.id, 'a-new', '2026-10-02']]) {
      data.messages.push({ id: randomUUID(), group_id: groupId, content: 'parent', sender_type: 'user', sender_id: owner.id,
        created_at: date + 'T00:00:00Z', comments: [{ id, message_id: 'untrusted-parent', content: 'scoped comment needle', created_at: date + 'T00:00:00Z' }] });
    }
  });
  const response = await request.get('/api/search').set('Cookie', owner.cookie).query({ q: 'scoped comment needle', type: 'comments', groupId: a.id, limit: 1 });
  assert.equal(response.status, 200); assert.equal(response.body.total, 2); assert.equal(response.body.counts.comments, 2);
  assert.equal(response.body.comments[0].id, 'a-new'); assert.equal(response.body.comments[0].group_id, a.id);
  assert.notEqual(response.body.comments[0].message_id, 'untrusted-parent'); assert.equal(response.body.pagination.hasMore, true);
  const missing = await search(owner, 'scoped comment needle', 'comments', randomUUID());
  assert.equal(missing.body.total, 0); assert.deepEqual(missing.body.comments, []);
});
