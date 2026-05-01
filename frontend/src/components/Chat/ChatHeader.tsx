import { useState, useEffect } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useUIStore } from '../../stores/uiStore';
import { DebateControlPanel } from './DebateControlPanel';
import { GroupInfoPage } from './GroupInfoPage';

interface ChatHeaderProps {
  showGroupInfoButton?: boolean;
  onToggleGroupInfo?: () => void;
  onBack?: () => void;
}

export function ChatHeader({ showGroupInfoButton = true, onToggleGroupInfo, onBack }: ChatHeaderProps = {}) {
  const { 
    currentGroup, 
    toggleDebateMode, 
    setDebateLevel, 
    startAIPrivateChat, 
    stopAIPrivateChat,
    startAutonomousChat,
    stopAutonomousChat,
    getAutonomousChatStatus,
    chatStatus,
    updateChatStatus,
    setTypingAI,
    fetchChatStatus
  } = useGroupsStore();
  const { toggleSidebar } = useNavigationStore();
  const [showTopicModal, setShowTopicModal] = useState(false);
  const [topic, setTopic] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showDebatePanel, setShowDebatePanel] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [autonomousRunning, setAutonomousRunning] = useState(false);
  const [debateLevelAnim, setDebateLevelAnim] = useState<number | null>(null);

  const isPrivateChat = currentGroup?.is_private === true;
  const isAIPrivateChat = currentGroup?.is_ai_private === true || currentGroup?.type === 'ai_private';
  const connectionStatus = useUIStore(state => state.connectionStatus);

  const currentChatStatus = currentGroup ? chatStatus.get(currentGroup.id) : undefined;
  const isChatRunning = currentChatStatus?.isRunning || currentChatStatus?.status === 'running';

  useEffect(() => {
    if (currentGroup && isAIPrivateChat) {
      fetchChatStatus(currentGroup.id);
      if (connectionStatus !== 'connected') {
        const interval = setInterval(() => {
          fetchChatStatus(currentGroup.id);
        }, 10000);
        return () => clearInterval(interval);
      }
    }
  }, [currentGroup?.id, isAIPrivateChat, connectionStatus]);

  useEffect(() => {
    if (currentGroup && !isAIPrivateChat && !isPrivateChat) {
      getAutonomousChatStatus(currentGroup.id).then((status: any) => {
        setAutonomousRunning(status?.isRunning === true || status?.status === 'running');
      }).catch(() => {});
    }
  }, [currentGroup?.id, isAIPrivateChat, isPrivateChat]);

  useEffect(() => {
    if (!isAIPrivateChat && !isPrivateChat) {
      setAutonomousRunning(isChatRunning);
    }
  }, [isChatRunning, isAIPrivateChat, isPrivateChat]);

  if (!currentGroup) {
    return (
      <div className="h-12 glass-header flex items-center justify-center">
        <span className="text-text-muted text-sm">选择一个群组开始聊天</span>
      </div>
    );
  }

  const handleStartChat = async () => {
    setShowTopicModal(false);
    setTopic('');
    setActionLoading(true);
    updateChatStatus(currentGroup.id, { isRunning: true, currentSpeaker: null, status: 'running' });
    
    try {
      const result = await startAIPrivateChat(currentGroup.id, topic || undefined);
      if (import.meta.env.DEV) console.log('开始对话结果:', result);
    } catch (error) {
      console.error('开始对话失败:', error);
      updateChatStatus(currentGroup.id, { isRunning: false, currentSpeaker: null, status: 'stopped' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleStartAutonomousChat = async () => {
    setShowTopicModal(false);
    setTopic('');
    setActionLoading(true);
    setAutonomousRunning(true);
    
    try {
      const result = await startAutonomousChat(currentGroup.id, topic || undefined);
      if (import.meta.env.DEV) console.log('开始自主对话结果:', result);
    } catch (error) {
      console.error('开始自主对话失败:', error);
      setAutonomousRunning(false);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStopAutonomousChat = async () => {
    setActionLoading(true);
    try {
      const result = await stopAutonomousChat(currentGroup.id);
      if (import.meta.env.DEV) console.log('停止自主对话结果:', result);
      setAutonomousRunning(false);
      setTypingAI(currentGroup.id, null);
    } catch (error) {
      console.error('停止自主对话失败:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStopChat = async () => {
    setActionLoading(true);
    try {
      const result = await stopAIPrivateChat(currentGroup.id);
      if (import.meta.env.DEV) console.log('停止对话结果:', result);
      updateChatStatus(currentGroup.id, { isRunning: false, currentSpeaker: null, status: 'stopped' });
      setTypingAI(currentGroup.id, null);
    } catch (error) {
      console.error('停止私聊失败:', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleChat = () => {
    if (isChatRunning) {
      handleStopChat();
    } else {
      setShowTopicModal(true);
    }
  };

  const handleToggleAutonomous = () => {
    if (autonomousRunning) {
      handleStopAutonomousChat();
    } else {
      setShowTopicModal(true);
    }
  };

  const handleToggleDebateMode = () => {
    if (!currentGroup) return;
    toggleDebateMode(currentGroup.id);
  };

  const handleSetDebateLevel = (level: number) => {
    if (!currentGroup) return;
    setDebateLevelAnim(level);
    setTimeout(() => setDebateLevelAnim(null), 300);
    setDebateLevel(currentGroup.id, level);
  };

  return (
    <>
      <div className="glass-header">
        <div className="w-full h-12 flex items-center justify-between px-4">
          <div className="flex items-center gap-3 min-w-0">
            {onBack && (
              <button
                onClick={onBack}
                aria-label="返回"
                className="md:hidden p-2 min-w-[44px] min-h-[44px] rounded-lg hover:bg-sidebar-hover transition-colors flex-shrink-0"
              >
                <svg className="w-5 h-5 text-text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            {!onBack && (
              <button
                onClick={toggleSidebar}
                aria-label="打开侧边栏"
                className="md:hidden p-2 min-w-[44px] min-h-[44px] rounded-lg hover:bg-sidebar-hover transition-colors flex-shrink-0"
              >
                <svg className="w-5 h-5 text-text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary truncate">
                {currentGroup.name}
              </h2>
              <p className="text-[11px] text-text-muted hidden sm:block">
                {currentGroup.ai_members?.length ?? 0} 位 AI 成员
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {isAIPrivateChat && (
              <button
                onClick={handleToggleChat}
                disabled={actionLoading}
                aria-label={isChatRunning ? '停止对话' : '开始对话'}
                className="p-2 rounded-lg hover:bg-sidebar-hover transition-colors text-text-secondary hover:text-text-primary flex items-center gap-1"
                title={isChatRunning ? '停止对话' : '开始对话'}
              >
                {isChatRunning ? (
                  <svg className="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-accent" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                  </svg>
                )}
                <span className="text-xs hidden sm:inline">{isChatRunning ? '停止' : '开始'}</span>
              </button>
            )}

            {!isPrivateChat && !isAIPrivateChat && (
              <>
                <button
                  onClick={handleToggleAutonomous}
                  disabled={actionLoading}
                  aria-label={autonomousRunning ? '停止AI自主对话' : '开始AI自主对话'}
                  className="p-2 rounded-lg hover:bg-sidebar-hover transition-colors text-text-secondary hover:text-text-primary flex items-center gap-1"
                  title={autonomousRunning ? '停止AI自主对话' : '开始AI自主对话'}
                >
                  {autonomousRunning ? (
                    <div className="w-4 h-4 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                    </div>
                  ) : (
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                    </svg>
                  )}
                  <span className="text-xs hidden sm:inline">{autonomousRunning ? '停止' : 'AI对话'}</span>
                </button>

                <button
                  onClick={() => setShowDebatePanel(true)}
                  aria-label="辩论设置"
                  className="flex p-2 rounded-lg hover:bg-sidebar-hover transition-colors text-text-secondary hover:text-text-primary items-center gap-1"
                  title="辩论设置"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3l7.07 7.07M21 21l-7.07-7.07M3 21l7.07-7.07M21 3l-7.07 7.07" /></svg>
                  <span className="text-xs hidden sm:inline">辩论</span>
                </button>

                <div className="flex items-center gap-2 p-2 rounded-lg bg-bg-surface2">
                  <span className="text-[11px] text-text-muted">辩论</span>
                  <button
                    onClick={handleToggleDebateMode}
                    aria-label={currentGroup.debate_mode ? '关闭辩论模式' : '开启辩论模式'}
                    className={`relative w-9 h-[18px] rounded-full transition-all duration-200 ease-spring overflow-hidden ${
                      currentGroup.debate_mode
                        ? 'bg-accent shadow-[0_0_12px_rgba(0,102,255,0.3)]'
                        : 'bg-bg-surface3'
                    }`}
                  >
                    <span
                      className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-md transition-all duration-200 ease-spring ${
                        currentGroup.debate_mode
                          ? 'left-[calc(100%-16px)] scale-110'
                          : 'left-[2px] scale-100'
                      }`}
                      style={{
                        boxShadow: currentGroup.debate_mode
                          ? '0 2px 8px rgba(0,0,0,0.15), 0 0 0 2px rgba(0,102,255,0.2)'
                          : '0 1px 3px rgba(0,0,0,0.1)'
                      }}
                    />
                  </button>
                </div>
              </>
            )}

            {showGroupInfoButton && (
              <button
                onClick={onToggleGroupInfo || (() => setShowGroupInfo(true))}
                aria-label="群聊信息"
                className="p-2 min-w-[36px] min-h-[36px] rounded-lg hover:bg-sidebar-hover text-text-secondary hover:text-text-primary transition-colors"
                title="群聊信息"
              >
                <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {currentGroup.debate_mode && !isPrivateChat && !isAIPrivateChat && (
          <div className="h-10 flex items-center justify-center gap-3 px-4 bg-accent-subtle border-t border-border-subtle animate-slide-down">
            <span className="text-xs text-accent font-medium">辩论强度:</span>
            <div className="flex gap-1.5">
              {[1, 2, 3].map(level => (
                <button
                  key={level}
                  onClick={() => handleSetDebateLevel(level)}
                  className={`px-3 py-0.5 rounded-full text-xs font-medium transition-all duration-200 transform ${
                    currentGroup.debate_level === level
                      ? 'bg-accent text-white shadow-md scale-105'
                      : 'bg-bg-surface2 text-text-secondary hover:bg-bg-surface3 hover:scale-105'
                  } ${debateLevelAnim === level ? 'debate-level-anim' : ''}`}
                >
                  {level === 1 ? <><svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" /></svg> 温和</> : level === 2 ? <><svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3l7.07 7.07M21 21l-7.07-7.07M3 21l7.07-7.07M21 3l-7.07 7.07" /></svg> 标准</> : <><svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" /></svg> 激烈</>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {showDebatePanel && currentGroup && (
        <DebateControlPanel
          groupId={currentGroup.id}
          isOpen={showDebatePanel}
          onClose={() => setShowDebatePanel(false)}
        />
      )}

      {showTopicModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-bg-surface rounded-2xl p-5 w-full max-w-md shadow-2xl animate-fade-in border border-border">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-accent flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" /></svg>
              </div>
              <div>
                <h3 className="text-base font-semibold text-text-primary">
                  {isAIPrivateChat ? '开始AI对话' : '启动AI自主对话'}
                </h3>
                <p className="text-xs text-text-muted">
                  {isAIPrivateChat 
                    ? '设置话题让AI围绕主题讨论'
                    : '让AI们自己开始聊天'}
                </p>
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                话题 <span className="text-text-muted font-normal">(可选)</span>
              </label>
              <textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如：讨论人工智能的未来发展..."
                className="w-full px-3 py-2 border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none transition-all text-text-primary bg-bg-surface text-sm"
                rows={2}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowTopicModal(false);
                  setTopic('');
                }}
                className="flex-1 px-4 py-2 border border-border rounded-xl text-text-secondary hover:bg-bg-surface2 transition-all text-sm font-medium"
              >
                取消
              </button>
              <button
                onClick={isAIPrivateChat ? handleStartChat : handleStartAutonomousChat}
                disabled={actionLoading}
                className="flex-1 px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm font-medium"
              >
                {actionLoading ? <><svg className="w-3.5 h-3.5 animate-spin inline" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg> 处理中...</> : <><svg className="w-3.5 h-3.5 inline" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg> 开始</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {showGroupInfo && currentGroup && (
        <GroupInfoPage
          groupId={currentGroup.id}
          isOpen={showGroupInfo}
          onClose={() => setShowGroupInfo(false)}
        />
      )}
    </>
  );
}
