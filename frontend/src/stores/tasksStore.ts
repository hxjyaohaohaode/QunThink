import { create } from 'zustand';
import { clearMetadataWork } from '../utils/taskMetadataRecovery';
import { createMetadataSlice, emptyMetadataState, type MetadataState } from './taskMetadataSlice';
import { axiosInstance, getAuthGeneration } from '../services/api';
import { persistTaskReceipt, readTaskReceipts, removeTaskReceipt, textHash, loadWritingContent, saveWritingContent, removeWritingDraft, type TaskCommandReceipt } from '../utils/taskRecovery';
import { getCacheUserId } from '../utils/cacheUtils';
import { requestError } from './modelsStore';
import { recordDiagnostic } from '../observability/runtimeDiagnostics';
import { readDependencyIntents, persistDependencyIntent, removeDependencyIntent, validDependencyIds, type DependencyIntent } from '../utils/taskDependencyRecovery';
import { validPlanningFields, validTaskPriority, validEstimatedMinutes } from '../utils/taskPlanning';
import type { TaskPriority, WorkspaceTask, TaskCreateInput, TaskCreateCommandReceipt, DependencyCommandResponse } from '../../../shared/tasks';

export interface TaskComposerDraft {
  title: string; prompt: string; category: 'work' | 'social' | 'play';
  priority: TaskPriority | null; estimatedMinutes: string;
  dependencyIds: string[]; modelId: string; groupId: string; sourceMessageId: string; sourceMessageEditedAt: string | null; runAt: string; repeat: string; autoRun: boolean;
}
export const emptyTaskDraft = (): TaskComposerDraft => ({ title: '', prompt: '', category: 'work', priority: null, estimatedMinutes: '', dependencyIds: [], modelId: '', groupId: '', sourceMessageId: '', sourceMessageEditedAt: null, runAt: '', repeat: '', autoRun: false });
export const hasTaskComposerDraft = (draft: TaskComposerDraft) => !!(draft.title || draft.prompt || draft.priority !== null || draft.estimatedMinutes !== '');
interface CreateIntent { key: string; payload: TaskCreateInput; composerSequence?: number; }
export interface TaskState extends MetadataState {
  tasks: WorkspaceTask[]; loading: boolean; error: string | null; lastUpdated: string | null;
  pending: Record<string, string>; uncertainCreate: boolean; recoveredCreate: { taskId: string | null; deleted: boolean; cancelled?: boolean; preserveDraft?: boolean } | null;
  pendingCreates: TaskCommandReceipt[]; recoveryError: string | null;
  verifyCreate: (key: string) => Promise<void>;
  closeCreate: (key: string) => Promise<void>;
  retryCreate: (key: string) => Promise<WorkspaceTask | undefined>;
  canRetryCreate: (key: string) => boolean;
  draft: { prompt: string; groupId: string | null; messageId?: string; editedAt?: string | null } | null;
  composerDraft: TaskComposerDraft;
  setDraft: (draft: { prompt: string; groupId: string | null; messageId?: string; editedAt?: string | null } | null) => void;
  setComposerDraft: (draft: TaskComposerDraft) => void;
  dependencyDrafts: Record<string, { revision: number; ids: string[]; commandKey?: string }>;
  dependencyIntents: Record<string, DependencyIntent>;
  dependencyQueues: Record<string, DependencyIntent[]>;
  dependencyErrors: Record<string, string>;
  dependencyNotices: Record<string, string>;
  dependencyConflicts: Record<string, boolean>;
  dependencyRecoveryError: string | null;
  editDependencies: (id: string, ids: string[]) => void;
  resetDependencies: (id: string) => Promise<void>;
  saveDependencies: (id: string) => Promise<void>;
  verifyDependencies: (id: string, key: string) => Promise<void>;
  closeDependencies: (id: string, key: string) => Promise<void>;
  retryDependencies: (id: string, key: string) => Promise<void>;
  fetch: () => Promise<void>;
  create: (data: TaskCreateInput) => Promise<WorkspaceTask>;
  run: (id: string) => Promise<void>;
  accept: (id: string, runId: string) => Promise<void>;
  resolveUnknown: (id: string, runId: string, decision: 'allow_retry' | 'abandon') => Promise<void>;
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  cleanup: () => void;
}
let epoch = 0;
let fetchSequence = 0;
const createIntents = new Map<string, CreateIntent>();
let composerSequence = 0;
const runIntents = new Map<string, string>();
const inFlight = new Map<string, Promise<unknown>>();
function definitiveFailure(error: unknown) {
  const candidate = error as { status?: number; response?: { status?: number } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}
const context = () => ({ user: getCacheUserId(), epoch, auth: getAuthGeneration() });
const current = (value: ReturnType<typeof context>) => value.epoch === epoch && value.auth === getAuthGeneration() && value.user === getCacheUserId();

export const useTasksStore = create<TaskState>((set, get) => {
  async function mutate<T>(id: string, label: string, action: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(id);
    if (existing) throw new Error('该任务正在处理，请等待当前操作完成');
    const origin = context();
    fetchSequence++; // An older read cannot undo this intent or its receipt.
    set(state => ({ pending: { ...state.pending, [id]: label } }));
    const started = performance.now();
    recordDiagnostic('task', id === 'create' ? 'task-composer' : 'task-card', 'started');
    const work = (async () => {
      try {
        const result = await action();
        if (!current(origin)) throw new Error('账号已切换，请在当前账号重新打开工作台');
        recordDiagnostic('task', id === 'create' ? 'task-composer' : 'task-card', 'succeeded', performance.now() - started);
        fetchSequence++;
        return result;
      } catch (error) {
        if (current(origin)) recordDiagnostic('task', id === 'create' ? 'task-composer' : 'task-card', definitiveFailure(error) ? 'failed' : 'unknown', performance.now() - started);
        throw error;
      } finally {
        if (current(origin)) {
          inFlight.delete(id);
          set(state => { const pending = { ...state.pending }; delete pending[id]; return { pending }; });
          void get().fetch();
        }
      }
    })();
    inFlight.set(id, work);
    return work;
  }
  function refreshCreateReceipts() {
    let receipts: TaskCommandReceipt[];
    try { receipts = readTaskReceipts().filter(item => item.action === 'create'); set(state => ({ recoveryError: null, ...(state.recoveryError && state.error === state.recoveryError ? { error: null } : {}) })); }
    catch (error) { const message = error instanceof Error ? error.message : '无法读取待核验记录，已暂停新的提交'; set({ recoveryError: message, error: message }); throw error; }
    // A different tab may already have removed its durable key after settlement.
    // Keep this page's known unresolved intent until we verify the same key ourselves.
    const merged = new Map(get().pendingCreates.map(item => [item.key, item]));
    for (const receipt of receipts) merged.set(receipt.key, receipt);
    const pendingCreates = [...merged.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.key.localeCompare(b.key));
    set({ pendingCreates, uncertainCreate: pendingCreates.length > 0 });
    return pendingCreates;
  }
  async function restoreCreateIntent(receipt: TaskCommandReceipt, origin: ReturnType<typeof context>) {
    if (createIntents.has(receipt.key)) return;
    const frozen = await loadWritingContent(`create-intent:${receipt.key}`);
    if (!current(origin) || !frozen) return;
    try {
      const payload = JSON.parse(frozen.body) as TaskCreateInput;
      if (validPlanningFields(payload) && await textHash(JSON.stringify(payload)) === receipt.payloadHash && current(origin) && get().pendingCreates.some(item => item.key === receipt.key) && !createIntents.has(receipt.key)) createIntents.set(receipt.key, { key: receipt.key, payload });
    } catch { /* Unreadable private input never becomes a replay. */ }
  }
  function releaseCreate(key: string) {
    removeTaskReceipt(key); removeWritingDraft(`create-intent:${key}`); createIntents.delete(key);
    set(state => { const pendingCreates = state.pendingCreates.filter(item => item.key !== key); return { pendingCreates, uncertainCreate: pendingCreates.length > 0 }; });
    refreshCreateReceipts();
  }
  function settleCreate(key: string, response: TaskCreateCommandReceipt, snapshotSequence = fetchSequence) {
    if (response.operation !== 'create' || response.client_request_id !== key || !['succeeded', 'cancelled'].includes(response.status)) throw new Error('回执标识不匹配，请继续核验原请求');
    if (response.status === 'cancelled' && (response.task_id !== null || response.task !== null || response.task_deleted !== false || !response.closed_at)) throw new Error('结束回执不完整，请继续核验原请求');
    if (response.status === 'succeeded' && (!response.task_id || (response.task ? response.task_deleted !== false || response.task.id !== response.task_id || response.task.client_request_id !== key : response.task !== null || response.task_deleted !== true))) throw new Error('创建回执不完整，请继续核验原请求');
    if (!get().pendingCreates.some(item => item.key === key)) return;
    const intent = createIntents.get(key);
    if (response.status === 'succeeded' && response.task) {
      const task = response.task;
      if (!Object.prototype.hasOwnProperty.call(task, 'priority') || !Object.prototype.hasOwnProperty.call(task, 'estimated_minutes') || !validTaskPriority(task.priority) || !validEstimatedMinutes(task.estimated_minutes) || !Number.isSafeInteger(task.metadata_revision) || task.metadata_revision! < 0) throw new Error('创建回执缺少有效规划属性，请保留原请求并更新服务后核验');
      if (intent && task.metadata_revision === 0 && (['priority', 'estimated_minutes'] as const).some(field => Object.prototype.hasOwnProperty.call(intent.payload, field) && task[field] !== intent.payload[field])) throw new Error('创建回执规划属性与原输入不一致，请继续核验原请求');
    }
    const clearDraft = response.status === 'succeeded' && intent?.composerSequence === composerSequence;
    releaseCreate(key);
    set(state => ({ ...(clearDraft ? { composerDraft: emptyTaskDraft() } : {}), recoveredCreate: { taskId: response.task_id, deleted: response.task_deleted, cancelled: response.status === 'cancelled', preserveDraft: !clearDraft && hasTaskComposerDraft(state.composerDraft) }, ...(response.task && snapshotSequence === fetchSequence ? { tasks: [response.task, ...state.tasks.filter(item => item.id !== response.task!.id)] } : {}) }));
  }
  async function queryCreate(key: string, close: boolean) {
    refreshCreateReceipts();
    if (!get().pendingCreates.some(item => item.key === key)) throw new Error('这次请求已不在待核验列表，请查看最新结果');
    const origin = context();
    await mutate(`create:${key}`, close ? '核对并结束中' : '核验中', async () => {
      try {
        const receipt = get().pendingCreates.find(item => item.key === key);
        if (receipt) await restoreCreateIntent(receipt, origin);
        if (!current(origin)) throw new Error('账号已切换，请重新核验原请求');
        const snapshotSequence = fetchSequence;
        const config = { headers: { 'X-Expected-User-Id': origin.user || '' } };
        const { data } = close ? await axiosInstance.post<TaskCreateCommandReceipt>(`/tasks/commands/${key}/close`, {}, config) : await axiosInstance.get<TaskCreateCommandReceipt>(`/tasks/commands/${key}`, config);
        if (current(origin)) settleCreate(key, data, snapshotSequence);
      } catch (error) {
        if (current(origin)) set({ error: close ? '尚未确认是否已结束。请求编号和当前输入仍保留，请再次核验或结束同一请求' : '尚未取得原请求的确认回执。可以稍后核验，或核对并结束这次请求' });
        throw error;
      }
    });
  }
  async function sendCreate(intent: CreateIntent): Promise<WorkspaceTask> {
    const origin = context();
    set({ recoveredCreate: null });
    return mutate('create', '保存中', async () => {
      let dispatched = false;
      try {
        const payloadHash = await textHash(JSON.stringify(intent.payload));
        if (!current(origin)) throw new Error('账号已切换，请在当前账号重新打开工作台');
        if (!get().pendingCreates.some(item => item.key === intent.key)) persistTaskReceipt({ key: intent.key, action: 'create', taskId: null, payloadHash, createdAt: new Date().toISOString() });
        refreshCreateReceipts();
        await saveWritingContent(`create-intent:${intent.key}`, { body: JSON.stringify(intent.payload), baseRevisionId: null, savedAt: new Date().toISOString() });
        if (!current(origin)) throw new Error('账号已切换，请在当前账号重新打开工作台');
        dispatched = true;
        const snapshotSequence = fetchSequence;
        const { data: task } = await axiosInstance.post<WorkspaceTask>('/tasks', intent.payload, { headers: { 'Idempotency-Key': intent.key, 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin)) settleCreate(intent.key, { status: 'succeeded', operation: 'create', client_request_id: intent.key, task_id: task.id, task_deleted: false, task }, snapshotSequence);
        return task;
      } catch (error) {
        if (current(origin)) {
          if (!dispatched) { try { releaseCreate(intent.key); } catch {} }
          else refreshCreateReceipts();
        }
        throw error;
      }
    });
  }
  function restoreDependencies() {
    if (!getCacheUserId()) return;
    try {
      const known = new Map(Object.values(get().dependencyQueues).flat().map(intent => [intent.payload.client_request_id, intent]));
      for (const intent of readDependencyIntents()) {
        const prior = known.get(intent.payload.client_request_id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(intent)) throw new Error('同一前置任务请求的设备记录不一致，请先核验原请求');
        known.set(intent.payload.client_request_id, intent);
      }
      const dependencyQueues: Record<string, DependencyIntent[]> = {};
      for (const intent of known.values()) (dependencyQueues[intent.taskId] ||= []).push(intent);
      const dependencyIntents = Object.fromEntries(Object.entries(dependencyQueues).filter(([, queue]) => queue.length).map(([id, queue]) => [id, queue[0]]));
      set({ dependencyQueues, dependencyIntents, dependencyRecoveryError: null });
    } catch (error) {
      set({ dependencyRecoveryError: error instanceof Error ? error.message : '无法读取前置任务待核验记录' });
      throw error;
    }
  }
  function releaseDependency(intent: DependencyIntent) {
    removeDependencyIntent(intent);
    set(state => {
      const dependencyQueues = { ...state.dependencyQueues, [intent.taskId]: (state.dependencyQueues[intent.taskId] || []).filter(item => item.payload.client_request_id !== intent.payload.client_request_id) };
      const dependencyIntents = { ...state.dependencyIntents }; delete dependencyIntents[intent.taskId];
      if (dependencyQueues[intent.taskId].length) dependencyIntents[intent.taskId] = dependencyQueues[intent.taskId][0];
      return { dependencyQueues, dependencyIntents };
    });
    restoreDependencies();
  }
  function settleDependency(intent: DependencyIntent, response: DependencyCommandResponse, snapshot: number) {
    const receipt = response?.receipt, id = intent.taskId;
    if (!receipt || receipt.id !== intent.payload.client_request_id || receipt.task_id !== id || receipt.operation !== 'dependencies' || !['succeeded', 'cancelled'].includes(receipt.status) || (receipt.status === 'cancelled' ? receipt.committed_revision !== null : !Number.isSafeInteger(receipt.committed_revision) || receipt.committed_revision !== intent.payload.expected_revision + 1) || (response.task ? response.task.id !== id || !Number.isSafeInteger(response.task.dependency_revision ?? 0) || (response.task.dependency_revision ?? 0) < (receipt.committed_revision ?? 0) : response.task_deleted !== true)) throw new Error('前置任务回执不匹配，请继续核验原请求');
    if (receipt.status === 'succeeded' && response.task?.dependency_revision === receipt.committed_revision && JSON.stringify([...(response.task.dependency_ids || [])].sort()) !== JSON.stringify([...intent.payload.dependency_ids].sort())) throw new Error('前置任务回执关系不匹配，请继续核验原请求');
    if (get().dependencyIntents[id]?.payload.client_request_id !== receipt.id) return;
    releaseDependency(intent);
    set(state => {
      const dependencyDrafts = { ...state.dependencyDrafts };
      if (receipt.status === 'succeeded' && dependencyDrafts[id]?.commandKey === intent.payload.client_request_id) delete dependencyDrafts[id];
      else if (receipt.status === 'cancelled' && !dependencyDrafts[id]) dependencyDrafts[id] = { revision: intent.payload.expected_revision, ids: [...intent.payload.dependency_ids] };
      const active = state.tasks.find(task => task.id === id);
      const saved = active && (active.dependency_revision ?? 0) > (response.task?.dependency_revision ?? 0) ? active : response.task;
      const draft = dependencyDrafts[id];
      const unsaved = !!draft && !draft.commandKey && !!saved && JSON.stringify([...draft.ids].sort()) !== JSON.stringify([...(saved.dependency_ids || [])].sort());
      return { dependencyDrafts, dependencyErrors: { ...state.dependencyErrors, [id]: '' }, dependencyConflicts: { ...state.dependencyConflicts, [id]: receipt.status === 'succeeded' && !!dependencyDrafts[id] }, dependencyNotices: { ...state.dependencyNotices, [id]: response.task_deleted ? '前置任务请求已确认；原任务已删除，没有重新创建' : receipt.status === 'cancelled' ? '原前置任务请求已结束，已保存的关系保持不变。处理完其余请求后可重新选择' : unsaved ? '原请求已确认保存，当前草稿尚未保存。已有正文保留，请核对是否需要保存新的复核版本' : '前置任务关系已确认。已有正文保留，请核对是否需要保存新的复核版本' }, ...(snapshot === fetchSequence ? { tasks: response.task ? state.tasks.map(task => task.id === id ? response.task! : task) : state.tasks.filter(task => task.id !== id) } : {}) };
    });
  }
  async function sendDependencies(intent: DependencyIntent, replay: boolean) {
    const origin = context(), id = intent.taskId;
    await mutate(id, '保存前置任务中', async () => {
      let dispatched = false;
      try {
        persistDependencyIntent(intent);
        set(state => ({ dependencyIntents: { ...state.dependencyIntents, [id]: intent }, dependencyQueues: { ...state.dependencyQueues, [id]: (state.dependencyQueues[id] || []).some(item => item.payload.client_request_id === intent.payload.client_request_id) ? state.dependencyQueues[id] : [...(state.dependencyQueues[id] || []), intent] }, dependencyErrors: { ...state.dependencyErrors, [id]: '' }, dependencyNotices: { ...state.dependencyNotices, [id]: '' } }));
        const snapshot = fetchSequence;
        dispatched = true;
        const response = await axiosInstance.put<DependencyCommandResponse>(`/tasks/${id}/dependencies`, structuredClone(intent.payload), { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin)) settleDependency(intent, response.data, snapshot);
      } catch (error) {
        if (current(origin)) {
          const status = (error as { status?: number; response?: { status?: number } }).status ?? (error as { response?: { status?: number } }).response?.status;
          const code = (error as { response?: { data?: { code?: string; error?: { code?: string } } }; code?: string }).response?.data;
          // Friendly Axios errors retain a structured top-level code. Use it
          // only for conflict classification, never to broaden key release.
          const revisionCode = code?.code ?? code?.error?.code ?? (error as { code?: string }).code;
          const revisionConflict = status === 409 && revisionCode === 'TASK_DEPENDENCY_REVISION_CONFLICT';
          const idConflict = code?.code === 'TASK_DEPENDENCY_IDEMPOTENCY_CONFLICT' || code?.error?.code === 'TASK_DEPENDENCY_IDEMPOTENCY_CONFLICT';
          const explicitCode = code?.code || code?.error?.code;
          const knownRejection = status === 400 || status === 422 || status === 404 && explicitCode === 'TASK_DEPENDENCY_NOT_FOUND';
          const rejected = dispatched && knownRejection && !idConflict && !replay;
          if (rejected) releaseDependency(intent);
          set(state => ({ dependencyErrors: { ...state.dependencyErrors, [id]: !dispatched ? requestError(error) : revisionConflict ? '前置任务关系发生冲突，先核对并结束原请求，再读取最新关系重新选择。' : rejected ? requestError(error) : status === 409 ? `${requestError(error)}。请先核对并结束原请求，再重新选择。` : '保存结果待核验，请保留原请求编号，核验或按原选择重试。连接失败不能证明没有保存。' }, dependencyConflicts: { ...state.dependencyConflicts, [id]: revisionConflict || !!state.dependencyConflicts[id] } }));
        }
        throw error;
      }
    });
  }
  return {
    ...createMetadataSlice(set, get, { context, current, sequence: () => fetchSequence, mutate }),
    dependencyDrafts: {}, dependencyIntents: {}, dependencyQueues: {}, dependencyErrors: {}, dependencyNotices: {}, dependencyConflicts: {}, dependencyRecoveryError: null,
    editDependencies: (id, ids) => {
      if (get().pending[id] || get().dependencyIntents[id] || get().dependencyConflicts[id]) return;
      const task = get().tasks.find(item => item.id === id);
      if (!task || ['running', 'outcome_unknown'].includes(task.status)) return;
      if (!validDependencyIds(ids) || ids.includes(id)) throw new Error('最多选择32个不同的前置任务，不能选择任务自身');
      set(state => ({ dependencyDrafts: { ...state.dependencyDrafts, [id]: { revision: state.dependencyDrafts[id]?.revision ?? task.dependency_revision ?? 0, ids: [...ids] } }, dependencyNotices: { ...state.dependencyNotices, [id]: '' }, dependencyErrors: { ...state.dependencyErrors, [id]: '' } }));
    },
    resetDependencies: async id => {
      if (get().pending[id] || get().dependencyIntents[id]) return;
      const origin = context();
      await get().fetch();
      if (!current(origin)) return;
      if (get().error || get().dependencyRecoveryError) throw new Error('尚未读取到最新关系，请联网后重试');
      const task = get().tasks.find(item => item.id === id); if (!task) return;
      set(state => ({ dependencyDrafts: { ...state.dependencyDrafts, [id]: { revision: task.dependency_revision ?? 0, ids: [...(task.dependency_ids || [])] } }, dependencyConflicts: { ...state.dependencyConflicts, [id]: false }, dependencyErrors: { ...state.dependencyErrors, [id]: '' } }));
    },
    saveDependencies: async id => {
      restoreDependencies();
      if (get().dependencyIntents[id]) throw new Error('先核验原前置任务请求，不能换编号覆盖');
      const task = get().tasks.find(item => item.id === id), draft = get().dependencyDrafts[id];
      if (!task || !draft) throw new Error('请先选择前置任务');
      if (get().dependencyConflicts[id] || draft.revision !== (task.dependency_revision ?? 0)) throw new Error('请读取最新关系后重新选择');
      if (['running', 'outcome_unknown'].includes(task.status)) throw new Error('正在生成或结果待核验时，不能修改前置任务');
      if (!validDependencyIds(draft.ids) || draft.ids.includes(id)) throw new Error('前置任务选择无效');
      const key = crypto.randomUUID();
      set(state => ({ dependencyDrafts: { ...state.dependencyDrafts, [id]: { ...draft, commandKey: key } } }));
      await sendDependencies({ taskId: id, payload: { client_request_id: key, expected_revision: draft.revision, dependency_ids: [...draft.ids] } }, false);
    },
    verifyDependencies: async (id, key) => {
      restoreDependencies();
      const intent = get().dependencyIntents[id]; if (!intent || intent.payload.client_request_id !== key) throw new Error('原请求已变化，请重新打开前置任务');
      const origin = context();
      await mutate(id, '核验前置任务中', async () => {
        try {
          const snapshot = fetchSequence;
          const response = await axiosInstance.get<DependencyCommandResponse>(`/tasks/${id}/dependencies/commands/${key}`, { headers: { 'X-Expected-User-Id': origin.user || '' } });
          if (current(origin)) settleDependency(intent, response.data, snapshot);
        } catch (error) {
          if (current(origin)) set(state => ({ dependencyErrors: { ...state.dependencyErrors, [id]: '尚未取得确认回执。未找到记录或连接失败都不代表未保存；可继续核验，或按原选择同号重试。' } }));
          throw error;
        }
      });
    },
    closeDependencies: async (id, key) => {
      restoreDependencies();
      const intent = get().dependencyIntents[id]; if (!intent || intent.payload.client_request_id !== key) throw new Error('原请求已变化，请重新打开前置任务');
      const origin = context();
      await mutate(id, '核对并结束前置请求中', async () => {
        try {
          const snapshot = fetchSequence;
          const response = await axiosInstance.post<DependencyCommandResponse>(`/tasks/${id}/dependencies/commands/${key}/close`, {}, { headers: { 'X-Expected-User-Id': origin.user || '' } });
          if (current(origin)) settleDependency(intent, response.data, snapshot);
        } catch (error) {
          if (current(origin)) set(state => ({ dependencyErrors: { ...state.dependencyErrors, [id]: '尚未确认原请求是否已结束，原编号和选择仍保留。请再次核验或结束同一请求。' } }));
          throw error;
        }
      });
    },
    retryDependencies: async (id, key) => {
      restoreDependencies();
      const intent = get().dependencyIntents[id]; if (!intent || intent.payload.client_request_id !== key) throw new Error('原请求已变化，请重新打开前置任务');
      await sendDependencies(intent, true);
    },
    tasks: [], loading: false, error: null, lastUpdated: null, pending: {}, uncertainCreate: false, pendingCreates: [], recoveryError: null, recoveredCreate: null,
    draft: null, composerDraft: emptyTaskDraft(),
    setDraft: draft => set({ draft }),
    setComposerDraft: composerDraft => { composerSequence++; set({ composerDraft }); },
    fetch: async () => {
      const origin = context(), request = ++fetchSequence;
      set({ loading: get().tasks.length === 0 });
      try { get().restoreMetadata(); } catch { /* Preserve readable tasks while metadata writes fail closed. */ }
      try { restoreDependencies(); } catch { /* Relationship writes fail closed; task reading remains available. */ }
      try {
        const unknownCreates = refreshCreateReceipts();
        for (const receipt of readTaskReceipts()) if (receipt.action === 'run' && receipt.taskId && !runIntents.has(receipt.taskId)) runIntents.set(receipt.taskId, receipt.key);
        const { data } = await axiosInstance.get<WorkspaceTask[]>('/tasks', { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (!current(origin) || request !== fetchSequence) return;
        set({ tasks: data });
        await get().hydrateMetadata();
        if (!current(origin) || request !== fetchSequence) return;
        for (const receipt of unknownCreates) {
          // Recover any available original intent before trusting a list/query
          // shortcut. Loading never normalizes old bytes or dispatches a write.
          await restoreCreateIntent(receipt, origin);
          if (!current(origin) || request !== fetchSequence) return;
          try {
            const task = data.find(item => item.client_request_id === receipt.key);
            const response = task ? { status: 'succeeded' as const, operation: 'create' as const, client_request_id: receipt.key, task_id: task.id, task_deleted: false, task } : (await axiosInstance.get<TaskCreateCommandReceipt>(`/tasks/commands/${receipt.key}`, { headers: { 'X-Expected-User-Id': origin.user || '' } })).data;
            if (!current(origin) || request !== fetchSequence) return;
            settleCreate(receipt.key, response);
          } catch { if (!current(origin) || request !== fetchSequence) return; }
        }
        for (const task of data) {
          const key = runIntents.get(task.id);
          if (key && task.status !== 'running' && (task.run_request_id === key || task.history.some(run => run.client_request_id === key))) { runIntents.delete(task.id); removeTaskReceipt(key); }
        }
        set({ loading: false, error: null, lastUpdated: new Date().toISOString() });
      } catch (error) { if (current(origin) && request === fetchSequence) set({ loading: false, error: requestError(error) }); }
    },
    create: async data => {
      if (!validPlanningFields(data)) throw new Error('请填写有效优先级和预计分钟');
      if (get().pending.create) throw new Error('正在保存，请稍候');
      const pending = refreshCreateReceipts();
      if (pending.length) {
        const intent = pending.length === 1 ? createIntents.get(pending[0].key) : undefined;
        if (!intent) throw new Error('原请求正文未保存在此设备或还有其他请求待核验。请先核对并结束原请求，再提交新输入');
        if (JSON.stringify(data) !== JSON.stringify(intent.payload)) throw new Error('上次保存结果待核验，请先按原内容重试或结束原请求，再提交新输入');
        return sendCreate(intent);
      }
      const intent = { key: crypto.randomUUID(), payload: structuredClone(data), composerSequence };
      createIntents.set(intent.key, intent);
      return sendCreate(intent);
    },
    canRetryCreate: key => !!createIntents.get(key)?.payload,
    retryCreate: async key => {
      refreshCreateReceipts();
      const intent = createIntents.get(key);
      if (!intent || !get().pendingCreates.some(item => item.key === key)) throw new Error('原文字未保存在此设备，请核对并结束这次请求后重新填写');
      return sendCreate(intent);
    },
    verifyCreate: key => queryCreate(key, false),
    closeCreate: key => queryCreate(key, true),
    run: async id => {
      get().requireSettledMetadata(id);
      restoreDependencies();
      if (get().tasks.find(task => task.id === id)?.dependency_state?.blocked || get().dependencyIntents[id]) throw new Error('前置任务尚未就绪或关系待核验，暂时不能生成');
      const origin = context();
      const key = runIntents.get(id) || crypto.randomUUID();
      runIntents.set(id, key);
      await mutate(id, '生成中', async () => {
        let dispatched = false;
        try {
          const payloadHash = await textHash(JSON.stringify({ taskId: id, action: 'run' }));
          if (!current(origin)) throw new Error('账号已切换，请在当前账号重新打开工作台');
          get().requireSettledMetadata(id);
          restoreDependencies();
          if (get().dependencyIntents[id]) throw new Error('前置任务关系待核验，暂时不能生成');
          persistTaskReceipt({ key, action: 'run', taskId: id, payloadHash, createdAt: new Date().toISOString() });
          dispatched = true;
          const { data } = await axiosInstance.post<WorkspaceTask>(`/tasks/${id}/run`, {}, { timeout: 110000, headers: { 'Idempotency-Key': key, 'X-Expected-User-Id': origin.user || '' } });
          if (current(origin)) { if (data.status !== 'running') { runIntents.delete(id); removeTaskReceipt(key); } set(state => ({ tasks: state.tasks.map(task => task.id === id ? data : task) })); }
        } catch (error) { if (current(origin) && (!dispatched || definitiveFailure(error))) { runIntents.delete(id); try { removeTaskReceipt(key); } catch {} } throw error; }
      });
    },
    accept: async (id, runId) => {
      get().requireSettledMetadata(id);
      restoreDependencies();
      const dependency = get().tasks.find(task => task.id === id)?.dependency_state;
      if (dependency?.blocked || dependency?.result_stale || get().dependencyIntents[id]) throw new Error('请先处理前置任务并复核文稿，再验收');
      if (!runId) throw new Error('缺少本次草稿的运行标识，请刷新后重试');
      await mutate(id, '确认中', async () => {
        const origin = context();
        const { data } = await axiosInstance.post<WorkspaceTask>(`/tasks/${id}/accept`, { run_id: runId }, { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin)) set(state => ({ tasks: state.tasks.map(task => task.id === id ? data : task) }));
      });
    },
    resolveUnknown: async (id, runId, decision) => {
      await mutate(id, '记录核验中', async () => {
        const origin = context();
        const { data } = await axiosInstance.post<WorkspaceTask>(`/tasks/${id}/resolve-unknown`, { decision, run_id: runId }, { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin)) { runIntents.delete(id); set(state => ({ tasks: state.tasks.map(task => task.id === id ? data : task) })); }
      });
    },
    update: async (id, patch) => { const origin = context();
      if (['title', 'auto_run', 'run_at', 'priority', 'estimated_minutes'].some(key => key in patch)) throw new Error('请使用任务设置面板保存。当前草稿保留；如面板不可用，请刷新或升级应用');
      if (patch.status !== 'cancelled') get().requireSettledMetadata(id);
      if (patch.status === 'cancelled') patch = { ...patch, ...(runIntents.get(id) ? { cancel_request_id: runIntents.get(id) } : {}) }; await mutate(patch.status === 'cancelled' ? `${id}:cancel` : id, patch.status === 'cancelled' ? '停止请求中' : '更新中', () => axiosInstance.patch(`/tasks/${id}`, patch, { headers: { 'X-Expected-User-Id': origin.user || '' } })); },
    remove: async id => {
      await mutate(id, '删除中', async () => {
        const origin = context();
        await axiosInstance.delete(`/tasks/${id}`, { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin)) { runIntents.delete(id); set(state => ({ tasks: state.tasks.filter(task => task.id !== id) })); }
      });
    },
    cleanup: () => {
      epoch++; fetchSequence++; composerSequence++; clearMetadataWork(); createIntents.clear(); runIntents.clear(); inFlight.clear();
      set({ ...emptyMetadataState(), dependencyDrafts: {}, dependencyIntents: {}, dependencyQueues: {}, dependencyErrors: {}, dependencyNotices: {}, dependencyConflicts: {}, dependencyRecoveryError: null, tasks: [], loading: false, error: null, lastUpdated: null, pending: {}, uncertainCreate: false, pendingCreates: [], recoveryError: null, recoveredCreate: null, draft: null, composerDraft: emptyTaskDraft() });
    }
  };
});
