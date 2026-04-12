import { create } from 'zustand';
import { api } from '../services/api';

export interface PersonaConfig {
  name: string;
  style: string;
  replyStyle: string;
  personality: string;
  typicalPhrases: string[];
  color?: string;
  avatar_url?: string | null;
}

interface PersonasState {
  personas: Record<string, PersonaConfig>;
  loading: boolean;
  fetchPersonas: () => Promise<void>;
  updatePersona: (aiId: string, config: Partial<PersonaConfig>) => Promise<void>;
  resetPersona: (aiId: string) => Promise<void>;
}

export const usePersonasStore = create<PersonasState>((set) => ({
  personas: {},
  loading: false,

  fetchPersonas: async () => {
    set({ loading: true });
    try {
      const data = await api.getPersonas();
      set({ personas: data, loading: false });
    } catch (error) {
      console.error('Failed to fetch personas:', error);
      set({ loading: false });
    }
  },

  updatePersona: async (aiId: string, config: Partial<PersonaConfig>) => {
    try {
      const updated = await api.updatePersona(aiId, config);
      set(state => ({
        personas: {
          ...state.personas,
          [aiId]: updated
        }
      }));
    } catch (error) {
      console.error('Failed to update persona:', error);
      throw error;
    }
  },

  resetPersona: async (aiId: string) => {
    try {
      const reset = await api.resetPersona(aiId);
      set(state => ({
        personas: {
          ...state.personas,
          [aiId]: reset
        }
      }));
    } catch (error) {
      console.error('Failed to reset persona:', error);
      throw error;
    }
  }
}));
