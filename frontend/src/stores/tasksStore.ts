import { create } from 'zustand';
import { axiosInstance, getAuthGeneration } from '../services/api';
import { persistTaskReceipt, readTaskReceipts, removeTaskReceipt, textHash, loadWritingContent, saveWritingContent, removeWritingDraft } from '../utils/taskRecovery';
import { getCacheUserId } from '../utils/cacheUtils';
import { requestError } from './modelsStore';
import { recordDiagnostic } from '../observability/runtimeDiagnostics';
import type { WorkspaceTask, TaskCreateInput } from '../../../shared/tasks';

export interface TaskComposerDraft {
  title: string; prompt: string; category: 'work' | 'social' | 'play';
  modelId: string; groupId: string; sourceMessageId: string; sourceMessageEditedAt: string | null; runAt: string; repeat: string; autoRun: boolean;
}
export const emptyTaskDraft = (): TaskComposerDraft => ({ title: '', prompt: '', category: 'work', modelId: '', groupId: '', sourceMessageId: '', sourceMessageEditedAt: null, runAt: '', repeat: '', autoRun: false });
interface CreateIntent { key: string; payload: TaskCreateInput; }
interface TaskState {
  tasks: WorkspaceTask[]; loading: boolean; error: string | null; lastUpdated: string | null;
  pending: Record<string, string>; uncertainCreate: boolean; recoveredCreate: { taskId: string | null; deleted: boolean } | null;
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
let createIntent: CreateIntent | null = null;
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
  return {
    tasks: [], loading: false, error: null, lastUpdated: null, pending: {}, uncertainCreate: false, recoveredCreate: null,
    draft: null, composerDraft: emptyTaskDraft(),
    setDraft: draft => set({ draft }),
    setComposerDraft: composerDraft => { if (!get().uncertainCreate && !get().pending.create) set({ composerDraft }); },
    fetch: async () => {
      const origin = context(), request = ++fetchSequence;
      set({ loading: get().tasks.length === 0 });
      try {
        const receipts = readTaskReceipts();
        const unknownCreates = receipts.filter(item => item.action === 'create');
        for (const receipt of receipts) if (receipt.action === 'run' && receipt.taskId && !runIntents.has(receipt.taskId)) runIntents.set(receipt.taskId, receipt.key);
        if (unknownCreates.length) set({ uncertainCreate: true });
        const { data } = await axiosInstance.get<WorkspaceTask[]>('/tasks', { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin) && request === fetchSequence) {
          for (const receipt of unknownCreates) {
            if (data.some(task => task.client_request_id === receipt.key)) {
              removeTaskReceipt(receipt.key); removeWritingDraft(`create-intent:${receipt.key}`);
              if (createIntent?.key === receipt.key) createIntent = null;
              set({ uncertainCreate: false, composerDraft: emptyTaskDraft(), recoveredCreate: { taskId: data.find(task => task.client_request_id === receipt.key)!.id, deleted: false } });
            } else {
              try {
                const { data: receiptResponse } = await axiosInstance.get<{ status: string; client_request_id: string; task_deleted: boolean; task: WorkspaceTask | null }>(`/tasks/commands/${receipt.key}`, { headers: { 'X-Expected-User-Id': origin.user || '' } });
                if (!current(origin) || request !== fetchSequence) return;
                if (receiptResponse.status === 'succeeded' && receiptResponse.client_request_id === receipt.key) {
                  removeTaskReceipt(receipt.key); removeWritingDraft(`create-intent:${receipt.key}`);
                  if (createIntent?.key === receipt.key) createIntent = null;
                  if (receiptResponse.task && !data.some(item => item.id === receiptResponse.task!.id)) data.unshift(receiptResponse.task);
                  set({ uncertainCreate: false, composerDraft: emptyTaskDraft(), recoveredCreate: { taskId: receiptResponse.task?.id || null, deleted: receiptResponse.task_deleted } });
                  continue;
                }
              } catch { if (!current(origin) || request !== fetchSequence) return; }
              if (createIntent) continue;
              const frozen = await loadWritingContent(`create-intent:${receipt.key}`);
              if (!current(origin) || request !== fetchSequence) return;
              if (frozen) {
                const payload = JSON.parse(frozen.body) as TaskCreateInput;
                if (await textHash(JSON.stringify(payload)) !== receipt.payloadHash || !current(origin) || request !== fetchSequence) continue;
                createIntent = { key: receipt.key, payload };
                set({ composerDraft: { title: payload.title, prompt: payload.prompt, category: payload.category, modelId: payload.model_id || '', groupId: payload.group_id || '', sourceMessageId: payload.source_message_id || '', sourceMessageEditedAt: payload.source_message_edited_at ?? null, runAt: payload.run_at || '', repeat: payload.repeat_minutes ? String(payload.repeat_minutes) : '', autoRun: payload.auto_run } });
              }
            }
          }
          for (const task of data) {
            const key = runIntents.get(task.id);
            if (key && task.status !== 'running' && (task.run_request_id === key || task.history.some(run => run.client_request_id === key))) { runIntents.delete(task.id); removeTaskReceipt(key); }
          }
          set({ tasks: data, loading: false, error: null, lastUpdated: new Date().toISOString() });
        }
      } catch (error) {
        if (current(origin) && request === fetchSequence) set({ loading: false, error: requestError(error) });
      }
    },
    create: async data => {
      if (get().pending.create) throw new Error('正在保存，请稍候');
      if (get().uncertainCreate && !createIntent) throw new Error('上次保存的正文未保存在此设备，请先刷新任务状态核验原请求；不会用新输入重复创建');
      if (!createIntent) createIntent = { key: crypto.randomUUID(), payload: structuredClone(data) };
      if (JSON.stringify(data) !== JSON.stringify(createIntent.payload)) throw new Error('上次保存结果待核验，请先按原内容重试确认，避免重复创建');
      const intent = createIntent;
      set({ recoveredCreate: null });
      const origin = context();
      return mutate('create', '保存中', async () => {
        let dispatched = false;
        try {
          const payloadHash = await textHash(JSON.stringify(intent.payload));
          if (!current(origin)) throw new Error('账号已切换，请在当前账号重新打开工作台');
          persistTaskReceipt({ key: intent.key, action: 'create', taskId: null, payloadHash, createdAt: new Date().toISOString() });
          await saveWritingContent(`create-intent:${intent.key}`, { body: JSON.stringify(intent.payload), baseRevisionId: null, savedAt: new Date().toISOString() });
          if (!current(origin)) throw new Error('账号已切换，请在当前账号重新打开工作台');
          dispatched = true;
          const { data: task } = await axiosInstance.post<WorkspaceTask>('/tasks', intent.payload, { headers: { 'Idempotency-Key': intent.key, 'X-Expected-User-Id': origin.user || '' } });
          if (current(origin)) {
            removeTaskReceipt(intent.key); removeWritingDraft(`create-intent:${intent.key}`);
            createIntent = null;
            set(state => ({ uncertainCreate: false, composerDraft: emptyTaskDraft(), tasks: [task, ...state.tasks.filter(t => t.id !== task.id)] }));
          }
          return task;
        } catch (error) {
          if (current(origin)) {
            if (!dispatched || definitiveFailure(error)) { try { removeTaskReceipt(intent.key); removeWritingDraft(`create-intent:${intent.key}`); } catch {} createIntent = null; set({ uncertainCreate: false }); }
            else set({ uncertainCreate: true });
          }
          throw error;
        }
      });
    },
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
      epoch++; fetchSequence++; createIntent = null; runIntents.clear(); inFlight.clear();
      set({ tasks: [], loading: false, error: null, lastUpdated: null, pending: {}, uncertainCreate: false, recoveredCreate: null, draft: null, composerDraft: emptyTaskDraft() });
    }
  };
});
