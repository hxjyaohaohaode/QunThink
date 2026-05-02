import { useEffect, useLayoutEffect, useState, useRef, useCallback, type TouchEvent as ReactTouchEvent } from 'react';
import type { Group } from './types';
import { useGroupsStore } from './stores/groupsStore';
import { useUIStore } from './stores/uiStore';
import { useProfileStore, type UserProfile } from './stores/profileStore';
import { ensurePersonasAutoRefresh, usePersonasStore, type PersonaConfig } from './stores/personasStore';
import { useMessagesStoreInternal, resetMessagesModuleState } from './stores/messagesStore';
import { useAgentsStore } from './stores/agentsStore';
import { connectWebSocket, destroyWebSocket, joinGroup, leaveGroup } from './services/websocket';
import { Sidebar } from './components/Layout/Sidebar';
import { MobileTabBar } from './components/Layout/MobileTabBar';
import { ChatList } from './components/Layout/ChatList';
import { SettingsPage } from './components/Layout/SettingsPage';
import { NewChatModal } from './components/Layout/NewChatModal';
import { AgentsPage } from './components/Layout/AgentsPage';
import { AgentCreateModal } from './components/Layout/AgentCreateModal';
import { AgentChatView } from './components/Layout/AgentChatView';
import { ConnectionStatus } from './components/Layout/ConnectionStatus';
import { SplashScreen } from './components/Layout/SplashScreen';
import { LoginPage } from './components/Layout/LoginPage';
import { ChatHeader, MessageList, MessageInput } from './components/Chat';
import { ObserverControlPanel } from './components/Chat/ObserverControlPanel';
import { GroupInfoPage } from './components/Chat/GroupInfoPage';
import { ErrorBoundary } from './components/Common/ErrorBoundary';
import { PWAInstallPrompt } from './components/Common/PWAInstallPrompt';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSwipeBack } from './components/Common/SwipeTransition';
import { api, getDevUserId, onAuthExpired } from './services/api';
import { initFontSize } from './stores/fontSizeStore';
import { setCacheUserId, getCacheUserId, clearAllCachesForUser, saveGroupsCache, saveGroupsCacheAsync, savePersonasCache, savePersonasCacheAsync, saveProfileCache, saveProfileCacheAsync } from './utils/cacheUtils';
import { setIndexedDBUserId, clearAllIndexedDBForUser } from './utils/indexedDB';

type MobileTab = 'chats' | 'agents' | 'settings';
type MobileView = 'main' | 'groupInfo' | 'chat' | 'agents' | 'agentChat';
type AppPhase = 'splash' | 'auth' | 'app';

type BootstrapPayload = {
  user?: { id?: string };
  groups?: Group[];
  profile?: UserProfile;
  personas?: Record<string, PersonaConfig>;
};

const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || 'session';
const SESSION_PERSIST_KEY = 'app_session_persist';

function persistSessionInfo(userId: string) {
  try {
    localStorage.setItem(SESSION_PERSIST_KEY, JSON.stringify({
      userId,
      timestamp: Date.now()
    }));
  } catch {}
}

function clearPersistedSessionInfo() {
  try {
    localStorage.removeItem(SESSION_PERSIST_KEY);
  } catch {}
}

function getPersistedSessionInfo(): { userId: string; timestamp: number } | null {
  try {
    const raw = localStorage.getItem(SESSION_PERSIST_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - data.timestamp > maxAge) {
      localStorage.removeItem(SESSION_PERSIST_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function isAuthFailure(error: unknown) {
  const status = (error as any)?.response?.status;
  return status === 401 || status === 403;
}

const defaultProfileState: UserProfile = {
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

function hydrateBootstrapData(userId: string, payload: BootstrapPayload) {
  setCacheUserId(userId);
  setIndexedDBUserId(userId);

  const groups = payload.groups || [];
  const profile = payload.profile || defaultProfileState;
  const personas = payload.personas || {};
  const currentGroupId = useGroupsStore.getState().currentGroup?.id;
  const currentGroup = currentGroupId ? groups.find(group => group.id === currentGroupId) || null : null;

  useGroupsStore.setState({
    groups,
    currentGroup,
    loading: false,
    initialized: true,
    error: null
  });

  useProfileStore.setState({
    profile,
    loading: false,
    initialized: true
  });

  usePersonasStore.setState({
    personas,
    loading: false
  });

  ensurePersonasAutoRefresh();
  saveGroupsCache(groups);
  saveGroupsCacheAsync(groups).catch(() => {});
  saveProfileCache(profile);
  saveProfileCacheAsync(profile).catch(() => {});
  savePersonasCache(personas);
  savePersonasCacheAsync(personas).catch(() => {});
}

async function initializeUserData(userId: string) {
  try {
    const payload = await api.getBootstrap();
    const resolvedUserId = payload.user?.id || userId;
    hydrateBootstrapData(resolvedUserId, payload);
  } catch (bootstrapError) {
    if (AUTH_MODE === 'session' && isAuthFailure(bootstrapError)) {
      throw bootstrapError;
    }

    const { fetchGroups } = useGroupsStore.getState();
    const { fetchProfile } = useProfileStore.getState();
    const { fetchPersonas } = usePersonasStore.getState();

    try {
      await Promise.all([
        fetchGroups(),
        fetchProfile(),
        fetchPersonas()
      ]);
    } catch (error) {
      console.error('[App] Failed to initialize user data:', error);
      throw error;
    }

    if (AUTH_MODE === 'session') {
      throw bootstrapError;
    }

    console.warn('[App] Bootstrap endpoint failed, fallback stores used:', bootstrapError);
  }

  if (import.meta.env.DEV) {
    console.log(`[App] User data initialized for: ${userId}`);
  }
}

async function handleLogout() {
  const cachedUserId = getCacheUserId();

  destroyWebSocket();

  useUIStore.getState().clearAllTypingTimeouts();

  try {
    await api.logout();
  } catch {}

  clearPersistedSessionInfo();

  if (cachedUserId) {
    clearAllCachesForUser(cachedUserId);
    await clearAllIndexedDBForUser(cachedUserId);
  }

  try {
    if (cachedUserId) {
      localStorage.removeItem(`ws_last_msg_ts_${cachedUserId}`);
    }
  } catch {}

  useGroupsStore.setState({
    groups: [],
    currentGroup: null,
    loading: false,
    initialized: false,
    chatStatus: new Map(),
    typingAIs: new Map(),
    debateStatus: new Map()
  });

  usePersonasStore.setState({
    personas: {},
    loading: false
  });

  resetMessagesModuleState();

  useMessagesStoreInternal.setState({
    messages: {},
    pagination: {},
    loading: false,
    sending: false,
    error: null
  });

  useProfileStore.setState({
    profile: {
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
    },
    loading: false,
    initialized: false
  });

  useAgentsStore.setState({
    agents: [],
    currentAgent: null,
    agentMessages: new Map(),
    loading: false,
    error: null,
    creatingAgent: false
  });

  setCacheUserId(null);
  setIndexedDBUserId(null);

  if (import.meta.env.DEV) {
    console.log('[App] User logged out, caches cleared');
  }
}

function App() {
  const { currentGroup } = useGroupsStore();
  const { applyTheme } = useUIStore();
  useKeyboardShortcuts();

  const [mobileTab, setMobileTab] = useState<MobileTab>('chats');
  const [mobileView, setMobileView] = useState<MobileView>('main');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [appPhase, setAppPhase] = useState<AppPhase>('splash');

  const prevViewRef = useRef<MobileView>('main');
  const splashCompletedRef = useRef(false);
  const isAuthenticatedRef = useRef<boolean | null>(null);
  const wsConnectedRef = useRef(false);
  const mobileViewRef = useRef(mobileView);
  const dataInitializedRef = useRef(false);
  mobileViewRef.current = mobileView;

  isAuthenticatedRef.current = isAuthenticated;

  useEffect(() => {
    let cancelled = false;

    const bootstrapSession = async () => {
      try {
        const authStatus = await api.getAuthStatus();
        if (cancelled) return;

        if (authStatus?.enabled === false) {
          const devUserId = getDevUserId();
          await initializeUserData(devUserId);
          if (!cancelled) {
            dataInitializedRef.current = true;
            setIsAuthenticated(true);
          }
          return;
        }

        if (authStatus?.valid !== true) {
          if (!cancelled) {
            dataInitializedRef.current = false;
            setIsAuthenticated(false);
          }
          return;
        }

        const currentUser = await api.getCurrentUser();
        const userId = currentUser?.user?.id || getCacheUserId() || getPersistedSessionInfo()?.userId;
        if (!userId) {
          if (!cancelled) {
            dataInitializedRef.current = false;
            setIsAuthenticated(false);
          }
          return;
        }

        await initializeUserData(userId);
        persistSessionInfo(userId);
        if (!cancelled) {
          dataInitializedRef.current = true;
          setIsAuthenticated(true);
        }
      } catch (error) {
        console.warn('[App] Session bootstrap failed:', error);
        if (!cancelled) {
          dataInitializedRef.current = false;
          setIsAuthenticated(false);
        }
      }
    };

    bootstrapSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated === true) {
      if (!wsConnectedRef.current) {
        wsConnectedRef.current = true;
        connectWebSocket();
      }
    } else if (isAuthenticated === false) {
      wsConnectedRef.current = false;
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated === false && appPhase !== 'auth') {
      setAppPhase('auth');
    } else if (isAuthenticated === true && appPhase !== 'app') {
      if (splashCompletedRef.current || appPhase === 'auth') {
        splashCompletedRef.current = true;
        setAppPhase('app');
      }
    }
  }, [isAuthenticated, appPhase]);

  useEffect(() => {
    const unsubscribe = onAuthExpired(async () => {
      await handleLogout();
      wsConnectedRef.current = false;
      dataInitializedRef.current = false;
      setIsAuthenticated(false);
    });
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    applyTheme();
    initFontSize();
  }, [applyTheme]);

  const currentGroupRef = useRef(currentGroup);
  currentGroupRef.current = currentGroup;

  useEffect(() => {
    return () => {
      leaveGroup(currentGroupRef.current?.id || '');
    };
  }, []);

  const navigateToView = useCallback((view: MobileView) => {
    prevViewRef.current = mobileViewRef.current;
    setMobileView(view);
  }, []);

  const handleMobileSelectGroup = useCallback((groupId: string) => {
    const { selectGroup } = useGroupsStore.getState();
    selectGroup(groupId);
    joinGroup(groupId);
    navigateToView('chat');
  }, [navigateToView]);

  const handleMobileBack = useCallback(() => {
    if (mobileView === 'groupInfo') {
      navigateToView('chat');
    } else if (mobileView === 'agentChat') {
      navigateToView('agents');
    } else if (mobileView === 'agents') {
      setMobileTab('chats');
      navigateToView('main');
    } else {
      const { selectGroup } = useGroupsStore.getState();
      selectGroup('');
      navigateToView('main');
    }
  }, [mobileView, navigateToView]);

  const handleTabChange = useCallback((tab: MobileTab) => {
    setMobileTab(tab);
    if (tab === 'chats') {
      const { selectGroup } = useGroupsStore.getState();
      selectGroup('');
      navigateToView('main');
    } else if (tab === 'agents') {
      navigateToView('agents');
    } else {
      navigateToView('main');
    }
  }, [navigateToView]);

  const shouldEnableSwipe = mobileView !== 'main' || mobileTab !== 'chats';
  const { handlers: swipeHandlers, swipeProgress } = useSwipeBack(handleMobileBack, { threshold: 80, enabled: shouldEnableSwipe });

  const handleSplashComplete = useCallback(() => {
    if (splashCompletedRef.current) return;
    splashCompletedRef.current = true;
    const authState = isAuthenticatedRef.current;
    if (authState === false) {
      setAppPhase('auth');
    } else if (authState === true) {
      setAppPhase('app');
    } else {
      setAppPhase('auth');
    }
  }, []);

  const handleLoginSuccess = useCallback(async () => {
    try {
      const response = await api.getBootstrap();
      const userId = response.user?.id;
      if (!userId) {
        throw new Error('登录后未获取到用户信息');
      }
      dataInitializedRef.current = true;
      hydrateBootstrapData(userId, response);
      persistSessionInfo(userId);
      splashCompletedRef.current = true;
      setIsAuthenticated(true);
      setAppPhase('app');
    } catch (error) {
      console.error('Failed to get user info after login:', error);
      dataInitializedRef.current = false;
      setIsAuthenticated(false);
      throw error;
    }
  }, []);

  if (appPhase === 'splash') {
    return (
      <ErrorBoundary>
        <SplashScreen onComplete={handleSplashComplete} />
      </ErrorBoundary>
    );
  }

  if (appPhase === 'auth') {
    return (
      <ErrorBoundary>
        <LoginPage
          onLoginSuccess={handleLoginSuccess}
        />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppContent
        mobileTab={mobileTab}
        mobileView={mobileView}
        navigateToView={navigateToView}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        currentGroup={currentGroup}
        handleMobileSelectGroup={handleMobileSelectGroup}
        handleMobileBack={handleMobileBack}
        handleTabChange={handleTabChange}
        swipeHandlers={swipeHandlers}
        swipeProgress={swipeProgress}
      />
      <PWAInstallPrompt />
    </ErrorBoundary>
  );
}

type AppContentProps = {
  mobileTab: MobileTab;
  mobileView: MobileView;
  navigateToView: (view: MobileView) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  currentGroup: Group | null;
  handleMobileSelectGroup: (id: string) => void;
  handleMobileBack: () => void;
  handleTabChange: (tab: MobileTab) => void;
  swipeHandlers: Record<string, ((e: ReactTouchEvent) => void) | undefined>;
  swipeProgress: number;
};

function AppContent({
  mobileTab,
  mobileView,
  navigateToView,
  sidebarCollapsed,
  setSidebarCollapsed,
  currentGroup,
  handleMobileSelectGroup,
  handleMobileBack,
  handleTabChange,
  swipeHandlers,
  swipeProgress,
}: AppContentProps) {
  const [showAgents, setShowAgents] = useState(false);
  const [showAgentCreate, setShowAgentCreate] = useState(false);
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('action');
    if (!action) return;

    const cleanUrl = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('action');
      url.searchParams.delete('title');
      url.searchParams.delete('text');
      url.searchParams.delete('url');
      window.history.replaceState({}, '', url.pathname + url.hash);
    };

    switch (action) {
      case 'new-chat':
        setShowNewChatModal(true);
        cleanUrl();
        break;
      case 'agents':
        setShowAgents(true);
        cleanUrl();
        break;
      case 'share': {
        const sharedText = params.get('text') || params.get('title') || params.get('url') || '';
        if (sharedText) {
          setShowNewChatModal(true);
        }
        cleanUrl();
        break;
      }
    }
  }, []);

  return (
    <div className="h-dvh bg-bg-primary text-text-primary overflow-hidden">
      <ConnectionStatus />

      {/* 桌面端布局 */}
      <div className="hidden md:flex h-dvh">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onOpenAgents={() => setShowAgents(true)}
        />
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {showAgents ? (
            <div className="flex flex-col h-full">
              {selectedAgentId ? (
                <AgentChatView agentId={selectedAgentId} onBack={() => setSelectedAgentId(null)} />
              ) : (
                <AgentsPage
                  onBack={() => setShowAgents(false)}
                  onOpenCreate={() => setShowAgentCreate(true)}
                  onSelectAgent={(agentId: string) => setSelectedAgentId(agentId)}
                />
              )}
            </div>
          ) : currentGroup ? (
            <div className="flex flex-col h-full">
              <div className="w-full flex flex-col h-full">
                <ChatHeader showGroupInfoButton={true} />
                <MessageList />
                {currentGroup.is_ai_private ? (
                  <ObserverControlPanel groupId={currentGroup.id} topic={currentGroup.topic || currentGroup.description} />
                ) : (
                  <MessageInput />
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center bg-bg-primary">
              <div className="text-center max-w-md px-6">
                <div className="flex justify-center mb-6">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -40 280 280" className="w-16 h-16">
                    <defs>
                      <linearGradient id="main" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#6C5CE7"/>
                        <stop offset="100%" stopColor="#A29BFE"/>
                      </linearGradient>
                      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#1A1A2E" floodOpacity="0.25"/>
                      </filter>
                    </defs>
                    <g filter="url(#shadow)">
                      <rect x="55" y="50" width="85" height="85" rx="20" fill="#1A1A2E" opacity="0.9" transform="rotate(-12, 97, 92)"/>
                      <rect x="70" y="48" width="85" height="85" rx="20" fill="#6C5CE7" opacity="0.6" transform="rotate(8, 112, 90)"/>
                      <rect x="82" y="58" width="85" height="85" rx="20" fill="url(#main)"/>
                    </g>
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-text-primary mb-2">开始对话</h2>
                <p className="text-text-secondary text-sm mb-8 leading-relaxed">选择一个群组开始聊天，或创建新的对话</p>
                <div className="grid grid-cols-3 gap-3">
                  <button onClick={() => setShowNewChatModal(true)} className="group flex flex-col items-center gap-2.5 p-4 rounded-xl bg-bg-surface border border-border-subtle hover:border-accent/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                    <div className="w-10 h-10 rounded-xl bg-accent-subtle flex items-center justify-center group-hover:bg-accent/15 transition-colors">
                      <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                      </svg>
                    </div>
                    <span className="text-xs font-medium text-text-secondary group-hover:text-text-primary transition-colors">群聊对话</span>
                  </button>
                  <button onClick={() => { setShowAgents(true); }} className="group flex flex-col items-center gap-2.5 p-4 rounded-xl bg-bg-surface border border-border-subtle hover:border-accent/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                    <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/20 flex items-center justify-center group-hover:bg-purple-100 dark:group-hover:bg-purple-900/30 transition-colors">
                      <svg className="w-5 h-5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                      </svg>
                    </div>
                    <span className="text-xs font-medium text-text-secondary group-hover:text-text-primary transition-colors">AI 私聊</span>
                  </button>
                  <button onClick={() => setShowNewChatModal(true)} className="group flex flex-col items-center gap-2.5 p-4 rounded-xl bg-bg-surface border border-border-subtle hover:border-accent/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                    <div className="w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-900/20 flex items-center justify-center group-hover:bg-orange-100 dark:group-hover:bg-orange-900/30 transition-colors">
                      <svg className="w-5 h-5 text-orange-600 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l7.07 7.07M21 21l-7.07-7.07M3 21l7.07-7.07M21 3l-7.07 7.07" />
                      </svg>
                    </div>
                    <span className="text-xs font-medium text-text-secondary group-hover:text-text-primary transition-colors">辩论模式</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 移动端布局 */}
      <div className="md:hidden relative h-full overflow-hidden" {...swipeHandlers}>
        <div
          className="absolute inset-0 pointer-events-none z-50"
          style={{
            background: `linear-gradient(to right, rgba(0,0,0,${swipeProgress * 0.3}) 0%, transparent ${swipeProgress * 30}%)`,
            opacity: swipeProgress > 0 ? 1 : 0,
            transition: swipeProgress > 0 ? 'none' : 'opacity 0.2s ease'
          }}
        />

        {mobileView === 'main' && mobileTab === 'chats' && (
          <div className="absolute inset-0 z-10 bg-bg-primary flex flex-col" style={{ paddingBottom: '56px' }}>
            <ChatList onNewChat={() => setShowNewChatModal(true)} onBack={handleMobileBack} onSelectGroup={handleMobileSelectGroup} />
          </div>
        )}

        {mobileView === 'main' && mobileTab === 'settings' && (
          <div className="absolute inset-0 z-10 bg-bg-primary flex flex-col" style={{ paddingBottom: '56px' }}>
            <SettingsPage />
          </div>
        )}

        {((mobileView === 'main' && mobileTab === 'agents') || mobileView === 'agents') && (
          <div className="absolute inset-0 z-10 bg-bg-primary flex flex-col" style={{ paddingBottom: '56px' }}>
            <AgentsPage
              onOpenCreate={() => setShowAgentCreate(true)}
              onSelectAgent={(agentId: string) => { setSelectedAgentId(agentId); navigateToView('agentChat'); }}
            />
          </div>
        )}

        {mobileView === 'agentChat' && selectedAgentId && (
          <div className="fixed inset-0 z-10 bg-bg-primary flex flex-col h-[100dvh]">
            <AgentChatView agentId={selectedAgentId} onBack={handleMobileBack} />
          </div>
        )}

        {mobileView === 'chat' && currentGroup && (
          <div className="fixed inset-0 z-10 bg-bg-primary flex flex-col" style={{ height: '100dvh' }}>
            <ChatHeader onBack={handleMobileBack} onToggleGroupInfo={() => navigateToView('groupInfo')} showGroupInfoButton={true} />
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <MessageList />
            </div>
            {currentGroup.is_ai_private ? (
              <ObserverControlPanel groupId={currentGroup.id} topic={currentGroup.topic || currentGroup.description} />
            ) : (
              <MessageInput />
            )}
          </div>
        )}

        {mobileView === 'groupInfo' && currentGroup && (
          <GroupInfoPage groupId={currentGroup.id} isOpen={true} onClose={() => navigateToView('chat')} />
        )}

        {(mobileView === 'main' || mobileView === 'agents') && (
          <MobileTabBar activeTab={mobileTab} onTabChange={handleTabChange} />
        )}
      </div>

      <AgentCreateModal isOpen={showAgentCreate} onClose={() => setShowAgentCreate(false)} />
      <NewChatModal isOpen={showNewChatModal} onClose={() => setShowNewChatModal(false)} onSelectGroup={handleMobileSelectGroup} />
    </div>
  );
}

export default App;
