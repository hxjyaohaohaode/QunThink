type MobileTab = 'workspace' | 'chats' | 'agents' | 'settings';
type MobileView = 'main' | 'groupInfo' | 'chat' | 'agents' | 'agentChat';
export type MobileRoute = 'workspace' | 'chats' | 'settings' | 'agents' | 'agentChat' | 'chat' | 'groupInfo';

// One route must own the mobile surface, including the render before a tab's
// view-reset effect runs. AnimatePresence's wait mode requires a single child.
export function resolveMobileRoute(tab: MobileTab, view: MobileView, hasGroup: boolean, hasAgent: boolean): MobileRoute {
  if (tab === 'workspace') return 'workspace';
  if (tab === 'settings') return 'settings';
  if (tab === 'agents') return view === 'agentChat' && hasAgent ? 'agentChat' : 'agents';
  if (view === 'groupInfo' && hasGroup) return 'groupInfo';
  if (view === 'chat' && hasGroup) return 'chat';
  return 'chats';
}

export function mobileRouteKey(route: MobileRoute, groupId?: string): string {
  if (route === 'chat') return `mobile-chat-${groupId}`;
  return {
    workspace: 'mobile-workspace', chats: 'mobile-chat-list', settings: 'mobile-settings',
    agents: 'mobile-agents', agentChat: 'mobile-agent-chat', groupInfo: 'mobile-group-info',
  }[route];
}
