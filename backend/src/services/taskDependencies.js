import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sourceSnapshot } from './taskSources.js';
import { readableSourceFiles } from './memory/persistentMemory.js';
import { taskResultState, plainVersion } from './taskResults.js';

export const TASK_DEPENDENCY_LIMITS = Object.freeze({ direct: 32, graph: 200, commands: 10000 });
const uuid = z.string().uuid().transform(value => value.toLowerCase());
export const dependencyIdsInput = z.array(uuid).max(TASK_DEPENDENCY_LIMITS.direct)
  .refine(ids => new Set(ids).size === ids.length, '前置任务不能重复');
export const editTaskDependenciesInput = z.object({ client_request_id: uuid,
  expected_revision: z.number().int().nonnegative(), dependency_ids: dependencyIdsInput }).strict();
export function dependencyError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status, statusCode: status, isOperational: true });
}
export function dependencyIds(task) {
  const parsed = dependencyIdsInput.safeParse(task.dependency_ids ?? []);
  if (!parsed.success) throw dependencyError('TASK_DEPENDENCY_STORAGE_UNCERTAIN', '前置任务记录无法核实，暂时不能执行', 503);
  return parsed.data;
}
export function dependencyRevision(task) {
  const value = task.dependency_revision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw dependencyError('TASK_DEPENDENCY_STORAGE_UNCERTAIN', '前置任务修订无法核实', 503);
  return value;
}
export function validateDependencyEdit(task, ids, db) {
  const tasks = db.data.tasks || [];
  if (!Array.isArray(tasks) || tasks.length > TASK_DEPENDENCY_LIMITS.graph) throw dependencyError('TASK_DEPENDENCY_GRAPH_LIMIT', '任务图超过当前安全核验上限', 409);
  const map = new Map(tasks.map(item => [item.id, item]));
  if (map.size !== tasks.length) throw dependencyError('TASK_DEPENDENCY_STORAGE_UNCERTAIN', '任务记录不唯一，暂时不能修改前置关系', 503);
  // Foreign and nonexistent IDs have the same account-local lookup and error.
  if (ids.some(id => !map.has(id))) throw dependencyError('TASK_DEPENDENCY_NOT_FOUND', '所选前置任务已删除或不属于当前账号', 404);
  const visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) throw dependencyError('TASK_DEPENDENCY_CYCLE', '前置任务不能形成循环');
    if (done.has(id)) return;
    visiting.add(id);
    const current = map.get(id);
    // Existing references to deleted tasks stay as blocking tombstones, never
    // silently dropped. They cannot introduce an edge back into the live graph.
    for (const next of id === task.id ? ids : current ? dependencyIds(current) : []) visit(next);
    visiting.delete(id); done.add(id);
    if (done.size > TASK_DEPENDENCY_LIMITS.graph + TASK_DEPENDENCY_LIMITS.direct) throw dependencyError('TASK_DEPENDENCY_GRAPH_LIMIT', '前置任务图超过安全核验上限');
  }
  visit(task.id);
}
export async function dependencyContext(userId, db, snapshot = null) {
  const sources = snapshot || await sourceSnapshot(userId, db);
  const files = await readableSourceFiles(userId, db);
  return { snapshot: sources, fileIds: new Set(files.map(file => file.id)), memo: new Map(), visiting: new Set() };
}
function headVersion(task, db) {
  const state = taskResultState(task, db);
  return { state, version: state.versions.find(version => version.id === state.head_version_id) };
}
function sourceState(task, version, db, context) {
  const all = task.group_id ? context.snapshot.messages.filter(message => message.group_id === task.group_id) : [];
  return plainVersion(task, version, { all, messages: all.slice(-40), fileIds: context.fileIds,
    blocked: !!task.group_id && (!context.snapshot.groupIds.has(task.group_id) ||
      !!task.source_message_id && !all.some(message => message.id === task.source_message_id)) }, db).source_status;
}
export function taskDependencyState(task, db, context) {
  if (context.memo.has(task.id)) return context.memo.get(task.id);
  if (context.visiting.has(task.id) || context.visiting.size >= TASK_DEPENDENCY_LIMITS.graph) {
    return { blocked: true, reasons: [{ task_id: task.id, code: 'invalid' }], signature: null, result_stale: true };
  }
  const reasons = [], proof = [];
  let ids;
  try { ids = dependencyIds(task); dependencyRevision(task); }
  catch { return { blocked: true, reasons: [{ task_id: task.id, code: 'invalid' }], signature: null, result_stale: true }; }
  context.visiting.add(task.id);
  try {
    for (const id of [...ids].sort()) {
      const required = (db.data.tasks || []).find(item => item.id === id);
      const fail = code => reasons.push({ task_id: id, code, ...(required ? { title: required.title } : {}) });
      if (!required) { fail('missing'); continue; }
      if (['failed', 'cancelled', 'outcome_unknown', 'running'].includes(required.status)) { fail(required.status); continue; }
      const prior = taskDependencyState(required, db, context);
      if (prior.blocked || prior.result_stale) { fail(prior.reasons.some(reason => reason.code === 'invalid') ? 'invalid' : 'dependency_changed'); continue; }
      try {
        const { state, version } = headVersion(required, db);
        if (!version || state.accepted_version_id !== version.id || state.accepted_content_hash !== version.content_hash) { fail('unaccepted'); continue; }
        if (sourceState(required, version, db, context) !== 'current') { fail('source_changed'); continue; }
        if ((version.dependency_signature ?? null) !== prior.signature) { fail('dependency_changed'); continue; }
        proof.push({ task_id: id, version_id: version.id, content_hash: version.content_hash,
          source_hash: version.source_hash ?? null, accepted_at: state.accepted_at ?? null,
          dependency_signature: prior.signature });
      } catch { fail('invalid'); }
    }
    const signature = ids.length && !reasons.length ? createHash('sha256').update(JSON.stringify(proof)).digest('hex') : null;
    let stale = false;
    try { const { version } = headVersion(task, db); stale = !!version && (reasons.length > 0 || (version.dependency_signature ?? null) !== signature); }
    catch { if (ids.length) { reasons.push({ task_id: task.id, code: 'invalid' }); stale = true; } }
    const result = { blocked: reasons.length > 0, reasons, signature, result_stale: stale };
    context.memo.set(task.id, result);
    return result;
  } finally { context.visiting.delete(task.id); }
}
export async function currentTaskDependencies(userId, task, db, context = null) {
  // Avoid introducing deletion-ledger reads to old standalone, source-free
  // tasks merely to report an empty dependency set.
  if (!dependencyIds(task).length) {
    const version = task.result_editor?.versions?.find(item => item.id === task.result_editor.head_version_id);
    const signature = version ? version.dependency_signature : task.history?.find(run => run.id === task.result_run_id)?.dependency_signature;
    return { blocked: false, reasons: [], signature: null, result_stale: !!signature };
  }
  return taskDependencyState(task, db, context || await dependencyContext(userId, db));
}
export function assertDependencyReady(state, expectedSignature = undefined) {
  if (state.blocked) throw dependencyError('TASK_DEPENDENCY_BLOCKED', '前置任务尚未完成有效验收，请核对阻塞原因后再继续');
  if (expectedSignature !== undefined && (expectedSignature ?? null) !== state.signature) {
    throw dependencyError('TASK_DEPENDENCY_CHANGED', '前置成果或来源已变化，请重新核对并保存新的正文版本');
  }
}
