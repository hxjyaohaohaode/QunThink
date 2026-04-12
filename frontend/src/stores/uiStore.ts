import { create } from 'zustand';

interface TypingState {
  [groupId: string]: {
    [aiId: string]: boolean;
  };
}

interface UIState {
  sidebarOpen: boolean;
  typingIndicators: TypingState;
  replyingTo: string | null;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setTyping: (groupId: string, aiId: string, isTyping: boolean) => void;
  setReplyingTo: (messageId: string | null) => void;
  clearAllTypingForGroup: (groupId: string) => void;
}

const typingTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};

function getTypingTimeoutKey(groupId: string, aiId: string): string {
  return `${groupId}_${aiId}`;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  typingIndicators: {},
  replyingTo: null,

  toggleSidebar: () => {
    set(state => ({ sidebarOpen: !state.sidebarOpen }));
  },

  setSidebarOpen: (open: boolean) => {
    set({ sidebarOpen: open });
  },

  setTyping: (groupId: string, aiId: string, isTyping: boolean) => {
    const key = getTypingTimeoutKey(groupId, aiId);

    if (typingTimeouts[key]) {
      clearTimeout(typingTimeouts[key]);
      delete typingTimeouts[key];
    }

    if (isTyping) {
      typingTimeouts[key] = setTimeout(() => {
        set(state => ({
          typingIndicators: {
            ...state.typingIndicators,
            [groupId]: {
              ...state.typingIndicators[groupId],
              [aiId]: false
            }
          }
        }));
        delete typingTimeouts[key];
      }, 30000);
    }

    set(state => ({
      typingIndicators: {
        ...state.typingIndicators,
        [groupId]: {
          ...state.typingIndicators[groupId],
          [aiId]: isTyping
        }
      }
    }));
  },

  setReplyingTo: (messageId: string | null) => {
    set({ replyingTo: messageId });
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
  }
}));
