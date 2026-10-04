import { create } from 'zustand';
import { api } from '../services/api';
import { loadProfileCache, saveProfileCache, getCacheUserId } from '../utils/cacheUtils';

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
  cleanup: () => void;
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
let profileEpoch = 0;
let fetchSequence = 0;
let updateInFlight = false;

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: defaultProfile,
  loading: false,
  initialized: false,
  error: null,

  cleanup: () => {
    profileEpoch++; fetchSequence++; profileFetchPromise = null; lastProfileFetchAt = 0; updateInFlight = false;
    set({ profile: { ...defaultProfile, hobbies: [], personality: [] }, loading: false, initialized: false, error: null });
  },

  fetchProfile: async () => {
    const userId = getCacheUserId(), epoch = profileEpoch;
    const stillCurrent = () => epoch === profileEpoch && userId === getCacheUserId();
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

    const sequence = ++fetchSequence;
    const work = (async () => {
      set({ loading: true });
      try {
        const data = await api.getProfile();
        if (!stillCurrent() || sequence !== fetchSequence) return;
        lastProfileFetchAt = Date.now();
        saveProfileCache(data);
        set({ profile: data, loading: false, initialized: true });
      } catch (error) {
        if (!stillCurrent() || sequence !== fetchSequence) return;
        set({ error: error instanceof Error ? error.message : '获取用户信息失败', loading: false, initialized: true });
      } finally {
        if (stillCurrent() && sequence === fetchSequence) profileFetchPromise = null;
      }
    })();
    profileFetchPromise = work;
    return work;
  },

  updateProfile: async (updates: Partial<UserProfile>) => {
    if (updateInFlight) throw new Error('资料正在保存，请等待当前操作完成');
    updateInFlight = true;
    const userId = getCacheUserId(), epoch = profileEpoch;
    const stillCurrent = () => epoch === profileEpoch && userId === getCacheUserId();
    fetchSequence++; profileFetchPromise = null;
    try {
      const updated = await api.updateProfile(updates);
      if (!stillCurrent()) throw new Error('账号已切换，已丢弃旧账号的资料响应');
      // Invalidate reads started while this write was awaiting its receipt too.
      fetchSequence++; profileFetchPromise = null;
      lastProfileFetchAt = Date.now();
      saveProfileCache(updated);
      set({ profile: updated, initialized: true, loading: false, error: null });
    } catch (error) {
      if (stillCurrent()) set({ error: error instanceof Error ? error.message : '更新用户信息失败', loading: false });
      throw error;
    } finally { if (stillCurrent()) updateInFlight = false; }
  }
}));
