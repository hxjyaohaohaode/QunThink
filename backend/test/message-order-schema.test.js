import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MESSAGE_ORDER_LIMITS, MAX_MESSAGE_SEQUENCE, buildLegacyMessageOrder,
  initializeNewAccountOrder, validateMessageOrder, prepareOrderedGroup,
  prepareOrderedAppend, assertMessageOrderPreserved, projectMessageOrder,
  parseMessageSequence
} from '../src/services/messageOrder.js';

const owner = 'synthetic-owner-a';
const generation = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const gen = () => generation(1);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacy = () => ({ groups: [{ id: 'preset', name: 'synthetic' }], messages: [],
  messageIdempotency: [{ client_message_id: 'original-key', message_id: 'deleted-legacy', request_hash: 'do-not-change' }],
  extra: { source_ids: ['old-b', 'old-a'], private_notes: 'synthetic-only' } });
const message = (id, time = '2026-10-13T01:00:00.000Z', group = 'preset') => ({
  id, group_id: group, created_at: time, content: '{"encrypted":"synthetic-not-a-key"}',
  metadata: { encryption: { encrypted: true }, original: 'unchanged' }, attachments: []
});
const current = () => initializeNewAccountOrder(legacy(), owner, { generationForGroup: gen });
const append = (data, id, options = {}) => prepareOrderedAppend(data, owner, message(id), { creationIntentHash: hash({ id }), ...options });
const unavailable = fn => assert.throws(fn, error => error.code === 'MESSAGE_ORDER_UNAVAILABLE' && error.status === 503);
const atCapacity = fn => assert.throws(fn, error => error.code === 'MESSAGE_ORDER_CAPACITY_EXCEEDED' && error.status === 409);

test('explicit empty-account initialization preserves every prior field and does not mutate input', () => {
  const input = legacy(), bytes = JSON.stringify(input), data = initializeNewAccountOrder(input, owner, { generationForGroup: gen });
  assert.equal(JSON.stringify(input), bytes);
  const { message_order, ...original } = data;
  assert.equal(JSON.stringify(original), bytes);
  assert.equal(message_order.owner_id, owner);
  assert.deepEqual(message_order.groups, [{ group_id: 'preset', generation: generation(1), next_sequence: '1', bindings: [] }]);
  assert.equal(validateMessageOrder(data, owner).bindings.size, 0);
});

test('legacy migration preserves ciphertext, receipts, all original arrays and values with more than 40 messages', () => {
  const input = legacy();
  for (let n = 0; n < 51; n++) input.messages.push(message(`id-${n}`, new Date(Date.UTC(2026, 9, 13, 1, 0, 50 - n)).toISOString()));
  input.messages[20].created_at = input.messages[19].created_at;
  const bytes = JSON.stringify(input), beforeLast40 = hash(input.messages.slice(-40));
  const order = buildLegacyMessageOrder(input, owner, { generationForGroup: gen });
  assert.equal(JSON.stringify(input), bytes);
  const migrated = { ...structuredClone(input), message_order: order };
  const { message_order, ...original } = migrated;
  assert.equal(JSON.stringify(original), bytes); assert.equal(hash(original.messages.slice(-40)), beforeLast40);
  assert.equal(message_order.groups[0].bindings[0].message_id, 'id-50');
  const sorted = message_order.groups[0].bindings.map(row => row.message_id);
  assert.ok(sorted.indexOf('id-19') < sorted.indexOf('id-20'), 'same-time migration uses original physical index');
  assert.ok(message_order.groups[0].bindings.every(row => !('creation_intent_hash' in row)), 'never fabricate original creation intent');
});

test('only explicit legacy schema may migrate; partial/new/unknown schemas are not silently rebuilt', () => {
  for (const order of [null, {}, { version: 99 }, current().message_order]) unavailable(() => buildLegacyMessageOrder({ ...legacy(), message_order: order }, owner, { generationForGroup: gen }));
  const populated = legacy(); populated.messages.push(message('old'));
  unavailable(() => initializeNewAccountOrder(populated, owner, { generationForGroup: gen }));
});

test('invalid and timezone-ambiguous legacy timestamps fail before any mutation', () => {
  for (const time of [undefined, 'bad', '2026-10-13T01:00:00']) {
    const input = legacy(); input.messages.push(message('old', time)); input.messages[0].created_at = time;
    const before = JSON.stringify(input);
    unavailable(() => buildLegacyMessageOrder(input, owner, { generationForGroup: gen }));
    assert.equal(JSON.stringify(input), before);
  }
});

test('orphan historical group gets an order identity without recreating its group or permitting append', () => {
  const input = legacy(); input.messages.push(message('orphan-message', undefined, 'deleted-group'));
  const data = { ...input, message_order: buildLegacyMessageOrder(input, owner, { generationForGroup: gen }) };
  assert.equal(data.groups.length, 1); assert.equal(validateMessageOrder(data, owner).groups.size, 2);
  unavailable(() => prepareOrderedAppend(data, owner, message('new', undefined, 'deleted-group'), { creationIntentHash: hash('new') }));
});

test('detached append assigns order while old records and receipt hashes remain unchanged', () => {
  const input = current(), before = JSON.stringify(input), prepared = message('new'), preparedBytes = JSON.stringify(prepared);
  const result = prepareOrderedAppend(input, owner, prepared, { creationIntentHash: hash(prepared) });
  assert.equal(JSON.stringify(input), before); assert.equal(JSON.stringify(prepared), preparedBytes);
  assert.deepEqual(result.serverOrder, { generation: generation(1), sequence: '1' });
  assert.equal(JSON.stringify(result.data.messages[0]), preparedBytes);
  assert.equal(JSON.stringify(result.data.messageIdempotency), JSON.stringify(input.messageIdempotency));
  assert.equal('server_order' in result.data.messages[0], false);
  result.data.extra.private_notes = 'local candidate only'; assert.equal(input.extra.private_notes, 'synthetic-only');
});

test('creation order ignores new clock rollback, tied timestamp and smaller random ID', () => {
  let data = current();
  for (const [id, time] of [['z', '2026-10-13T02:00:00Z'], ['a', '2026-10-13T01:00:00Z'], ['0', '2026-10-13T01:00:00Z']]) {
    data = prepareOrderedAppend(data, owner, message(id, time), { creationIntentHash: hash(id) }).data;
  }
  assert.deepEqual(data.message_order.groups[0].bindings.map(row => [row.message_id, row.sequence]), [['z', '1'], ['a', '2'], ['0', '3']]);
  assert.deepEqual(data.messages.map(row => row.id), ['z', 'a', '0']);
});

test('delete/clear/group delete retain bindings; deleted IDs and group identities cannot be reused', () => {
  const first = append(current(), 'one').data, cleared = structuredClone(first);
  cleared.messages = []; assertMessageOrderPreserved(first, cleared, owner);
  assert.throws(() => append(cleared, 'one'), error => error.code === 'MESSAGE_ORDER_ID_BOUND');
  const second = append(cleared, 'two').data; assert.equal(second.message_order.groups[0].bindings[1].sequence, '2');
  const removed = structuredClone(second); removed.groups = []; removed.messages = [];
  assertMessageOrderPreserved(second, removed, owner);
  assert.throws(() => prepareOrderedGroup(removed, owner, { id: 'preset' }, { generation: generation(2) }), error => error.code === 'MESSAGE_ORDER_ID_BOUND');
  assert.deepEqual(removed.groups, []); assert.equal(validateMessageOrder(removed, owner).groups.size, 1);
});

test('empty group creation is atomic in the detached candidate and leaves next at one', () => {
  const input = current(), before = JSON.stringify(input);
  const data = prepareOrderedGroup(input, owner, { id: 'empty-new', name: 'synthetic' }, { generation: generation(2) });
  assert.equal(JSON.stringify(input), before); assert.equal(data.groups.length, 2);
  assert.deepEqual(data.message_order.groups[1], { group_id: 'empty-new', generation: generation(2), next_sequence: '1', bindings: [] });
  const broken = structuredClone(input); broken.groups.push({ id: 'missing-sidecar' });
  unavailable(() => validateMessageOrder(broken, owner));
});

test('response projection attaches sequence only to a detached copy', () => {
  const data = append(current(), 'one').data, before = JSON.stringify(data), index = validateMessageOrder(data, owner);
  const projected = projectMessageOrder(data.messages[0], index);
  assert.deepEqual(projected.server_order, { generation: generation(1), sequence: '1' });
  projected.metadata.original = 'only projection';
  assert.equal(JSON.stringify(data), before);
  unavailable(() => projectMessageOrder({ ...data.messages[0], group_id: 'other' }, index));
});

test('same preset/ID in separate account documents remains independent; foreign sidecar is rejected', () => {
  const a = append(current(), 'same').data;
  const b = initializeNewAccountOrder(legacy(), 'synthetic-owner-b', { generationForGroup: () => generation(2) });
  const created = prepareOrderedAppend(b, 'synthetic-owner-b', message('same'), { creationIntentHash: hash('same') });
  assert.equal(created.serverOrder.sequence, '1'); unavailable(() => validateMessageOrder(a, 'synthetic-owner-b'));
  const polluted = legacy(); polluted.messages.push({ ...message('foreign'), owner_user_id: 'synthetic-owner-b' });
  unavailable(() => buildLegacyMessageOrder(polluted, owner, { generationForGroup: gen }));
});

for (const value of [null, false, 0, '']) test(`explicit malformed owner ${JSON.stringify(value)} is not treated as a missing legacy owner`, () => {
  for (const domain of ['groups', 'messages']) {
    const input = legacy();
    if (domain === 'messages') input.messages.push(message('old'));
    input[domain][0].owner_user_id = value;
    const before = JSON.stringify(input);
    unavailable(() => buildLegacyMessageOrder(input, owner, { generationForGroup: gen }));
    assert.equal(JSON.stringify(input), before);
  }
});

const corruptions = {
  'missing sidecar': data => { delete data.message_order; },
  'unknown version': data => { data.message_order.version = 2; },
  'unknown sidecar field': data => { data.message_order.unrecognized = true; },
  'duplicate group binding': data => { data.message_order.groups.push(structuredClone(data.message_order.groups[0])); },
  'invalid generation': data => { data.message_order.groups[0].generation = 'guess'; },
  'duplicate raw ID': data => { data.messages.push(structuredClone(data.messages[0])); },
  'missing ID binding': data => { data.message_order.groups[0].bindings = []; },
  'duplicate sequence': data => { data.message_order.groups[0].bindings.push({ message_id: 'other', sequence: '1' }); },
  'wrong group binding': data => { data.messages[0].group_id = 'other'; },
  'regressed next': data => { data.message_order.groups[0].next_sequence = '1'; },
  'invalid hash': data => { data.message_order.groups[0].bindings[0].creation_intent_hash = 'not-a-digest'; }
};
for (const [label, corrupt] of Object.entries(corruptions)) test(`malformed persisted order fails closed: ${label}`, () => {
  const data = append(current(), 'one').data; corrupt(data); const bytes = JSON.stringify(data);
  unavailable(() => validateMessageOrder(data, owner)); assert.equal(JSON.stringify(data), bytes);
});

for (const field of ['sequence', 'creation_intent_hash', 'generation', 'next_sequence']) test(`ordinary writes cannot rewrite prior ${field}`, () => {
  const before = append(current(), 'one').data, after = structuredClone(before), group = after.message_order.groups[0];
  if (field === 'sequence') { group.bindings[0].sequence = '2'; group.next_sequence = '3'; }
  if (field === 'creation_intent_hash') group.bindings[0].creation_intent_hash = hash('other');
  if (field === 'generation') group.generation = generation(2);
  if (field === 'next_sequence') { group.bindings = []; after.messages = []; group.next_sequence = '1'; }
  unavailable(() => assertMessageOrderPreserved(before, after, owner));
});

test('metadata-only writes and message edits preserve creation order without changing their contracts', () => {
  const before = append(current(), 'one').data, after = structuredClone(before);
  after.messages[0].content = 'synthetic edited ciphertext'; after.messages[0].revision = 2;
  after.extra.private_notes = 'another synthetic note'; assertMessageOrderPreserved(before, after, owner);
});

test('normal-write gate rejects resurrecting a previously removed message even with its original binding', () => {
  const original = append(current(), 'one').data, deleted = structuredClone(original);
  deleted.messages = []; assertMessageOrderPreserved(original, deleted, owner);
  unavailable(() => assertMessageOrderPreserved(deleted, original, owner));
});

test('normal-write gate rejects restoring a deleted group under its old generation', () => {
  const original = current(), deleted = structuredClone(original);
  deleted.groups = []; assertMessageOrderPreserved(original, deleted, owner);
  unavailable(() => assertMessageOrderPreserved(deleted, original, owner));
});

test('normal-write gate cannot append a new binding into a retained orphan group', () => {
  const before = current(); before.groups = [];
  const after = structuredClone(before);
  after.messages.push(message('not-authorized-by-sidecar'));
  after.message_order.groups[0].bindings.push({ message_id: 'not-authorized-by-sidecar', sequence: '1', creation_intent_hash: hash('new') });
  after.message_order.groups[0].next_sequence = '2';
  unavailable(() => assertMessageOrderPreserved(before, after, owner));
});

test('normal-write gate cannot insert a newly created ID below an existing next_sequence', () => {
  const before = current(); before.message_order.groups[0].next_sequence = '10';
  const after = structuredClone(before);
  after.messages.push(message('late-low-number'));
  after.message_order.groups[0].bindings.push({ message_id: 'late-low-number', sequence: '1', creation_intent_hash: hash('new') });
  unavailable(() => assertMessageOrderPreserved(before, after, owner));
});

for (const marker of ['deleted_at', 'is_deleted']) test(`normal-write gate cannot clear a prior ${marker} deletion marker`, () => {
  const original = append(current(), 'one').data, deleted = structuredClone(original);
  deleted.messages[0][marker] = marker === 'is_deleted' ? true : '2026-10-13T02:00:00Z';
  assertMessageOrderPreserved(original, deleted, owner);
  unavailable(() => assertMessageOrderPreserved(deleted, original, owner));
});

test('numbers stay exact beyond Number safe range and stop before next_sequence overflow', () => {
  assert.ok(parseMessageSequence('10') > parseMessageSequence('9'));
  assert.ok(parseMessageSequence('9007199254740993') > parseMessageSequence('9007199254740992'));
  for (const bad of ['01', '1e2', '-1', '1.0', '', '0', '9223372036854775808', 1, null]) unavailable(() => parseMessageSequence(bad));
  assert.equal(parseMessageSequence('0', { allowZero: true }), 0n);
  const data = current(); data.message_order.groups[0].next_sequence = String(MAX_MESSAGE_SEQUENCE);
  const before = JSON.stringify(data); atCapacity(() => append(data, 'one')); assert.equal(JSON.stringify(data), before);
});

test('binding capacity refuses the entire candidate; retained tombstones count', () => {
  const first = append(current(), 'one').data; first.messages = [];
  const before = JSON.stringify(first), limits = { ...MESSAGE_ORDER_LIMITS, maxBindings: 1 };
  atCapacity(() => append(first, 'two', { limits })); assert.equal(JSON.stringify(first), before);
});

test('UTF-8 sidecar byte budget has exact boundary including empty groups', () => {
  const data = current(), bytes = Buffer.byteLength(JSON.stringify(data.message_order));
  assert.equal(validateMessageOrder(data, owner, { limits: { maxBindings: 10, maxBytes: bytes } }).bytes, bytes);
  atCapacity(() => validateMessageOrder(data, owner, { limits: { maxBindings: 10, maxBytes: bytes - 1 } }));
  const before = JSON.stringify(data);
  atCapacity(() => prepareOrderedGroup(data, owner, { id: '新群' }, { generation: generation(2), limits: { maxBindings: 10, maxBytes: bytes } }));
  assert.equal(JSON.stringify(data), before);
});

test('prototype-shaped IDs are data, not object property writes', () => {
  const input = { groups: [{ id: '__proto__' }], messages: [message('constructor', undefined, '__proto__')] };
  const data = { ...input, message_order: buildLegacyMessageOrder(input, owner, { generationForGroup: gen }) };
  assert.equal(validateMessageOrder(data, owner).bindings.get('constructor').groupId, '__proto__');
  assert.equal(Object.prototype.polluted, undefined);
});

for (const [code, status, action] of [
  ['MESSAGE_ORDER_UNAVAILABLE', 503, () => validateMessageOrder({}, owner)],
  ['MESSAGE_ORDER_CAPACITY_EXCEEDED', 409, () => append(current(), 'one', { limits: { maxBindings: 0, maxBytes: 8192 } })],
  ['MESSAGE_ORDER_ID_BOUND', 409, () => append(append(current(), 'one').data, 'one')]
]) test(`${code} is compatible with the actual operational HTTP error middleware`, () => {
  assert.throws(action, error => error.isOperational === true && error.code === code && error.status === status && error.statusCode === status);
});
