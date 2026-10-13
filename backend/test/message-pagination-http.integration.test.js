// Actual loopback HTTP, production auth/message routers, encrypted JSON and
// independent local deletion journal. Only users/content/clocks are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-page-http-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];
const { initializeEmptyInstallation, initDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { prepareOrderedAppend, validateMessageOrder } = await import('../src/services/messageOrder.js');
const { markMessageDeleted, markFileDeleted, markGroupDeleted } = await import('../src/services/memory/persistentMemory.js');
const { sourceHash } = await import('../src/services/taskSources.js');
await initializeEmptyInstallation(); await initDatabase(); await initAuthDb();
const server = createTestApp().listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ActualDate = Date;
test.after(async () => {
  globalThis.Date = ActualDate;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
});
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString());
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function http(method, endpoint, body, cookie) {
  const response = await fetch(base + endpoint, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
}
async function fixture() {
  const r = await http('POST', '/api/auth/register', { username: `pagination_${randomUUID()}`, password: 'SyntheticFixtureOnly2026!' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const db = await getUserDb(r.body.user.id), groupId = db.data.groups[0].id;
  return { id: r.body.user.id, db, groupId, cookie: r.cookie, endpoint: `/api/groups/${groupId}/messages`, file: path.join(process.env.DATA_DIR, 'users', `db_${r.body.user.id}.json`) };
}
const get = (f, query = 'order=sequence_v1') => http('GET', `${f.endpoint}${query ? '?' + query : ''}`, null, f.cookie);
const post = (f, content = 'Synthetic HTTP message') => http('POST', f.endpoint, { content, clientMessageId: randomUUID() }, f.cookie);
const sequences = page => page.messages.map(m => m.server_order.sequence);
const ids = page => page.messages.map(m => m.id);
async function page(f, query) { const r = await get(f, query); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
async function frozenClock(action) {
  let millis = ActualDate.now();
  globalThis.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : [millis])); } static now() { return millis; } };
  try { return await action(value => { millis += value; }); } finally { globalThis.Date = ActualDate; }
}
async function writes(f, count) {
  const out = [];
  for (let i = 0; i < count; i++) { const r = await post(f, `Synthetic same-millisecond message ${i}`); assert.equal(r.status, 201, JSON.stringify(r.body)); out.push(r.body); }
  return out;
}

test('original 51 same-millisecond real HTTP pattern now yields 50+1 IDs and same-time after append', async t => {
  const f = await fixture();
  await frozenClock(async () => {
    const sent = await writes(f, 51); assert.equal(new Set(sent.map(m => m.created_at)).size, 1);
    const bytes = await fs.readFile(f.file), before = JSON.parse(bytes), hash1 = sourceHash(before.messages, { data: before }, 1), hash2 = sourceHash(before.messages, { data: before }, 2);
    const first = await page(f, 'order=sequence_v1&limit=50');
    const second = await page(f, `order=sequence_v1&limit=50&before_cursor=${first.before_cursor}`);
    assert.equal(first.messages.length, 50); assert.equal(second.messages.length, 1); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
    assert.deepEqual([...ids(second), ...ids(first)], sent.map(m => m.id));
    assert.equal(second.after_cursor, null); assert.equal(second.consumed_through, null);
    assert.ok((await fs.readFile(f.file)).equals(bytes)); assert.deepEqual(f.db.data.messages, before.messages);
    assert.deepEqual(f.db.data.messageIdempotency, before.messageIdempotency);
    assert.equal(sourceHash(f.db.data.messages, f.db, 1), hash1); assert.equal(sourceHash(f.db.data.messages, f.db, 2), hash2);
    assert.ok(before.messages.every(m => m.metadata.encryption.encrypted && !m.content.startsWith('Synthetic')));
    const appended = await post(f); assert.equal(appended.status, 201); assert.equal(appended.body.created_at, sent[0].created_at);
    const after = await page(f, `order=sequence_v1&limit=50&after_cursor=${first.after_cursor}`);
    assert.deepEqual(ids(after), [appended.body.id]); assert.equal(after.consumed_through, '52');
    t.diagnostic(JSON.stringify({ realHttpWrites: 52, originalCount: 51, pages: [50, 1], timestampCount: 1, sourceHashesAndCiphertextUnchangedByReads: true, afterSameTimestamp: true }));
  });
});

test('101 real same-millisecond writes drain earliest-first in exact 50/50/1 after pages', async t => {
  const f = await fixture(), baseline = await page(f);
  await frozenClock(async () => {
    const sent = await writes(f, 101), received = []; let cursor = baseline.after_cursor;
    for (const [count, consumed, more] of [[50, '50', true], [50, '100', true], [1, '101', false]]) {
      const result = await page(f, `order=sequence_v1&limit=50&after_cursor=${cursor}`); cursor = result.after_cursor;
      assert.equal(result.messages.length, count); assert.equal(result.consumed_through, consumed); assert.equal(result.high_watermark, '101');
      assert.equal(result.hasMore, more); assert.equal(result.before_cursor, null); received.push(...ids(result));
    }
    assert.deepEqual(received, sent.map(m => m.id)); t.diagnostic(JSON.stringify({ realHttpWrites: 101, pages: [50, 50, 1], unique: new Set(received).size }));
  });
});

test('601 real writes survive a five-page pause, clock rollback, lower UUID and a new commit beyond fixed H', async t => {
  const f = await fixture(), baseline = await page(f);
  await frozenClock(async changeClock => {
    const sent = await writes(f, 601); assert.equal(new Set(sent.map(m => m.created_at)).size, 1);
    assert.ok(sent.some((m, i) => i > 0 && m.id < sent[i - 1].id), 'a later committed random UUID sorts below its predecessor');
    let cursor = baseline.after_cursor; const received = [], counts = [];
    for (let i = 0; i < 5; i++) {
      const result = await page(f, `order=sequence_v1&limit=100&after_cursor=${cursor}`); cursor = result.after_cursor; received.push(...ids(result)); counts.push(result.messages.length);
      assert.equal(result.hasMore, true); assert.equal(result.high_watermark, '601'); assert.equal(result.consumed_through, String((i + 1) * 100));
      if (i === 0) { changeClock(-10_000); const appended = await post(f, 'Synthetic rollback timestamp append'); assert.equal(appended.status, 201); assert.equal(appended.body.server_order.sequence, '602'); assert.ok(appended.body.created_at < sent[0].created_at); }
    }
    assert.equal(decode(cursor).at, '500'); assert.equal(decode(cursor).until, '601');
    for (let i = 0; i < 2; i++) {
      const result = await page(f, `order=sequence_v1&limit=100&after_cursor=${cursor}`); cursor = result.after_cursor; received.push(...ids(result)); counts.push(result.messages.length);
      assert.equal(result.high_watermark, '601'); assert.equal(result.hasMore, i === 0);
    }
    assert.deepEqual(received, sent.map(m => m.id)); assert.equal(decode(cursor).until, undefined); assert.equal(decode(cursor).at, '601');
    const next = await page(f, `order=sequence_v1&limit=100&after_cursor=${cursor}`); assert.deepEqual(sequences(next), ['602']); assert.equal(next.consumed_through, '602');
    t.diagnostic(JSON.stringify({ realHttpWrites: 602, originalCount: 601, pages: counts, unique: new Set(received).size, resumedFrom: '500', fixedH: '601', nextBatch: '602', clockRollback: true }));
  });
});

test('before retains H through new commits, deleted anchor and deleted history rows', async () => {
  const f = await fixture(), sent = await writes(f, 12), first = await page(f, 'order=sequence_v1&limit=5');
  assert.deepEqual(sequences(first), ['8', '9', '10', '11', '12']);
  assert.equal((await http('DELETE', `/api/messages/${sent[7].id}`, null, f.cookie)).status, 200);
  assert.equal((await http('DELETE', `/api/messages/${sent[5].id}`, null, f.cookie)).status, 200);
  assert.equal((await post(f)).status, 201);
  const second = await page(f, `order=sequence_v1&limit=5&before_cursor=${first.before_cursor}`);
  assert.deepEqual(sequences(second), ['2', '3', '4', '5', '7']); assert.equal(second.high_watermark, '12'); assert.equal(second.hasMore, true);
  const third = await page(f, `order=sequence_v1&limit=5&before_cursor=${second.before_cursor}`);
  assert.deepEqual(sequences(third), ['1']); assert.equal(third.high_watermark, '12'); assert.equal(third.hasMore, false);
});

test('complete deletion leaves H and consumes empty after batch without a cursor loop', async () => {
  const f = await fixture(), baseline = await page(f); await writes(f, 6);
  const first = await page(f, `order=sequence_v1&limit=2&after_cursor=${baseline.after_cursor}`);
  assert.equal(first.high_watermark, '6'); assert.equal(first.consumed_through, '2'); assert.equal(first.hasMore, true);
  assert.equal((await http('DELETE', f.endpoint, null, f.cookie)).status, 200);
  const rest = await page(f, `order=sequence_v1&limit=2&after_cursor=${first.after_cursor}`);
  assert.deepEqual(rest.messages, []); assert.equal(rest.high_watermark, '6'); assert.equal(rest.consumed_through, '6'); assert.equal(rest.hasMore, false); assert.equal(decode(rest.after_cursor).until, undefined);
  const empty = await page(f); assert.equal(empty.high_watermark, '6'); assert.equal(empty.consumed_through, '6'); assert.equal(empty.before_cursor, null);
  const sent = await post(f); assert.equal(sent.body.server_order.sequence, '7');
  const next = await page(f, `order=sequence_v1&after_cursor=${rest.after_cursor}`); assert.deepEqual(ids(next), [sent.body.id]);
});

test('current source revocation filters pages before counting without mutating stored ciphertext, hashes or attachments', async () => {
  const f = await fixture(), baseline = await page(f), sent = await writes(f, 5);
  await f.db.read({ force: true });
  f.db.data.files.push({ id: 'synthetic-source-file', group_id: f.groupId, owner_user_id: f.id, uploader_id: f.id, filename: 'synthetic.txt', parsed_content: 'Synthetic private extract' });
  f.db.data.messages[2].attachments = [{ id: 'synthetic-source-file', parsed_content: 'Synthetic private extract', url: '/api/files/synthetic-source-file/download' }];
  await f.db.write(); const before = await fs.readFile(f.file), stored = JSON.parse(before), hashes = [1, 2].map(v => sourceHash(stored.messages, { data: stored }, v));
  await markMessageDeleted(f.id, f.db, f.groupId, [sent[0].id, sent[1].id, sent[3].id, sent[4].id]);
  await markFileDeleted(f.id, f.db, f.groupId, 'synthetic-source-file');
  const result = await page(f, `order=sequence_v1&limit=1&after_cursor=${baseline.after_cursor}`);
  assert.deepEqual(ids(result), [sent[2].id]); assert.deepEqual(result.messages[0].attachments, []); assert.equal(result.hasMore, false); assert.equal(result.consumed_through, '5');
  assert.ok((await fs.readFile(f.file)).equals(before)); assert.deepEqual(f.db.data.messages, stored.messages);
  assert.deepEqual([1, 2].map(v => sourceHash(f.db.data.messages, f.db, v)), hashes);
  await markMessageDeleted(f.id, f.db, f.groupId, [sent[2].id]);
  const empty = await page(f, `order=sequence_v1&after_cursor=${baseline.after_cursor}`); assert.deepEqual(empty.messages, []); assert.equal(empty.consumed_through, '5');
});

test('same preset group IDs never allow cross-owner cursors, and unreadable scope precedes cursor parsing', async () => {
  const a = await fixture(), b = await fixture(); assert.equal(a.groupId, b.groupId); await writes(a, 2);
  const first = await page(a), ownEmpty = await page(b); assert.deepEqual(ownEmpty.messages, []);
  const crossed = await get(b, `order=sequence_v1&after_cursor=${first.after_cursor}`); assert.equal(crossed.status, 400); assert.equal(crossed.body.code, 'INVALID_MESSAGE_CURSOR');
  const anonymous = await http('GET', `${a.endpoint}?order=sequence_v1&after_cursor=broken`, null); assert.equal(anonymous.status, 401);
  for (const q of ['order=sequence_v1&after_cursor=broken', 'before=old', `order=sequence_v1&after_cursor=${first.after_cursor}`]) {
    const absent = await http('GET', `/api/groups/nonexistent/messages?${q}`, null, b.cookie); assert.equal(absent.status, 404); assert.deepEqual(absent.body, { error: 'Group not found' });
  }
  const otherGroup = a.db.data.groups[1].id;
  const crossedGroup = await http('GET', `/api/groups/${otherGroup}/messages?order=sequence_v1&after_cursor=${first.after_cursor}`, null, a.cookie); assert.equal(crossedGroup.status, 400);
  await markGroupDeleted(a.id, a.db, a.groupId);
  const revoked = await get(a, `order=sequence_v1&after_cursor=${first.after_cursor}`); assert.equal(revoked.status, 404); assert.deepEqual(revoked.body, { error: 'Group not found' });
});

test('old first page preserves time ordering while every old timestamp pagination request gives honest 428', async () => {
  const f = await fixture();
  await frozenClock(async changeClock => { await writes(f, 2); changeClock(-1000); await writes(f, 1); });
  const ordered = await page(f), legacy = await page(f, 'limit=bad');
  assert.equal(legacy.order, undefined); assert.equal(legacy.messages[0].id, ordered.messages.at(-1).id); assert.equal(legacy.messages[0].server_order, undefined);
  for (const q of ['before=2026-10-13T00%3A00%3A00Z', 'after=', 'order=sequence_v1&before=old', 'order=sequence_v1&after=old', 'before=a&after=b']) {
    const r = await get(f, q); assert.equal(r.status, 428); assert.equal(r.body.code, 'MESSAGE_CURSOR_REQUIRED');
    assert.equal(r.body.error, '消息分页协议已更新，请刷新客户端后继续。刷新前请确认草稿已保存，或复制未发送内容。');
    assert.equal(r.body.messages, undefined);
  }
});

test('real HTTP rejects duplicate, malformed, foreign and future cursors without changing storage', async () => {
  const f = await fixture(); await writes(f, 2); const first = await page(f), decoded = decode(first.after_cursor), before = await fs.readFile(f.file);
  const queries = ['order=sequence_v1&limit=201', 'order=sequence_v1&limit=01', 'order=sequence_v1&limit=1&limit=2', 'order=sequence_v1&order=sequence_v1',
    'order=sequence_v1&after_cursor[]=x', 'order=sequence_v1&before_cursor=x&after_cursor=y', `order=sequence_v1&after_cursor=${'a'.repeat(1025)}`,
    ...[first.after_cursor + '=', encode({ ...decoded, at: '3' }), encode({ ...decoded, until: '3' }), encode({ ...decoded, owner: 'unknown-account' }),
      encode({ ...decoded, extra: true }), Buffer.from(JSON.stringify(decoded).replace('"v":1', '"v":1,"v":1')).toString('base64url')].map(c => `order=sequence_v1&after_cursor=${encodeURIComponent(c)}`)];
  for (const q of queries) { const r = await get(f, q); assert.equal(r.status, 400, q); assert.equal(r.body.code, 'INVALID_MESSAGE_CURSOR'); assert.equal(r.body.messages, undefined); }
  assert.ok((await fs.readFile(f.file)).equals(before));
});

test('real HTTP compares sparse 9/10 and beyond-safe-integer sequences without numeric rounding', async () => {
  const f = await fixture(); await f.db.read(); let snapshot = structuredClone(f.db.data);
  for (let i = 0; i < 4; i++) snapshot = prepareOrderedAppend(snapshot, f.id, { id: randomUUID(), group_id: f.groupId, content: 'Synthetic sparse seed', created_at: new ActualDate().toISOString() }, { creationIntentHash: createHash('sha256').update(String(i)).digest('hex') }).data;
  const group = snapshot.message_order.groups.find(g => g.group_id === f.groupId), seqs = ['9', '10', '9007199254740992', '9007199254740993'];
  group.bindings.forEach((b, i) => { b.sequence = seqs[i]; }); group.next_sequence = '9007199254740994';
  // Synthetic input installed before this account has any allocated messages.
  await f.db.write({ snapshot });
  const result = await page(f, 'order=sequence_v1&limit=2'); assert.deepEqual(sequences(result), seqs.slice(2)); assert.equal(result.high_watermark, seqs.at(-1));
  const previous = await page(f, `order=sequence_v1&limit=2&before_cursor=${result.before_cursor}`); assert.deepEqual(sequences(previous), seqs.slice(0, 2));
  const sent = await post(f); assert.equal(sent.body.server_order.sequence, '9007199254740994');
  const after = await page(f, `order=sequence_v1&after_cursor=${result.after_cursor}`); assert.deepEqual(sequences(after), ['9007199254740994']);
});

test('old generation resets even for a low frontier; corrupt schema remains 503 and raw bytes are not repaired', async () => {
  const f = await fixture(); await writes(f, 2); const first = await page(f), raw = JSON.parse(await fs.readFile(f.file, 'utf8'));
  raw.message_order.groups.find(g => g.group_id === f.groupId).generation = randomUUID();
  await clearUserDbCache(f.id); await fs.writeFile(f.file, JSON.stringify(raw));
  const oldLow = encode({ ...decode(first.after_cursor), at: '0' });
  const response = await get(f, `order=sequence_v1&after_cursor=${oldLow}`); assert.equal(response.status, 409); assert.equal(response.body.code, 'CURSOR_RESET_REQUIRED');
  for (const mutate of [data => { delete data.message_order; }, data => { data.message_order.version = 999; }, data => { data.message_order.groups[0].bindings.pop(); }]) {
    const broken = structuredClone(raw); mutate(broken); await clearUserDbCache(f.id); const bytes = JSON.stringify(broken); await fs.writeFile(f.file, bytes);
    const r = await get(f); assert.equal(r.status, 503, JSON.stringify(r.body)); assert.equal(r.body.code, 'MESSAGE_ORDER_UNAVAILABLE'); assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
  }
});

test('held actual commit and racing HTTP read never expose a candidate sequence before durable write succeeds', async () => {
  const f = await fixture(), write = f.db.write; let open, reached;
  const gate = new Promise(resolve => { open = resolve; }), started = new Promise(resolve => { reached = resolve; });
  f.db.write = async function(options) { reached(); await gate; return write.call(this, options); };
  let done = false;
  try {
    const sending = post(f); await started; const reading = get(f).then(r => { done = true; return r; });
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(done, false); assert.equal(f.db.data.messages.length, 0);
    open(); const sent = await sending, read = await reading; assert.equal(sent.status, 201); assert.equal(read.status, 200); assert.deepEqual(ids(read.body), [sent.body.id]); assert.equal(read.body.high_watermark, '1');
  } finally { open(); f.db.write = write; }
});

test('all ordered page reads are pure persisted projections, including explicit account lock serialization', async () => {
  const f = await fixture(); await writes(f, 3); const before = await fs.readFile(f.file), baseline = structuredClone(f.db.data); let writesObserved = 0;
  const write = f.db.write; f.db.write = async function(...args) { writesObserved++; return write.apply(this, args); };
  try {
    const first = await page(f, 'order=sequence_v1&limit=1');
    await page(f, `order=sequence_v1&limit=1&before_cursor=${first.before_cursor}`);
    await page(f, `order=sequence_v1&after_cursor=${first.after_cursor}`);
    await withWriteLock(f.id, async () => validateMessageOrder(f.db.data, f.id));
    assert.equal(writesObserved, 0); assert.ok((await fs.readFile(f.file)).equals(before)); assert.deepEqual(f.db.data, baseline);
  } finally { f.db.write = write; }
});

test('all three genuinely created empty group kinds bootstrap at zero and expose their first real HTTP write', async () => {
  const owner = await fixture(); await owner.db.read();
  owner.db.data.modelCatalog = { revision: 0, providers: [], models: ['fixture_a', 'fixture_b'].map(id => ({ id, name: id, enabled: true, capabilities: ['chat'] })), defaults: { chat: null, vision: null, tts: null } };
  await owner.db.write();
  for (const [endpoint, body] of [['/api/groups', { name: 'Synthetic empty group', ai_members: [] }], ['/api/private-chat/fixture_a', {}], ['/api/ai-private-chat', { aiMembers: ['fixture_a', 'fixture_b'] }]]) {
    const created = await http('POST', endpoint, body, owner.cookie); assert.equal(created.status, 201, JSON.stringify(created.body));
    const f = { ...owner, groupId: created.body.id, endpoint: `/api/groups/${created.body.id}/messages` };
    const baseline = await page(f); assert.deepEqual(baseline.messages, []); assert.equal(baseline.high_watermark, '0'); assert.equal(baseline.consumed_through, '0'); assert.equal(baseline.before_cursor, null);
    const sent = await post(f); assert.equal(sent.status, 201, JSON.stringify(sent.body)); assert.equal(sent.body.server_order.sequence, '1'); assert.equal(sent.body.server_order.generation, baseline.generation);
    const after = await page(f, `order=sequence_v1&after_cursor=${baseline.after_cursor}`); assert.deepEqual(ids(after), [sent.body.id]); assert.equal(after.consumed_through, '1');
  }
});
