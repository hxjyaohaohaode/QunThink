import { create } from 'zustand';
import { api } from '../services/api';

export interface Group {
  id: string;
  name: string;
  description: string;
  type: 'preset' | 'custom' | 'private';
  is_private?: boolean;
  pinned?: boolean;
  debate_mode: boolean;
  debate_level: number;
  ai_members: string[];
  created_at: string;
}

interface GroupsState {
  groups: Group[];
  currentGroup: Group | null;
  loading: boolean;
  error: string | null;
  fetchGroups: () => Promise<void>;
  selectGroup: (groupId: string) => void;
  createGroup: (name: string, description: string, aiMembers?: string[]) => Promise<Group>;
  deleteGroup: (groupId: string) => Promise<void>;
  pinGroup: (groupId: string, pinned: boolean) => Promise<void>;
  getOrCreatePrivateChat: (aiId: string) => Promise<Group>;
  toggleDebateMode: (groupId: string) => Promise<void>;
  setDebateLevel: (groupId: string, level: number) => Promise<void>;
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: [],
  currentGroup: null,
  loading: false,
  error: null,

  fetchGroups: async () => {
    set({ loading: true, error: null });
    try {
      const groups = await api.getGroups();
      
      set(state => {
        const currentGroupId = state.currentGroup?.id;
        const updatedCurrentGroup = currentGroupId 
          ? groups.find((g: Group) => g.id === currentGroupId) || state.currentGroup
          : groups.length > 0 ? groups[0] : null;
        
        return { 
          groups, 
          currentGroup: updatedCurrentGroup,
          loading: false 
        };
      });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  selectGroup: (groupId: string) => {
    const group = get().groups.find(g => g.id === groupId);
    if (group) {
      set({ currentGroup: group });
    }
  },

  createGroup: async (name: string, description: string, aiMembers?: string[]) => {
    try {
      const newGroup = await api.createGroup(name, description, aiMembers);
      
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
      
      // 清除 localStorage 中该群聊的消息缓存
      localStorage.removeItem(`messages_${groupId}`);
      
      // 同时清除全局消息缓存中该群聊的数据
      const cachedMessages = localStorage.getItem('messages_cache');
      if (cachedMessages) {
        try {
          const parsed = JSON.parse(cachedMessages);
          delete parsed[groupId];
          localStorage.setItem('messages_cache', JSON.stringify(parsed));
        } catch (e) {
          console.error('Failed to update messages cache:', e);
        }
      }
      
      set(state => {
        const newGroups = state.groups.filter(g => g.id !== groupId);
        const newCurrentGroup = state.currentGroup?.id === groupId 
          ? (newGroups.length > 0 ? newGroups[0] : null)
          : state.currentGroup;
        
        return {
          groups: newGroups,
          currentGroup: newCurrentGroup
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
  }
}));