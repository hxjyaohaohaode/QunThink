import { useProfileStore } from '../../stores/profileStore';
import type { DesktopView } from '../../stores/navigationStore';
import { useNavigationStore } from '../../stores/navigationStore';

const destinations: Array<{ id: DesktopView; label: string; path: string }> = [
  { id: 'workspace', label: '工作台', path: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z' },
  { id: 'chat', label: '聊天', path: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { id: 'agents', label: '智能体', path: 'M12 3v3 M8 3h8 M7 6h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M8 11h1 M15 11h1 M8 16h8' },
  { id: 'settings', label: '设置', path: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6' },
];

export function DesktopNavigation({ active, onNavigate, onProfile }: {
  active: DesktopView; onNavigate: (view: DesktopView) => void; onProfile: () => void;
}) {
  const nickname = useProfileStore(state => state.profile.nickname);
  return <nav aria-label="主导航" data-testid="desktop-navigation" className="desktop-navigation">
    <button className="desktop-brand" title="返回工作台" onClick={() => onNavigate('workspace')}><img src="/favicon.svg" alt="群想" width="32" height="32" /></button>
    <div className="desktop-destinations">
      {destinations.map(item => <button key={item.id} title={item.label} aria-current={active === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.path} /></svg><span>{item.label}</span>
      </button>)}
    </div>
    <div className="desktop-navigation-footer">
      <button title="全局搜索" aria-label="全局搜索" onClick={() => useNavigationStore.getState().setSearchPanelOpen(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button>
      <button title="个人资料" aria-label="个人资料" onClick={onProfile}><span className="desktop-profile-avatar">{nickname?.[0] || '我'}</span></button>
    </div>
  </nav>;
}
