import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface NavigationState {
  sidebarOpen: boolean;
  searchPanelOpen: boolean;
  scrollToMessageId: string | null;
  timeFormat: 'relative' | 'full';
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSearchPanelOpen: (open: boolean) => void;
  setScrollToMessageId: (id: string | null) => void;
  setTimeFormat: (format: 'relative' | 'full') => void;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      searchPanelOpen: false,
      scrollToMessageId: null,
      timeFormat: 'relative',
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSearchPanelOpen: (open) => set({ searchPanelOpen: open }),
      setScrollToMessageId: (id: string | null) => {
        set({ scrollToMessageId: id });
        if (id) {
          setTimeout(() => {
            const current = get().scrollToMessageId;
            if (current === id) {
              set({ scrollToMessageId: null });
            }
          }, 15000);
        }
      },
      setTimeFormat: (format) => set({ timeFormat: format }),
    }),
    { name: 'navigation-storage', partialize: (state) => ({ timeFormat: state.timeFormat }) }
  )
);
