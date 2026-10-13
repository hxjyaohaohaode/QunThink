import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { buildLegacyMessageOrder } from '../src/services/messageOrder.js';
import { orderedMessagePage, parseMessagePageQuery } from '../src/services/messagePagination.js';

const spec = parse(await readFile(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8'));
const operation = spec.paths['/api/groups/{groupId}/messages'].get;
const schemas = spec.components.schemas;

test('OpenAPI declares sequence cursors and the actual timestamp upgrade error', () => {
  const query = Object.fromEntries(operation.parameters.filter(p => p.in === 'query').map(p => [p.name, p]));
  assert.deepEqual(query.order.schema.enum, ['sequence_v1']);
  assert.equal(query.limit.schema.maximum, 200);
  for (const key of ['before_cursor', 'after_cursor']) {
    assert.equal(query[key].schema.maxLength, 1024);
    assert.equal(query[key].schema.minLength, 1);
  }
  for (const key of ['before', 'after']) {
    assert.equal(query[key].deprecated, true);
    assert.throws(() => parseMessagePageQuery(`${key}=old`), error => error.statusCode === 428 && error.code === 'MESSAGE_CURSOR_REQUIRED');
  }
  for (const code of ['200', '400', '401', '404', '409', '428', '503']) assert.ok(operation.responses[code], code);
});

test('OpenAPI ordered response required fields and null cursor rules match real projection', () => {
  const ownerId = 'synthetic-openapi-owner', groupId = 'synthetic-openapi-group';
  const snapshot = { groups: [{ id: groupId }], messages: [1, 2, 3].map(i => ({ id: `m${i}`, group_id: groupId, created_at: '2026-10-13T00:00:00.000Z' })) };
  snapshot.message_order = buildLegacyMessageOrder(snapshot, ownerId, { generationForGroup: () => '8f22feef-6a7c-4bb7-a09a-43dca9c95d0a' });
  const run = raw => orderedMessagePage({ snapshot, readableMessages: snapshot.messages, ownerId, groupId, query: parseMessagePageQuery(raw) });
  const first = run('order=sequence_v1&limit=1');
  const before = run(`order=sequence_v1&limit=1&before_cursor=${first.before_cursor}`);
  const after = run(`order=sequence_v1&limit=1&after_cursor=${first.after_cursor}`);
  const schema = schemas.OrderedMessagesResponse;
  assert.deepEqual([...schema.required].sort(), Object.keys(first).sort());
  assert.deepEqual(schema.properties.order.enum, ['sequence_v1']);
  for (const page of [first, before, after]) {
    for (const key of schema.required) assert.ok(Object.hasOwn(page, key), key);
    assert.match(page.high_watermark, new RegExp(schema.properties.high_watermark.pattern));
    for (const row of page.messages) {
      assert.match(row.server_order.sequence, new RegExp(schemas.MessageOrder.properties.sequence.pattern));
      assert.deepEqual(Object.keys(row.server_order).sort(), [...schemas.MessageOrder.required].sort());
    }
  }
  for (const key of ['consumed_through', 'before_cursor', 'after_cursor']) assert.ok(schema.properties[key].type.includes('null'));
  assert.equal(before.consumed_through, null); assert.equal(before.after_cursor, null);
  assert.equal(after.before_cursor, null);
  assert.equal(schemas.Message.properties.server_order.$ref, '#/components/schemas/MessageOrder');
  assert.deepEqual(operation.responses['200'].content['application/json'].schema.anyOf.map(item => item.$ref), ['#/components/schemas/OrderedMessagesResponse', '#/components/schemas/PaginatedMessagesResponse']);
});
