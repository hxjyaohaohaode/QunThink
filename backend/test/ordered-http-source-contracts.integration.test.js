// Independent JSON/source/journal and HTTP behavior tests. Fault injections
// mark acknowledgement/CAS branches; they do not claim real JSON revision CAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const backend = new URL('../', import.meta.url);
const load = file => import(new URL(file, backend));
const require = createRequire(new URL('package.json', backend));
process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-independent-source-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];
const { initializeEmptyInstallation, initDatabase, getUserDb, withWriteLock } = await load('src/models/db.js');
const { initAuthDb } = await load('src/models/authDb.js');
const { createTestApp } = await load('test/helpers/createTestApp.js');
const { commitCreatedGroup, commitGroupMemberChange } = await load('src/services/groupCreationCommit.js');
const { commitUserHttpMessage } = await load('src/services/httpMessageCommit.js');
const { prepareOrderedAppend, validateMessageOrder, buildLegacyMessageOrder } = await load('src/services/messageOrder.js');
const { markFileDeleted, markGroupDeleted, markMessageDeleted } = await load('src/services/memory/persistentMemory.js');
const encryption = (await load('src/utils/encryption.js')).default;
await initializeEmptyInstallation(); await initDatabase(); await initAuthDb();
const request = require('supertest')(createTestApp());
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const requestHash = (groupId, body) => createHash('sha256').update(canonical({ groupId, content: body.content, content_type: body.content_type || 'text', reply_to: body.reply_to || null, metadata: body.metadata || {}, attachments: body.attachments || [] })).digest('hex');
async function fixture() {
 const registration = await request.post('/api/auth/register').send({ username: `ind_${randomUUID()}`, password: 'SyntheticFixtureOnly2026!' });
 assert.equal(registration.status, 201, JSON.stringify(registration.body));
 const id = registration.body.user.id, cookie = registration.headers['set-cookie'], db = await getUserDb(id); await db.read();
 db.data.modelCatalog = { revision: 0, providers: [], models: ['fixture_a', 'fixture_b', 'fixture_c'].map(id => ({ id, name: id, enabled: true, capabilities: ['chat'] })), defaults: { chat: null, vision: null, tts: null } };
 db.data.groups[0].ai_members = ['fixture_a', 'fixture_b']; await db.write();
 return { id, cookie, db, groupId: db.data.groups[0].id, file: path.join(process.env.DATA_DIR, 'users', `db_${id}.json`) };
}
async function durable(f) { const data = JSON.parse(await fs.readFile(f.file, 'utf8')); validateMessageOrder(data, f.id); return data; }
const bodyFor = fileId => ({ content: 'original attachment request', clientMessageId: randomUUID(), attachments: [{ id: fileId, name: 'synthetic.txt', type: 'text/plain', size: 20, url: `/api/files/${fileId}/download` }] });
const post = (f, body) => request.post(`/api/groups/${f.groupId}/messages`).set('Cookie', f.cookie).send(body);
async function addFile(f, extra = {}) { const file = { id: randomUUID(), group_id: f.groupId, owner_user_id: f.id, uploader_id: f.id, parsed_content: 'original extracted text', media_description: 'original description', ...extra }; await f.db.read(); f.db.data.files.push(file); await f.db.write(); return file; }

for (const field of ['owner_user_id', 'uploader_id', 'group_id']) test(`attachment with mismatched ${field} fails before persistence`, async () => {
 const f = await fixture(), file = await addFile(f, { [field]: randomUUID() }), before = await fs.readFile(f.file, 'utf8');
 const response = await post(f, bodyFor(file.id)); assert.equal(response.status, 404, JSON.stringify(response.body)); assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('independent file tombstone blocks a new post although restored file record is physically present', async () => {
 const f = await fixture(), file = await addFile(f), before = await fs.readFile(f.file, 'utf8');
 await markFileDeleted(f.id, f.db, f.groupId, file.id);
 const response = await post(f, bodyFor(file.id)); assert.equal(response.status, 404); assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('historical no-hash receipt replays original ciphertext and filters revoked attachments without changing stored records', async () => {
 const f = await fixture(), file = await addFile(f), body = bodyFor(file.id), first = await post(f, body); assert.equal(first.status, 201);
 // Offline legacy fixture: erase only modern binding hash, keeping the same
 // old receipt and every business byte. This is test fixture data, not a runtime migration.
 const data = await durable(f); delete data.message_order.groups.find(g => g.group_id === f.groupId).bindings[0].creation_intent_hash;
 await fs.writeFile(f.file, JSON.stringify(data)); await f.db.read({ force: true });
 await markFileDeleted(f.id, f.db, f.groupId, file.id); const before = await fs.readFile(f.file, 'utf8');
 const replay = await post(f, body); assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.id, first.body.id); assert.deepEqual(replay.body.server_order, first.body.server_order); assert.deepEqual(replay.body.attachments, []);
 assert.equal(await fs.readFile(f.file, 'utf8'), before); assert.deepEqual(f.db.data.messages[0].attachments.map(a => a.id), [file.id]);
 assert.equal((await durable(f)).messages[0].content, data.messages[0].content);
 const conflict = await post(f, { ...body, content: 'different intent' }); assert.equal(conflict.status, 409); assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

for (const field of ['parsed_content', 'media_description']) test(`attachment ${field} change between preparation and force read cannot be silently rederived`, async () => {
 const f = await fixture(), file = await addFile(f), read = f.db.read, body = bodyFor(file.id); let injected = false;
 f.db.read = async function(options) {
  if (options?.onPublished && !injected) { injected = true; await read.call(this, { force: true }); this.data.files[0][field] = 'changed after preparation'; await this.write(); }
  return read.call(this, options);
 };
 let response; try { response = await post(f, body); } finally { f.db.read = read; }
 assert.equal(injected, true); assert.equal(response.status, 409, JSON.stringify(response.body)); assert.equal(response.body.code, 'MESSAGE_ATTACHMENT_CHANGED'); assert.equal((await durable(f)).messages.length, 0);
});

test('confirmed same-client lost ACK filters newly revoked file without mutating underlying attachment derivation', async () => {
 const f = await fixture(), file = await addFile(f), body = bodyFor(file.id), write = f.db.write; let count = 0;
 f.db.write = async function(options) { count++; await write.call(this, options); await markFileDeleted(f.id, f.db, f.groupId, file.id); throw new Error('ACK lost after file revocation'); };
 let response; try { response = await post(f, body); } finally { f.db.write = write; }
 assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(count, 1); assert.deepEqual(response.body.attachments, []); const data = await durable(f); assert.equal(data.messages.length, 1); assert.equal(data.messages[0].attachments[0].parsed_content, 'original extracted text');
});

test('no-client lost ACK with revoked file fails closed rather than exposing cached source description', async () => {
 const f = await fixture(), file = await addFile(f), body = bodyFor(file.id), write = f.db.write; delete body.clientMessageId; let count = 0;
 f.db.write = async function(options) { count++; await write.call(this, options); await markFileDeleted(f.id, f.db, f.groupId, file.id); throw new Error('ACK lost after file revocation'); };
 let response; try { response = await post(f, body); } finally { f.db.write = write; }
 assert.equal(response.status, 404, JSON.stringify(response.body)); assert.equal(count, 1); assert.equal((await durable(f)).messages.length, 1);
});

test('independent group tombstone blocks both message and member writes against physically restored group', async () => {
 const f = await fixture(), before = await fs.readFile(f.file, 'utf8'); await markGroupDeleted(f.id, f.db, f.groupId);
 assert.equal((await post(f, { content: 'denied', clientMessageId: randomUUID() })).status, 404);
 assert.equal((await request.post(`/api/groups/${f.groupId}/members`).set('Cookie', f.cookie).send({ aiId: 'fixture_c' })).status, 404);
 assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

for (const kind of ['group', 'member']) test(`${kind} CAS rebuild rechecks model disabled on fresh snapshot and does not consume a sequence`, async () => {
 const f = await fixture(), write = f.db.write; let attempts = 0;
 f.db.write = async function(options) {
  attempts++;
  if (attempts === 1) { const current = structuredClone(this.data); current.modelCatalog.models.find(m => m.id === 'fixture_c').enabled = false; await write.call(this, { snapshot: current }); throw Object.assign(new Error('synthetic explicit CAS conflict'), { code: 'REVISION_CONFLICT', status: 409 }); }
  return write.call(this, options);
 };
 let response; try { response = kind === 'group' ? await request.post('/api/groups').set('Cookie', f.cookie).send({ name: 'not created', ai_members: ['fixture_c'] }) : await request.post(`/api/groups/${f.groupId}/members`).set('Cookie', f.cookie).send({ aiId: 'fixture_c' }); } finally { f.db.write = write; }
 assert.equal(response.status, 400, JSON.stringify(response.body)); assert.equal(attempts, 1); const data = await durable(f); assert.equal(data.messages.length, 0); assert.equal(data.message_order.groups.find(g => g.group_id === f.groupId).next_sequence, '1'); assert.ok(!data.groups.some(g => g.name === 'not created')); assert.ok(!data.groups[0].ai_members.includes('fixture_c'));
});

test('existing private lookup returns original group and preserves stored settings without constructing a replacement', async () => {
 const f = await fixture();
 const created = await request.post('/api/private-chat/fixture_a').set('Cookie', f.cookie); assert.equal(created.status, 201);
 await f.db.read(); const existing = f.db.data.groups.find(g => g.id === created.body.id); existing.name = 'Original edited name'; existing.description = 'Original description'; existing.pinned = false; existing.userSetting = { preserve: true }; await f.db.write(); const before = await fs.readFile(f.file, 'utf8');
 const response = await request.post('/api/private-chat/fixture_a').set('Cookie', f.cookie); assert.equal(response.status, 200); assert.equal(response.body.id, created.body.id); assert.equal(response.body.name, 'Original edited name'); assert.equal(response.body.pinned, false); assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('same-client receipt retains original identity after message tombstone and never creates a replacement', async () => {
 const f = await fixture(), body = { content: 'source', clientMessageId: randomUUID() }, first = await post(f, body); assert.equal(first.status, 201); await markMessageDeleted(f.id, f.db, f.groupId, [first.body.id]);
 const before = await fs.readFile(f.file, 'utf8'), response = await post(f, body); assert.equal(response.status, 410); assert.equal(await fs.readFile(f.file, 'utf8'), before);
});
