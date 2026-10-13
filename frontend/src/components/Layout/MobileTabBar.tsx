import { motion } from 'framer-motion';
import { useReducedMotion } from '../../hooks/useReducedMotion';

type TabType = 'workspace' | 'chats' | 'agents' | 'settings';
interface MobileTabBarProps { activeTab: TabType; onTabChange: (tab: TabType) => void; unreadCount?: number; }
const tabs: { id: TabType; name: string; path: string }[] = [
  { id: 'workspace', name: '工作台', path: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z' },
  { id: 'chats', name: '聊天', path: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { id: 'agents', name: '智能体', path: 'M12 3v3 M8 3h8 M7 6h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M8 11h1 M15 11h1 M8 16h8' },
  { id: 'settings', name: '设置', path: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6' },
];
export function MobileTabBar({ activeTab, onTabChange, unreadCount = 0 }: MobileTabBarProps) {
  const reduced = useReducedMotion();
  return <nav aria-label="主导航" data-testid="mobile-navigation" className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-bg-surface border-t border-border/40" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
    <div className="grid grid-cols-4 gap-1 px-2 py-1">
      {tabs.map(tab => <button key={tab.id} aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => onTabChange(tab.id)} className={`relative isolate min-h-12 flex flex-col items-center justify-center gap-1 rounded-xl ${activeTab === tab.id ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}>
        {activeTab === tab.id && <motion.span layoutId="mobile-navigation-selection" className="absolute inset-0 -z-10 rounded-xl bg-accent/10" transition={{ duration: reduced ? 0 : 0.22 }} />}
        <span className="relative"><svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tab.path} /></svg>
          {tab.id === 'chats' && unreadCount > 0 && <span className="absolute -top-1 -right-3 min-w-4 px-1 h-4 bg-red-500 rounded-full text-[9px] text-white flex items-center justify-center" aria-label={unreadCount + ' 条未读'}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </span><span className="text-[11px] font-medium">{tab.name}</span>
      </button>)}
    </div>
  </nav>;
}
