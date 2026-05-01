import { create } from 'zustand';
import { isAxiosError } from 'axios';
import { api } from '../services/api';
import { removeCache, loadGroupsCache, saveGroupsCache, saveGroupsCacheAsync, loadMessagesCache, saveMessagesCache, loadMessagesCacheAsync, saveMessagesCacheAsync } from '../utils/cacheUtils';
import { Group } from '../types';

export type { Group };

const GROUPS_STALE_TIME_MS = 15 * 1000;
let groupsFetchPromise: Promise<void> | null = null;
let lastGroupsFetchAt = 0;

export interface ChatStatus {
  isRunning: boolean;
  currentSpeaker: string | null;
  status: 'running' | 'stopped';
}

export interface DebateRole {
  id: string;
  name: string;
}

export interface DebateRoles {
  proponents: DebateRole[];
  opponents: DebateRole[];
  judge: DebateRole | null;
  audience: DebateRole[];
  hasJudge: boolean;
  hasAudience: boolean;
}

export interface DebateStatus {
  isRunning: boolean;
  status: 'running' | 'stopped';
  topic?: string;
  currentPhase?: string;
  phaseName?: string;
  roles?: DebateRoles;
  debateLevel?: number;
  selectedParticipants?: string[];
  hasAudience?: boolean;
}

interface GroupsState {
  groups: Group[];
  currentGroup: Group | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  chatStatus: Map<string, ChatStatus>;
  typingAIs: Map<string, string>;
  debateStatus: Map<string, DebateStatus>;
  fetchGroups: (silent?: boolean) => Promise<void>;
  selectGroup: (groupId: string) => void;
  createGroup: (name: string, description: string, aiMembers?: string[], avatarUrl?: string) => Promise<Group>;
  deleteGroup: (groupId: string) => Promise<void>;
  pinGroup: (groupId: string, pinned: boolean) => Promise<void>;
  getOrCreatePrivateChat: (aiId: string) => Promise<Group>;
  addGroupMember: (groupId: string, aiId: string) => Promise<void>;
  removeGroupMember: (groupId: string, aiId: string) => Promise<void>;
  getAIPrivateChats: () => Promise<Group[]>;
  createAIPrivateChat: (aiMembers: string[], topic?: string, customName?: string) => Promise<Group>;
  deleteAIPrivateChat: (chatId: string) => Promise<void>;
  startAIPrivateChat: (chatId: string, topic?: string) => Promise<{ group: Group; status: string }>;
  continueAIPrivateChat: (chatId: string) => Promise<{ status: string; message: string }>;
  stopAIPrivateChat: (chatId: string) => Promise<{ status: string }>;
  startAutonomousChat: (groupId: string, topic?: string) => Promise<{ status: string; message: string }>;
  stopAutonomousChat: (groupId: string) => Promise<{ status: string }>;
  getAutonomousChatStatus: (groupId: string) => Promise<{ active: boolean; group_id: string; ai_count: number }>;
  toggleDebateMode: (groupId: string) => Promise<void>;
  setDebateLevel: (groupId: string, level: number) => Promise<void>;
  updateChatStatus: (groupId: string, status: ChatStatus) => void;
  setTypingAI: (groupId: string, aiId: string | null) => void;
  fetchChatStatus: (chatId: string) => Promise<ChatStatus>;
  startFormalDebate: (groupId: string, topic: string, rolePreferences?: Record<string, string>, debateLevel?: number, selectedParticipants?: string[]) => Promise<{ status: string; message: string }>;
  stopFormalDebate: (groupId: string) => Promise<{ status: string }>;
  getFormalDebateStatus: (groupId: string) => Promise<DebateStatus>;
  allocateDebateRoles: (groupId: string, rolePreferences?: Record<string, string>, selectedParticipants?: string[]) => Promise<{ status: string; roles: Record<string, string> }>;
  triggerAudienceComment: (groupId: string, audienceMembers: string[]) => Promise<{ status: string; comment: string }>;
  updateDebateStatus: (groupId: string, status: DebateStatus) => void;
  updateGroupSettings: (groupId: string, settings: Partial<Group>) => void;
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: [],
  currentGroup: null,
  loading: false,
  initialized: false,
  error: null,
  chatStatus: new Map(),
  typingAIs: new Map(),
  debateStatus: new Map(),

  fetchGroups: async (silent: boolean = false) => {
    const currentGroups = get().groups;
    const isAlreadyLoaded = currentGroups.length > 0;
    const isFresh = get().initialized && Date.now() - lastGroupsFetchAt < GROUPS_STALE_TIME_MS;

    if (isFresh) {
      return;
    }

    if (!silent && !isAlreadyLoaded) {
      const syncCached = loadGroupsCache<Group[]>();
      if (syncCached && syncCached.length > 0) {
        const currentGroupId = get().currentGroup?.id;
        const updatedCurrentGroup = currentGroupId
          ? syncCached.find((g: Group) => g.id === currentGroupId) || null
          : null;
        set({ groups: syncCached, currentGroup: updatedCurrentGroup });
      } else {
        set({ loading: true, error: null });
      }
    }

    if (groupsFetchPromise) {
      return groupsFetchPromise;
    }

    groupsFetchPromise = (async () => {
      try {
        const groups = await api.getGroups();
        const existingGroups = get().groups;

        const mergedGroups: Group[] = groups.map((g: Group) => {
          const existingGroup = existingGroups.find(eg => eg.id === g.id);
          if (existingGroup) {
            return {
              ...g,
              avatar_url: existingGroup.avatar_url || g.avatar_url,
              background_url: existingGroup.background_url || g.background_url,
              announcement: existingGroup.announcement || g.announcement
            };
          }
          return g;
        });

        lastGroupsFetchAt = Date.now();
        saveGroupsCache(mergedGroups);
        saveGroupsCacheAsync(mergedGroups).catch(() => {});

        const currentGroupId = get().currentGroup?.id;
        const updatedCurrentGroup = currentGroupId
          ? mergedGroups.find((g: Group) => g.id === currentGroupId) || null
          : null;

        set({
          groups: mergedGroups,
          currentGroup: updatedCurrentGroup,
          loading: false,
          initialized: true
        });
      } catch (error) {
        set({ error: (error as Error).message, loading: false, initialized: true });
        if (!isAlreadyLoaded) {
          const cachedGroups = loadGroupsCache<Group[]>();
          if (cachedGroups && cachedGroups.length > 0) {
            const currentGroupId = get().currentGroup?.id;
            const updatedCurrentGroup = currentGroupId
              ? cachedGroups.find((g: Group) => g.id === currentGroupId) || null
              : null;
            set({ groups: cachedGroups, currentGroup: updatedCurrentGroup });
          }
        }
      } finally {
        groupsFetchPromise = null;
      }
    })();

    return groupsFetchPromise;
  },

  selectGroup: (groupId: string) => {
    if (!groupId) {
      set({ currentGroup: null });
      return;
    }
    const group = get().groups.find(g => g.id === groupId);
    if (group) {
      set({ currentGroup: group });
    }
  },

  createGroup: async (name: string, description: string, aiMembers?: string[], avatarUrl?: string) => {
    try {
      const newGroup = await api.createGroup(name, description, aiMembers, avatarUrl);
      
      set(state => ({
        groups: [...state.groups, newGroup],
        currentGroup: newGroup
      }));
      
      return newGroup;
    } catch (error) {
      console.error('Failed to create group:', error);
      throw error;
    }
  },

  deleteGroup: async (groupId: string) => {
    try {
      await api.deleteGroup(groupId);
      
      removeCache(`messages_${groupId}`);
      
      const cachedMessages = await loadMessagesCacheAsync().catch(() => loadMessagesCache());
      if (cachedMessages && cachedMessages[groupId]) {
        delete cachedMessages[groupId];
        saveMessagesCacheAsync(cachedMessages).catch(() => saveMessagesCache(cachedMessages));
      }
      
      set(state => {
        const newGroups = state.groups.filter(g => g.id !== groupId);
        const newCurrentGroup = state.currentGroup?.id === groupId 
          ? null
          : state.currentGroup;
        
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.delete(groupId);
        const newTypingAIs = new Map(state.typingAIs);
        newTypingAIs.delete(groupId);
        const newDebateStatus = new Map(state.debateStatus);
        newDebateStatus.delete(groupId);
        
        return {
          groups: newGroups,
          currentGroup: newCurrentGroup,
          chatStatus: newChatStatus,
          typingAIs: newTypingAIs,
          debateStatus: newDebateStatus
        };
      });
    } catch (error) {
      console.error('Failed to delete group:', error);
      throw error;
    }
  },

  pinGroup: async (groupId: string, pinned: boolean) => {
    try {
      const updated = await api.pinGroup(groupId, pinned);
      
      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? updated : g),
        currentGroup: state.currentGroup?.id === groupId ? updated : state.currentGroup
      }));
    } catch (error) {
      console.error('Failed to pin group:', error);
      throw error;
    }
  },

  getOrCreatePrivateChat: async (aiId: string) => {
    try {
      const privateChat = await api.getOrCreatePrivateChat(aiId);
      
      set(state => {
        const existingGroup = state.groups.find(g => g.id === privateChat.id);
        if (existingGroup) {
          return { currentGroup: existingGroup };
        }
        return {
          groups: [...state.groups, privateChat],
          currentGroup: privateChat
        };
      });
      
      return privateChat;
    } catch (error) {
      console.error('Failed to get or create private chat:', error);
      throw error;
    }
  },

  toggleDebateMode: async (groupId: string) => {
    const group = get().groups.find(g => g.id === groupId);
    if (!group) return;

    try {
      const updated = await api.updateDebateMode(groupId, !group.debate_mode);

      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? updated : g),
        currentGroup: state.currentGroup?.id === groupId ? updated : state.currentGroup
      }));
    } catch (error) {
      console.error('Failed to toggle debate mode:', error);
    }
  },

  setDebateLevel: async (groupId: string, level: number) => {
    const group = get().groups.find(g => g.id === groupId);
    if (!group) return;

    try {
      const updated = await api.updateDebateMode(groupId, group.debate_mode, level);

      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? updated : g),
        currentGroup: state.currentGroup?.id === groupId ? updated : state.currentGroup
      }));
    } catch (error) {
      console.error('Failed to set debate level:', error);
    }
  },

  addGroupMember: async (groupId: string, aiId: string) => {
    try {
      const result = await api.addGroupMember(groupId, aiId);
      
      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? result.group : g),
        currentGroup: state.currentGroup?.id === groupId ? result.group : state.currentGroup
      }));
    } catch (error) {
      console.error('Failed to add group member:', error);
      throw error;
    }
  },

  removeGroupMember: async (groupId: string, aiId: string) => {
    try {
      const result = await api.removeGroupMember(groupId, aiId);
      
      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? result.group : g),
        currentGroup: state.currentGroup?.id === groupId ? result.group : state.currentGroup
      }));
    } catch (error) {
      console.error('Failed to remove group member:', error);
      throw error;
    }
  },

  getAIPrivateChats: async () => {
    try {
      const aiPrivateChats = await api.getAIPrivateChats();
      return aiPrivateChats;
    } catch (error) {
      console.error('Failed to get AI private chats:', error);
      return [];
    }
  },

  createAIPrivateChat: async (aiMembers: string[], topic?: string, customName?: string) => {
    try {
      const newChat = await api.createAIPrivateChat(aiMembers, topic || undefined, customName);
      
      set(state => {
        const existingChat = state.groups.find(g => g.id === newChat.id);
        if (existingChat) {
          return { currentGroup: existingChat };
        }
        return {
          groups: [...state.groups, newChat],
          currentGroup: newChat
        };
      });
      
      return newChat;
    } catch (error) {
      console.error('Failed to create AI private chat:', error);
      throw error;
    }
  },

  deleteAIPrivateChat: async (chatId: string) => {
    try {
      await api.deleteAIPrivateChat(chatId);
      
      set(state => ({
        groups: state.groups.filter(g => g.id !== chatId),
        currentGroup: state.currentGroup?.id === chatId ? null : state.currentGroup
      }));
    } catch (error) {
      console.error('Failed to delete AI private chat:', error);
      throw error;
    }
  },

  startAIPrivateChat: async (chatId: string, topic?: string) => {
    try {
      const result = await api.startAIPrivateChat(chatId, topic);
      return result;
    } catch (error) {
      console.error('Failed to start AI private chat:', error);
      throw error;
    }
  },

  continueAIPrivateChat: async (chatId: string) => {
    try {
      const result = await api.continueAIPrivateChat(chatId);
      return result;
    } catch (error) {
      console.error('Failed to continue AI private chat:', error);
      throw error;
    }
  },

  stopAIPrivateChat: async (chatId: string) => {
    try {
      const result = await api.stopAIPrivateChat(chatId);
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(chatId, { isRunning: false, currentSpeaker: null, status: 'stopped' });
        const newTypingAIs = new Map(state.typingAIs);
        newTypingAIs.delete(chatId);
        return { chatStatus: newChatStatus, typingAIs: newTypingAIs };
      });
      return result;
    } catch (error) {
      console.error('Failed to stop AI private chat:', error);
      throw error;
    }
  },

  startAutonomousChat: async (groupId: string, topic?: string) => {
    try {
      const result = await api.startAutonomousChat(groupId, topic);
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(groupId, { isRunning: true, currentSpeaker: null, status: 'running' });
        return { chatStatus: newChatStatus };
      });
      return result;
    } catch (error) {
      console.error('Failed to start autonomous chat:', error);
      throw error;
    }
  },

  stopAutonomousChat: async (groupId: string) => {
    try {
      const result = await api.stopAutonomousChat(groupId);
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(groupId, { isRunning: false, currentSpeaker: null, status: 'stopped' });
        const newTypingAIs = new Map(state.typingAIs);
        newTypingAIs.delete(groupId);
        return { chatStatus: newChatStatus, typingAIs: newTypingAIs };
      });
      return result;
    } catch (error) {
      console.error('Failed to stop autonomous chat:', error);
      throw error;
    }
  },

  getAutonomousChatStatus: async (groupId: string) => {
    try {
      const result = await api.getAutonomousChatStatus(groupId);
      return { isRunning: result.active === true, status: result.active ? 'running' : 'stopped', ...result };
    } catch (error) {
      if (!(isAxiosError(error) && error.response?.status === 429)) {
        console.error('Failed to get autonomous chat status:', error);
      }
      return { isRunning: false, status: 'stopped' };
    }
  },

  updateChatStatus: (groupId: string, status: ChatStatus) => {
    set(state => {
      const newChatStatus = new Map(state.chatStatus);
      newChatStatus.set(groupId, status);
      return { chatStatus: newChatStatus };
    });
  },

  setTypingAI: (groupId: string, aiId: string | null) => {
    set(state => {
      const newTypingAIs = new Map(state.typingAIs);
      if (aiId) {
        newTypingAIs.set(groupId, aiId);
      } else {
        newTypingAIs.delete(groupId);
      }
      return { typingAIs: newTypingAIs };
    });
  },

  fetchChatStatus: async (chatId: string) => {
    try {
      const status = await api.getAIPrivateChatStatus(chatId);
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(chatId, status);
        return { chatStatus: newChatStatus };
      });
      return status;
    } catch (error) {
      console.error('Failed to fetch chat status:', error);
      return { isRunning: false, currentSpeaker: null, status: 'stopped' };
    }
  },

  startFormalDebate: async (groupId: string, topic: string, rolePreferences?: Record<string, string>, debateLevel?: number, selectedParticipants?: string[]) => {
    try {
      const result = await api.startFormalDebate(groupId, topic, rolePreferences, debateLevel, selectedParticipants);
      set(state => {
        const newDebateStatus = new Map(state.debateStatus);
        newDebateStatus.set(groupId, {
          isRunning: true,
          status: 'running',
          topic,
          selectedParticipants
        });
        return { debateStatus: newDebateStatus };
      });
      return result;
    } catch (error) {
      console.error('Failed to start formal debate:', error);
      throw error;
    }
  },

  stopFormalDebate: async (groupId: string) => {
    try {
      const result = await api.stopFormalDebate(groupId);
      set(state => {
        const newDebateStatus = new Map(state.debateStatus);
        newDebateStatus.set(groupId, { isRunning: false, status: 'stopped' });
        return { debateStatus: newDebateStatus };
      });
      return result;
    } catch (error) {
      console.error('Failed to stop formal debate:', error);
      throw error;
    }
  },

  getFormalDebateStatus: async (groupId: string) => {
    try {
      const status = await api.getFormalDebateStatus(groupId);
      set(state => {
        const newDebateStatus = new Map(state.debateStatus);
        newDebateStatus.set(groupId, status);
        return { debateStatus: newDebateStatus };
      });
      return status;
    } catch (error) {
      console.error('Failed to get formal debate status:', error);
      return { isRunning: false, status: 'stopped' };
    }
  },

  allocateDebateRoles: async (groupId: string, rolePreferences?: Record<string, string>, selectedParticipants?: string[]) => {
    try {
      const result = await api.allocateDebateRoles(groupId, rolePreferences, selectedParticipants);
      return result;
    } catch (error) {
      console.error('Failed to allocate debate roles:', error);
      throw error;
    }
  },

  triggerAudienceComment: async (groupId: string, audienceMembers: string[]) => {
    try {
      const result = await api.triggerAudienceComment(groupId, audienceMembers);
      return result;
    } catch (error) {
      console.error('Failed to trigger audience comment:', error);
      throw error;
    }
  },

  updateDebateStatus: (groupId: string, status: DebateStatus) => {
    set(state => {
      const newDebateStatus = new Map(state.debateStatus);
      newDebateStatus.set(groupId, status);
      return { debateStatus: newDebateStatus };
    });
  },

  updateGroupSettings: (groupId: string, settings: Partial<Group>) => {
    set(state => {
      const updatedGroups = state.groups.map(g => 
        g.id === groupId ? { ...g, ...settings } : g
      );
      const updatedCurrentGroup = state.currentGroup?.id === groupId
        ? { ...state.currentGroup, ...settings }
        : state.currentGroup;
      
      const groupsToCache = updatedGroups.map(g => ({
        ...g,
        avatar_url: g.avatar_url,
        background_url: g.background_url
      }));
      saveGroupsCacheAsync(groupsToCache).catch(() => saveGroupsCache(groupsToCache));
      
      return { groups: updatedGroups, currentGroup: updatedCurrentGroup };
    });
  }
}));
