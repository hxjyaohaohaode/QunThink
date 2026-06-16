import { create } from 'zustand';
import { api } from '../services/api';
import { loadProfileCache, saveProfileCache, saveProfileCacheAsync } from '../utils/cacheUtils';

export interface UserProfile {
  nickname: string;
  avatar_url?: string;
  gender: string;
  age: number | null;
  height: number | null;
  weight: number | null;
  occupation: string;
  education: string;
  hobbies: string[];
  personality: string[];
  goals: string;
  bio: string;
}

interface ProfileState {
  profile: UserProfile;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  fetchProfile: () => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>) => Promise<void>;
}

const defaultProfile: UserProfile = {
  nickname: '',
  avatar_url: '',
  gender: '',
  age: null,
  height: null,
  weight: null,
  occupation: '',
  education: '',
  hobbies: [],
  personality: [],
  goals: '',
  bio: ''
};

const PROFILE_STALE_TIME_MS = 30 * 1000;
let profileFetchPromise: Promise<void> | null = null;
let lastProfileFetchAt = 0;

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: defaultProfile,
  loading: false,
  initialized: false,
  error: null,

  fetchProfile: async () => {
    const state = get();
    const isFresh = state.initialized && Date.now() - lastProfileFetchAt < PROFILE_STALE_TIME_MS;

    if (isFresh) {
      return;
    }

    if (!state.initialized) {
      const cachedProfile = loadProfileCache<UserProfile>();
      if (cachedProfile) {
        set({ profile: cachedProfile, initialized: true });
      }
    }

    if (profileFetchPromise) {
      return profileFetchPromise;
    }

    profileFetchPromise = (async () => {
      set({ loading: true });
      try {
        const data = await api.getProfile();
        lastProfileFetchAt = Date.now();
        saveProfileCache(data);
        saveProfileCacheAsync(data).catch(() => { });
        set({ profile: data, loading: false, initialized: true });
      } catch (error) {
        console.error('Failed to fetch profile:', error);
        set({ error: error instanceof Error ? error.message : '获取用户信息失败', loading: false, initialized: true });
      } finally {
        profileFetchPromise = null;
      }
    })();

    return profileFetchPromise;
  },

  updateProfile: async (updates: Partial<UserProfile>) => {
    try {
      const updated = await api.updateProfile(updates);
      lastProfileFetchAt = Date.now();
      saveProfileCache(updated);
      saveProfileCacheAsync(updated).catch(() => { });
      set({ profile: updated, initialized: true });
    } catch (error) {
      console.error('Failed to update profile:', error);
      set({ error: error instanceof Error ? error.message : '更新用户信息失败' });
      throw error;
    }
  }
}));
