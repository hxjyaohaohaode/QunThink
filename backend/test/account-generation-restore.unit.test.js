import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareRestorePlan, restoreFingerprint, buildRestoreTarget, verifyRestoreTarget, inspectRestoreSnapshot } from '../src/services/accountGenerationRestore.js';
import { PgLow } from '../src/models/supabaseAdapter.js';
const source = () => ({ preserved: { z: ['ciphertext', null, 4], a: { source_hash: 'a'.repeat(64), receipt: { exact: true } } },
  groups: [{ id: 'empty' }, { id: 'live' }], messages: [{ id: 'b', group_id: 'live', content: '{"encrypted":"synthetic"}' }],
  message_order: { version: 1, owner_id: 'synthetic-owner', groups: [
    { group_id: 'live', generation: randomUUID(), next_sequence: '9', bindings: [{message_id:'a',sequence:'2',creation_intent_hash:'f'.repeat(64)},{message_id:'b',sequence:'8'}] },
    { group_id: 'empty', generation: randomUUID(), next_sequence: '1', bindings: [] },
    { group_id: 'deleted', generation: randomUUID(), next_sequence: '4', bindings: [{message_id:'old',sequence:'3'}] }
  ] } });
test('fixed plan rotates every sidecar, preserving all other values and physical array ordering', () => {
  const data = source(), before = structuredClone(data), plan = prepareRestorePlan(data, 'synthetic-owner');
  const target = buildRestoreTarget(data, plan);
  assert.deepEqual(data, before); assert.equal(plan.generations.length, 3);
  for (let i=0;i<3;i++) { assert.notEqual(target.message_order.groups[i].generation, data.message_order.groups[i].generation); target.message_order.groups[i].generation = data.message_order.groups[i].generation; }
  assert.deepEqual(target, data);
  assert.equal(inspectRestoreSnapshot(data,true,plan,'synthetic-owner'),'unconfirmed');
  assert.equal(inspectRestoreSnapshot(buildRestoreTarget(data,plan),true,plan,'synthetic-owner'),'confirmed');
});
test('canonical fingerprints ignore object key serialization but retain array order and exact values', () => {
  const data = source(), reordered = Object.fromEntries(Object.entries(data).reverse());
  reordered.preserved = Object.fromEntries(Object.entries(data.preserved).reverse());
  assert.equal(restoreFingerprint(data),restoreFingerprint(reordered));
  const reversed = structuredClone(data); reversed.message_order.groups.reverse();
  assert.notEqual(restoreFingerprint(data),restoreFingerprint(reversed));
  assert.throws(()=>restoreFingerprint({invalid:undefined}));
});
test('wrong owner, unknown fields/version, invalid UUID, duplicate/missing/reordered maps and tampering reject', () => {
  const data=source(), plan=prepareRestorePlan(data,'synthetic-owner');
  for (const mutate of [p=>p.owner_id='other',p=>p.version=2,p=>p.extra=true,p=>p.generations.pop(),p=>p.generations.reverse(),p=>p.generations.push(p.generations[0]),p=>p.generations[0].to=p.generations[0].from,p=>p.generations[0].to='invalid',p=>p.target_hash='0'.repeat(64)]) {
    const p=structuredClone(plan); mutate(p); assert.throws(()=>buildRestoreTarget(data,p,'synthetic-owner'));
  }
  const target=buildRestoreTarget(data,plan); target.preserved.z[0]='different';
  assert.throws(()=>verifyRestoreTarget(target,plan));
  const forged=structuredClone(plan); forged.target_hash=restoreFingerprint(target);
  assert.throws(()=>verifyRestoreTarget(target,forged),{code:'RESTORE_TARGET_CONFLICT'},'target hash alone cannot hide a non-generation delta');
});
test('legal zero-sidecar account is confirmed with zero changes', () => {
  const data={groups:[],messages:[],message_order:{version:1,owner_id:'synthetic-owner',groups:[]}};
  const plan=prepareRestorePlan(data,'synthetic-owner'); assert.equal(plan.source_hash,plan.target_hash);
  assert.equal(inspectRestoreSnapshot(data,true,plan,'synthetic-owner'),'confirmed');
});
for (const branch of ['deleted row','concurrent revision winner']) test(`existing-only revision-zero ${branch} never INSERTs; ordinary raw behavior stays unchanged`, async () => {
  const calls=[]; const pool={query:async sql=>{calls.push(sql.trim().split(/\s/)[0]);return sql.includes('INSERT')?{rowCount:1,rows:[{revision:'1'}]}:{rowCount:0,rows:[]};}};
  const strict=new PgLow('user:synthetic-owner',{},pool,{existingOnly:true});
  await assert.rejects(strict.write({snapshot:{groups:[],messages:[]},expectedRevision:0}),{code:'REVISION_CONFLICT'});
  assert.deepEqual(calls,['UPDATE']); calls.length=0;
  await new PgLow('user:synthetic-owner',{},pool).write({snapshot:{groups:[],messages:[]},expectedRevision:0});
  assert.deepEqual(calls,['UPDATE','INSERT']);
});
