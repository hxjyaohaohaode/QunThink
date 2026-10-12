import test from 'node:test';
import assert from 'node:assert/strict';
import { settleKnownMetadataQueue } from '../scripts/metadata-command-queue-recovery.mjs';
const winner = { client_request_id: 'winner', expected_revision: 0 }, loser = { client_request_id: 'loser', expected_revision: 0 };
function setup(order, mutate = value => value) {
  const queue = [...order], actions = [], waits = [];
  return { queue, actions, waits, options: { winner, loser, ownerId: 'alice', taskId: 'task',
    observe: async () => queue.length ? { kind: 'pending', id: queue[0] } : { kind: 'ready' },
    act: async action => { actions.push(action); const closed = action.operation === 'close'; return mutate({ status: 200, method: closed ? 'POST' : 'GET', path: action.path, ownerId: 'alice', requestBody: closed ? {} : undefined, body: { receipt: { id: action.id, task_id: 'task', operation: 'metadata', status: closed ? 'cancelled' : 'succeeded', committed_revision: closed ? null : 1 }, task: { id: 'task', metadata_revision: 1 } } }); },
    waitForAdvance: async id => { assert.equal(queue[0], id); waits.push(id); await Promise.resolve(); queue.shift(); },
  } };
}
for (const order of [['loser', 'winner'], ['winner', 'loser'], ['loser']]) test(`visible exact UUID order ${order} settles once without closing the winner`, async () => {
  const s = setup(order); assert.deepEqual(await settleKnownMetadataQueue(s.options), order);
  assert.deepEqual(s.actions.map(a => [a.id, a.operation]), order.map(id => [id, id === 'loser' ? 'close' : 'verify'])); assert.deepEqual(s.waits, order);
});
test('known request arriving during rendered-head settlement is observed before re-edit', async () => {
  const s = setup(['winner']); s.options.waitForAdvance = async id => { s.waits.push(id); s.queue.shift(); if (id === 'winner') { await Promise.resolve(); s.queue.push('loser'); } };
  assert.deepEqual(await settleKnownMetadataQueue(s.options), ['winner', 'loser']); assert.equal(s.actions.length, 2);
});
for (const order of [['unknown'], ['winner', 'unknown'], ['winner', 'winner'], ['loser', 'winner', 'unknown']]) test(`unknown or repeated queue ${order} stops without another action`, async () => {
  const s = setup(order); await assert.rejects(settleKnownMetadataQueue(s.options), /Unknown|repeated/);
  assert.equal(s.actions.some(a => a.id === 'unknown'), false); assert.ok(s.actions.filter(a => a.id === 'winner').length <= 1); assert.ok(s.actions.length <= 2);
});
test('a missing rejected request cannot silently count as cancelled', async () => {
  for (const order of [[], ['winner']]) { const s = setup(order); await assert.rejects(settleKnownMetadataQueue(s.options), /before the exact rejected command/); }
});
for (const changed of ['owner', 'task', 'uuid', 'revision', 'status', 'operation', 'path', 'method', 'body', 'deleted', 'http']) test(`a ${changed} mismatch fails closed without consuming the visible request`, async () => {
  const s = setup(['loser'], r => {
    if (changed === 'owner') r.ownerId = 'bob'; if (changed === 'task') r.body.receipt.task_id = 'other'; if (changed === 'uuid') r.body.receipt.id = 'winner';
    if (changed === 'revision') r.body.task.metadata_revision = 2; if (changed === 'status') r.body.receipt.status = 'succeeded'; if (changed === 'operation') r.body.receipt.operation = 'dependencies';
    if (changed === 'path') r.path += '/other'; if (changed === 'method') r.method = 'GET'; if (changed === 'body') r.requestBody = { changes: {} }; if (changed === 'deleted') r.body.task_deleted = true; if (changed === 'http') r.status = 404; return r;
  });
  await assert.rejects(settleKnownMetadataQueue(s.options), /does not match/); assert.equal(s.actions.length, 1); assert.equal(s.waits.length, 0);
});
test('unknown network result is never replayed and no later command is touched', async () => {
  const s = setup(['loser', 'winner']); s.options.act = async a => { s.actions.push(a); throw new Error('network unknown'); };
  await assert.rejects(settleKnownMetadataQueue(s.options), /network unknown/); assert.equal(s.actions.length, 1); assert.equal(s.waits.length, 0);
});
test('native recovery asserts a new UUID and new revision only after cancelled receipt and explicit re-edit', async () => {
  const { readFile } = await import('node:fs/promises'); const source = await readFile(new URL('../e2e/task-metadata.spec.ts', import.meta.url), 'utf8');
  assert.match(source, /settleKnownMetadataQueue/); assert.match(source, /newCommand\.client_request_id\)\.not\.toBe\(firstSent\.client_request_id\)/);
  assert.match(source, /newCommand\.client_request_id\)\.not\.toBe\(secondSent\.client_request_id\)/); assert.match(source, /newCommand\.expected_revision\)\.toBe\(1\)/);
  assert.doesNotMatch(source, /if \(await verify\.count\(\)\)/);
  assert.doesNotMatch(source, /has: first\.getByText/);
  assert.match(source, /first\.filter\(\{ has: page\.getByText\(id/);
});
