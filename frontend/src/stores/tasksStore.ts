import { create } from 'zustand';
import { axiosInstance, getAuthGeneration } from '../services/api';
import { persistTaskReceipt, readTaskReceipts, removeTaskReceipt, textHash, loadWritingContent, saveWritingContent, removeWritingDraft, type TaskCommandReceipt } from '../utils/taskRecovery';
import { getCacheUserId } from '../utils/cacheUtils';
import { requestError } from './modelsStore';
import { recordDiagnostic } from '../observability/runtimeDiagnostics';
import type { WorkspaceTask, TaskCreateInput, TaskCreateCommandReceipt } from '../../../shared/tasks';

export interface TaskComposerDraft {
  title: string; prompt: string; category: 'work' | 'social' | 'play';
  modelId: string; groupId: string; sourceMessageId: string; sourceMessageEditedAt: string | null; runAt: string; repeat: string; autoRun: boolean;
}
export const emptyTaskDraft = (): TaskComposerDraft => ({ title: '', prompt: '', category: 'work', modelId: '', groupId: '', sourceMessageId: '', sourceMessageEditedAt: null, runAt: '', repeat: '', autoRun: false });
interface CreateIntent { key: string; payload: TaskCreateInput; composerSequence?: number; }
interface TaskState {
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
  function releaseCreate(key: string) {
    removeTaskReceipt(key); removeWritingDraft(`create-intent:${key}`); createIntents.delete(key);
    set(state => { const pendingCreates = state.pendingCreates.filter(item => item.key !== key); return { pendingCreates, uncertainCreate: pendingCreates.length > 0 }; });
    refreshCreateReceipts();
  }
  function settleCreate(key: string, response: TaskCreateCommandReceipt, snapshotSequence = fetchSequence) {
    if (response.operation !== 'create' || response.client_request_id !== key || !['succeeded', 'cancelled'].includes(response.status)) throw new Error('回执标识不匹配，请继续核验原请求');
    if (response.status === 'cancelled' && (response.task_id !== null || response.task !== null || response.task_deleted !== false || !response.closed_at)) throw new Error('结束回执不完整，请继续核验原请求');
    if (response.status === 'succeeded' && (!response.task_id || (!response.task && !response.task_deleted) || (response.task && (response.task.id !== response.task_id || response.task.client_request_id !== key)))) throw new Error('创建回执不完整，请继续核验原请求');
    if (!get().pendingCreates.some(item => item.key === key)) return;
    const intent = createIntents.get(key);
    const clearDraft = response.status === 'succeeded' && intent?.composerSequence === composerSequence;
    releaseCreate(key);
    set(state => ({ ...(clearDraft ? { composerDraft: emptyTaskDraft() } : {}), recoveredCreate: { taskId: response.task_id, deleted: response.task_deleted, cancelled: response.status === 'cancelled', preserveDraft: !clearDraft && !!(state.composerDraft.title || state.composerDraft.prompt) }, ...(response.task && snapshotSequence === fetchSequence ? { tasks: [response.task, ...state.tasks.filter(item => item.id !== response.task!.id)] } : {}) }));
  }
  async function queryCreate(key: string, close: boolean) {
    refreshCreateReceipts();
    if (!get().pendingCreates.some(item => item.key === key)) throw new Error('这次请求已不在待核验列表，请查看最新结果');
    const origin = context();
    await mutate(`create:${key}`, close ? '核对并结束中' : '核验中', async () => {
      try {
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
  return {
    tasks: [], loading: false, error: null, lastUpdated: null, pending: {}, uncertainCreate: false, pendingCreates: [], recoveryError: null, recoveredCreate: null,
    draft: null, composerDraft: emptyTaskDraft(),
    setDraft: draft => set({ draft }),
    setComposerDraft: composerDraft => { composerSequence++; set({ composerDraft }); },
    fetch: async () => {
      const origin = context(), request = ++fetchSequence;
      set({ loading: get().tasks.length === 0 });
      try {
        const unknownCreates = refreshCreateReceipts();
        for (const receipt of readTaskReceipts()) if (receipt.action === 'run' && receipt.taskId && !runIntents.has(receipt.taskId)) runIntents.set(receipt.taskId, receipt.key);
        const { data } = await axiosInstance.get<WorkspaceTask[]>('/tasks', { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (!current(origin) || request !== fetchSequence) return;
        set({ tasks: data });
        for (const receipt of unknownCreates) {
          try {
            const task = data.find(item => item.client_request_id === receipt.key);
            const response = task ? { status: 'succeeded' as const, operation: 'create' as const, client_request_id: receipt.key, task_id: task.id, task_deleted: false, task } : (await axiosInstance.get<TaskCreateCommandReceipt>(`/tasks/commands/${receipt.key}`, { headers: { 'X-Expected-User-Id': origin.user || '' } })).data;
            if (!current(origin) || request !== fetchSequence) return;
            settleCreate(receipt.key, response);
            continue;
          } catch { if (!current(origin) || request !== fetchSequence) return; }
          if (createIntents.has(receipt.key)) continue;
          const frozen = await loadWritingContent(`create-intent:${receipt.key}`);
          if (!current(origin) || request !== fetchSequence) return;
          if (frozen) {
            try {
              const payload = JSON.parse(frozen.body) as TaskCreateInput;
              if (await textHash(JSON.stringify(payload)) !== receipt.payloadHash || !current(origin) || request !== fetchSequence) continue;
              createIntents.set(receipt.key, { key: receipt.key, payload });
            } catch { /* Unreadable private input never becomes a replay. */ }
          }
        }
        for (const task of data) {
          const key = runIntents.get(task.id);
          if (key && task.status !== 'running' && (task.run_request_id === key || task.history.some(run => run.client_request_id === key))) { runIntents.delete(task.id); removeTaskReceipt(key); }
        }
        set({ loading: false, error: null, lastUpdated: new Date().toISOString() });
      } catch (error) { if (current(origin) && request === fetchSequence) set({ loading: false, error: requestError(error) }); }
    },
    create: async data => {
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
      const origin = context();
      const key = runIntents.get(id) || crypto.randomUUID();
      runIntents.set(id, key);
      await mutate(id, '生成中', async () => {
        let dispatched = false;
        try {
          const payloadHash = await textHash(JSON.stringify({ taskId: id, action: 'run' }));
          if (!current(origin)) throw new Error('账号已切换，请在当前账号重新打开工作台');
          persistTaskReceipt({ key, action: 'run', taskId: id, payloadHash, createdAt: new Date().toISOString() });
          dispatched = true;
          const { data } = await axiosInstance.post<WorkspaceTask>(`/tasks/${id}/run`, {}, { timeout: 110000, headers: { 'Idempotency-Key': key, 'X-Expected-User-Id': origin.user || '' } });
          if (current(origin)) { if (data.status !== 'running') { runIntents.delete(id); removeTaskReceipt(key); } set(state => ({ tasks: state.tasks.map(task => task.id === id ? data : task) })); }
        } catch (error) { if (current(origin) && (!dispatched || definitiveFailure(error))) { runIntents.delete(id); try { removeTaskReceipt(key); } catch {} } throw error; }
      });
    },
    accept: async (id, runId) => {
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
      if (patch.status === 'cancelled') patch = { ...patch, ...(runIntents.get(id) ? { cancel_request_id: runIntents.get(id) } : {}) }; await mutate(patch.status === 'cancelled' ? `${id}:cancel` : id, patch.status === 'cancelled' ? '停止请求中' : '更新中', () => axiosInstance.patch(`/tasks/${id}`, patch, { headers: { 'X-Expected-User-Id': origin.user || '' } })); },
    remove: async id => {
      await mutate(id, '删除中', async () => {
        const origin = context();
        await axiosInstance.delete(`/tasks/${id}`, { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin)) { runIntents.delete(id); set(state => ({ tasks: state.tasks.filter(task => task.id !== id) })); }
      });
    },
    cleanup: () => {
      epoch++; fetchSequence++; composerSequence++; createIntents.clear(); runIntents.clear(); inFlight.clear();
      set({ tasks: [], loading: false, error: null, lastUpdated: null, pending: {}, uncertainCreate: false, pendingCreates: [], recoveryError: null, recoveredCreate: null, draft: null, composerDraft: emptyTaskDraft() });
    }
  };
});
