import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DesktopView = 'chat' | 'agents' | 'settings';
export type MobileTab = 'chats' | 'agents' | 'settings';

interface NavigationState {
  sidebarOpen: boolean;
  searchPanelOpen: boolean;
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
  setScrollToMessageId: (id: string | null) => void;
  setTimeFormat: (format: 'relative' | 'full') => void;
  setActiveDesktopView: (view: DesktopView) => void;
  setActiveMobileTab: (tab: MobileTab) => void;
  setIsTransitioning: (v: boolean) => void;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      searchPanelOpen: false,
      scrollToMessageId: null,
      timeFormat: 'relative',
      activeDesktopView: 'chat',
      activeMobileTab: 'chats',
      isTransitioning: false,

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
      setActiveDesktopView: (view) => {
        if (get().activeDesktopView === view) return;
        set({ isTransitioning: true });
        // 短暂延迟后设置新视图，让退出动画先播放
        requestAnimationFrame(() => {
          set({ activeDesktopView: view });
          // 过渡完成后清除标记
          setTimeout(() => set({ isTransitioning: false }), 250);
        });
      },
      setActiveMobileTab: (tab) => {
        if (get().activeMobileTab === tab) return;
        set({ isTransitioning: true });
        requestAnimationFrame(() => {
          set({ activeMobileTab: tab });
          setTimeout(() => set({ isTransitioning: false }), 250);
        });
      },
      setIsTransitioning: (v) => set({ isTransitioning: v }),
    }),
    { name: 'navigation-storage', partialize: (state) => ({ timeFormat: state.timeFormat }) }
  )
);
