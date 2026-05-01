import { create } from 'zustand';
import { api } from '../services/api';
import { loadPersonasCache, savePersonasCache, savePersonasCacheAsync } from '../utils/cacheUtils';

export interface PersonaDebateConfig {
  mode?: string;
  level?: string;
  topic?: string;
  rounds?: number;
  speakingTime?: number;
  roles?: Record<string, string>;
}

export interface ResponseConfig {
  enabled: boolean;
  responseFrequency: number;
  minDelay: number;
  maxDelay: number;
  activeHours: { start: number; end: number };
  maxResponsesPerConversation: number;
  cooldownBetweenResponses: number;
}

export interface SocialConfig {
  maxMessageLength: number;
  enableQuoting: boolean;
  enableSocialFeedback: boolean;
  quoteProbability: number;
  maxQuotesPerMessage: number;
  likeProbability: number;
  commentProbability: number;
  dislikeProbability: number;
  interactionProbability: number;
}

export interface ModelConfig {
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
}

export type PreferredRole = 'expert' | 'student' | 'critic' | 'mediator' | 'innovator' | 'analyst' | 'supporter' | 'challenger' | 'teacher' | 'storyteller' | 'pragmatist' | 'philosopher' | 'humorist' | 'skeptic' | 'optimist' | 'realist' | 'custom';

export interface PersonaConfig {
  name: string;
  style: string;
  replyStyle: string;
  personality: string;
  typicalPhrases: string[];
  color?: string;
  avatar_url?: string | null;
  keywords?: string[];
  firstSpeakerTopics?: string[];
  speakingOrder?: number;
  messageLength?: string;
  questionProbability?: number;
  debateTendency?: string;
  silenceProbability?: number;
  preferredRole?: PreferredRole;
  customRoleName?: string;
  responseConfig?: ResponseConfig;
  socialConfig?: SocialConfig;
  modelConfig?: ModelConfig;
  expertise?: string[];
  styleTag?: string;
  speakingTraits?: string;
  debateConfig?: PersonaDebateConfig | null;
}

interface PersonasState {
  personas: Record<string, PersonaConfig>;
  loading: boolean;
  fetchPersonas: () => Promise<void>;
  updatePersona: (aiId: string, config: Partial<PersonaConfig>) => Promise<void>;
  resetPersona: (aiId: string) => Promise<void>;
  refreshPersonas: () => Promise<void>;
  handlePersonaUpdate: (aiId: string, persona: PersonaConfig) => void;
  cleanup: () => void;
}

function deduplicatePersonas(personas: Record<string, PersonaConfig>): Record<string, PersonaConfig> {
  const seenNames = new Map<string, string>();
  const result: Record<string, PersonaConfig> = {};
  
  for (const [id, persona] of Object.entries(personas)) {
    const name = persona.name || id;
    const existingId = seenNames.get(name);
    
    if (existingId && existingId !== id) {
      if (import.meta.env.DEV) {
        console.warn(`[Personas] 发现重复的AI角色: "${name}" (ID: ${existingId} 和 ${id})，保留 ${existingId}`);
      }
      continue;
    }
    
    seenNames.set(name, id);
    result[id] = persona;
  }
  
  return result;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let editLockCount = 0;

function startAutoRefresh() {
  if (refreshTimer) return;
  if (editLockCount > 0) return;
  
  refreshTimer = setInterval(() => {
    if (editLockCount > 0) return;
    const state = usePersonasStore.getState();
    if (!state.loading) {
      state.fetchPersonas();
    }
  }, 60000);
  
  if (import.meta.env.DEV) {
    console.log('[Personas] 已启动自动刷新，间隔60秒');
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    if (import.meta.env.DEV) {
      console.log('[Personas] 已停止自动刷新');
    }
  }
}

export function pausePersonasAutoRefresh() {
  editLockCount++;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (import.meta.env.DEV) {
    console.log('[Personas] 自动刷新已暂停，编辑锁计数:', editLockCount);
  }
}

export function resumePersonasAutoRefresh() {
  editLockCount = Math.max(0, editLockCount - 1);
  if (editLockCount === 0) {
    startAutoRefresh();
  }
  if (import.meta.env.DEV) {
    console.log('[Personas] 自动刷新已恢复，编辑锁计数:', editLockCount);
  }
}

export function ensurePersonasAutoRefresh() {
  startAutoRefresh();
}

export const usePersonasStore = create<PersonasState>((set, get) => ({
  personas: {},
  loading: false,

  fetchPersonas: async () => {
    startAutoRefresh();

    const syncCached = loadPersonasCache<Record<string, PersonaConfig>>();
    if (syncCached && Object.keys(syncCached).length > 0) {
      set({ personas: deduplicatePersonas(syncCached) });
    } else {
      set({ loading: true });
    }

    try {
      const data = await api.getPersonas();

      const currentPersonas = get().personas;
      const mergedPersonas: Record<string, PersonaConfig> = {};
      for (const [aiId, persona] of Object.entries(data)) {
        const existing = currentPersonas[aiId];
        const personaConfig = persona as PersonaConfig;
        mergedPersonas[aiId] = {
          ...(personaConfig as object),
          avatar_url: personaConfig.avatar_url || existing?.avatar_url || null,
          color: personaConfig.color || existing?.color
        } as PersonaConfig;
      }

      const dedupedPersonas = deduplicatePersonas(mergedPersonas);
      set({ personas: dedupedPersonas, loading: false });
      savePersonasCache(dedupedPersonas);
      savePersonasCacheAsync(dedupedPersonas).catch(() => {});
    } catch (error) {
      console.error('Failed to fetch personas:', error);
      if (!syncCached || Object.keys(syncCached).length === 0) {
        const cached = loadPersonasCache<Record<string, PersonaConfig>>();
        if (cached) {
          set({ personas: deduplicatePersonas(cached), loading: false });
        }
      }
      set({ loading: false });
    }
  },

  updatePersona: async (aiId: string, config: Partial<PersonaConfig>) => {
    try {
      const updated = await api.updatePersona(aiId, config);
      set(state => {
        const newPersonas = {
          ...state.personas,
          [aiId]: updated
        };
        const dedupedPersonas = deduplicatePersonas(newPersonas);
        savePersonasCacheAsync(dedupedPersonas).catch(() => savePersonasCache(dedupedPersonas));
        return { personas: dedupedPersonas };
      });
    } catch (error) {
      console.error('Failed to update persona:', error);
      throw error;
    }
  },

  refreshPersonas: async () => {
    await get().fetchPersonas();
  },

  handlePersonaUpdate: (aiId: string, persona: PersonaConfig) => {
    set(state => {
      const newPersonas = {
        ...state.personas,
        [aiId]: persona
      };
      const dedupedPersonas = deduplicatePersonas(newPersonas);
      savePersonasCacheAsync(dedupedPersonas).catch(() => savePersonasCache(dedupedPersonas));
      return { personas: dedupedPersonas };
    });
  },

  resetPersona: async (aiId: string) => {
    try {
      const reset = await api.resetPersona(aiId);
      set(state => {
        const newPersonas = {
          ...state.personas,
          [aiId]: reset
        };
        const dedupedPersonas = deduplicatePersonas(newPersonas);
        savePersonasCacheAsync(dedupedPersonas).catch(() => savePersonasCache(dedupedPersonas));
        return { personas: dedupedPersonas };
      });
    } catch (error) {
      console.error('Failed to reset persona:', error);
      throw error;
    }
  },

  cleanup: () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }
}));

// 初始化：加载缓存数据并启动自动刷新
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', stopAutoRefresh);
}
