import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MessageTTSAudio } from '../types';

interface AudioStore {
  playingAudios: Record<string, { isPlaying: boolean; currentTime: number; duration: number }>;
  currentAudioId: string | null;
  ttsAudios: Record<string, MessageTTSAudio>;
  ttsLoadingStates: Record<string, boolean>;
  setAudioPlaying: (messageId: string, isPlaying: boolean) => void;
  setAudioTime: (messageId: string, currentTime: number, duration: number) => void;
  setCurrentAudioId: (messageId: string | null) => void;
  clearAudio: (messageId: string) => void;
  stopAll: () => void;
  setTTSLoading: (messageId: string, isLoading: boolean) => void;
  setTTSAudio: (messageId: string, audio: MessageTTSAudio) => void;
  removeTTSAudio: (messageId: string) => void;
  getTTSAudio: (messageId: string) => MessageTTSAudio | undefined;
  isTTSLoading: (messageId: string) => boolean;
}

const TTS_STORAGE_KEY = 'tts-audios-store';

export const useAudioStore = create<AudioStore>()(
  persist(
    (set, get) => ({
      playingAudios: {},
      currentAudioId: null,
      ttsAudios: {},
      ttsLoadingStates: {},

      setAudioPlaying: (messageId: string, isPlaying: boolean) => {
        set(state => {
          const newAudios = { ...state.playingAudios };
          if (isPlaying) {
            newAudios[messageId] = {
              isPlaying: true,
              currentTime: newAudios[messageId]?.currentTime || 0,
              duration: newAudios[messageId]?.duration || 0
            };
          } else {
            if (newAudios[messageId]) {
              newAudios[messageId] = { ...newAudios[messageId], isPlaying: false };
            }
          }
          return { playingAudios: newAudios, currentAudioId: isPlaying ? messageId : (state.currentAudioId === messageId ? null : state.currentAudioId) };
        });
      },

      setAudioTime: (messageId: string, currentTime: number, duration: number) => {
        set(state => ({
          playingAudios: {
            ...state.playingAudios,
            [messageId]: {
              isPlaying: state.playingAudios[messageId]?.isPlaying || false,
              currentTime,
              duration
            }
          }
        }));
      },

      setCurrentAudioId: (messageId: string | null) => {
        set({ currentAudioId: messageId });
      },

      clearAudio: (messageId: string) => {
        set(state => {
          const newAudios = { ...state.playingAudios };
          delete newAudios[messageId];
          return {
            playingAudios: newAudios,
            currentAudioId: state.currentAudioId === messageId ? null : state.currentAudioId
          };
        });
      },

      stopAll: () => {
        set({ playingAudios: {}, currentAudioId: null });
      },

      setTTSLoading: (messageId: string, isLoading: boolean) => {
        set(state => ({
          ttsLoadingStates: {
            ...state.ttsLoadingStates,
            [messageId]: isLoading
          }
        }));
      },

      setTTSAudio: (messageId: string, audio: MessageTTSAudio) => {
        set(state => ({
          ttsAudios: {
            ...state.ttsAudios,
            [messageId]: audio
          },
          ttsLoadingStates: {
            ...state.ttsLoadingStates,
            [messageId]: false
          }
        }));
      },

      removeTTSAudio: (messageId: string) => {
        set(state => {
          const newTtsAudios = { ...state.ttsAudios };
          delete newTtsAudios[messageId];
          const newLoadingStates = { ...state.ttsLoadingStates };
          delete newLoadingStates[messageId];
          const newPlayingAudios = { ...state.playingAudios };
          delete newPlayingAudios[messageId];
          return {
            ttsAudios: newTtsAudios,
            ttsLoadingStates: newLoadingStates,
            playingAudios: newPlayingAudios,
            currentAudioId: state.currentAudioId === messageId ? null : state.currentAudioId
          };
        });
      },

      getTTSAudio: (messageId: string) => {
        return get().ttsAudios[messageId];
      },

      isTTSLoading: (messageId: string) => {
        return get().ttsLoadingStates[messageId] || false;
      }
    }),
    {
      name: TTS_STORAGE_KEY,
      partialize: (state) => ({
        ttsAudios: state.ttsAudios
      })
    }
  )
);
