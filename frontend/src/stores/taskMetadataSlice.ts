import type { StoreApi } from 'zustand';
import type { TaskState } from './tasksStore';
import type { WorkspaceTask, TaskMetadataChanges, UpdateTaskMetadataInput, MetadataCommandResponse } from '../../../shared/tasks';
import { axiosInstance } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import { textHash, loadWritingContent, saveWritingContent, removeWritingDraft } from '../utils/taskRecovery';
import { beginMetadataWork, canonicalMetadata, journalValue, metadataContentKey, persistMetadataJournal, readMetadataJournal, removeMetadataJournal, validMetadataChanges, type MetadataIntent } from '../utils/taskMetadataRecovery';

type Values = Pick<WorkspaceTask, 'title' | 'auto_run' | 'run_at'>;
interface MetadataDraft { revision: number; values: Values; base: Values; commandKey?: string }
export interface MetadataState {
  metadataDrafts: Record<string, MetadataDraft>;
  metadataIntents: Record<string, MetadataIntent>;
  metadataQueues: Record<string, MetadataIntent[]>;
  metadataErrors: Record<string, string>;
  metadataNotices: Record<string, string>;
  metadataConflicts: Record<string, boolean>;
  metadataRecoveryError: string | null;
  restoreMetadata: () => void;
  hydrateMetadata: () => Promise<void>;
  editMetadata: (id: string, changes: TaskMetadataChanges) => void;
  resetMetadata: (id: string) => Promise<void>;
  saveMetadata: (id: string) => Promise<void>;
  verifyMetadata: (id: string, key: string) => Promise<void>;
  closeMetadata: (id: string, key: string) => Promise<void>;
  retryMetadata: (id: string, key: string) => Promise<void>;
  requireSettledMetadata: (id: string) => void;
}
export const emptyMetadataState = () => ({ metadataDrafts: {}, metadataIntents: {}, metadataQueues: {}, metadataErrors: {}, metadataNotices: {}, metadataConflicts: {}, metadataRecoveryError: null });
export const metadataValues = (task: WorkspaceTask): Values => ({ title: task.title, auto_run: task.auto_run, run_at: task.run_at });
export function metadataChanges(draft: MetadataDraft): TaskMetadataChanges {
  return Object.fromEntries(Object.entries(draft.values).filter(([key, value]) => value !== draft.base[key as keyof Values]).map(([key, value]) => [key, key === 'title' && typeof value === 'string' ? value.trim() : value]));
}
export function createMetadataSlice<Context extends { user: string | null }>(
  set: StoreApi<TaskState>['setState'], get: StoreApi<TaskState>['getState'],
  helpers: { context: () => Context; current: (scope: Context) => boolean; sequence: () => number; mutate: <T>(id: string, label: string, action: () => Promise<T>) => Promise<T> }
): MetadataState {
  const { context, current, sequence, mutate } = helpers;
  const identity = (item: MetadataIntent) => `${item.taskId}:${item.key}`;
  function restoreMetadata() {
    if (!getCacheUserId()) return;
    try {
      const known = new Map(Object.values(get().metadataQueues).flat().map(item => [identity(item), item]));
      for (const item of readMetadataJournal()) {
        const previous = known.get(identity(item));
        if (previous && JSON.stringify(journalValue(previous)) !== JSON.stringify(item)) throw new Error('同一任务设置请求的设备记录不一致，请先核验原请求');
        if (!previous) known.set(identity(item), item);
      }
      const metadataQueues: Record<string, MetadataIntent[]> = {};
      for (const item of known.values()) (metadataQueues[item.taskId] ||= []).push(item);
      const metadataIntents = Object.fromEntries(Object.entries(metadataQueues).filter(([, queue]) => queue.length).map(([id, queue]) => [id, queue[0]]));
      set({ metadataQueues, metadataIntents, metadataRecoveryError: null });
    } catch (error) {
      set({ metadataRecoveryError: error instanceof Error ? error.message : '任务设置记录无法读取' }); throw error;
    }
  }
  function replaceIntent(item: MetadataIntent) {
    set(state => {
      const queue = state.metadataQueues[item.taskId] || [], at = queue.findIndex(value => value.key === item.key);
      const next = at < 0 ? [...queue, item] : queue.map((value, index) => index === at ? item : value);
      return { metadataQueues: { ...state.metadataQueues, [item.taskId]: next }, metadataIntents: { ...state.metadataIntents, [item.taskId]: next[0] } };
    });
  }
  async function hydrateMetadata() {
    const scope = context();
    for (const item of Object.values(get().metadataQueues).flat()) {
      if (item.payload) continue;
      const frozen = await loadWritingContent(metadataContentKey(item));
      if (!current(scope)) return;
      if (!frozen) continue;
      try {
        const payload = JSON.parse(frozen.body) as UpdateTaskMetadataInput;
        if (Object.keys(payload).sort().join(',') !== 'changes,client_request_id,expected_revision' || payload.client_request_id !== item.key || payload.expected_revision !== item.revision || !validMetadataChanges(payload.changes) || Object.keys(payload.changes).sort().join(',') !== [...item.fields].sort().join(',') || await textHash(canonicalMetadata(payload)) !== item.payloadHash) continue;
        if (!current(scope)) return;
        if (get().metadataQueues[item.taskId]?.some(value => value.key === item.key)) replaceIntent({ ...item, payload });
      } catch { /* Missing or changed private content never authorizes replay. */ }
    }
  }
  function release(item: MetadataIntent) {
    removeMetadataJournal(item);
    removeWritingDraft(metadataContentKey(item));
    set(state => {
      const metadataQueues = { ...state.metadataQueues, [item.taskId]: (state.metadataQueues[item.taskId] || []).filter(value => value.key !== item.key) };
      const metadataIntents = { ...state.metadataIntents }; delete metadataIntents[item.taskId];
      if (metadataQueues[item.taskId].length) metadataIntents[item.taskId] = metadataQueues[item.taskId][0];
      return { metadataQueues, metadataIntents };
    });
    restoreMetadata();
  }
  async function settle(item: MetadataIntent, response: MetadataCommandResponse, snapshot: number, scope: Context) {
    const receipt = response?.receipt, id = item.taskId, task = response?.task;
    if (!receipt || receipt.id !== item.key || receipt.task_id !== id || receipt.operation !== 'metadata' || !['succeeded', 'cancelled'].includes(receipt.status) || (receipt.status === 'cancelled' ? receipt.committed_revision !== null : !Number.isSafeInteger(receipt.committed_revision) || receipt.committed_revision !== item.revision + 1) || (task ? response.task_deleted === true || task.id !== id || !Number.isSafeInteger(task.metadata_revision ?? 0) || (task.metadata_revision ?? 0) < (receipt.committed_revision ?? 0) : response.task_deleted !== true)) throw new Error('任务设置回执不匹配，请继续核验原请求');
    if (receipt.status === 'succeeded' && task?.metadata_revision === receipt.committed_revision) {
      const changes = Object.fromEntries(item.fields.map(field => [field, task[field]]));
      if (await textHash(canonicalMetadata({ client_request_id: item.key, expected_revision: item.revision, changes })) !== item.payloadHash) throw new Error('任务设置回执内容不匹配，请继续核验原请求');
    }
    if (!current(scope)) return;
    if (!get().metadataQueues[id]?.some(value => value.key === item.key)) return;
    release(item);
    set(state => {
      const metadataDrafts = { ...state.metadataDrafts };
      if (receipt.status === 'succeeded' && metadataDrafts[id]?.commandKey === item.key) delete metadataDrafts[id];
      // A cancellation never rebases the original draft. Explicit reread is required.
      const active = state.tasks.find(value => value.id === id);
      const canProject = snapshot === sequence() && (!task || !active || (task.metadata_revision ?? 0) >= (active.metadata_revision ?? 0));
      return { metadataDrafts, metadataErrors: { ...state.metadataErrors, [id]: '' }, metadataConflicts: { ...state.metadataConflicts, [id]: receipt.status === 'cancelled' || !!metadataDrafts[id] }, metadataNotices: { ...state.metadataNotices, [id]: response.task_deleted ? '原请求已确认；任务已删除，没有重新创建。' : receipt.status === 'cancelled' ? '原请求已结束。已保存设置保持不变，请读取最新设置后明确重新编辑。' : '任务设置已确认保存。' }, ...(canProject ? { tasks: task ? state.tasks.map(value => value.id === id ? task : value) : state.tasks.filter(value => value.id !== id) } : {}) };
    });
  }
  function recordError(id: string, error: unknown) {
    const value = error as { status?: number; code?: string; response?: { status?: number; data?: { code?: string; error?: { code?: string } } } };
    // The shared Axios interceptor deliberately exposes only status/code. Keep
    // raw Axios support too; message text never establishes command state.
    const status = value.status ?? value.response?.status, code = value.response?.data?.code ?? value.response?.data?.error?.code ?? value.code;
    const conflict = status === 409 && code === 'TASK_METADATA_REVISION_CONFLICT';
    const message = !get().metadataIntents[id] ? (error instanceof Error ? error.message : '尚未发送，请检查任务设置') : status === 428 ? '服务端需要新版任务设置协议。请保留当前草稿，刷新或升级应用后核验原请求。' : conflict ? '任务设置已被修改。先核对并结束原请求，再读取最新设置重新编辑；不会自动覆盖。' : '保存结果待核验。连接失败、未找到或冲突都不能证明未保存，请核验或结束原请求。';
    set(state => ({ metadataErrors: { ...state.metadataErrors, [id]: message }, metadataConflicts: { ...state.metadataConflicts, [id]: conflict || !!state.metadataConflicts[id] } }));
  }
  async function send(item: MetadataIntent, scope: Context) {
    if (!item.payload || await textHash(canonicalMetadata(item.payload)) !== item.payloadHash) throw new Error('原内容未可靠保存在此设备，只能核验或结束原请求');
    if (!current(scope)) throw new Error('账号已切换，请重新打开任务设置');
    persistMetadataJournal(item); replaceIntent(item);
    await saveWritingContent(metadataContentKey(item), { body: canonicalMetadata(item.payload), baseRevisionId: null, savedAt: item.createdAt });
    if (!current(scope)) throw new Error('账号已切换，请重新打开任务设置');
    const snapshot = sequence();
    const response = await axiosInstance.put<MetadataCommandResponse>(`/tasks/${item.taskId}/metadata`, structuredClone(item.payload), { headers: { 'X-Expected-User-Id': scope.user || '' } });
    if (current(scope)) await settle(item, response.data, snapshot, scope);
  }
  async function query(id: string, key: string, close: boolean) {
    restoreMetadata(); const item = get().metadataIntents[id];
    if (!item || item.key !== key) throw new Error('原请求已变化，请重新打开任务设置');
    const scope = context();
    await mutate(id, close ? '核对并结束设置请求中' : '核验任务设置中', async () => {
      try {
        const snapshot = sequence(), path = `/tasks/${id}/metadata/commands/${key}`, config = { headers: { 'X-Expected-User-Id': scope.user || '' } };
        const response = close ? await axiosInstance.post<MetadataCommandResponse>(path + '/close', {}, config) : await axiosInstance.get<MetadataCommandResponse>(path, config);
        if (current(scope)) await settle(item, response.data, snapshot, scope);
      } catch (error) { if (current(scope)) recordError(id, error); throw error; }
    });
  }
  return {
    ...emptyMetadataState(), restoreMetadata, hydrateMetadata,
    requireSettledMetadata: id => { restoreMetadata(); if (get().metadataIntents[id]) throw new Error('任务设置请求待核验，请先核验或结束原请求'); },
    editMetadata: (id, changes) => {
      if (get().pending[id] || get().metadataIntents[id] || get().metadataConflicts[id] || get().metadataRecoveryError) return;
      const task = get().tasks.find(value => value.id === id); if (!task || ['running', 'outcome_unknown'].includes(task.status)) return;
      const prior = get().metadataDrafts[id];
      if (prior && prior.revision !== (task.metadata_revision ?? 0)) return;
      set(state => ({ metadataDrafts: { ...state.metadataDrafts, [id]: { revision: prior?.revision ?? task.metadata_revision ?? 0, base: prior?.base ?? metadataValues(task), values: { ...(prior?.values ?? metadataValues(task)), ...changes } } }, metadataErrors: { ...state.metadataErrors, [id]: '' }, metadataNotices: { ...state.metadataNotices, [id]: '' } }));
    },
    resetMetadata: async id => {
      restoreMetadata(); if (get().pending[id] || get().metadataIntents[id]) throw new Error('先核验或结束原请求，再重新编辑');
      const scope = context(); await get().fetch(); if (!current(scope)) return;
      if (get().error || get().metadataRecoveryError) throw new Error('尚未读取到最新任务设置，请联网后重试');
      const task = get().tasks.find(value => value.id === id); if (!task) return;
      set(state => { const metadataDrafts = { ...state.metadataDrafts }; delete metadataDrafts[id]; return { metadataDrafts, metadataConflicts: { ...state.metadataConflicts, [id]: false }, metadataErrors: { ...state.metadataErrors, [id]: '' } }; });
    },
    saveMetadata: async id => {
      restoreMetadata(); if (get().metadataIntents[id]) throw new Error('先核验原任务设置请求，不能换编号覆盖');
      const task = get().tasks.find(value => value.id === id), draft = get().metadataDrafts[id];
      if (!task || !draft) throw new Error('请先修改任务设置');
      if (get().metadataConflicts[id] || draft.revision !== (task.metadata_revision ?? 0)) throw new Error('请读取最新设置后重新编辑');
      if (['running', 'outcome_unknown'].includes(task.status)) throw new Error('正在生成或结果待核验时，不能修改任务设置');
      const changes = metadataChanges(draft); if (!validMetadataChanges(changes)) throw new Error('请填写有效标题和排期，并至少修改一项');
      if (draft.values.auto_run && !draft.values.run_at) throw new Error('启用定时生成需要明确的下次生成时间');
      if (draft.values.auto_run && ['completed', 'cancelled'].includes(task.status)) throw new Error('已完成或已停止的任务不能启用定时生成');
      const scope = context();
      await mutate(id, '保存任务设置中', async () => {
        const finished = beginMetadataWork(id);
        try {
          const payload = { client_request_id: crypto.randomUUID(), expected_revision: draft.revision, changes };
          set(state => ({ metadataDrafts: { ...state.metadataDrafts, [id]: { ...draft, commandKey: payload.client_request_id } } }));
          const payloadHash = await textHash(canonicalMetadata(payload));
          if (!current(scope)) throw new Error('账号已切换，请重新打开任务设置');
          await send({ taskId: id, key: payload.client_request_id, revision: draft.revision, fields: Object.keys(changes).sort() as Array<keyof TaskMetadataChanges>, payloadHash, createdAt: new Date().toISOString(), payload }, scope);
        } catch (error) { if (current(scope)) recordError(id, error); throw error; } finally { finished(); }
      });
    },
    verifyMetadata: (id, key) => query(id, key, false), closeMetadata: (id, key) => query(id, key, true),
    retryMetadata: async (id, key) => {
      restoreMetadata(); const item = get().metadataIntents[id]; if (!item || item.key !== key) throw new Error('原请求已变化，请重新打开任务设置');
      if (!item.payload) throw new Error('原内容未可靠保存在此设备，只能核验或结束原请求');
      const scope = context();
      await mutate(id, '同号重试任务设置中', async () => { try { await send(item, scope); } catch (error) { if (current(scope)) recordError(id, error); throw error; } });
    },
  };
}
