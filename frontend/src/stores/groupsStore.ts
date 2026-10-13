import { create } from 'zustand';
import { isAxiosError } from 'axios';
import { api, getAuthGeneration } from '../services/api';
import { getCacheUserId, removeCache, loadGroupsCache, saveGroupsCache, loadMessagesCacheAsync, saveMessagesCache } from '../utils/cacheUtils';
import { Group } from '../types';

export type { Group };

const GROUPS_STALE_TIME_MS = 5 * 1000;
let groupsFetchPromise: Promise<void> | null = null;
let lastGroupsFetchAt = 0;
let groupsRevision = 0;
let fetchOwner = '';
const accountKey = () => JSON.stringify([getCacheUserId(), getAuthGeneration()]);
function invalidateGroupsRead() { groupsRevision++; lastGroupsFetchAt = 0; groupsFetchPromise = null; }


export interface ChatStatus {
  isRunning: boolean;
  currentSpeaker: string | null;
  status: 'running' | 'stopped' | 'paused';
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
  fetchGroups: (silent?: boolean, force?: boolean) => Promise<void>;
  selectGroup: (groupId: string) => void;
  upsertGroup: (group: Group) => void;
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

  fetchGroups: async (silent = false, force = false) => {
    const owner = accountKey();
    if (fetchOwner !== owner) { fetchOwner = owner; invalidateGroupsRead(); }
    if (!force && get().initialized && Date.now() - lastGroupsFetchAt < GROUPS_STALE_TIME_MS) return;
    if (groupsFetchPromise && !force) return groupsFetchPromise;
    const revision = ++groupsRevision;
    const current = () => owner === accountKey() && revision === groupsRevision;
    if (!silent && !get().groups.length) {
      const cached = loadGroupsCache<Group[]>();
      if (cached?.length) set({ groups: cached });
      set({ loading: !cached?.length, error: null });
    }
    const pending = (async () => {
      try {
        const groups = await api.getGroups();
        if (!current()) return;
        // An acknowledged server snapshot is authoritative, including empty
        // fields and removals. Old previews must never resurrect deleted text.
        lastGroupsFetchAt = Date.now();
        saveGroupsCache(groups);
        const id = get().currentGroup?.id;
        set({ groups, currentGroup: id ? groups.find((group: Group) => group.id === id) || null : null,
          loading: false, initialized: true, error: null });
      } catch {
        if (current()) set({ loading: false, initialized: true, error: '会话刷新失败，请检查连接后重试' });
      } finally {
        if (current()) groupsFetchPromise = null;
      }
    })();
    groupsFetchPromise = pending;
    return pending;
  },

  upsertGroup: (group) => {
    invalidateGroupsRead();
    set(state => {
      const groups = [...state.groups.filter(item => item.id !== group.id), group];
      saveGroupsCache(groups);
      return { groups, currentGroup: state.currentGroup?.id === group.id ? group : state.currentGroup, loading: false };
    });
  },

  selectGroup: (groupId: string) => {
    if (!groupId) {
      set({ currentGroup: null });
      return;
    }
    const group = get().groups.find(g => g.id === groupId);
    set({ currentGroup: group || null });
  },

  createGroup: async (name: string, description: string, aiMembers?: string[], avatarUrl?: string) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      const newGroup = await api.createGroup(name, description, aiMembers, avatarUrl);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      set(state => {
        const updatedGroups = [...state.groups, newGroup];
        saveGroupsCache(updatedGroups);
        return {
          groups: updatedGroups,
          currentGroup: newGroup
        };
      });

      return newGroup;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to create group:', error);
      set({ error: error instanceof Error ? error.message : '创建群组失败' });
      throw error;
    }
  },

  deleteGroup: async (groupId: string) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      await api.deleteGroup(groupId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      removeCache(`messages_${groupId}`);

      const cachedMessages = await loadMessagesCacheAsync();
      if (owner !== accountKey()) throw new Error('账号已切换');
      if (cachedMessages && cachedMessages[groupId]) {
        delete cachedMessages[groupId];
        saveMessagesCache(cachedMessages);
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

        // 持久化更新后的groups缓存
        saveGroupsCache(newGroups);

        return {
          groups: newGroups,
          currentGroup: newCurrentGroup,
          chatStatus: newChatStatus,
          typingAIs: newTypingAIs,
          debateStatus: newDebateStatus
        };
      });
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to delete group:', error);
      set({ error: error instanceof Error ? error.message : '删除群组失败' });
      throw error;
    }
  },

  pinGroup: async (groupId: string, pinned: boolean) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      const updated = await api.pinGroup(groupId, pinned);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? updated : g),
        currentGroup: state.currentGroup?.id === groupId ? updated : state.currentGroup
      }));
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to pin group:', error);
      set({ error: error instanceof Error ? error.message : '置顶操作失败' });
      throw error;
    }
  },

  getOrCreatePrivateChat: async (aiId: string) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      const privateChat = await api.getOrCreatePrivateChat(aiId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

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
      if (owner !== accountKey()) throw error;
      console.error('Failed to get or create private chat:', error);
      set({ error: error instanceof Error ? error.message : '创建私聊失败' });
      throw error;
    }
  },

  toggleDebateMode: async (groupId: string) => {
    const owner = accountKey();
    const group = get().groups.find(g => g.id === groupId);
    if (!group) return;

    try {
      invalidateGroupsRead();
      set({ loading: false });
      const updated = await api.updateDebateMode(groupId, !group.debate_mode);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? updated : g),
        currentGroup: state.currentGroup?.id === groupId ? updated : state.currentGroup
      }));
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to toggle debate mode:', error);
      set({ error: error instanceof Error ? error.message : '切换辩论模式失败' });
    }
  },

  setDebateLevel: async (groupId: string, level: number) => {
    const owner = accountKey();
    const group = get().groups.find(g => g.id === groupId);
    if (!group) return;

    try {
      invalidateGroupsRead();
      set({ loading: false });
      const updated = await api.updateDebateMode(groupId, group.debate_mode, level);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? updated : g),
        currentGroup: state.currentGroup?.id === groupId ? updated : state.currentGroup
      }));
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to set debate level:', error);
      set({ error: error instanceof Error ? error.message : '设置辩论等级失败' });
    }
  },

  addGroupMember: async (groupId: string, aiId: string) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      const result = await api.addGroupMember(groupId, aiId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? result.group : g),
        currentGroup: state.currentGroup?.id === groupId ? result.group : state.currentGroup
      }));
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to add group member:', error);
      set({ error: error instanceof Error ? error.message : '添加成员失败' });
      throw error;
    }
  },

  removeGroupMember: async (groupId: string, aiId: string) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      const result = await api.removeGroupMember(groupId, aiId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      set(state => ({
        groups: state.groups.map(g => g.id === groupId ? result.group : g),
        currentGroup: state.currentGroup?.id === groupId ? result.group : state.currentGroup
      }));
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to remove group member:', error);
      set({ error: error instanceof Error ? error.message : '移除成员失败' });
      throw error;
    }
  },

  getAIPrivateChats: async () => {
    const owner = accountKey();
    try {
      const aiPrivateChats = await api.getAIPrivateChats();
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      return aiPrivateChats;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to get AI private chats:', error);
      set({ error: error instanceof Error ? error.message : '获取AI私聊失败' });
      return [];
    }
  },

  createAIPrivateChat: async (aiMembers: string[], topic?: string, customName?: string) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      const newChat = await api.createAIPrivateChat(aiMembers, topic || undefined, customName);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

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
      if (owner !== accountKey()) throw error;
      console.error('Failed to create AI private chat:', error);
      set({ error: error instanceof Error ? error.message : '创建AI私聊失败' });
      throw error;
    }
  },

  deleteAIPrivateChat: async (chatId: string) => {
    const owner = accountKey();
    try {
      invalidateGroupsRead();
      set({ loading: false });
      await api.deleteAIPrivateChat(chatId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      invalidateGroupsRead();

      set(state => {
        // 清理所有关联的运行时状态，防止内存泄漏
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.delete(chatId);
        const newTypingAIs = new Map(state.typingAIs);
        newTypingAIs.delete(chatId);
        const newDebateStatus = new Map(state.debateStatus);
        newDebateStatus.delete(chatId);
        saveGroupsCache(state.groups.filter(g => g.id !== chatId));

        return {
          groups: state.groups.filter(g => g.id !== chatId),
          currentGroup: state.currentGroup?.id === chatId ? null : state.currentGroup,
          chatStatus: newChatStatus,
          typingAIs: newTypingAIs,
          debateStatus: newDebateStatus
        };
      });
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to delete AI private chat:', error);
      set({ error: error instanceof Error ? error.message : '删除AI私聊失败' });
      throw error;
    }
  },

  startAIPrivateChat: async (chatId: string, topic?: string) => {
    const owner = accountKey();
    try {
      const result = await api.startAIPrivateChat(chatId, topic);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to start AI private chat:', error);
      set({ error: error instanceof Error ? error.message : '启动AI私聊失败' });
      throw error;
    }
  },

  continueAIPrivateChat: async (chatId: string) => {
    const owner = accountKey();
    try {
      const result = await api.continueAIPrivateChat(chatId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to continue AI private chat:', error);
      set({ error: error instanceof Error ? error.message : '继续AI私聊失败' });
      throw error;
    }
  },

  stopAIPrivateChat: async (chatId: string) => {
    const owner = accountKey();
    try {
      const result = await api.stopAIPrivateChat(chatId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(chatId, { isRunning: false, currentSpeaker: null, status: 'stopped' });
        const newTypingAIs = new Map(state.typingAIs);
        newTypingAIs.delete(chatId);
        return { chatStatus: newChatStatus, typingAIs: newTypingAIs };
      });
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to stop AI private chat:', error);
      set({ error: error instanceof Error ? error.message : '停止AI私聊失败' });
      throw error;
    }
  },

  startAutonomousChat: async (groupId: string, topic?: string) => {
    const owner = accountKey();
    try {
      const result = await api.startAutonomousChat(groupId, topic);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(groupId, { isRunning: true, currentSpeaker: null, status: 'running' });
        return { chatStatus: newChatStatus };
      });
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to start autonomous chat:', error);
      set({ error: error instanceof Error ? error.message : '启动自主聊天失败' });
      throw error;
    }
  },

  stopAutonomousChat: async (groupId: string) => {
    const owner = accountKey();
    try {
      const result = await api.stopAutonomousChat(groupId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(groupId, { isRunning: false, currentSpeaker: null, status: 'stopped' });
        const newTypingAIs = new Map(state.typingAIs);
        newTypingAIs.delete(groupId);
        return { chatStatus: newChatStatus, typingAIs: newTypingAIs };
      });
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to stop autonomous chat:', error);
      set({ error: error instanceof Error ? error.message : '停止自主聊天失败' });
      throw error;
    }
  },

  getAutonomousChatStatus: async (groupId: string) => {
    const owner = accountKey();
    try {
      const result = await api.getAutonomousChatStatus(groupId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      return { isRunning: result.active === true, status: result.active ? 'running' : 'stopped', ...result };
    } catch (error) {
      if (owner !== accountKey()) throw error;
      if (!(isAxiosError(error) && error.response?.status === 429)) {
        console.error('Failed to get autonomous chat status:', error);
      }
      set({ error: error instanceof Error ? error.message : '获取聊天状态失败' });
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
    const owner = accountKey();
    try {
      const status = await api.getAIPrivateChatStatus(chatId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      set(state => {
        const newChatStatus = new Map(state.chatStatus);
        newChatStatus.set(chatId, status);
        return { chatStatus: newChatStatus };
      });
      return status;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to fetch chat status:', error);
      set({ error: error instanceof Error ? error.message : '获取聊天状态失败' });
      return { isRunning: false, currentSpeaker: null, status: 'stopped' };
    }
  },

  startFormalDebate: async (groupId: string, topic: string, rolePreferences?: Record<string, string>, debateLevel?: number, selectedParticipants?: string[]) => {
    const owner = accountKey();
    try {
      const result = await api.startFormalDebate(groupId, topic, rolePreferences, debateLevel, selectedParticipants);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
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
      if (owner !== accountKey()) throw error;
      console.error('Failed to start formal debate:', error);
      set({ error: error instanceof Error ? error.message : '启动正式辩论失败' });
      throw error;
    }
  },

  stopFormalDebate: async (groupId: string) => {
    const owner = accountKey();
    try {
      const result = await api.stopFormalDebate(groupId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      set(state => {
        const newDebateStatus = new Map(state.debateStatus);
        newDebateStatus.set(groupId, { isRunning: false, status: 'stopped' });
        return { debateStatus: newDebateStatus };
      });
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to stop formal debate:', error);
      set({ error: error instanceof Error ? error.message : '停止正式辩论失败' });
      throw error;
    }
  },

  getFormalDebateStatus: async (groupId: string) => {
    const owner = accountKey();
    try {
      const status = await api.getFormalDebateStatus(groupId);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      set(state => {
        const newDebateStatus = new Map(state.debateStatus);
        newDebateStatus.set(groupId, status);
        return { debateStatus: newDebateStatus };
      });
      return status;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to get formal debate status:', error);
      set({ error: error instanceof Error ? error.message : '获取辩论状态失败' });
      return { isRunning: false, status: 'stopped' };
    }
  },

  allocateDebateRoles: async (groupId: string, rolePreferences?: Record<string, string>, selectedParticipants?: string[]) => {
    const owner = accountKey();
    try {
      const result = await api.allocateDebateRoles(groupId, rolePreferences, selectedParticipants);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to allocate debate roles:', error);
      set({ error: error instanceof Error ? error.message : '分配辩论角色失败' });
      throw error;
    }
  },

  triggerAudienceComment: async (groupId: string, audienceMembers: string[]) => {
    const owner = accountKey();
    try {
      const result = await api.triggerAudienceComment(groupId, audienceMembers);
      if (owner !== accountKey()) throw new Error('账号已切换，已忽略旧操作结果');
      return result;
    } catch (error) {
      if (owner !== accountKey()) throw error;
      console.error('Failed to trigger audience comment:', error);
      set({ error: error instanceof Error ? error.message : '触发观众评论失败' });
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
    invalidateGroupsRead();
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
      saveGroupsCache(groupsToCache);

      return { groups: updatedGroups, currentGroup: updatedCurrentGroup };
    });
  }
}));
