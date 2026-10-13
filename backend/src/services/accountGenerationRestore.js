// Offline, fixed generation-only delta. Never calls loaders, source filters or models.
import { createHash, randomUUID } from 'node:crypto';
import { validateRequiredAccount, accountStoreError } from '../models/accountStoreLifecycle.js';

export const restoreError = (code, cause) => accountStoreError(code, '恢复换代未获确认，请保持全部写入停止并核验原计划及维护票据', cause);
export const restoreDigest = value => createHash('sha256').update(value).digest('hex');
export const RESTORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ownerPattern = /^[A-Za-z0-9_-]{1,128}$/;
export function exactRestoreFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw restoreError('RESTORE_PLAN_INVALID');
}
export function canonicalRestoreJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalRestoreJson).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalRestoreJson(value[key])).join(',') + '}';
  }
  throw restoreError('RESTORE_DOCUMENT_INVALID');
}
export const restoreFingerprint = data => restoreDigest(canonicalRestoreJson(data));
export function validateRestorePlan(plan, owner) {
  exactRestoreFields(plan, ['version', 'owner_id', 'request_id', 'source_hash', 'target_hash', 'generations']);
  if (plan.version !== 1 || typeof owner !== 'string' || !ownerPattern.test(owner) || plan.owner_id !== owner
    || typeof plan.request_id !== 'string' || !RESTORE_UUID.test(plan.request_id)
    || typeof plan.source_hash !== 'string' || !HASH.test(plan.source_hash) || typeof plan.target_hash !== 'string' || !HASH.test(plan.target_hash)
    || !Array.isArray(plan.generations)) throw restoreError('RESTORE_PLAN_INVALID');
  const seen = new Set(), targets = new Set();
  for (const entry of plan.generations) {
    exactRestoreFields(entry, ['group_id', 'from', 'to']);
    if (typeof entry.group_id !== 'string' || !entry.group_id.length || entry.group_id.length > 128
      || /[\u0000-\u001f\u007f]/.test(entry.group_id) || seen.has(entry.group_id)
      || typeof entry.from !== 'string' || !RESTORE_UUID.test(entry.from) || typeof entry.to !== 'string' || !RESTORE_UUID.test(entry.to) || entry.from === entry.to || targets.has(entry.to)) throw restoreError('RESTORE_PLAN_INVALID');
    seen.add(entry.group_id); targets.add(entry.to);
  }
  return plan;
}
function replaceGenerations(data, plan, reverse) {
  validateRequiredAccount(data, plan.owner_id);
  const groups = data.message_order.groups;
  if (groups.length !== plan.generations.length) throw restoreError('RESTORE_PLAN_INVALID');
  const candidate = structuredClone(data);
  for (let i = 0; i < groups.length; i++) {
    const entry = plan.generations[i];
    if (groups[i].group_id !== entry.group_id || groups[i].generation !== entry[reverse ? 'to' : 'from']) throw restoreError('RESTORE_PLAN_INVALID');
    candidate.message_order.groups[i].generation = entry[reverse ? 'from' : 'to'];
  }
  validateRequiredAccount(candidate, plan.owner_id);
  return candidate;
}
export function buildRestoreTarget(source, plan, owner = plan?.owner_id) {
  validateRestorePlan(plan, owner);
  if (restoreFingerprint(source) !== plan.source_hash) throw restoreError('RESTORE_SOURCE_CHANGED');
  const target = replaceGenerations(source, plan, false);
  if (restoreFingerprint(target) !== plan.target_hash) throw restoreError('RESTORE_PLAN_INVALID');
  verifyRestoreTarget(target, plan, owner);
  return target;
}
export function verifyRestoreTarget(target, plan, owner = plan?.owner_id) {
  validateRestorePlan(plan, owner);
  if (restoreFingerprint(target) !== plan.target_hash
    || restoreFingerprint(replaceGenerations(target, plan, true)) !== plan.source_hash) throw restoreError('RESTORE_TARGET_CONFLICT');
}
export function prepareRestorePlan(source, owner, { uuid = randomUUID } = {}) {
  validateRequiredAccount(source, owner);
  const plan = { version: 1, owner_id: owner, request_id: uuid(), source_hash: restoreFingerprint(source), target_hash: '0'.repeat(64),
    generations: source.message_order.groups.map(group => ({ group_id: group.group_id, from: group.generation, to: uuid() })) };
  validateRestorePlan(plan, owner);
  plan.target_hash = restoreFingerprint(replaceGenerations(source, plan, false));
  buildRestoreTarget(source, plan, owner);
  return plan;
}
export function inspectRestoreSnapshot(data, exists, plan, owner) {
  validateRestorePlan(plan, owner); validateRequiredAccount(data, owner, exists);
  const hash = restoreFingerprint(data);
  if (hash === plan.target_hash) { verifyRestoreTarget(data, plan, owner); return 'confirmed'; }
  if (hash === plan.source_hash) { buildRestoreTarget(data, plan, owner); return 'unconfirmed'; }
  throw restoreError('RESTORE_TARGET_CONFLICT');
}
