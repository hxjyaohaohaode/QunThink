import { create } from 'zustand';
import { api } from '../services/api';

export interface UserProfile {
  nickname: string;
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
  fetchProfile: () => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>) => Promise<void>;
}

const defaultProfile: UserProfile = {
  nickname: '',
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

export const useProfileStore = create<ProfileState>((set) => ({
  profile: defaultProfile,
  loading: false,

  fetchProfile: async () => {
    set({ loading: true });
    try {
      const data = await api.getProfile();
      set({ profile: data, loading: false });
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      set({ loading: false });
    }
  },

  updateProfile: async (updates: Partial<UserProfile>) => {
    try {
      const updated = await api.updateProfile(updates);
      set({ profile: updated });
    } catch (error) {
      console.error('Failed to update profile:', error);
      throw error;
    }
  }
}));
