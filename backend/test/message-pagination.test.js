import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLegacyMessageOrder } from '../src/services/messageOrder.js';
import { orderedMessagePage, parseMessagePageQuery, MESSAGE_CURSOR_REQUIRED_TEXT } from '../src/services/messagePagination.js';

const ownerId = 'fixture-owner', groupId = 'group-presidential';
const generation = 'a5b30f79-88be-4618-a639-3dcb204587bf';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString());
const token = (kind, at, until) => encode({ v: 1, owner: ownerId, group: groupId, generation, kind, at, ...(until === undefined ? {} : { until }) });
const invalid = operation => assert.throws(operation, error => error.code === 'INVALID_MESSAGE_CURSOR' && error.statusCode === 400);
function fixture(count = 12) {
  const snapshot = { groups: [{ id: groupId }], messages: Array.from({ length: count }, (_, i) => ({ id: `message-${i + 1}`, group_id: groupId,
    content: `synthetic-${i + 1}`, created_at: '2026-10-13T03:00:00.000Z' })) };
  snapshot.message_order = buildLegacyMessageOrder(snapshot, ownerId, { generationForGroup: () => generation });
  const run = (query = 'order=sequence_v1&limit=5', readableMessages = snapshot.messages) => orderedMessagePage({ snapshot, readableMessages, ownerId, groupId, query: parseMessagePageQuery(query) });
  return { snapshot, run };
}

test('bootstrap and before use ascending sequence with a fixed H and independent cursors', () => {
  const { snapshot, run } = fixture(), original = structuredClone(snapshot);
  const first = run(); assert.deepEqual(first.messages.map(m => m.server_order.sequence), ['8', '9', '10', '11', '12']);
  assert.equal(first.high_watermark, '12'); assert.equal(first.consumed_through, '12'); assert.equal(first.hasMore, true);
  assert.deepEqual(decode(first.before_cursor), { v: 1, owner: ownerId, group: groupId, generation, kind: 'before', at: '8', until: '12' });
  const second = run(`order=sequence_v1&limit=5&before_cursor=${first.before_cursor}`);
  assert.deepEqual(second.messages.map(m => m.server_order.sequence), ['3', '4', '5', '6', '7']);
  assert.equal(second.consumed_through, null); assert.equal(second.after_cursor, null); assert.equal(second.high_watermark, '12');
  const last = run(`order=sequence_v1&limit=5&before_cursor=${second.before_cursor}`);
  assert.deepEqual(last.messages.map(m => m.server_order.sequence), ['1', '2']); assert.equal(last.hasMore, false); assert.equal(last.before_cursor, null);
  assert.deepEqual(snapshot, original);
});

test('after reads earliest pages and consumes H only when the fixed batch is exhausted', () => {
  const { run } = fixture(); let cursor = token('after', '0');
  for (const [expected, consumed, more] of [[['1', '2', '3', '4', '5'], '5', true], [['6', '7', '8', '9', '10'], '10', true], [['11', '12'], '12', false]]) {
    const page = run(`order=sequence_v1&limit=5&after_cursor=${cursor}`); cursor = page.after_cursor;
    assert.deepEqual(page.messages.map(m => m.server_order.sequence), expected); assert.equal(page.consumed_through, consumed);
    assert.equal(page.before_cursor, null); assert.equal(page.hasMore, more); assert.equal(decode(cursor).until, more ? '12' : undefined);
  }
});

test('deleted anchor and empty readable windows use numeric frontiers and consume holes without looping', () => {
  const { snapshot, run } = fixture(), first = run();
  snapshot.messages = snapshot.messages.filter(m => !['message-8', 'message-7', 'message-6'].includes(m.id));
  const before = run(`order=sequence_v1&limit=5&before_cursor=${first.before_cursor}`);
  assert.deepEqual(before.messages.map(m => m.server_order.sequence), ['1', '2', '3', '4', '5']);
  const empty = run(`order=sequence_v1&after_cursor=${token('after', '0', '12')}`, []);
  assert.deepEqual(empty.messages, []); assert.equal(empty.consumed_through, '12'); assert.equal(empty.hasMore, false);
  assert.deepEqual(decode(empty.after_cursor), decode(token('after', '12')));
});

test('sequence sorting compares BigInt across 9 to 10 and beyond safe integers', () => {
  const { snapshot, run } = fixture(4);
  const seqs = ['9007199254740993', '10', '9007199254740992', '9'];
  snapshot.message_order.groups[0].bindings.forEach((b, i) => { b.sequence = seqs[i]; });
  snapshot.message_order.groups[0].next_sequence = '9007199254740994';
  const first = run('order=sequence_v1&limit=2');
  assert.deepEqual(first.messages.map(m => m.server_order.sequence), ['9007199254740992', '9007199254740993']);
  assert.equal(first.high_watermark, '9007199254740993');
  const second = run(`order=sequence_v1&limit=2&before_cursor=${first.before_cursor}`);
  assert.deepEqual(second.messages.map(m => m.server_order.sequence), ['9', '10']);
});

test('empty bootstrap establishes zero and returns an after cursor but no history frontier', () => {
  const page = fixture(0).run(); assert.deepEqual(page.messages, []); assert.equal(page.high_watermark, '0');
  assert.equal(page.consumed_through, '0'); assert.equal(page.before_cursor, null); assert.equal(page.hasMore, false);
  assert.deepEqual(decode(page.after_cursor), decode(token('after', '0')));
});

test('new queries are unique and bounded, and legacy before/after always require upgrade', () => {
  for (const query of ['order=sequence_v1&limit=0', 'order=sequence_v1&limit=201', 'order=sequence_v1&limit=01', 'order=sequence_v1&limit=1e2',
    'order=sequence_v1&limit=1.0', 'order=sequence_v1&limit=+1', 'order=sequence_v1&limit=2&limit=2', 'order=sequence_v1&order=sequence_v1',
    'order=sequence_v1&after_cursor=x&before_cursor=y', 'order=sequence_v1&after_cursor=', 'order=sequence_v1&after_cursor=x&after_cursor=x',
    'order=sequence_v1&after_cursor[]=x', 'order=sequence_v1&unknown=1', 'order=unknown', 'after_cursor=x', 'x'.repeat(4097),
    `order=sequence_v1&after_cursor=${'a'.repeat(1025)}`]) invalid(() => parseMessagePageQuery(query));
  for (const key of ['before', 'after']) for (const prefix of ['', 'order=sequence_v1&']) {
    assert.throws(() => parseMessagePageQuery(`${prefix}${key}=`), error => error.code === 'MESSAGE_CURSOR_REQUIRED' && error.statusCode === 428 && error.message === MESSAGE_CURSOR_REQUIRED_TEXT);
  }
  assert.deepEqual(parseMessagePageQuery('limit=bad'), { kind: 'legacy', rawLimit: 'bad' });
  assert.equal(parseMessagePageQuery('order=sequence_v1&limit=200').limit, 200);
});

test('cursor strict canonical JSON/base64url rejects alternate syntax, duplicate/unknown fields and invalid UTF-8', () => {
  const { run } = fixture(), valid = token('after', '0'), obj = decode(valid), json = JSON.stringify(obj);
  const candidates = [valid + '=', valid + '\n', '+/' + valid, valid + 'é', Buffer.from('null').toString('base64url'), encode([]),
    encode({ ...obj, secret: true }), Buffer.from(json.replace('"v":1', '"v":1,"v":1')).toString('base64url'),
    Buffer.from(` ${json}`).toString('base64url'), encode({ at: obj.at, ...obj }),
    Buffer.from(json.replace('"v":1', '"v":1.0')).toString('base64url'),
    Buffer.concat([Buffer.from(json.slice(0, -1)), Buffer.from([0xff]), Buffer.from('}')]).toString('base64url')];
  for (const cursor of candidates) invalid(() => run(`order=sequence_v1&after_cursor=${encodeURIComponent(cursor)}`));
  // Base64 decoders accept nonzero unused pad bits. A canonical token does not.
  let noncanonical;
  for (const at of ['0', '10', '11']) {
    const canonical = token('after', at);
    for (const last of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
      const alternate = canonical.slice(0, -1) + last;
      if (alternate !== canonical && Buffer.from(alternate, 'base64url').equals(Buffer.from(canonical, 'base64url'))) { noncanonical = alternate; break; }
    }
    if (noncanonical) break;
  }
  assert.ok(noncanonical); invalid(() => run(`order=sequence_v1&after_cursor=${noncanonical}`));
});

test('scope, type, generation syntax, direction and numeric bounds are strict', () => {
  const { run } = fixture(), obj = decode(token('after', '0'));
  for (const change of [{ v: 2 }, { owner: 'other' }, { group: 'other' }, { generation: 'broken' }, { kind: 'before' }, { at: 0 },
    ...['-1', '+1', '01', '1e1', '1.0', '13', '9223372036854775808', '999999999999999999999999'].map(at => ({ at })),
    { at: '5', until: '4' }, { until: '13' }, { until: null }]) invalid(() => run(`order=sequence_v1&after_cursor=${encode({ ...obj, ...change })}`));
  invalid(() => run(`order=sequence_v1&before_cursor=${token('before', '0', '12')}`));
  invalid(() => run(`order=sequence_v1&before_cursor=${token('before', '1')}`));
});

test('legal previous generation resets; malformed/cross-scope cursors do not disclose generation', () => {
  const { run } = fixture(), obj = decode(token('after', '0'));
  const old = { ...obj, generation: 'b5b30f79-88be-4618-a639-3dcb204587bf' };
  for (const at of ['0', '99']) assert.throws(() => run(`order=sequence_v1&after_cursor=${encode({ ...old, at })}`), e => e.code === 'CURSOR_RESET_REQUIRED' && e.statusCode === 409);
  invalid(() => run(`order=sequence_v1&after_cursor=${encode({ ...old, owner: 'other' })}`));
  invalid(() => run(`order=sequence_v1&after_cursor=${encode({ ...old, at: '01' })}`));
});

test('corrupt schema fails closed rather than returning an empty page or reset', () => {
  for (const mutate of [data => { delete data.message_order; }, data => { data.message_order.version = 999; },
    data => { data.message_order.groups[0].bindings[1].sequence = '1'; }, data => { data.message_order.groups[0].bindings.pop(); }]) {
    const { snapshot, run } = fixture(); mutate(snapshot); assert.throws(run, error => error.code === 'MESSAGE_ORDER_UNAVAILABLE' && error.statusCode === 503);
  }
});
