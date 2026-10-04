import { create } from 'zustand';
import { usePersonasStore } from './personasStore';
import { useMemo } from 'react';
import { axiosInstance } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import type { ModelCatalog } from '../../../shared/models';

export function requestError(error: unknown): string {
  const e = error as { response?: { data?: { error?: string } }; message?: string };
  return e.response?.data?.error || e.message || '操作失败，请重试';
}
let epoch = 0;
export const useModelsStore = create<{
  catalog: ModelCatalog | null;
  loading: boolean;
  error: string | null;
  fetch: () => Promise<void>;
  save: (catalog: ModelCatalog) => Promise<ModelCatalog>;
  cleanup: () => void;
}>((set) => ({
  catalog: null, loading: false, error: null,
  fetch: async () => {
    const user = getCacheUserId(), generation = epoch;
    set({ loading: true, error: null });
    try {
      const { data } = await axiosInstance.get<ModelCatalog>('/user/model-catalog');
      if (user === getCacheUserId() && generation === epoch) set({ catalog: data, loading: false });
    } catch (error) {
      if (user === getCacheUserId() && generation === epoch) set({ error: requestError(error), loading: false });
    }
  },
  save: async (catalog) => {
    const user = getCacheUserId(), generation = epoch;
    const { data } = await axiosInstance.put<ModelCatalog>('/user/model-catalog', catalog);
    if (user !== getCacheUserId() || generation !== epoch) throw new Error('账号已切换，请重新加载');
    set({ catalog: data, error: null });
    void usePersonasStore.getState().fetchPersonas();
    return data;
  },
  cleanup: () => { epoch++; set({ catalog: null, loading: false, error: null }); }
}));

export function useChatModelIds(readyOnly = false) {
  const models = useModelsStore(s => s.catalog?.models);
  return useMemo(() => (models || []).filter(m => m.enabled && m.capabilities.includes('chat') &&
    (!readyOnly || (m.ready && m.verifiedCapabilities?.includes('chat')))).map(m => m.id), [models, readyOnly]);
}
