import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandReadGate } from '../scripts/create-command-read-gate.mjs';
const ownerId = 'synthetic-owner', key = '5377c727-d9cc-4998-8299-01bdbcad04ba', taskId = '33dca665-9769-410f-a365-2e350543ce2d';
const origins = ['http://127.0.0.1:3210', 'http://127.0.0.1:3202'];
const task = { id: taskId, client_request_id: key, priority: 'high', estimated_minutes: 0, metadata_revision: 0 };
const receipt = () => ({ operation: 'create', status: 'succeeded', client_request_id: key, task_id: taskId, task_deleted: false, task: { ...task } });
const request = (path = `/api/tasks/commands/${key}`, origin = origins[0]) => ({ method: 'GET', url: origin + path, ownerId });
const setup = () => { const gate = createCommandReadGate({ ownerId, origins }); gate.bind({ key, taskId, priority: 'high', estimatedMinutes: 0 }); return gate; };
test('real list and original query responses stay held until the completed click barrier', async () => {
 const gate = setup(), list = gate.begin(request('/api/tasks')), query = gate.begin(request());
 const realList = [task], realReceipt = receipt(); gate.verify(list, { status: 200, body: realList }); gate.verify(query, { status: 200, body: realReceipt });
 let delivered = 0; const work = Promise.all([list, query].map(async ticket => { await gate.wait(ticket); gate.delivered(ticket); delivered++; }));
 await Promise.resolve(); assert.equal(delivered, 0); assert.equal(gate.snapshot().released, false);
 gate.releaseAfterClick(); await work; assert.equal(delivered, 2); gate.assertComplete(); assert.deepEqual(realList, [task]); assert.deepEqual(realReceipt, receipt());
});
test('real pre-create empty list is accepted as observed data without inventing a saved task', () => {
 const gate = createCommandReadGate({ ownerId, origins }); const list = gate.begin(request('/api/tasks')); gate.verify(list, { status: 200, body: [] }); assert.equal(gate.snapshot().verified, 1); assert.equal(gate.snapshot().released, false);
});
for (const origin of origins) test(`one exact original query may use supported origin ${origin}`, async () => {
 const gate = setup(), list = gate.begin(request('/api/tasks')), query = gate.begin(request(undefined, origin)); gate.verify(list, { status: 200, body: [task] }); gate.verify(query, { status: 200, body: receipt() }); gate.releaseAfterClick(); for (const ticket of [list, query]) { await gate.wait(ticket); gate.delivered(ticket); } gate.assertComplete();
});
for (const [name, change] of Object.entries({ owner: r => r.ownerId = 'other', uuid: r => r.url += '-other', method: r => r.method = 'POST', origin: r => r.url = 'https://foreign.test/api/tasks', suffix: r => r.url += '?retry=1' })) test(`wrong ${name} fails before a read is forwarded`, () => { const gate = setup(), r = request(); change(r); assert.throws(() => gate.begin(r)); assert.throws(() => gate.snapshot()); });
for (const [name, change] of Object.entries({ uuid: r => r.client_request_id = 'other', task: r => r.task.id = 'other', taskKey: r => r.task.client_request_id = 'other', operation: r => r.operation = 'metadata', deleted: r => r.task_deleted = true, missing: r => delete r.task.estimated_minutes, stringZero: r => r.task.estimated_minutes = '0', null: r => r.task.estimated_minutes = null, priority: r => r.task.priority = 'low', revision: r => r.task.metadata_revision = 1 })) test(`invalid authoritative ${name} never passes the barrier`, () => { const gate = setup(), ticket = gate.begin(request()), body = receipt(); change(body); assert.throws(() => gate.verify(ticket, { status: 200, body })); assert.throws(() => gate.releaseAfterClick()); });
test('non-200, extra query, fifth list and premature release are explicit failures', () => {
 let gate = setup(); assert.throws(() => gate.verify(gate.begin(request()), { status: 503, body: receipt() }));
 gate = setup(); gate.begin(request()); assert.throws(() => gate.begin(request()));
 gate = setup(); for (let n = 0; n < 4; n++) gate.begin(request('/api/tasks')); assert.throws(() => gate.begin(request('/api/tasks')));
 gate = setup(); assert.throws(() => gate.releaseAfterClick());
 gate = setup(); const ticket = gate.begin(request()); gate.verify(ticket, { status: 200, body: receipt() }); assert.throws(() => gate.delivered(ticket));
});

test('cleanup rejects held handlers without claiming a click, delivery or successful completion', async () => {
 const gate = setup(), list = gate.begin(request('/api/tasks')), query = gate.begin(request()); gate.verify(list, { status: 200, body: [task] }); gate.verify(query, { status: 200, body: receipt() });
 const waiting = Promise.all([list, query].map(async ticket => { await gate.wait(ticket); gate.delivered(ticket); })); gate.cleanup(); await assert.rejects(waiting, error => gate.isCleanupError(error));
 assert.equal(gate.snapshot().delivered, 0); assert.equal(gate.snapshot().released, false); assert.throws(() => gate.assertComplete());
});
test('cleanup before any read is idempotent and does not produce unhandled rejection activity', async () => { const gate = setup(); gate.cleanup(); gate.cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(gate.snapshot().released, false); assert.throws(() => gate.begin(request())); });
test('a started but unverified query cannot authorize releasing any real response', () => { const gate = setup(); gate.begin(request()); assert.throws(() => gate.releaseAfterClick()); });
