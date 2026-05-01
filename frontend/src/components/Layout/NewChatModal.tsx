import { useState, useEffect, useRef } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { AI_COLORS, AI_NAMES, AI_AVATAR_LETTERS, AI_LIST } from '../../types';
import { useToast } from '../Common';

const CHATTABLE_AI_LIST: string[] = AI_LIST.filter(id => id !== 'mimo_tts');

const GROUP_AVATAR_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef',
  '#f43f5e', '#14b8a6', '#0ea5e9', '#a855f7', '#ec4899'
];

interface NewChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectGroup: (groupId: string) => void;
}

type ChatTab = 'private' | 'aiPrivate' | 'group';

export function NewChatModal({ isOpen, onClose, onSelectGroup }: NewChatModalProps) {
  const { createGroup, getOrCreatePrivateChat, createAIPrivateChat } = useGroupsStore();
  const { personas } = usePersonasStore();
  const { showToast, Toast } = useToast();

  const [activeTab, setActiveTab] = useState<ChatTab>('private');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [selectedAiMembers, setSelectedAiMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [aiPrivateChatName, setAiPrivateChatName] = useState('');
  const [aiPrivateTopic, setAiPrivateTopic] = useState('');
  const [selectedAiPrivateMembers, setSelectedAiPrivateMembers] = useState<string[]>([]);
  const [creatingAiPrivate, setCreatingAiPrivate] = useState(false);

  const [groupAvatarUrl, setGroupAvatarUrl] = useState<string | null>(null);
  const [groupAvatarColor, setGroupAvatarColor] = useState<string | null>(null);
  const [avatarMode, setAvatarMode] = useState<'auto' | 'color' | 'upload'>('auto');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [modalVisible, setModalVisible] = useState(false);
  const [modalClosing, setModalClosing] = useState(false);
  const [isCreatingPrivate, setIsCreatingPrivate] = useState(false);

  const getPersona = (id: string) => {
    const personaMap = personas as Record<string, typeof personas[string]>;
    return personaMap[id];
  };

  useEffect(() => {
    if (isOpen) {
      setModalClosing(false);
      requestAnimationFrame(() => setModalVisible(true));
    } else {
      if (modalVisible) {
        setModalClosing(true);
        setModalVisible(false);
        const timer = setTimeout(() => setModalClosing(false), 250);
        return () => clearTimeout(timer);
      }
    }
  }, [isOpen]);

  const handleClose = () => {
    setModalClosing(true);
    setModalVisible(false);
    setTimeout(() => {
      setModalClosing(false);
      onClose();
    }, 250);
  };

  const resetForm = () => {
    setNewGroupName('');
    setNewGroupDesc('');
    setSelectedAiMembers([]);
    setAiPrivateChatName('');
    setAiPrivateTopic('');
    setSelectedAiPrivateMembers([]);
    setGroupAvatarUrl(null);
    setGroupAvatarColor(null);
    setAvatarMode('auto');
  };

  const toggleAiMember = (aiId: string) => {
    setSelectedAiMembers(prev =>
      prev.includes(aiId) ? prev.filter(id => id !== aiId) : [...prev, aiId]
    );
  };

  const toggleAiPrivateMember = (aiId: string) => {
    setSelectedAiPrivateMembers(prev => {
      if (prev.includes(aiId)) {
        return prev.filter(id => id !== aiId);
      }
      if (prev.length >= 5) {
        showToast({ message: '最多选择 5 个 AI', type: 'warning' });
        return prev;
      }
      return [...prev, aiId];
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast({ message: '头像大小不能超过 2MB', type: 'error' });
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      setGroupAvatarUrl(event.target?.result as string);
      setGroupAvatarColor(null);
      setAvatarMode('upload');
    };
    reader.readAsDataURL(file);
  };

  const handleSelectColor = (color: string) => {
    setGroupAvatarColor(color);
    setGroupAvatarUrl(null);
    setAvatarMode('color');
  };

  const getAvatarToUse = (): string | undefined => {
    if (avatarMode === 'upload' && groupAvatarUrl) return groupAvatarUrl;
    if (avatarMode === 'color' && groupAvatarColor) return undefined;
    return undefined;
  };

  const renderGroupAvatarPreview = () => {
    const displayName = newGroupName.trim() || '群';
    const firstLetter = displayName[0].toUpperCase();

    if (avatarMode === 'upload' && groupAvatarUrl) {
      return (
        <img src={groupAvatarUrl} alt="头像预览" className="w-full h-full object-cover" />
      );
    }

    if (avatarMode === 'color' && groupAvatarColor) {
      return (
        <div
          className="w-full h-full flex items-center justify-center text-white text-xl font-bold"
          style={{ backgroundColor: groupAvatarColor }}
        >
          {firstLetter}
        </div>
      );
    }

    if (selectedAiMembers.length === 0) {
      return (
        <div className="w-full h-full bg-gradient-to-br from-bg-surface3 to-bg-surface4 flex items-center justify-center text-text-muted">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </div>
      );
    }

    if (selectedAiMembers.length === 1) {
      const aiId = selectedAiMembers[0];
      const persona = getPersona(aiId);
      const avatarColor = persona?.color || AI_COLORS[aiId];
      const avatarUrl = persona?.avatar_url;
      const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];
      return (
        <div
          className="w-full h-full flex items-center justify-center text-white text-lg font-bold"
          style={{
            backgroundColor: avatarUrl ? 'transparent' : avatarColor,
            backgroundImage: avatarUrl ? `url(${avatarUrl})` : 'none',
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          {!avatarUrl && avatarLetter.toUpperCase()}
        </div>
      );
    }

    const getLayoutClass = () => {
      const count = selectedAiMembers.length;
      if (count === 2) return 'grid-cols-2 grid-rows-1';
      if (count === 3) return 'grid-cols-3 grid-rows-1';
      return 'grid-cols-2 grid-rows-2';
    };

    const displayMembers = selectedAiMembers.slice(0, 4);

    return (
      <div className={`w-full h-full grid ${getLayoutClass()} gap-px bg-bg-surface3 p-0.5`}>
        {displayMembers.map((aiId: string) => {
          const persona = getPersona(aiId);
          const avatarColor = persona?.color || AI_COLORS[aiId];
          const avatarUrl = persona?.avatar_url;
          const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];
          return (
            <div
              key={aiId}
              className="flex items-center justify-center text-white text-[8px] font-bold overflow-hidden"
              style={{
                backgroundColor: avatarUrl ? 'transparent' : avatarColor,
                backgroundImage: avatarUrl ? `url(${avatarUrl})` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}
            >
              {!avatarUrl && avatarLetter.toUpperCase()}
            </div>
          );
        })}
      </div>
    );
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim() || selectedAiMembers.length < 2) return;
    setCreating(true);
    try {
      const avatarUrl = getAvatarToUse();
      const group = await createGroup(newGroupName, newGroupDesc || '新的对话', selectedAiMembers, avatarUrl || undefined);
      resetForm();
      handleClose();
      onSelectGroup(group.id);
    } catch (error) {
      showToast({ message: '创建群聊失败', type: 'error' });
    } finally {
      setCreating(false);
    }
  };

  const handleCreatePrivateChat = async (aiId: string) => {
    if (isCreatingPrivate) return;
    setIsCreatingPrivate(true);
    try {
      const group = await getOrCreatePrivateChat(aiId);
      resetForm();
      handleClose();
      onSelectGroup(group.id);
    } catch (error) {
      console.error('创建私聊失败:', error);
      showToast({ message: '创建私聊失败', type: 'error' });
    } finally {
      setIsCreatingPrivate(false);
    }
  };

  const handleCreateAiPrivateChat = async () => {
    if (selectedAiPrivateMembers.length < 2) {
      showToast({ message: '请至少选择2个AI', type: 'warning' });
      return;
    }
    setCreatingAiPrivate(true);
    try {
      const group = await createAIPrivateChat(
        selectedAiPrivateMembers,
        aiPrivateTopic || undefined,
        aiPrivateChatName || undefined
      );
      resetForm();
      handleClose();
      onSelectGroup(group.id);
    } catch (error) {
      console.error('创建AI私聊失败:', error);
      showToast({ message: '创建AI私聊失败', type: 'error' });
    } finally {
      setCreatingAiPrivate(false);
    }
  };

  if (!isOpen && !modalClosing) return null;

  const renderAiAvatar = (aiId: string, size: string = 'w-6 h-6', textSize: string = 'text-[10px]') => {
    const persona = getPersona(aiId);
    return (
      <div
        className={`${size} rounded-full flex items-center justify-center text-white ${textSize} font-semibold flex-shrink-0 overflow-hidden`}
        style={{
          backgroundColor: persona?.avatar_url ? 'transparent' : (persona?.color || AI_COLORS[aiId] || AI_COLORS[aiId] || '#888'),
          backgroundImage: persona?.avatar_url ? `url(${persona?.avatar_url})` : 'none',
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }}
      >
        {!persona?.avatar_url && (AI_AVATAR_LETTERS[aiId] || aiId.charAt(0).toUpperCase())}
      </div>
    );
  };

  const getAiName = (aiId: string) => {
    const persona = getPersona(aiId);
    return persona?.name || AI_NAMES[aiId] || aiId;
  };

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 p-4 transition-opacity duration-200 ${
        modalVisible && !modalClosing ? 'opacity-100' : 'opacity-0'
      } bg-black/50 backdrop-blur-sm`}
      onClick={handleClose}
    >
      <div
        className={`bg-bg-surface rounded-lg p-6 w-full max-w-[520px] shadow-xl animate-fade-in max-h-[90vh] overflow-y-auto transition-all duration-[250ms] ${
          modalVisible && !modalClosing ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
        style={{
          transitionTimingFunction: modalVisible && !modalClosing
            ? 'cubic-bezier(0.175, 0.885, 0.32, 1.275)'
            : 'cubic-bezier(0.4, 0.0, 1, 1)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-text-primary mb-4">新建聊天</h3>

        <div className="flex gap-1 mb-4 border-b border-border-subtle overflow-x-auto">
          <button
            onClick={() => setActiveTab('private')}
            className={`px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'private'
                ? 'text-user border-b-2 border-user'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            AI 私聊
          </button>
          <button
            onClick={() => setActiveTab('aiPrivate')}
            className={`px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'aiPrivate'
                ? 'text-user border-b-2 border-user'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            AI 与 AI 私聊
          </button>
          <button
            onClick={() => setActiveTab('group')}
            className={`px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'group'
                ? 'text-user border-b-2 border-user'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            创建群聊
          </button>
        </div>

        {activeTab === 'private' && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted mb-3">选择一个AI开始一对一私聊</p>
            <div className="grid grid-cols-3 gap-3">
              {CHATTABLE_AI_LIST.map(aiId => (
                <button
                  key={aiId}
                  onClick={() => handleCreatePrivateChat(aiId)}
                  className="flex flex-col items-center gap-2 p-3 rounded-xl bg-bg-surface2 border border-border-subtle hover:border-accent/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
                >
                  {renderAiAvatar(aiId, 'w-10 h-10', 'text-sm')}
                  <span className="text-xs text-text-secondary truncate w-full text-center">
                    {getAiName(aiId)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'aiPrivate' && (
          <div className="space-y-4">
            <p className="text-sm text-text-muted">选择 2-5 个 AI 成员，它们可以围绕话题私聊。</p>

            <div>
              <label className="block text-xs text-text-secondary mb-1.5">聊天名称（可选）</label>
              <input
                type="text"
                value={aiPrivateChatName}
                onChange={(e) => setAiPrivateChatName(e.target.value)}
                placeholder="输入聊天名称，留空则自动生成"
                className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1.5">话题（可选）</label>
              <input
                type="text"
                value={aiPrivateTopic}
                onChange={(e) => setAiPrivateTopic(e.target.value)}
                placeholder="输入聊天话题"
                className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-text-secondary">选择 AI 成员 <span className="text-text-muted">（2-5 个）</span></label>
                <span className="text-xs text-text-muted">{selectedAiPrivateMembers.length}/5</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {CHATTABLE_AI_LIST.map(aiId => {
                  const isSelected = selectedAiPrivateMembers.includes(aiId);
                  return (
                    <button
                      key={aiId}
                      onClick={() => toggleAiPrivateMember(aiId)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all ${
                        isSelected
                          ? 'border-accent ring-2 ring-accent/20 bg-accent-subtle'
                          : 'border-border-subtle bg-bg-surface2'
                      }`}
                    >
                      {renderAiAvatar(aiId, 'w-6 h-6', 'text-[10px]')}
                      <span className="text-xs">{getAiName(aiId)}</span>
                      {isSelected && <span className="text-accent">✓</span>}
                    </button>
                  );
                })}
              </div>
              {selectedAiPrivateMembers.length < 2 && (
                <p className="text-[11px] text-red-500 mt-1">请至少选择 2 个 AI 成员</p>
              )}
            </div>

            <button
              onClick={handleCreateAiPrivateChat}
              disabled={creatingAiPrivate || selectedAiPrivateMembers.length < 2}
              className="w-full py-2.5 rounded-[10px] bg-accent hover:bg-accent-hover text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {creatingAiPrivate ? '创建中...' : '创建 AI 私聊'}
            </button>
          </div>
        )}

        {activeTab === 'group' && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex flex-col items-center gap-1.5">
                <div className="w-14 h-14 rounded-xl overflow-hidden shadow-sm border border-border-subtle">
                  {renderGroupAvatarPreview()}
                </div>
                <span className="text-[10px] text-text-muted">头像预览</span>
              </div>
              <div className="flex-1 space-y-2">
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setAvatarMode('auto')}
                    className={`px-2.5 py-1 text-[11px] rounded-md border transition-all ${
                      avatarMode === 'auto'
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-border-subtle text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    AI 拼接
                  </button>
                  <button
                    onClick={() => setAvatarMode('color')}
                    className={`px-2.5 py-1 text-[11px] rounded-md border transition-all ${
                      avatarMode === 'color'
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-border-subtle text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    纯色
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={`px-2.5 py-1 text-[11px] rounded-md border transition-all ${
                      avatarMode === 'upload'
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-border-subtle text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    上传图片
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </div>
                {avatarMode === 'color' && (
                  <div className="flex flex-wrap gap-1.5">
                    {GROUP_AVATAR_COLORS.map(color => (
                      <button
                        key={color}
                        onClick={() => handleSelectColor(color)}
                        className={`w-6 h-6 rounded-full border-2 transition-all ${
                          groupAvatarColor === color ? 'border-text-primary scale-110' : 'border-transparent hover:scale-105'
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1.5">群聊名称</label>
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="输入群聊名称"
                className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1.5">描述（可选）</label>
              <input
                type="text"
                value={newGroupDesc}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                placeholder="输入群聊描述"
                className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-text-secondary">选择 AI 成员 <span className="text-text-muted">（至少 2 个）</span></label>
                <span className="text-xs text-text-muted">{selectedAiMembers.length}/9</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {CHATTABLE_AI_LIST.map(aiId => {
                  const isSelected = selectedAiMembers.includes(aiId);
                  return (
                    <button
                      key={aiId}
                      onClick={() => toggleAiMember(aiId)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all ${
                        isSelected
                          ? 'border-accent ring-2 ring-accent/20 bg-accent-subtle'
                          : 'border-border-subtle bg-bg-surface2'
                      }`}
                    >
                      {renderAiAvatar(aiId, 'w-6 h-6', 'text-[10px]')}
                      <span className="text-xs">{getAiName(aiId)}</span>
                      {isSelected && <span className="text-accent">✓</span>}
                    </button>
                  );
                })}
              </div>
              {selectedAiMembers.length < 2 && (
                <p className="text-[11px] text-red-500 mt-1">请至少选择 2 个 AI 成员</p>
              )}
            </div>

            <button
              onClick={handleCreateGroup}
              disabled={creating || !newGroupName.trim() || selectedAiMembers.length < 2}
              className="w-full py-2.5 rounded-[10px] bg-accent hover:bg-accent-hover text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {creating ? '创建中...' : '创建群聊'}
            </button>
          </div>
        )}

        <div className="flex justify-end mt-6">
          <button
            onClick={handleClose}
            className="px-4 py-2 border border-border rounded-lg text-text-secondary hover:bg-bg-surface2 transition-all duration-200"
          >
            取消
          </button>
        </div>
      </div>
      {Toast}
    </div>
  );
}

