import { useState, useEffect, useRef } from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { useProfileStore } from '../../stores/profileStore';
import { AIPersonaEditor } from './AIPersonaEditor';
import { UserProfileEditor } from './UserProfileEditor';
import { FontSizeSelector } from './FontSizeToggle';
import { useConfirm, useToast } from '../Common';
import { AI_LIST } from '../../types';
import { api } from '../../services/api';
import { useModalAnimation } from '../../hooks/useModalAnimation';

interface ApiProviderConfig {
  apiKey: string;
  baseUrl: string;
}

const API_VENDORS: { key: string; label: string; desc: string; color: string }[] = [
  { key: 'deepseek', label: 'DeepSeek', desc: 'DeepSeek-V3 / R1', color: '#4D6BFE' },
  { key: 'zhipu', label: '智谱AI (GLM)', desc: 'GLM-4 / GLM-4V', color: '#3B5FFF' },
  { key: 'mimo', label: 'MiMo', desc: 'MiMo-TTS 语音模型', color: '#FF6A00' },
  { key: 'qwen', label: '通义千问 (Qwen)', desc: 'Qwen-Max / Qwen-VL', color: '#6C5CE7' },
];

type SettingsTab = 'api' | 'appearance' | 'personas' | 'profile' | 'about';

interface DesktopSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DesktopSettingsModal({ isOpen, onClose }: DesktopSettingsModalProps) {
  const APP_VERSION = import.meta.env.VITE_APP_VERSION || '2.8.9';
  const { theme, setTheme } = useThemeStore();
  const { groups } = useGroupsStore();
  const { personas, fetchPersonas, loading: personasLoading } = usePersonasStore();
  const userProfile = useProfileStore(state => state.profile);
  const fetchProfile = useProfileStore(state => state.fetchProfile);
  const { confirm, ConfirmModal } = useConfirm();
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<SettingsTab>('api');
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [showProfileEditor, setShowProfileEditor] = useState(false);

  const [apiConfig, setApiConfig] = useState<Record<string, ApiProviderConfig>>({});
  const [apiConfigVisible, setApiConfigVisible] = useState<Record<string, boolean>>({});
  const [expandedVendors, setExpandedVendors] = useState<Record<string, boolean>>({});
  const [savingApiConfig, setSavingApiConfig] = useState(false);
  const [apiConfigLoaded, setApiConfigLoaded] = useState(false);
  const [apiConfigSaveError, setApiConfigSaveError] = useState(false);
  const apiConfigOriginalRef = useRef<Record<string, ApiProviderConfig>>({});

  const [expandedPersona, setExpandedPersona] = useState<string | null>(null);
  const { isVisible, close: handleClose, overlayClass, contentClass } = useModalAnimation(isOpen, onClose);

  const NON_CHATTABLE_AI = ['mimo_tts', 'glm_4v_flash', 'qwen_vl_plus', 'qwen_omni'];
  const aiMembers = Array.from(new Set(groups.flatMap(g => g.ai_members || [])));
  const totalAIModels = AI_LIST.length;
  const chatAIMembers = aiMembers.filter(id => !NON_CHATTABLE_AI.includes(id as string));
  const personaEntries = Object.entries(personas);

  useEffect(() => {
    if (isOpen) {
      fetchProfile();
    }
  }, [isOpen, fetchProfile]);

  useEffect(() => {
    if (isOpen && !apiConfigLoaded) {
      api.getUserApiConfig().then((data) => {
        if (data?.config && typeof data.config === 'object') {
          setApiConfig(data.config);
          apiConfigOriginalRef.current = JSON.parse(JSON.stringify(data.config));
        }
      }).catch(() => { }).finally(() => setApiConfigLoaded(true));
    }
  }, [isOpen, apiConfigLoaded]);

  useEffect(() => {
    if (isOpen) {
      fetchPersonas();
    }
  }, [isOpen, fetchPersonas]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  const handleApiConfigChange = (vendor: string, field: 'apiKey' | 'baseUrl', value: string) => {
    setApiConfigSaveError(false);
    setApiConfig(prev => ({ ...prev, [vendor]: { ...prev[vendor], [field]: value } }));
  };

  const toggleApiConfigVisibility = (vendor: string) => {
    setApiConfigVisible(prev => ({ ...prev, [vendor]: !prev[vendor] }));
  };

  const toggleVendorExpand = (vendor: string) => {
    setExpandedVendors(prev => ({ ...prev, [vendor]: !prev[vendor] }));
  };

  const handleSaveApiConfig = async () => {
    setSavingApiConfig(true);
    setApiConfigSaveError(false);
    try {
      await api.updateUserApiConfig(apiConfig);
      apiConfigOriginalRef.current = JSON.parse(JSON.stringify(apiConfig));
      showToast({ message: 'API配置已保存', type: 'success' });
    } catch {
      setApiConfigSaveError(true);
      showToast({ message: '保存失败，请重试', type: 'error' });
    } finally {
      setSavingApiConfig(false);
    }
  };

  const handleThemeModeSelect = (mode: 'light' | 'dark' | 'system') => {
    if (theme !== mode) setTheme(mode);
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

  if (!isVisible) return null;

  const tabs: { key: SettingsTab; label: string; icon: JSX.Element }[] = [
    {
      key: 'api',
      label: 'API 配置',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" /></svg>,
    },
    {
      key: 'appearance',
      label: '外观',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" /></svg>,
    },
    {
      key: 'personas',
      label: 'AI 角色',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>,
    },
    {
      key: 'profile',
      label: '个人资料',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg>,
    },
    {
      key: 'about',
      label: '关于',
      icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" /></svg>,
    },
  ];

  const renderApiSection = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">API 配置</h3>
          <p className="text-[11px] text-text-muted mt-0.5">配置各AI服务商的API密钥和自定义地址</p>
        </div>
        <div className="flex items-center gap-2">
          {apiConfigSaveError && (
            <button
              onClick={() => {
                setApiConfig(JSON.parse(JSON.stringify(apiConfigOriginalRef.current)));
                setApiConfigSaveError(false);
              }}
              className="px-3 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/30 rounded-lg hover:bg-amber-500/5 transition-colors"
            >
              放弃更改
            </button>
          )}
          <button
            onClick={handleSaveApiConfig}
            disabled={savingApiConfig}
            className="px-4 py-1.5 text-xs font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {savingApiConfig ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>
      {apiConfigSaveError && (
        <p className="text-xs text-amber-600 dark:text-amber-400 -mt-2">配置尚未保存</p>
      )}
      <div className="space-y-2">
        {API_VENDORS.map((vendor) => {
          const cfg = apiConfig[vendor.key] || { apiKey: '', baseUrl: '' };
          const showPw = apiConfigVisible[vendor.key] || false;
          const isExpanded = expandedVendors[vendor.key] || false;
          const isConfigured = !!(cfg.apiKey && cfg.apiKey.trim());

          return (
            <div
              key={vendor.key}
              className="border border-border-subtle rounded-xl overflow-hidden bg-bg-surface2/50"
            >
              <button
                onClick={() => toggleVendorExpand(vendor.key)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-bg-surface3/50 transition-colors"
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: vendor.color }}
                >
                  {vendor.label[0]}
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{vendor.label}</span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConfigured ? 'bg-green-500' : 'bg-text-muted/30'}`}
                      title={isConfigured ? '已配置' : '未配置'}
                    />
                  </div>
                  <span className="text-[11px] text-text-muted">{vendor.desc}</span>
                </div>
                <svg
                  className={`w-4 h-4 text-text-muted transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {isExpanded && (
                <div className="px-4 pb-3 space-y-2.5 border-t border-border-subtle/50 pt-3">
                  <div>
                    <label className="text-[11px] font-medium text-text-secondary mb-1 block">API Key</label>
                    <div className="relative">
                      <input
                        type={showPw ? 'text' : 'password'}
                        value={cfg.apiKey}
                        onChange={(e) => handleApiConfigChange(vendor.key, 'apiKey', e.target.value)}
                        placeholder="输入 API Key"
                        className="w-full px-3 py-2 pr-10 bg-bg-surface border border-border-subtle rounded-lg text-xs outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-1 focus:ring-accent/20 transition-all"
                      />
                      <button
                        onClick={() => toggleApiConfigVisibility(vendor.key)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded hover:bg-bg-surface2 text-text-muted hover:text-text-secondary transition-colors"
                        title={showPw ? '隐藏' : '显示'}
                      >
                        {showPw ? (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                        )}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-text-secondary mb-1 block">Base URL</label>
                    <input
                      type="text"
                      value={cfg.baseUrl}
                      onChange={(e) => handleApiConfigChange(vendor.key, 'baseUrl', e.target.value)}
                      placeholder="自定义地址（可选，留空使用默认）"
                      className="w-full px-3 py-2 bg-bg-surface border border-border-subtle rounded-lg text-xs outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-1 focus:ring-accent/20 transition-all"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderAppearanceSection = () => (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">外观</h3>
        <p className="text-[11px] text-text-muted">自定义应用的外观和显示效果</p>
      </div>

      <div>
        <label className="text-[11px] font-medium text-text-secondary mb-2 block">主题模式</label>
        <div className="grid grid-cols-3 gap-2">
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => handleThemeModeSelect(mode)}
              className={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${
                theme === mode
                  ? 'border-accent bg-accent/5 text-accent'
                  : 'border-border-subtle bg-bg-surface2/50 text-text-secondary hover:border-border hover:bg-bg-surface2'
              }`}
            >
              {mode === 'light' && (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {mode === 'dark' && (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
              {mode === 'system' && (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
              )}
              <span className="text-xs font-medium">
                {mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[11px] font-medium text-text-secondary mb-2 block">字体大小</label>
        <FontSizeSelector />
      </div>
    </div>
  );

  const renderPersonasSection = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">AI 角色</h3>
          <p className="text-[11px] text-text-muted mt-0.5">查看和编辑AI角色的性格、风格和参数</p>
        </div>
        <button
          onClick={() => fetchPersonas()}
          disabled={personasLoading}
          className="p-1.5 rounded-lg hover:bg-bg-surface2 transition-colors disabled:opacity-50"
          title="刷新"
        >
          <svg className={`w-4 h-4 text-text-secondary ${personasLoading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>
      <div className="space-y-1.5">
        {personaEntries.map(([id, persona]) => {
          const isExpanded = expandedPersona === id;
          const personaTyped = persona as any;
          const isEnabled = personaTyped?.responseConfig?.enabled !== false;
          const isNonChat = NON_CHATTABLE_AI.includes(id);
          const isEditable = id !== 'mimo_tts';

          return (
            <div key={id} className="border border-border-subtle rounded-xl overflow-hidden bg-bg-surface2/50">
              <button
                onClick={() => isEditable && setExpandedPersona(isExpanded ? null : id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 ${isEditable ? 'hover:bg-bg-surface3/50 cursor-pointer' : 'cursor-default'}`}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0 overflow-hidden"
                  style={{
                    backgroundColor: personaTyped.avatar_url ? 'transparent' : (personaTyped.color || '#888'),
                    backgroundImage: personaTyped.avatar_url ? `url(${personaTyped.avatar_url})` : 'none',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  }}
                >
                  {!personaTyped.avatar_url && (personaTyped.name || id).charAt(0)}
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{personaTyped.name || id}</span>
                    {isNonChat ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">{personaTyped.styleTag || '专用'}</span>
                    ) : isEnabled ? (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">已启用</span>
                    ) : (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">已禁用</span>
                    )}
                  </div>
                  <p className="text-[11px] text-text-muted truncate">{personaTyped.personality || personaTyped.description || ''}</p>
                </div>
                {isEditable && (
                  <svg className={`w-4 h-4 text-text-muted transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                )}
              </button>

              {isEditable && isExpanded && (
                <div className="px-4 pb-3 pt-2 border-t border-border-subtle/50 space-y-2.5">
                  {personaTyped.personality && (
                    <div>
                      <span className="text-[10px] font-medium text-text-muted">性格特征</span>
                      <p className="text-xs text-text-secondary mt-0.5">{personaTyped.personality}</p>
                    </div>
                  )}
                  {personaTyped.conversational_style && (
                    <div>
                      <span className="text-[10px] font-medium text-text-muted">对话风格</span>
                      <p className="text-xs text-text-secondary mt-0.5">{personaTyped.conversational_style}</p>
                    </div>
                  )}
                  {personaTyped.expertise_areas && personaTyped.expertise_areas.length > 0 && (
                    <div>
                      <span className="text-[10px] font-medium text-text-muted">擅长领域</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {personaTyped.expertise_areas.map((area: string) => (
                          <span key={area} className="text-[10px] px-2 py-0.5 rounded-full bg-bg-surface text-text-secondary">{area}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingPersonaId(id); }}
                    className="w-full py-2 text-xs font-semibold rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
                  >
                    编辑AI人格
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderProfileSection = () => {
    const hasNickname = !!userProfile.nickname?.trim();
    const hasAvatar = !!userProfile.avatar_url;
    const filledCount = [
      userProfile.nickname, userProfile.gender, userProfile.occupation,
      userProfile.education, userProfile.bio
    ].filter(v => v).length;
    return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">个人资料</h3>
        <p className="text-[11px] text-text-muted mt-0.5">填写性格偏好、爱好等信息，帮助AI更好地了解你</p>
      </div>
      <button
        onClick={() => setShowProfileEditor(true)}
        className="w-full flex items-center gap-3 p-4 rounded-xl border border-border-subtle bg-bg-surface2/50 hover:bg-bg-surface3/50 transition-colors"
      >
        <div
          className="w-12 h-12 rounded-lg flex items-center justify-center text-white text-sm font-semibold flex-shrink-0 overflow-hidden"
          style={{
            backgroundColor: hasAvatar ? 'transparent' : 'var(--accent-color, #4f46e5)',
            backgroundImage: hasAvatar ? `url(${userProfile.avatar_url})` : 'none',
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          {!hasAvatar && (userProfile.nickname?.charAt(0) || 'U')}
        </div>
        <div className="flex-1 text-left">
          <span className="text-sm font-medium text-text-primary">
            {hasNickname ? userProfile.nickname : '编辑个人资料'}
          </span>
          <p className="text-[11px] text-text-muted mt-0.5">
            {hasNickname
              ? `已填写 ${filledCount} 项信息 · ${userProfile.gender || '未设置性别'} · ${userProfile.occupation || '未设置职业'}`
              : '性格偏好、兴趣爱好、交流风格'}
          </p>
        </div>
        <svg className="w-4 h-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );};

  const renderAboutSection = () => (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">关于</h3>
      </div>
      <div className="border border-border-subtle rounded-xl overflow-hidden bg-bg-surface2/50 divide-y divide-border-subtle/50">
        <div className="flex items-center gap-3 p-4">
          <svg viewBox="0 0 200 200" className="w-10 h-10 flex-shrink-0">
            <defs>
              <linearGradient id="settingsAboutGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#6C5CE7" />
                <stop offset="100%" stopColor="#A29BFE" />
              </linearGradient>
            </defs>
            <rect x="55" y="50" width="85" height="85" rx="20" fill="#1A1A2E" opacity="0.9" transform="rotate(-12, 97, 92)" />
            <rect x="70" y="48" width="85" height="85" rx="20" fill="#6C5CE7" opacity="0.6" transform="rotate(8, 112, 90)" />
            <rect x="82" y="58" width="85" height="85" rx="20" fill="url(#settingsAboutGrad)" />
          </svg>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-base font-bold text-text-primary">群想</span>
              <span className="text-[10px] font-medium text-[#6C5CE7] dark:text-indigo-400 tracking-[1px]">Muse aloud</span>
            </div>
            <span className="text-[11px] text-text-muted">想，就聊出来</span>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm text-text-secondary">版本</span>
          <span className="text-sm text-text-primary">{APP_VERSION}</span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm text-text-secondary">AI模型</span>
          <span className="text-sm text-text-primary">{totalAIModels} 个已配置</span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm text-text-secondary">群聊</span>
          <span className="text-sm text-text-primary">{groups.length} 个对话</span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm text-text-secondary">网络</span>
          <span className="text-sm text-green-500">已连接</span>
        </div>
        <div className="px-4 py-2.5">
          <p className="text-xs text-text-muted">
            聊天AI：{chatAIMembers.length} 个已加入群聊 · 专用AI：4 个（TTS语音、视觉识别、全模态分析）
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={async () => {
            try {
              const exportData: Record<string, unknown> = {
                exportDate: new Date().toISOString(),
                version: APP_VERSION,
                groups: groups,
                personas: personas,
              };
              if (Object.keys(exportData).length > 10000) {
                showToast({ message: '数据量较大，导出可能需要一些时间...', type: 'info' });
              }
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
          className="flex-1 py-2.5 text-sm text-text-secondary border border-border-subtle rounded-xl hover:bg-bg-surface2 transition-colors"
        >
          导出数据
        </button>
        <button
          onClick={handleClearData}
          className="flex-1 py-2.5 text-sm text-red-500 border border-red-500/20 rounded-xl hover:bg-red-500/5 transition-colors"
        >
          清空数据
        </button>
      </div>
    </div>
  );

  const renderContent = () => {
    switch (activeTab) {
      case 'api': return renderApiSection();
      case 'appearance': return renderAppearanceSection();
      case 'personas': return renderPersonasSection();
      case 'profile': return renderProfileSection();
      case 'about': return renderAboutSection();
    }
  };

  return (
    <>
      <div
        className={`fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm ${overlayClass}`}
        onClick={handleClose}
      >
        <div
          className={`flex w-full max-w-3xl max-h-[85vh] bg-bg-surface rounded-2xl shadow-2xl border border-border-subtle overflow-hidden ${contentClass}`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Left Navigation */}
          <div className="w-48 flex-shrink-0 border-r border-border-subtle bg-bg-surface2/30 p-3 flex flex-col gap-1">
            <div className="px-3 py-2 mb-2">
              <h2 className="text-sm font-semibold text-text-primary">设置</h2>
            </div>
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-all ${
                  activeTab === tab.key
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-text-secondary hover:bg-bg-surface2 hover:text-text-primary'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Right Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {renderContent()}
          </div>

          {/* Close Button */}
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-surface2 transition-colors"
            title="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
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

      {ConfirmModal}
    </>
  );
}
