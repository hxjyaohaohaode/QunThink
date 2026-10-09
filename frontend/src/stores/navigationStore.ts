import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DesktopView = 'workspace' | 'chat' | 'agents' | 'settings';
export type MobileTab = 'workspace' | 'chats' | 'agents' | 'settings';

interface NavigationState {
  sidebarOpen: boolean;
  searchPanelOpen: boolean;
  /** 全局命令面板（Ctrl+K） */
  commandPaletteOpen: boolean;
  scrollToMessageId: string | null;
  timeFormat: 'relative' | 'full';
  /** 当前桌面端活动视图 */
  activeDesktopView: DesktopView;
  /** 当前移动端底部标签 */
  activeMobileTab: MobileTab;
  /** 视图切换过渡中标记，防止快速切换导致布局跳动 */
  isTransitioning: boolean;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSearchPanelOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setScrollToMessageId: (id: string | null) => void;
  setTimeFormat: (format: 'relative' | 'full') => void;
  setActiveDesktopView: (view: DesktopView) => void;
  setActiveMobileTab: (tab: MobileTab) => void;
  setIsTransitioning: (v: boolean) => void;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => {
      const transitions = new Map<'desktop' | 'mobile', symbol>();
      const transitionTo = (surface: 'desktop' | 'mobile', commit: () => void) => {
        const intent = Symbol(surface);
        transitions.set(surface, intent);
        // Commit with the caller's local view state. Framer Motion owns the
        // visual exit; a deferred store write can resurrect an older intent.
        commit();
        set({ isTransitioning: true });
        setTimeout(() => {
          if (transitions.get(surface) !== intent) return;
          transitions.delete(surface);
          set({ isTransitioning: transitions.size > 0 });
        }, 250);
      };
      return {
      sidebarOpen: true,
      searchPanelOpen: false,
      commandPaletteOpen: false,
      scrollToMessageId: null,
      timeFormat: 'relative',
      activeDesktopView: 'workspace',
      activeMobileTab: 'workspace',
      isTransitioning: false,

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSearchPanelOpen: (open) => set({ searchPanelOpen: open }),
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
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
      setActiveDesktopView: (view) => {
        if (get().activeDesktopView === view) return;
        transitionTo('desktop', () => set({ activeDesktopView: view }));
      },
      setActiveMobileTab: (tab) => {
        if (get().activeMobileTab === tab) return;
        transitionTo('mobile', () => set({ activeMobileTab: tab }));
      },
      setIsTransitioning: (v) => set({ isTransitioning: v }),
      };
    },
    { name: 'navigation-storage', partialize: (state) => ({ timeFormat: state.timeFormat }) }
  )
);
