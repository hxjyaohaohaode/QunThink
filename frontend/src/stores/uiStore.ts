import { create } from 'zustand';
import { useThemeStore, Theme } from './themeStore';

export { useThemeStore } from './themeStore';
export type { Theme } from './themeStore';
export { useNavigationStore } from './navigationStore';

interface TypingState {
  [groupId: string]: {
    [aiId: string]: boolean;
  };
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface UIState {
  sidebarWidth: number;
  typingIndicators: TypingState;
  replyingTo: string[];
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  effectiveTheme: 'light' | 'dark';
  setSidebarWidth: (width: number) => void;
  setTyping: (groupId: string, aiId: string, isTyping: boolean) => void;
  setReplyingTo: (messageIds: string[]) => void;
  addReplyingTo: (messageId: string) => void;
  removeReplyingTo: (messageId: string) => void;
  clearReplyingTo: () => void;
  clearAllTypingForGroup: (groupId: string) => void;
  clearAllTypingTimeouts: () => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setConnectionError: (error: string | null) => void;
  applyTheme: () => void;
  setEffectiveTheme: (theme: 'light' | 'dark') => void;
}

const typingTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};
const TYPING_TIMEOUT_MAX_KEYS = 200;

function getTypingTimeoutKey(groupId: string, aiId: string): string {
  return `${groupId}_${aiId}`;
}

function cleanupOldestTypingTimeout() {
  const keys = Object.keys(typingTimeouts);
  if (keys.length > TYPING_TIMEOUT_MAX_KEYS) {
    const oldestKey = keys[0];
    clearTimeout(typingTimeouts[oldestKey]);
    delete typingTimeouts[oldestKey];
  }
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function computeEffectiveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? getSystemTheme() : theme;
}

export const useUIStore = create<UIState>()(
    (set, get) => ({
      sidebarWidth: 256,
      typingIndicators: {},
      replyingTo: [],
      connectionStatus: 'disconnected',
      connectionError: null,
      effectiveTheme: computeEffectiveTheme(useThemeStore.getState().theme),

      setSidebarWidth: (width: number) => {
        set({ sidebarWidth: width });
      },

      setConnectionStatus: (status: ConnectionStatus) => {
        if (status === 'connected') {
          set({ connectionStatus: status, connectionError: null });
        } else {
          set({ connectionStatus: status });
        }
      },

      setConnectionError: (error: string | null) => {
        set({ connectionError: error });
      },

      setTyping: (groupId: string, aiId: string, isTyping: boolean) => {
        const key = getTypingTimeoutKey(groupId, aiId);

        if (typingTimeouts[key]) {
          clearTimeout(typingTimeouts[key]);
          delete typingTimeouts[key];
        }

        cleanupOldestTypingTimeout();

        set(state => {
          if (state.typingIndicators[groupId]?.[aiId] === isTyping) {
            return state;
          }
          return {
            typingIndicators: {
              ...state.typingIndicators,
              [groupId]: {
                ...state.typingIndicators[groupId],
                [aiId]: isTyping
              }
            }
          };
        });

        if (isTyping) {
          typingTimeouts[key] = setTimeout(() => {
            set(state => {
              if (state.typingIndicators[groupId]?.[aiId] === false) {
                return state;
              }
              return {
                typingIndicators: {
                  ...state.typingIndicators,
                  [groupId]: {
                    ...state.typingIndicators[groupId],
                    [aiId]: false
                  }
                }
              };
            });
            delete typingTimeouts[key];
          }, 30000);
        }
      },

      setReplyingTo: (messageIds: string[]) => {
        set({ replyingTo: messageIds });
      },

      addReplyingTo: (messageId: string) => {
        set(state => ({
          replyingTo: state.replyingTo.includes(messageId)
            ? state.replyingTo
            : [...state.replyingTo, messageId]
        }));
      },

      removeReplyingTo: (messageId: string) => {
        set(state => ({
          replyingTo: state.replyingTo.filter(id => id !== messageId)
        }));
      },

      clearReplyingTo: () => {
        set({ replyingTo: [] });
      },

      clearAllTypingForGroup: (groupId: string) => {
        Object.keys(typingTimeouts).forEach(key => {
          if (key.startsWith(`${groupId}_`)) {
            clearTimeout(typingTimeouts[key]);
            delete typingTimeouts[key];
          }
        });

        set(state => {
          const newTypingIndicators = { ...state.typingIndicators };
          if (newTypingIndicators[groupId]) {
            const clearedGroup: Record<string, boolean> = {};
            Object.keys(newTypingIndicators[groupId]).forEach(aiId => {
              clearedGroup[aiId] = false;
            });
            newTypingIndicators[groupId] = clearedGroup;
          }
          return { typingIndicators: newTypingIndicators };
        });
      },

      clearAllTypingTimeouts: () => {
        Object.values(typingTimeouts).forEach(timeout => clearTimeout(timeout));
        Object.keys(typingTimeouts).forEach(key => delete typingTimeouts[key]);
        set({ typingIndicators: {} });
      },

      applyTheme: () => {
        const { effectiveTheme } = get();
        if (typeof document !== 'undefined') {
          const root = document.documentElement;
          root.setAttribute('data-theme-transition', 'true');
          if (effectiveTheme === 'dark') {
            root.classList.add('dark');
          } else {
            root.classList.remove('dark');
          }
          requestAnimationFrame(() => {
            setTimeout(() => {
              root.removeAttribute('data-theme-transition');
            }, 300);
          });
        }
      },

      setEffectiveTheme: (theme: 'light' | 'dark') => {
        set({ effectiveTheme: theme });
        get().applyTheme();
      },
    })
);

useThemeStore.subscribe((state) => {
  const effectiveTheme = computeEffectiveTheme(state.theme);
  useUIStore.getState().setEffectiveTheme(effectiveTheme);
});

if (typeof window !== 'undefined') {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    const themeState = useThemeStore.getState();
    if (themeState.theme === 'system') {
      const newEffectiveTheme = getSystemTheme();
      useUIStore.getState().setEffectiveTheme(newEffectiveTheme);
    }
  });
}
