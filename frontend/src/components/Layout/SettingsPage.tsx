import { useState, useEffect, useRef } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { AIPersonaEditor } from './AIPersonaEditor';
import { UserProfileEditor } from './UserProfileEditor';
import { FontSizeSelector } from './FontSizeToggle';
import { useConfirm, useToast } from '../Common';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { AI_LIST, AI_NAMES } from '../../types';

export function SettingsPage() {
  const APP_VERSION = import.meta.env.VITE_APP_VERSION || '2.8.9';
  const { theme, setTheme } = useThemeStore();
  const { groups } = useGroupsStore();
  const { personas, fetchPersonas, loading: personasLoading } = usePersonasStore();
  const { confirm, ConfirmModal } = useConfirm();
  const { showToast, Toast } = useToast();
  const [expandedPersona, setExpandedPersona] = useState<string | null>(null);
  const [isPageEntered, setIsPageEntered] = useState(false);
  const [visibleSections, setVisibleSections] = useState<number[]>([]);
  const [isDarkMode, setIsDarkMode] = useState(theme === 'dark');
  const [isThemeChanging, setIsThemeChanging] = useState(false);
  const [prevExpandedPersona, setPrevExpandedPersona] = useState<string | null>(null);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const { canInstall, isInstalled, isStandalone, isOnline, install, getInstallGuidance, platform } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  const aiMembers = Array.from(new Set(groups.flatMap(g => g.ai_members || [])));
  const totalAIModels = AI_LIST.length;
  const nonChatModels = ['mimo_tts', 'glm_4v_flash', 'qwen_vl_plus', 'qwen_omni'];
  const chatAIMembers = aiMembers.filter(id => !nonChatModels.includes(id as string));
  const notInGroups = AI_LIST.filter(id => !aiMembers.includes(id as string) && !nonChatModels.includes(id as string));
  const personaEntries = Object.entries(personas);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsPageEntered(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    fetchPersonas();
  }, [fetchPersonas]);

  useEffect(() => {
    const sectionCount = 9;
    const timers: ReturnType<typeof setTimeout>[] = [];

    Array.from({ length: sectionCount }).forEach((_, index) => {
      const timer = setTimeout(() => {
        setVisibleSections(prev => [...prev, index]);
      }, 100 + index * 80);
      timers.push(timer);
    });

    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  useEffect(() => {
    setIsDarkMode(theme === 'dark');
  }, [theme]);

  const toggleDarkMode = () => {
    setIsThemeChanging(true);
    setTheme(theme === 'dark' ? 'light' : 'dark');
    setTimeout(() => {
      setIsThemeChanging(false);
    }, 300);
  };

  const clearAll = () => {
    try {
      const keysToRemove = Object.keys(localStorage).filter(key =>
        key.startsWith('chat_app_') || key.startsWith('ai-chat-') || key.startsWith('app_cache_') || key === 'messages-cache' || key === 'groups-cache'
      );
      keysToRemove.forEach(key => localStorage.removeItem(key));
    } catch (e) {
      console.warn('clearAll failed:', e);
    }

    try {
      indexedDB.deleteDatabase('ai-chat-db');
    } catch (e) {
      console.warn('IndexedDB cleanup failed:', e);
    }
  };

  const handleClearData = async () => {
    const confirmed = await confirm({
      title: '清空所有聊天数据',
      description: '此操作将删除所有聊天记录和对话，且无法恢复。确定要继续吗？',
      danger: true,
    });
    if (confirmed) {
      clearAll();
      showToast({ message: '数据已清空', type: 'success' });
    }
  };

  const handlePersonaToggle = (id: string) => {
    setPrevExpandedPersona(expandedPersona);
    setExpandedPersona(expandedPersona === id ? null : id);
  };

  const handleThemeModeSelect = (mode: 'light' | 'dark' | 'system') => {
    if (theme !== mode) {
      setIsThemeChanging(true);
      setTheme(mode);
      setTimeout(() => {
        setIsThemeChanging(false);
      }, 300);
    }
  };

  const getSectionStyle = (index: number) => ({
    opacity: visibleSections.includes(index) ? 1 : 0,
    transform: visibleSections.includes(index) ? 'translateY(0)' : 'translateY(16px)',
    transition: 'opacity 400ms cubic-bezier(0.0, 0.0, 0.2, 1), transform 400ms cubic-bezier(0.0, 0.0, 0.2, 1)',
  });

  return (
    <>
      <div 
        className={`md:hidden h-full flex flex-col bg-bg-primary pb-14 settings-theme-transition ${
          isPageEntered ? 'settings-page-enter' : 'opacity-0'
        }`}
      >
        <div className="px-4 py-3 bg-bg-surface border-b border-border-subtle settings-theme-transition">
          <h1 className="text-lg font-semibold text-text-primary settings-theme-transition">设置</h1>
        </div>

        <div className="flex-1 overflow-y-auto pb-safe">
          <div className="py-4 space-y-6">
            <div
              ref={el => { sectionRefs.current[5] = el }}
              style={getSectionStyle(5)}
              className="px-4"
            >
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-3 settings-theme-transition">应用</h2>
              <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden divide-y divide-border/30 settings-theme-transition settings-card">
                {isStandalone || isInstalled ? (
                  <div className="flex items-center gap-3 p-3 settings-theme-transition">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-green-100 dark:bg-green-900/30 settings-theme-transition">
                      <svg className="w-5 h-5 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <span className="text-sm text-text-primary settings-theme-transition">已安装到桌面</span>
                      <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">应用已添加到主屏幕，可像原生应用一样使用</p>
                    </div>
                  </div>
                ) : canInstall ? (
                  <button
                    onClick={install}
                    className="w-full flex items-center gap-3 p-3 active:bg-bg-primary/50 settings-theme-transition"
                  >
                    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-bg-surface2 settings-theme-transition">
                      <svg className="w-5 h-5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </div>
                    <div className="flex-1 text-left">
                      <span className="text-sm text-text-primary settings-theme-transition">安装到桌面</span>
                      <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">快速访问，离线可用，享受原生应用体验</p>
                    </div>
                    <svg className="w-4 h-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                ) : getInstallGuidance() ? (
                  <div>
                    <button
                      onClick={() => setShowIOSGuide(!showIOSGuide)}
                      className="w-full flex items-center gap-3 p-3 active:bg-bg-primary/50 settings-theme-transition"
                    >
                      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-bg-surface2 settings-theme-transition">
                        <svg className="w-5 h-5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8.21 13.89A1 1 0 019 13h6a1 1 0 01.79 1.89l-1.58 2.63A2 2 0 0112.47 18h-.94a2 2 0 01-1.74-1.01L8.21 13.89zM12 2v4M4.93 4.93l2.83 2.83M2 10h4M18 10h4M16.24 7.76l2.83-2.83" />
                        </svg>
                      </div>
                      <div className="flex-1 text-left">
                        <span className="text-sm text-text-primary settings-theme-transition">添加到主屏幕</span>
                        <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">
                          {platform === 'ios' ? '通过Safari分享菜单添加' : '通过浏览器菜单安装应用'}
                        </p>
                      </div>
                      <svg className={`settings-expand-icon w-4 h-4 text-text-muted ${showIOSGuide ? 'expanded' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                    {showIOSGuide && getInstallGuidance() && (
                      <div className="px-3 pb-3 bg-bg-primary/30 settings-theme-transition">
                        <div className="space-y-2 pt-2">
                          {getInstallGuidance()!.steps.map((step, index) => (
                            <div key={index} className="flex items-start gap-2 animate-fade-in" style={{ animationDelay: `${index * 50}ms` }}>
                              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-accent/10 text-accent text-[10px] font-bold flex items-center justify-center mt-0.5">
                                {index + 1}
                              </span>
                              <span className="text-xs text-text-secondary settings-theme-transition">{step}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-3 settings-theme-transition">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-bg-surface2 settings-theme-transition">
                      <svg className="w-5 h-5 text-text-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8.21 13.89A1 1 0 019 13h6a1 1 0 01.79 1.89l-1.58 2.63A2 2 0 0112.47 18h-.94a2 2 0 01-1.74-1.01L8.21 13.89zM12 2v4M4.93 4.93l2.83 2.83M2 10h4M18 10h4M16.24 7.76l2.83-2.83" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <span className="text-sm text-text-primary settings-theme-transition">添加到主屏幕</span>
                      <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">请通过浏览器菜单选择"安装应用"或"添加到主屏幕"</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3 p-3 settings-theme-transition">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center bg-bg-surface2 settings-theme-transition">
                    <svg className={`w-5 h-5 ${isOnline ? 'text-green-500' : 'text-amber-500'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {isOnline ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m-2.829-2.829a5 5 0 000-7.07m-4.243 4.243a1.5 1.5 0 010-2.122" />
                      )}
                    </svg>
                  </div>
                  <div className="flex-1">
                    <span className="text-sm text-text-primary settings-theme-transition">网络状态</span>
                    <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">
                      {isOnline ? '已连接 — 所有功能可用' : '已断开 — 仅可查看已缓存内容'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div 
              ref={el => { sectionRefs.current[1] = el }}
              style={getSectionStyle(1)}
              className="px-4"
            >
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-3 settings-theme-transition">主题模式</h2>
              <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden divide-y divide-border/30 settings-theme-transition settings-card">
                {(['light', 'dark', 'system'] as const).map((mode, index) => (
                  <button
                    key={mode}
                    onClick={() => handleThemeModeSelect(mode)}
                    className={`theme-mode-btn w-full flex items-center justify-between p-3 ${
                      theme === mode ? 'selected bg-bg-primary/50' : ''
                    }`}
                    style={{
                      animationDelay: `${index * 50}ms`,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-bg-surface settings-theme-transition">
                        {mode === 'light' && (
                          <svg className={`w-5 h-5 text-yellow-500 ${isThemeChanging && theme === mode ? 'theme-icon-rotate' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="12" r="4" />
                            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        )}
                        {mode === 'dark' && (
                          <svg className={`w-5 h-5 text-indigo-400 ${isThemeChanging && theme === mode ? 'theme-icon-rotate' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                          </svg>
                        )}
                        {mode === 'system' && (
                          <svg className={`w-5 h-5 text-text-secondary ${isThemeChanging && theme === mode ? 'theme-icon-rotate' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="3" width="20" height="14" rx="2" />
                            <path d="M8 21h8M12 17v4" />
                          </svg>
                        )}
                      </div>
                      <span className="text-sm text-text-primary settings-theme-transition">
                        {mode === 'light' ? '浅色模式' : mode === 'dark' ? '深色模式' : '跟随系统'}
                      </span>
                    </div>
                    {theme === mode && (
                      <svg 
                        className="w-5 h-5 text-user animate-checkmark settings-theme-transition" 
                        viewBox="0 0 24 24" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="2.5"
                      >
                        <path className="animate-draw-check" d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div
              ref={el => { sectionRefs.current[2] = el }}
              style={getSectionStyle(2)}
              className="px-4"
            >
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-3 settings-theme-transition">字体大小</h2>
              <FontSizeSelector />
            </div>

            <div
              ref={el => { sectionRefs.current[3] = el }}
              style={getSectionStyle(3)}
              className="px-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider settings-theme-transition">AI角色设置</h2>
                <button
                  onClick={() => fetchPersonas()}
                  disabled={personasLoading}
                  className="p-1.5 rounded-lg hover:bg-bg-surface2 transition-colors disabled:opacity-50"
                  title="刷新AI角色列表"
                >
                  <svg className={`w-4 h-4 text-text-secondary ${personasLoading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                </button>
              </div>
              <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden divide-y divide-border/30 settings-theme-transition settings-card">
                {personaEntries.map(([id, persona], index) => {
                  const isExpanded = expandedPersona === id;
                  const isInChat = aiMembers.includes(id);
                  const personaTyped = persona as any;
                  const wasExpanded = prevExpandedPersona === id;
                  const isEditable = id !== 'mimo_tts';

                  return (
                    <div key={id}>
                      <button
                        onClick={() => isEditable && handlePersonaToggle(id)}
                        className={`w-full flex items-center gap-3 p-3 settings-theme-transition ${isEditable ? 'active:bg-bg-primary/50' : 'cursor-default'}`}
                        style={{
                          animationDelay: `${index * 30}ms`,
                        }}
                      >
                        <div
                          className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0 overflow-hidden shadow-sm settings-theme-transition"
                          style={{
                            backgroundColor: personaTyped.avatar_url ? 'transparent' : (personaTyped.color || '#888'),
                            backgroundImage: personaTyped.avatar_url ? `url(${personaTyped.avatar_url})` : 'none',
                            backgroundSize: 'cover',
                            backgroundPosition: 'center'
                          }}
                        >
                          {!personaTyped.avatar_url && (personaTyped.name || id).charAt(0)}
                        </div>
                        <div className="flex-1 text-left">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-text-primary settings-theme-transition">{personaTyped.name || id}</span>
                            <div className="flex items-center gap-2">
                              {isInChat && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 settings-theme-transition">
                                  已启用
                                </span>
                              )}
                              {isEditable && (
                                <svg
                                  className={`settings-expand-icon w-4 h-4 text-text-muted ${isExpanded ? 'expanded' : ''}`}
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="m6 9 6 6 6-6" />
                                </svg>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-text-secondary mt-0.5 line-clamp-1 settings-theme-transition">
                            {personaTyped.description || personaTyped.personality || ''}
                          </p>
                        </div>
                      </button>

                      {isEditable && (
                        <div
                          className={`${isExpanded ? 'expand-content' : wasExpanded ? 'collapse-content' : 'hidden'}`}
                        >
                          <div className="px-3 pb-3 bg-bg-primary/30 settings-theme-transition">
                            <div className="space-y-3 pt-2">
                              {personaTyped.personality && (
                                <div className="animate-fade-in" style={{ animationDelay: '50ms' }}>
                                  <span className="text-[10px] font-medium text-text-muted settings-theme-transition">性格特征</span>
                                  <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">{personaTyped.personality}</p>
                                </div>
                              )}
                              {personaTyped.conversational_style && (
                                <div className="animate-fade-in" style={{ animationDelay: '100ms' }}>
                                  <span className="text-[10px] font-medium text-text-muted settings-theme-transition">对话风格</span>
                                  <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">{personaTyped.conversational_style}</p>
                                </div>
                              )}
                              {(personaTyped.humor_level !== undefined || personaTyped.sentiment_bias !== undefined) && (
                                <div className="grid grid-cols-2 gap-2 animate-fade-in" style={{ animationDelay: '150ms' }}>
                                  {personaTyped.humor_level !== undefined && (
                                    <div>
                                      <span className="text-[10px] font-medium text-text-muted settings-theme-transition">幽默度</span>
                                      <div className="mt-1 h-1.5 bg-bg-surface rounded-full overflow-hidden settings-theme-transition">
                                        <div
                                          className="h-full rounded-full transition-all duration-300 ease-out settings-theme-transition"
                                          style={{
                                            width: `${((personaTyped.humor_level || 5) / 10) * 100}%`,
                                            backgroundColor: personaTyped.color || '#888'
                                          }}
                                        />
                                      </div>
                                    </div>
                                  )}
                                  {personaTyped.sentiment_bias !== undefined && (
                                    <div>
                                      <span className="text-[10px] font-medium text-text-muted settings-theme-transition">情感倾向</span>
                                      <div className="mt-1 h-1.5 bg-bg-surface rounded-full overflow-hidden settings-theme-transition">
                                        <div
                                          className="h-full rounded-full transition-all duration-300 ease-out settings-theme-transition"
                                          style={{
                                            width: `${((personaTyped.sentiment_bias || 5) / 10) * 100}%`,
                                            backgroundColor: personaTyped.color || '#888'
                                          }}
                                        />
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                              {personaTyped.expertise_areas && personaTyped.expertise_areas.length > 0 && (
                                <div className="animate-fade-in" style={{ animationDelay: '200ms' }}>
                                  <span className="text-[10px] font-medium text-text-muted settings-theme-transition">擅长领域</span>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {personaTyped.expertise_areas.map((area: string) => (
                                      <span
                                        key={area}
                                        className="text-[10px] px-2 py-0.5 rounded-full bg-bg-surface text-text-secondary settings-theme-transition"
                                      >
                                        {area}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingPersonaId(id);
                                }}
                                className="w-full mt-2 py-2.5 text-sm font-semibold rounded-lg active:scale-[0.98] transition-all duration-200 settings-theme-transition"
                                style={{
                                  backgroundColor: 'var(--accent-color, #4f46e5)',
                                  color: '#ffffff'
                                }}
                              >
                                编辑AI人格
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              ref={el => { sectionRefs.current[6] = el }}
              style={getSectionStyle(6)}
              className="px-4"
            >
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-3 settings-theme-transition">用户画像</h2>
              <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden settings-theme-transition settings-card">
                <button
                  onClick={() => setShowProfileEditor(true)}
                  className="w-full flex items-center justify-between p-3 active:bg-bg-primary/50 settings-theme-transition"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden shadow-sm settings-theme-transition"
                      style={{ backgroundColor: 'var(--accent-color, #4f46e5)' }}
                    >
                      <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    </div>
                    <div className="flex-1 text-left">
                      <span className="text-sm font-medium text-text-primary settings-theme-transition">编辑个人资料</span>
                      <p className="text-xs text-text-secondary mt-0.5 settings-theme-transition">填写性格偏好、爱好等信息</p>
                    </div>
                  </div>
                  <svg className="w-4 h-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </div>
            </div>

            <div 
              ref={el => { sectionRefs.current[4] = el }}
              style={getSectionStyle(4)}
              className="px-4"
            >
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-3 settings-theme-transition">关于</h2>
              <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden divide-y divide-border/30 settings-theme-transition settings-card">
                <div className="flex items-center gap-3 p-3 settings-theme-transition">
                  <svg viewBox="0 0 200 200" className="w-8 h-8 flex-shrink-0">
                    <defs>
                      <linearGradient id="aboutGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#6C5CE7"/>
                        <stop offset="100%" stopColor="#A29BFE"/>
                      </linearGradient>
                    </defs>
                    <rect x="55" y="50" width="85" height="85" rx="20" fill="#1A1A2E" opacity="0.9" transform="rotate(-12, 97, 92)"/>
                    <rect x="70" y="48" width="85" height="85" rx="20" fill="#6C5CE7" opacity="0.6" transform="rotate(8, 112, 90)"/>
                    <rect x="82" y="58" width="85" height="85" rx="20" fill="url(#aboutGrad)"/>
                  </svg>
                  <div className="flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold text-text-primary settings-theme-transition">群想</span>
                      <span className="text-[10px] font-medium text-[#6C5CE7] dark:text-indigo-400 tracking-[1px] settings-theme-transition">Muse aloud</span>
                    </div>
                    <span className="text-[10px] text-text-muted settings-theme-transition">想，就聊出来</span>
                  </div>
                </div>
                <div className="flex items-center justify-between p-3 settings-theme-transition">
                  <span className="text-sm text-text-primary settings-theme-transition">版本</span>
                  <span className="text-sm text-text-secondary settings-theme-transition">{APP_VERSION}</span>
                </div>
                <div className="flex items-center justify-between p-3 settings-theme-transition">
                  <span className="text-sm text-text-primary settings-theme-transition">AI模型</span>
                  <span className="text-sm text-text-secondary settings-theme-transition">{totalAIModels} 个已配置</span>
                </div>
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-text-muted">
                    聊天AI：{chatAIMembers.length} 个已加入群聊 · 专用AI：4 个（TTS语音、视觉识别、全模态分析）
                  </p>
                  {notInGroups.length > 0 && (
                    <p className="text-xs text-amber-500">
                      未入群：{notInGroups.map(id => AI_NAMES[id as keyof typeof AI_NAMES] || id).join('、')}（可在创建群聊时添加）
                    </p>
                  )}
                </div>
                <button
                  onClick={async () => {
                    try {
                      const exportData: Record<string, unknown> = {
                        exportDate: new Date().toISOString(),
                        version: APP_VERSION,
                        groups: groups,
                        personas: personas,
                      };
                      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `群想-数据导出-${new Date().toISOString().slice(0, 10)}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                      showToast({ message: '数据导出成功' });
                    } catch (e) {
                      showToast({ message: '导出失败: ' + (e as Error).message, type: 'error' });
                    }
                  }}
                  className="flex items-center justify-between p-3 w-full active:bg-bg-surface2 settings-theme-transition"
                >
                  <span className="text-sm text-text-primary settings-theme-transition">导出数据</span>
                  <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                </button>
              </div>
            </div>

            <div 
              ref={el => { sectionRefs.current[6] = el }}
              style={getSectionStyle(6)}
              className="px-4"
            >
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider mb-3 settings-theme-transition">显示</h2>
              <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden settings-theme-transition settings-card">
                <div className="flex items-center justify-between p-3 settings-theme-transition">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-bg-surface2 settings-theme-transition">
                      {isDarkMode ? (
                        <svg className={`w-5 h-5 text-indigo-400 ${isThemeChanging ? 'theme-icon-rotate' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                      ) : (
                        <svg className={`w-5 h-5 text-yellow-500 ${isThemeChanging ? 'theme-icon-rotate' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="12" r="4" />
                          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      )}
                    </div>
                    <span className="text-sm text-text-primary settings-theme-transition">深色模式</span>
                  </div>
                  <button
                    onClick={toggleDarkMode}
                    className={`relative w-12 h-7 rounded-full transition-all duration-300 ease-out settings-theme-transition ${
                      isDarkMode ? 'bg-accent' : 'bg-bg-surface'
                    }`}
                    style={{
                      boxShadow: isDarkMode 
                        ? '0 0 0 2px rgba(23, 23, 23, 0.1), 0 2px 8px rgba(0, 0, 0, 0.15)' 
                        : '0 0 0 1px var(--border-color), 0 2px 4px rgba(0, 0, 0, 0.05)'
                    }}
                  >
                    <div
                      className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-300 ease-out ${
                        isDarkMode ? 'toggle-switch-on' : 'toggle-switch-off'
                      }`}
                      style={{
                        left: isDarkMode ? 'auto' : '4px',
                        right: isDarkMode ? '4px' : 'auto',
                        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.1)'
                      }}
                    >
                      {isDarkMode ? (
                        <svg className="w-full h-full p-1 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                      ) : (
                        <svg className="w-full h-full p-1 text-yellow-500" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="12" r="4" />
                        </svg>
                      )}
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <div 
              ref={el => { sectionRefs.current[7] = el }}
              style={getSectionStyle(7)}
              className="px-4 pb-4"
            >
              <button
                onClick={handleClearData}
                className="w-full py-3 text-sm text-error btn-secondary hover:bg-error/5"
              >
                清空所有聊天数据
              </button>
            </div>
          </div>
        </div>
        {ConfirmModal}
        {Toast}
      </div>

      {editingPersonaId && (
        <AIPersonaEditor
          aiId={editingPersonaId}
          isOpen={!!editingPersonaId}
          onClose={() => setEditingPersonaId(null)}
        />
      )}

      <UserProfileEditor
        isOpen={showProfileEditor}
        onClose={() => setShowProfileEditor(false)}
      />
    </>
  );
}
