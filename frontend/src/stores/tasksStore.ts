import { create } from 'zustand';
import { axiosInstance } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import { requestError } from './modelsStore';
import type { WorkspaceTask, TaskCreateInput } from '../../../shared/tasks';

let epoch = 0;
export const useTasksStore = create<{
  tasks: WorkspaceTask[];
  loading: boolean;
  error: string | null;
  draft: { prompt: string; groupId: string | null } | null;
  setDraft: (draft: { prompt: string; groupId: string | null } | null) => void;
  fetch: () => Promise<void>;
  create: (data: TaskCreateInput) => Promise<void>;
  run: (id: string) => Promise<void>;
  accept: (id: string, runId: string) => Promise<void>;
  resolveUnknown: (id: string, decision: 'allow_retry' | 'abandon') => Promise<void>;
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  cleanup: () => void;
}>((set, get) => ({
  tasks: [], loading: false, error: null, draft: null,
  setDraft: draft => set({ draft }),
  fetch: async () => {
    const user = getCacheUserId(), generation = epoch;
    set({ loading: get().tasks.length === 0 });
    try {
      const { data } = await axiosInstance.get<WorkspaceTask[]>('/tasks');
      if (generation === epoch && user === getCacheUserId()) set({ tasks: data, loading: false, error: null });
    } catch (e) { if (generation === epoch && user === getCacheUserId()) set({ loading: false, error: requestError(e) }); }
  },
  create: async data => { await axiosInstance.post('/tasks', data); await get().fetch(); },
  run: async id => {
    set(s => ({ tasks: s.tasks.map(t => t.id === id ? { ...t, status: 'running', error: null } : t) }));
    try { await axiosInstance.post(`/tasks/${id}/run`, {}, { timeout: 110000 }); }
    finally { await get().fetch(); }
  },
  accept: async (id, runId) => {
    if (!runId) throw new Error('缺少本次草稿的运行标识，请刷新后重试');
    const user = getCacheUserId(), generation = epoch;
    const { data } = await axiosInstance.post<WorkspaceTask>(`/tasks/${id}/accept`, { run_id: runId });
    if (generation === epoch && user === getCacheUserId()) {
      set(s => ({ tasks: s.tasks.map(t => t.id === id ? data : t) }));
      await get().fetch();
    }
  },
  resolveUnknown: async (id, decision) => {
    const user = getCacheUserId(), generation = epoch;
    const { data } = await axiosInstance.post<WorkspaceTask>(`/tasks/${id}/resolve-unknown`, { decision });
    if (generation === epoch && user === getCacheUserId()) {
      set(s => ({ tasks: s.tasks.map(t => t.id === id ? data : t) }));
      await get().fetch();
    }
  },
  update: async (id, patch) => { await axiosInstance.patch(`/tasks/${id}`, patch); await get().fetch(); },
  remove: async id => { await axiosInstance.delete(`/tasks/${id}`); await get().fetch(); },
  cleanup: () => { epoch++; set({ tasks: [], loading: false, error: null, draft: null }); }
}));
