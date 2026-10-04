import { create } from 'zustand';
import { usePersonasStore } from './personasStore';
import { useMemo } from 'react';
import { axiosInstance } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import type { ModelCatalog } from '../../../shared/models';
import { startModelProbe, readModelProbe, probeKey, probeReceipt, probeUnresolved } from '../services/modelProbes';
import type { ModelProbeCapability, ModelProbeReceipt } from '../services/modelProbes';

export function requestError(error: unknown): string {
  const e = error as { response?: { data?: { error?: string } }; message?: string };
  return e.response?.data?.error || e.message || '操作失败，请重试';
}
interface ProbeState extends ModelProbeReceipt { accountId: string | null; catalogRevision: number; notFound?: boolean; pending: boolean; checking: boolean; queryError?: string; }
interface DiscoveryState { providerId: string; loading: boolean; models: string[]; error: string | null; complete: boolean; }
const emptyDiscovery = (): DiscoveryState => ({ providerId: '', loading: false, models: [], error: null, complete: false });
interface ModelsState {
  catalog: ModelCatalog | null; loading: boolean; error: string | null;
  draft: ModelCatalog | null; draftBase: ModelCatalog | null; dirty: boolean; selected: string;
  saving: boolean; saveError: string | null; conflict: boolean; notice: string;
  discovery: DiscoveryState; probes: Record<string, ProbeState>;
  fetch: () => Promise<void>; save: (catalog: ModelCatalog) => Promise<ModelCatalog>;
  setDraft: (catalog: ModelCatalog) => void; selectProvider: (id: string) => void;
  discardDraft: () => void; rebaseDraft: () => Promise<void>;
  discover: () => Promise<void>;
  test: (modelId: string, capability: ModelProbeCapability) => Promise<void>;
  queryProbe: (key: string) => Promise<void>;
  resubmitProbe: (key: string) => Promise<void>;
  cleanup: () => void;
}
let epoch = 0, fetchSequence = 0, mutationBarrier = 0, appliedRead = 0, discoverySequence = 0;
const context = () => ({ user: getCacheUserId(), epoch });
const current = (value: ReturnType<typeof context>) => value.epoch === epoch && value.user === getCacheUserId();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const statusOf = (error: unknown) => { const e = error as { status?: number; response?: { status?: number } }; return e.response?.status ?? e.status; };

// Explicit three-way recovery: untouched remote fields survive. Locally edited
// fields win only after the user chooses this action, and are never auto-saved.
export function mergeModelDraft(base: ModelCatalog, local: ModelCatalog, remote: ModelCatalog): ModelCatalog {
  function mergeRows<T extends { id: string }>(before: T[], edited: T[], latest: T[]): T[] {
    const rows = latest.filter(row => !before.some(old => old.id === row.id) || edited.some(row2 => row2.id === row.id));
    for (const row of edited) {
      const old = before.find(item => item.id === row.id);
      const index = rows.findIndex(item => item.id === row.id);
      if (!old) { if (index < 0) rows.push(row); else rows[index] = row; continue; }
      const changedFields = (Object.keys(row) as (keyof T)[]).filter(field =>
        !['ready', 'verifiedCapabilities', 'apiKeyConfigured', 'keySource'].includes(String(field)) && !same(row[field], old[field]));
      if (!changedFields.length) continue;
      const result = { ...(index < 0 ? row : rows[index]) };
      for (const field of changedFields) result[field] = row[field];
      if (index < 0) rows.push(result); else rows[index] = result;
    }
    return rows;
  }
  const providers = mergeRows(base.providers, local.providers, remote.providers).map(provider => {
    const edited = local.providers.find(p => p.id === provider.id);
    // A pending plaintext key is scoped to the connection where it was entered.
    // Never combine it with a concurrently changed destination or protocol.
    return edited?.apiKey && (provider.baseUrl !== edited.baseUrl || provider.protocol !== edited.protocol)
      ? { ...provider, baseUrl: edited.baseUrl, protocol: edited.protocol } : provider;
  });
  const models = mergeRows(base.models, local.models, remote.models);
  // Preserve a locally edited model's provider if it was concurrently removed.
  for (const model of models) {
    if (!providers.some(p => p.id === model.providerId)) {
      const provider = local.providers.find(p => p.id === model.providerId);
      if (provider) providers.push(provider);
    }
  }
  return { ...remote, providers, models, defaults: {
    chat: local.defaults.chat !== base.defaults.chat ? local.defaults.chat : remote.defaults.chat,
    vision: local.defaults.vision !== base.defaults.vision ? local.defaults.vision : remote.defaults.vision,
    tts: local.defaults.tts !== base.defaults.tts ? local.defaults.tts : remote.defaults.tts,
  } };
}

export const useModelsStore = create<ModelsState>((set, get) => {
  function acceptCatalog(data: ModelCatalog, request: number) {
    const existing = get().catalog;
    if (existing && (data.revision < existing.revision || (data.revision === existing.revision && request < appliedRead))) return;
    appliedRead = request;
    data = { ...data, models: data.models.map(model => ({ ...model, verifiedCapabilities: model.verifiedCapabilities?.filter(cap => {
      const receipt = get().probes[`${model.id}:${cap}`];
      return !receipt?.pending || receipt.stale || receipt.catalogRevision !== data.revision;
    }) })) };
    set(state => ({ catalog: data, ...(!state.dirty && !state.saving ? {
      draft: data, draftBase: data,
      selected: data.providers.some(p => p.id === state.selected) ? state.selected : data.providers[0]?.id || '',
    } : {}) }));
  }
  function invalidateVerification(modelId: string, capability: ModelProbeCapability) {
    const invalidate = (catalog: ModelCatalog | null) => catalog && { ...catalog, models: catalog.models.map(model => model.id === modelId ? {
      ...model, verifiedCapabilities: model.verifiedCapabilities?.filter(cap => cap !== capability),
    } : model) };
    set(state => ({ catalog: invalidate(state.catalog), draft: invalidate(state.draft) }));
  }
  function putProbe(key: string, receipt: ProbeState) { set(state => ({ probes: { ...state.probes, [key]: receipt } })); }
  async function receiveProbe(key: string, origin: ReturnType<typeof context>, initial: ProbeState, operation: () => Promise<unknown>, querying = false) {
    try {
      const data = await operation();
      if (!current(origin)) return;
      const receipt = probeReceipt(data);
      if (!receipt || receipt.modelId !== initial.modelId || receipt.capability !== initial.capability) throw new Error('测试回执格式不匹配，请核验原请求');
      // The server can return a canonical ID when deduplicating a pending test.
      putProbe(key, { ...receipt, accountId: initial.accountId, catalogRevision: initial.catalogRevision, pending: false, checking: false });
    } catch (error) {
      if (!current(origin)) return;
      const failure = error as { probeReceipt?: unknown; response?: { data?: unknown } };
      const receipt = probeReceipt(failure.probeReceipt ?? failure.response?.data);
      if (receipt && receipt.modelId === initial.modelId && receipt.capability === initial.capability) {
        putProbe(key, { ...receipt, accountId: initial.accountId, catalogRevision: initial.catalogRevision, pending: false, checking: false });
      } else if (querying) {
        putProbe(key, { ...initial, checking: false, notFound: statusOf(error) === 404, queryError: statusOf(error) === 404 ? '服务端暂未找到回执，不能据此认定原请求未发出。可以继续查询，或明确补交原请求号；原请求尚未收到时会开始测试，可能计费。不会自动重新发起付费测试。' : '暂时无法核验。请保留请求号，稍后再次查询；不会重新发起付费测试。' });
      } else {
        const status = statusOf(error);
        const definitive = status !== undefined && status >= 400 && status < 500 && ![408, 409, 429].includes(status);
        putProbe(key, { ...initial, pending: false, checking: false, status: definitive ? 'failed' : 'unknown', possibleCharge: !definitive,
          error: definitive ? requestError(error) : '请求结果未确认。请查询原请求状态，并核对服务商用量；不要重复发起测试。' });
      }
    } finally {
      if (current(origin)) {
        // A failed probe revokes prior verification too; refresh every outcome.
        mutationBarrier = ++fetchSequence;
        if (get().catalog?.revision === initial.catalogRevision && !get().probes[key]?.stale) invalidateVerification(initial.modelId, initial.capability);
        await get().fetch();
      }
    }
  }
  return {
    catalog: null, loading: false, error: null, draft: null, draftBase: null, dirty: false, selected: '',
    saving: false, saveError: null, conflict: false, notice: '', discovery: emptyDiscovery(), probes: {},
    fetch: async () => {
      const origin = context(), request = ++fetchSequence;
      set({ loading: true, error: null });
      try {
        const { data } = await axiosInstance.get<ModelCatalog>('/user/model-catalog', { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin) && request >= mutationBarrier) {
          acceptCatalog(data, request);
          if (request === fetchSequence) set({ loading: false, error: null });
        }
      } catch (error) {
        if (current(origin) && request === fetchSequence) set({ error: requestError(error), loading: false });
      }
    },
    setDraft: draft => {
      if (get().saving) return; // Preserve the exact snapshot while its receipt is pending.
      const before = get().draft?.providers.find(p => p.id === get().selected);
      const after = draft.providers.find(p => p.id === get().selected);
      const connectionChanged = !before || !after || (['baseUrl', 'protocol', 'enabled', 'keyRequired', 'apiKey', 'clearApiKey'] as const).some(field => before[field] !== after[field]);
      if (connectionChanged) discoverySequence++;
      set({ draft, dirty: true, notice: '', saveError: get().conflict ? get().saveError : null, ...(connectionChanged ? { discovery: emptyDiscovery() } : {}) });
    },
    selectProvider: selected => {
      if (selected !== get().selected) { discoverySequence++; set({ selected, discovery: emptyDiscovery() }); }
    },
    discardDraft: () => {
      if (get().saving) return;
      discoverySequence++;
      const catalog = get().catalog;
      set({ draft: catalog, draftBase: catalog, dirty: false, saveError: null, conflict: false, notice: '', discovery: emptyDiscovery(),
        selected: catalog?.providers.some(p => p.id === get().selected) ? get().selected : catalog?.providers[0]?.id || '' });
    },
    save: async catalog => {
      if (get().saving) throw new Error('正在保存，请稍候');
      if (get().conflict) throw new Error('请先合并最新配置或放弃草稿，再保存');
      const origin = context(), snapshot = structuredClone(catalog);
      mutationBarrier = ++fetchSequence;
      discoverySequence++;
      set({ saving: true, saveError: null, notice: '', loading: false, discovery: emptyDiscovery() });
      try {
        const { data } = await axiosInstance.put<ModelCatalog>('/user/model-catalog', snapshot, { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (!current(origin)) throw new Error('账号已切换，请重新加载');
        mutationBarrier = ++fetchSequence;
        acceptCatalog(data, mutationBarrier);
        const latest = get().catalog || data;
        set({ draft: latest, draftBase: latest, dirty: false, conflict: false, saveError: null, error: null, loading: false,
          notice: '已保存。会话、智能体和任务将使用新的配置；新增或变更的能力仍需测试。' });
        // Exactly one refresh per save; its failure must not turn a saved catalog into an unsaved draft.
        void usePersonasStore.getState().fetchPersonas().catch(() => {});
        return data;
      } catch (error) {
        if (current(origin)) {
          set({ saveError: requestError(error), conflict: statusOf(error) === 409 });
          if (statusOf(error) === 409) await get().fetch();
        }
        throw error;
      } finally { if (current(origin)) set({ saving: false }); }
    },
    rebaseDraft: async () => {
      if (get().saving) return;
      const origin = context();
      await get().fetch();
      if (!current(origin) || get().error) return;
      const { draft, draftBase, catalog } = get();
      if (!draft || !draftBase || !catalog) return;
      discoverySequence++;
      set({ draft: mergeModelDraft(draftBase, draft, catalog), draftBase: catalog, dirty: true, conflict: false, saveError: null,
        discovery: emptyDiscovery(), notice: '已合并最新版本，并保留你的修改。同一字段有冲突时使用你的值；请检查后再保存。' });
    },
    discover: async () => {
      const { selected, dirty, saving, discovery, catalog } = get();
      if (!selected || dirty || saving || discovery.loading) return;
      const origin = context(), request = ++discoverySequence, revision = catalog?.revision;
      set({ discovery: { providerId: selected, loading: true, models: [], error: null, complete: false } });
      try {
        const { data } = await axiosInstance.post<{ models: string[] }>('/user/model-catalog/discover', { providerId: selected }, { headers: { 'X-Expected-User-Id': origin.user || '' } });
        if (current(origin) && request === discoverySequence && get().selected === selected && get().catalog?.revision === revision) {
          set({ discovery: { providerId: selected, loading: false, models: data.models, error: null, complete: true } });
        }
      } catch (error) {
        if (current(origin) && request === discoverySequence && get().selected === selected) set({ discovery: { providerId: selected, loading: false, models: [], error: requestError(error), complete: false } });
      } finally {
        if (current(origin) && request === discoverySequence) set(state => ({ discovery: { ...state.discovery, loading: false } }));
      }
    },
    test: async (modelId, capability) => {
      const { dirty, saving, probes, catalog } = get();
      if (dirty || saving) return;
      const key = probeKey(modelId, capability), previous = probes[key];
      if (previous && (previous.pending || previous.checking || probeUnresolved(previous))) return;
      const model = catalog?.models.find(m => m.id === modelId);
      if (!model?.ready || !model.enabled || !model.capabilities.includes(capability)) return;
      const origin = context();
      const initial: ProbeState = { requestId: crypto.randomUUID(), modelId, capability, accountId: origin.user, catalogRevision: catalog!.revision, status: 'running', healthy: false, stale: false, possibleCharge: true, replayed: false, pending: true, checking: false };
      putProbe(key, initial);
      mutationBarrier = ++fetchSequence;
      invalidateVerification(modelId, capability);
      await receiveProbe(key, origin, initial, () => startModelProbe(origin.user, modelId, capability, initial.requestId, initial.catalogRevision));
    },
    queryProbe: async key => {
      const probe = get().probes[key];
      if (!probe || probe.pending || probe.checking) return;
      const origin = context();
      putProbe(key, { ...probe, checking: true, queryError: undefined });
      await receiveProbe(key, origin, probe, () => readModelProbe(origin.user, probe.requestId), true);
    },
    resubmitProbe: async key => {
      const probe = get().probes[key];
      if (!probe?.notFound || probe.pending || probe.checking || !probeUnresolved(probe) ||
          get().saving || get().dirty || get().catalog?.revision !== probe.catalogRevision || probe.accountId !== getCacheUserId()) return;
      const origin = context();
      const initial: ProbeState = { ...probe, status: 'running', healthy: false, pending: true, checking: false, notFound: false, queryError: undefined };
      putProbe(key, initial);
      mutationBarrier = ++fetchSequence;
      invalidateVerification(probe.modelId, probe.capability);
      // This explicit action replays the frozen intent, never a fresh paid ID.
      // Admission checks the original revision atomically on the server too.
      await receiveProbe(key, origin, initial, () => startModelProbe(probe.accountId, probe.modelId, probe.capability, probe.requestId, probe.catalogRevision));
    },
    // Memory only: never send drafts/keys to cacheUtils, localStorage or sessionStorage.
    cleanup: () => {
      epoch++; mutationBarrier = ++fetchSequence; discoverySequence++; appliedRead = 0;
      set({ catalog: null, loading: false, error: null, draft: null, draftBase: null, dirty: false, selected: '',
        saving: false, saveError: null, conflict: false, notice: '', discovery: emptyDiscovery(), probes: {} });
    },
  };
});

export function useChatModelIds(readyOnly = false) {
  const models = useModelsStore(s => s.catalog?.models);
  return useMemo(() => (models || []).filter(m => m.enabled && m.capabilities.includes('chat') &&
    (!readyOnly || (m.ready && m.verifiedCapabilities?.includes('chat')))).map(m => m.id), [models, readyOnly]);
}
