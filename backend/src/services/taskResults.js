import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getUserDb, withWriteLock, beginUserDbWriteBarrier } from '../models/db.js';
import { encryptText, decryptData } from '../utils/encryption.js';
import { readableSourceFiles } from './memory/persistentMemory.js';
import { sourceHash, sourceSnapshot, isTaskInputSourceStale } from './taskSources.js';

export const TASK_RESULT_LIMITS = Object.freeze({ versions: 100, commands: 10000, content: 64000 });
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const content = z.string().min(1).max(TASK_RESULT_LIMITS.content).refine(value => value.trim().length > 0, '正文不能为空');
const commandBase = { client_request_id: uuid, expected_revision: z.number().int().nonnegative() };
export const saveTaskResultInput = z.object({ ...commandBase, base_version_id: uuid.nullable(), content, reviewed_source_hash: hash.nullable().optional() }).strict();
export const acceptTaskResultVersionInput = z.object({ ...commandBase, version_id: uuid, content_hash: hash, source_hash: hash.nullable() }).strict();
export const adoptTaskResultVersionInput = z.object({ ...commandBase, version_id: uuid }).strict();
export const rebaseTaskBriefInput = z.object({ ...commandBase, prompt: z.string().trim().min(1).max(12000), source_hash: hash.nullable() }).strict();
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
function resultError(code, message, status = 409) { return Object.assign(new Error(message), { code, status, statusCode: status, isOperational: true }); }
function storageError() { return resultError('RESULT_STORAGE_UNCERTAIN', '文稿保存记录暂时无法核实，请核验原保存请求；不会自动提交另一份', 503); }
function unpack(value) {
  if (!value) return '';
  let parsed;
  try { parsed = JSON.parse(value); } catch { return value; }
  if (!parsed?.encrypted || !parsed.iv || !parsed.authTag || !parsed.algorithm) return value;
  try { const text = decryptData(parsed); if (typeof text !== 'string') throw storageError(); return text; }
  catch { throw storageError(); }
}
function refs(messages) { return messages.map(message => ({ id: message.id, revision: message.revision ?? null, edited_at: message.edited_at ?? null })); }
function fileIds(messages) { return [...new Set(messages.flatMap(message => (message.attachments || []).map(file => file.id)).filter(Boolean))]; }
function emptyState() { return { schema: 1, revision: 0, head_version_id: null, accepted_version_id: null, accepted_content_hash: null, accepted_at: null, versions: [] }; }

// Pure projection also migrates legacy run bodies using their stable run UUIDs.
// A GET never commits a hidden migration or invents a new document identity.
export function taskResultState(task, db) {
  const state = task.result_editor ? structuredClone(task.result_editor) : emptyState();
  if (state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.versions)) throw storageError();
  const ids = new Set();
  for (const version of state.versions) {
    if (!uuid.safeParse(version.id).success || ids.has(version.id) || !['generated', 'manual'].includes(version.kind) || !hash.safeParse(version.content_hash).success || !Array.isArray(version.source_messages) || typeof version.content !== 'string') throw storageError();
    ids.add(version.id);
  }
  for (const run of task.history || []) {
    if (!['generated', 'accepted'].includes(run.status) || !run.result || ids.has(run.id)) continue;
    // Existing histories are retained even when they predate today's write limit.
    const text = unpack(run.result);
    if (!text.trim()) continue;
    const sourceMessages = run.source_messages || [];
    const legacyMessages = (db.data.messages || []).filter(message => sourceMessages.some(ref => ref.id === message.id));
    const previousHead = state.versions.find(version => version.id === state.head_version_id);
    const version = { id: run.id, sequence: state.versions.length + 1, kind: 'generated', parent_version_id: run.result_base_version_id ?? null,
      run_id: run.id, content: run.result, content_hash: digest(text), created_at: run.finished_at,
      source_hash: run.source_hash ?? null, source_hash_version: run.source_hash_version || 1,
      source_messages: structuredClone(sourceMessages), source_manifest_known: Array.isArray(run.source_messages), source_file_ids: run.source_file_ids || fileIds(legacyMessages) };
    state.versions.push(version); ids.add(version.id); state.revision++;
    // Human work always wins the editing position. A later model response is a
    // candidate until the user explicitly adopts it, even across processes.
    if (!previousHead || previousHead.kind === 'generated') state.head_version_id = version.id;
    if (task.accepted_run_id === run.id) {
      state.accepted_version_id = run.id; state.accepted_content_hash = version.content_hash; state.accepted_at = run.accepted_at || run.finished_at;
    }
  }
  if ((state.head_version_id && !ids.has(state.head_version_id)) || (state.accepted_version_id && !ids.has(state.accepted_version_id))) throw storageError();
  if (state.accepted_version_id && state.versions.find(version => version.id === state.accepted_version_id)?.content_hash !== state.accepted_content_hash) throw storageError();
  return state;
}

export function synchronizeTaskResults(task, db) { task.result_editor = taskResultState(task, db); }
export function currentTaskResultHead(task, db) { return taskResultState(task, db).head_version_id; }

async function sourceView(userId, task, db) {
  const snapshot = await sourceSnapshot(userId, db);
  const all = task.group_id ? snapshot.messages.filter(message => message.group_id === task.group_id) : [];
  const messages = all.slice(-40);
  const files = await readableSourceFiles(userId, db);
  const origin = task.source_message_id ? all.find(message => message.id === task.source_message_id) : null;
  return { snapshot, all, messages, fileIds: new Set(files.map(file => file.id)),
    blocked: !!task.group_id && (!snapshot.groupIds.has(task.group_id) || !!task.source_message_id && !origin),
    hash: task.group_id ? sourceHash(messages, db) : null, origin };
}
function versionSourceStatus(task, version, sources, db) {
  if (sources.blocked) return 'blocked';
  if ((version.source_messages || []).some(ref => !sources.all.some(message => message.id === ref.id)) ||
      (version.source_file_ids || []).some(id => !sources.fileIds.has(id))) return 'blocked';
  if (!task.group_id) return 'current';
  // A legacy hash alone cannot distinguish an edit from removal/revocation.
  // Keep matching legacy snapshots readable; fail closed when their identity
  // manifest is missing and the source set has since changed.
  if (version.source_manifest_known !== true && !version.source_messages?.length &&
      version.source_hash !== sourceHash(sources.messages, db, version.source_hash_version || 1)) return 'blocked';
  return version.source_hash && version.source_hash === sourceHash(sources.messages, db, version.source_hash_version || 1) ? 'current' : 'changed';
}
function plainVersion(task, version, sources, db) {
  const sourceStatus = versionSourceStatus(task, version, sources, db);
  const text = sourceStatus === 'blocked' ? '' : unpack(version.content);
  if (sourceStatus !== 'blocked' && digest(text) !== version.content_hash) throw storageError();
  return { id: version.id, sequence: version.sequence, kind: version.kind, parent_version_id: version.parent_version_id,
    run_id: version.run_id, content: text, content_hash: version.content_hash, created_at: version.created_at,
    source_hash: version.source_hash, source_messages: structuredClone(version.source_messages), source_status: sourceStatus, content_hidden: sourceStatus === 'blocked' };
}
async function documentView(userId, task, db) {
  const state = taskResultState(task, db), sources = await sourceView(userId, task, db);
  const head = state.versions.find(version => version.id === state.head_version_id);
  const status = head ? versionSourceStatus(task, head, sources, db) : sources.blocked ? 'blocked' : 'current';
  const previous = new Map((head?.source_messages || []).map(ref => [ref.id, ref]));
  return { task_id: task.id, title: task.title, group_id: task.group_id, revision: state.revision,
    head_version_id: state.head_version_id, accepted_version_id: state.accepted_version_id,
    accepted_content_hash: state.accepted_content_hash, accepted_at: state.accepted_at,
    versions: state.versions.map(version => plainVersion(task, version, sources, db)),
    source: { status, hash: sources.blocked ? null : sources.hash,
      messages: sources.blocked ? [] : sources.messages.map(message => {
        const prior = previous.get(message.id);
        return { ...refs([message])[0], sender_type: message.sender_type, created_at: message.created_at,
          content: message.metadata?.encryption?.encrypted ? unpack(message.content) : message.content,
          change: !prior ? 'added' : prior.revision !== (message.revision ?? null) || prior.edited_at !== (message.edited_at ?? null) ? 'changed' : 'unchanged' };
      }),
      missing_message_ids: (head?.source_messages || []).filter(ref => !sources.all.some(message => message.id === ref.id)).map(ref => ref.id),
      message: status === 'blocked' ? '部分来源已撤回或权限不可用，相关正文已隐藏，不能继续引用或确认' : status === 'changed' ? '依据已变化。人工稿仍保留，请核对最新资料后明确保存复核版本' : null },
    generation: { status: task.status, run_id: task.run_id || null, source_input_stale: isTaskInputSourceStale(task, db, sources.snapshot) } };
}
function commands(db) {
  const list = db.data.taskResultCommands || [];
  if (!Array.isArray(list) || list.length > TASK_RESULT_LIMITS.commands || new Set(list.map(command => command.id)).size !== list.length) throw storageError();
  return list;
}
function publicReceipt(command) {
  return { id: command.id, operation: command.operation, task_id: command.task_id, version_id: command.version_id,
    committed_revision: command.committed_revision, committed_at: command.committed_at, status: command.status };
}
async function commandResponse(userId, receipt, db) {
  const task = db.data.tasks?.find(task => task.id === receipt.task_id);
  return { receipt: publicReceipt(receipt), document: task ? await documentView(userId, task, db) : null, ...(!task ? { task_deleted: true } : {}) };
}
async function persist(db, before) {
  const releaseReaders = beginUserDbWriteBarrier(db);
  try { await db.write(); }
  catch { db.data = before; db.invalidateReadCache?.(); throw storageError(); }
  finally { releaseReaders(); }
}
async function locked(userId, action) {
  return withWriteLock(userId, async () => {
    let db;
    try { db = await getUserDb(userId); await db.read({ force: true }); } catch { throw storageError(); }
    // All result projections and source checks use this one committed snapshot.
    // Ordinary catalog/profile reads must not replace db.data or its CAS
    // revision while an async source-barrier check is in progress. No db.read
    // occurs inside this scope; releasing in finally also fences prior reads.
    const releaseReaders = beginUserDbWriteBarrier(db);
    try { return await action(db); } finally { releaseReaders(); }
  });
}
export async function getTaskResult(userId, taskId) {
  return locked(userId, async db => {
    const task = db.data.tasks?.find(task => task.id === taskId);
    if (!task) throw resultError('TASK_NOT_FOUND', '这份文稿已删除或不属于当前账号', 404);
    return documentView(userId, task, db);
  });
}
export async function getTaskResultCommand(userId, taskId, requestId) {
  requestId = uuid.parse(requestId);
  return locked(userId, async db => {
    const receipt = commands(db).find(command => command.id === requestId && command.task_id === taskId);
    if (!receipt) throw resultError('RESULT_COMMAND_NOT_FOUND', '尚未找到这次保存的记录，请保留原请求核验；不要换编号重复提交', 404);
    return commandResponse(userId, receipt, db);
  });
}
async function mutate(userId, taskId, operation, input, apply) {
  const inputHash = digest(JSON.stringify({ task_id: taskId, operation, input }));
  return locked(userId, async db => {
    const list = commands(db), existing = list.find(command => command.id === input.client_request_id);
    if (existing) {
      if (existing.input_hash !== inputHash || existing.task_id !== taskId) throw resultError('RESULT_IDEMPOTENCY_CONFLICT', '原请求编号绑定了另一份内容，请先核验原保存记录');
      return commandResponse(userId, existing, db);
    }
    const task = db.data.tasks?.find(task => task.id === taskId);
    if (!task) throw resultError('TASK_NOT_FOUND', '这份文稿已删除或不属于当前账号', 404);
    const state = taskResultState(task, db), sources = await sourceView(userId, task, db);
    if (state.revision !== input.expected_revision) throw resultError('RESULT_REVISION_CONFLICT', '文稿已在其他页面更新。你的输入仍可保留，请先比较当前版本');
    if (sources.blocked) throw resultError('RESULT_SOURCE_BLOCKED', '来源已撤回或权限不可用，不能继续使用旧正文', 410);
    if (list.length >= TASK_RESULT_LIMITS.commands) throw resultError('RESULT_COMMAND_LIMIT', '保存回执记录已满，需要归档核验；不会遗忘旧请求后盲目重试', 429);
    const before = structuredClone(db.data), now = new Date().toISOString();
    const versionId = apply({ task, state, sources, db, now });
    state.revision++;
    task.result_editor = state; task.updated_at = now;
    const receipt = { id: input.client_request_id, task_id: taskId, operation, input_hash: inputHash,
      version_id: versionId, committed_revision: state.revision, committed_at: now, status: 'succeeded' };
    db.data.taskResultCommands = [...list, receipt];
    await persist(db, before);
    return commandResponse(userId, receipt, db);
  });
}
function assertVisibleVersion(task, version, sources, db) {
  if (!version || versionSourceStatus(task, version, sources, db) === 'blocked') throw resultError('RESULT_SOURCE_BLOCKED', '此版本的来源已不可用，不能从隐藏正文继续', 410);
}
function setHead(task, state, version) {
  state.head_version_id = version.id;
  task.result = version.content; task.result_run_id = version.run_id;
  task.result_pending_review = state.accepted_version_id !== version.id;
  task.accepted_run_id = state.accepted_version_id === version.id && version.kind === 'generated' ? version.run_id : null;
  if (!['running', 'outcome_unknown'].includes(task.status)) task.status = task.result_pending_review ? 'needs_review' : 'completed';
}
export async function saveTaskResultVersion(userId, taskId, raw) {
  const input = saveTaskResultInput.parse(raw);
  return mutate(userId, taskId, 'save', input, ({ task, state, sources, db, now }) => {
    if (state.head_version_id !== input.base_version_id) throw resultError('RESULT_REVISION_CONFLICT', '编辑依据已变化，请先比较当前文稿；不会覆盖你的输入');
    const parent = state.versions.find(version => version.id === state.head_version_id);
    if (parent) assertVisibleVersion(task, parent, sources, db);
    if (state.versions.length >= TASK_RESULT_LIMITS.versions) throw resultError('RESULT_VERSION_LIMIT', '文稿版本记录已满，请先导出并联系管理员归档；不会覆盖旧稿');
    const reviewed = Object.hasOwn(input, 'reviewed_source_hash');
    if (reviewed && input.reviewed_source_hash !== sources.hash) throw resultError('RESULT_SOURCE_CHANGED', '资料又有更新，请先看最新依据，再确认复核');
    const version = { id: randomUUID(), sequence: state.versions.length + 1, kind: 'manual', parent_version_id: parent?.id || null,
      run_id: parent?.run_id || null, content: encryptText(input.content), content_hash: digest(input.content), created_at: now,
      source_hash: reviewed || !parent ? sources.hash : parent.source_hash,
      source_hash_version: reviewed || !parent ? 2 : parent.source_hash_version,
      source_messages: reviewed || !parent ? refs(sources.messages) : structuredClone(parent.source_messages),
      source_manifest_known: reviewed || !parent ? true : parent.source_manifest_known,
      source_file_ids: reviewed || !parent ? fileIds(sources.messages).filter(id => sources.fileIds.has(id)) : [...(parent.source_file_ids || [])] };
    state.versions.push(version); setHead(task, state, version); return version.id;
  });
}
export async function acceptTaskResultVersion(userId, taskId, raw) {
  const input = acceptTaskResultVersionInput.parse(raw);
  return mutate(userId, taskId, 'accept', input, ({ task, state, sources, db, now }) => {
    const version = state.versions.find(version => version.id === input.version_id);
    assertVisibleVersion(task, version, sources, db);
    if (state.head_version_id !== version.id || version.content_hash !== input.content_hash) throw resultError('RESULT_REVISION_CONFLICT', '你核对的不是当前正文版本，请先打开当前稿');
    if (['running', 'outcome_unknown'].includes(task.status)) throw resultError('RESULT_RUN_PENDING', '这份文稿仍有生成请求待核验，请先处理该请求；人工文字会保留');
    if (sources.hash !== input.source_hash || versionSourceStatus(task, version, sources, db) !== 'current') throw resultError('RESULT_SOURCE_CHANGED', '依据已变化，请核对并保存复核版本后再确认');
    const generatedRun = version.kind === 'generated' ? task.history?.find(run => run.id === version.run_id) : null;
    if (version.kind === 'generated' && (!generatedRun || !['generated', 'accepted'].includes(generatedRun.status))) throw resultError('RESULT_RUN_UNAVAILABLE', '该生成版本的运行回执不可用，不能将其标为已确认');
    state.accepted_version_id = version.id; state.accepted_content_hash = version.content_hash; state.accepted_at = now;
    task.status = 'completed'; task.auto_run = false; task.result_pending_review = false;
    task.accepted_run_id = version.kind === 'generated' ? version.run_id : null;
    if (version.kind === 'generated') {
      generatedRun.status = 'accepted'; generatedRun.accepted_at = now; generatedRun.accepted_by = userId;
    }
    return version.id;
  });
}
export async function adoptTaskResultVersion(userId, taskId, raw) {
  const input = adoptTaskResultVersionInput.parse(raw);
  return mutate(userId, taskId, 'adopt', input, ({ task, state, sources, db }) => {
    const version = state.versions.find(version => version.id === input.version_id);
    assertVisibleVersion(task, version, sources, db); setHead(task, state, version); return version.id;
  });
}
export async function rebaseTaskBrief(userId, taskId, raw) {
  const input = rebaseTaskBriefInput.parse(raw);
  return mutate(userId, taskId, 'brief', input, ({ task, state, sources, db }) => {
    if (['running', 'outcome_unknown'].includes(task.status)) throw resultError('RESULT_RUN_PENDING', '请先处理当前生成请求，再调整新的写作要求');
    if (input.source_hash !== sources.hash) throw resultError('RESULT_SOURCE_CHANGED', '资料又有更新，请核对最新资料再更新要求');
    task.prompt = encryptText(input.prompt);
    if (sources.origin) { task.source_input_hash = sourceHash([sources.origin], db); task.source_message_edited_at = sources.origin.edited_at ?? null; }
    task.auto_run = false;
    return state.head_version_id;
  });
}
