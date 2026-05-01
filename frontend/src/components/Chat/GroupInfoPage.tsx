import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { useMessagesStoreInternal } from '../../stores/messagesStore';
import { AI_NAMES, AI_COLORS, AI_AVATAR_LETTERS, AI_LIST, GroupFile } from '../../types';
import { formatFileSize, getFileTypeIcon } from './AttachmentStack';
import { api } from '../../services/api';
import { sanitizeUrl } from '../../utils/sanitizeUrl';
import { useConfirm, useToast } from '../Common';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

const GROUP_AVATAR_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef',
  '#f43f5e', '#14b8a6', '#0ea5e9', '#a855f7', '#ec4899'
];

type SearchFilterType = 'all' | 'member' | 'date' | 'media' | 'file';

interface GroupInfoPageProps {
  groupId: string;
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'info' | 'members' | 'search' | 'files' | 'settings';

export function GroupInfoPage({ groupId, isOpen, onClose }: GroupInfoPageProps) {
  const {
    groups,
    updateGroupSettings,
    pinGroup,
    selectGroup,
    deleteGroup,
    addGroupMember,
    removeGroupMember
  } = useGroupsStore();
  const { personas } = usePersonasStore();
  const allMessages = useMessagesStoreInternal((state) => state.messages);
  const clearAllMessages = useMessagesStoreInternal((state) => state.clearAllMessages);
  const messages = allMessages[groupId] || [];
  const [activeTab, setActiveTab] = useState<TabType>('info');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilter, setSearchFilter] = useState<SearchFilterType>('all');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [editingAnnouncement, setEditingAnnouncement] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearingMessages, setClearingMessages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<GroupFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { confirm, ConfirmModal } = useConfirm();
  const { showToast, Toast } = useToast();
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [showAvatarColorPicker, setShowAvatarColorPicker] = useState(false);

  const isDirty = editingName || editingDesc || editingAnnouncement;

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const group = groups.find(g => g.id === groupId);

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      setIsClosing(false);
    } else {
      setIsVisible(false);
      setIsClosing(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (activeTab === 'files' && group) {
      loadFiles();
    }
  }, [activeTab, groupId]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsVisible(false);
      setIsClosing(false);
      onClose();
    }, 300);
  };

  const loadFiles = async () => {
    setLoadingFiles(true);
    try {
      const fileList = await api.getGroupFiles(groupId);
      setFiles(fileList);
    } catch (error) {
      console.error('加载文件失败:', error);
      setFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  };

  if (!isOpen || !group) return null;

  const handleUpdateAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      showToast({ message: '头像大小不能超过2MB', type: 'error' });
      return;
    }

    setIsUploadingAvatar(true);
    const reader = new FileReader();
    reader.onload = async (event) => {
      const avatarUrl = event.target?.result as string;
      try {
        await api.updateGroupSettings(groupId, { avatar_url: avatarUrl });
        updateGroupSettings(groupId, { avatar_url: avatarUrl });
        setShowAvatarColorPicker(false);
      } catch (error) {
        console.error('更新头像失败:', error);
        showToast({ message: '更新头像失败，请重试', type: 'error' });
      } finally {
        setIsUploadingAvatar(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleUpdateAvatarColor = async (color: string) => {
    try {
      await api.updateGroupSettings(groupId, { avatar_url: null, avatar_color: color });
      updateGroupSettings(groupId, { avatar_url: null, avatar_color: color });
      setShowAvatarColorPicker(false);
    } catch (error) {
      console.error('更新头像颜色失败:', error);
      showToast({ message: '更新头像颜色失败，请重试', type: 'error' });
    }
  };

  const handleUpdateBackground = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await api.uploadBackground(groupId, file);
      updateGroupSettings(groupId, { background_url: result.background_url });
    } catch (error) {
      console.error('上传背景失败:', error);
    } finally {
      setUploading(false);
    }
  };

  const handleResetBackground = async () => {
    try {
      await api.updateGroupSettings(groupId, { background_url: '' });
      updateGroupSettings(groupId, { background_url: '' });
    } catch (error) {
      console.error('重置背景失败:', error);
    }
  };

  const handleSaveName = async () => {
    if (!groupName.trim()) return;
    setSaving(true);
    try {
      await api.updateGroupSettings(groupId, { name: groupName.trim() });
      updateGroupSettings(groupId, { name: groupName.trim() });
      setEditingName(false);
    } catch (error) {
      console.error('保存名称失败:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDesc = async () => {
    setSaving(true);
    try {
      await api.updateGroupSettings(groupId, { description: groupDesc.trim() });
      updateGroupSettings(groupId, { description: groupDesc.trim() });
      setEditingDesc(false);
    } catch (error) {
      console.error('保存描述失败:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAnnouncement = async () => {
    setSaving(true);
    try {
      await api.updateGroupSettings(groupId, { announcement });
      updateGroupSettings(groupId, { announcement });
      setEditingAnnouncement(false);
    } catch (error) {
      console.error('保存公告失败:', error);
      showToast({ message: '保存公告失败，请重试', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveMember = async (aiId: string) => {
    const name = AI_NAMES[aiId] || aiId;
    const confirmed = await confirm({ title: '移除成员', description: `确定要移除${name} 吗？`, danger: true });
    if (!confirmed) return;
    try {
      await removeGroupMember(groupId, aiId);
      showToast({ message: '成员已移除', type: 'success' });
    } catch (error) {
      console.error('移除成员失败:', error);
    }
  };

  const handleAddMember = async (aiId: string) => {
    try {
      await addGroupMember(groupId, aiId);
      showToast({ message: '成员已添加', type: 'success' });
    } catch (error) {
      console.error('添加成员失败:', error);
    }
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
      showToast({ message: '文件大小不能超过50MB', type: 'error' });
      return;
    }

    setUploading(true);
    try {
      const newFile = await api.uploadGroupFile(groupId, file);
      if (newFile) {
        setFiles(prev => [newFile, ...prev]);
      }
      await loadFiles();
      showToast({ message: '文件上传成功', type: 'success' });
    } catch (error) {
      console.error('上传文件失败:', error);
      showToast({ message: '文件上传失败', type: 'error' });
    } finally {
      setUploading(false);
      if (uploadFileInputRef.current) {
        uploadFileInputRef.current.value = '';
      }
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    const confirmed = await confirm({ title: '删除文件', description: '确定要删除这个文件吗？', danger: true });
    if (!confirmed) return;
    try {
      await api.deleteGroupFile(groupId, fileId);
      setFiles(prev => prev.filter(f => f.id !== fileId));
      showToast({ message: '文件已删除', type: 'success' });
    } catch (error) {
      console.error('删除文件失败:', error);
    }
  };

  const handleClearFiles = async () => {
    const confirmed = await confirm({ title: '清空文件', description: '确定要清空所有共享文件吗？此操作不可恢复？', danger: true });
    if (!confirmed) return;
    try {
      for (const file of files) {
        await api.deleteGroupFile(groupId, file.id);
      }
      setFiles([]);
      showToast({ message: '所有文件已清空', type: 'success' });
    } catch (error) {
      console.error('清空文件失败:', error);
    }
  };

  const handleDeleteGroup = async () => {
    const confirmed = await confirm({ title: '删除群组', description: '确定要删除这个群组吗？所有聊天记录和文件将被清除？', danger: true });
    if (!confirmed) return;
    try {
      await deleteGroup(groupId);
      selectGroup('');
      showToast({ message: '群组已删除', type: 'success' });
      onClose();
    } catch (error) {
      console.error('删除群组失败:', error);
    }
  };

  const handleDeleteMemory = async (aiName: string) => {
    const confirmed = await confirm({ title: '清除记忆', description: `确定要清除${aiName} 的记忆吗？`, danger: true });
    if (!confirmed) return;
    try {
      await api.clearMemories();
      showToast({ message: '记忆已清除', type: 'success' });
    } catch (error) {
      console.error('清除记忆失败:', error);
    }
  };



  const getFileIcon = (type: string): ReactNode => {
    const { icon } = getFileTypeIcon(type);
    return <span className="text-base">{icon}</span>;
  };

  const filteredMessages = useMemo(() => {
    let result = messages;

    if (searchQuery) {
      result = result.filter(m =>
        m.content.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    if (searchFilter === 'member' && selectedMemberId) {
      if (selectedMemberId === 'user') {
        result = result.filter(m => m.sender_type === 'user');
      } else {
        result = result.filter(m => m.sender_id === selectedMemberId);
      }
    }

    if (searchFilter === 'date' && selectedDate) {
      result = result.filter(m =>
        dayjs(m.created_at).format('YYYY-MM-DD') === selectedDate
      );
    }

    if (searchFilter === 'media') {
      result = result.filter(m =>
        m.attachments?.some(a => a.type?.startsWith('image/') || a.type?.startsWith('video/'))
      );
    }

    if (searchFilter === 'file') {
      result = result.filter(m =>
        m.attachments?.some(a =>
          !a.type?.startsWith('image/') && !a.type?.startsWith('video/')
        )
      );
    }

    return result;
  }, [messages, searchQuery, searchFilter, selectedMemberId, selectedDate]);

  const availableDates = useMemo(() => {
    const dateSet = new Set<string>();
    messages.forEach(m => {
      dateSet.add(dayjs(m.created_at).format('YYYY-MM-DD'));
    });
    return Array.from(dateSet).sort().reverse();
  }, [messages]);

  const aiMembers = group.ai_members || [];
  const allAIs = [...AI_LIST].filter(id => id !== 'mimo_tts');
  const availableAIs = allAIs.filter(ai => !aiMembers.includes(ai));
  const isAIPrivateChat = group.is_ai_private === true || group.type === 'ai_private';

  const groupMembers = useMemo(() => {
    const members: { id: string; name: string; color: string; letter: string; avatarUrl?: string | null }[] = [
      { id: 'user', name: '我', color: '#171717', letter: '我' }
    ];
    aiMembers.forEach((aiId: string) => {
      const persona = personas[aiId];
      members.push({
        id: aiId,
        name: persona?.name || AI_NAMES[aiId] || aiId,
        color: persona?.color || AI_COLORS[aiId] || '#737373',
        letter: AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0],
        avatarUrl: persona?.avatar_url
      });
    });
    if (memberSearchQuery) {
      return members.filter(m =>
        m.name.toLowerCase().includes(memberSearchQuery.toLowerCase()) ||
        m.id.toLowerCase().includes(memberSearchQuery.toLowerCase())
      );
    }
    return members;
  }, [aiMembers, personas, memberSearchQuery]);

  const tabs = [
    { key: 'info', label: '基本信息' },
    ...(isAIPrivateChat ? [] : [{ key: 'members', label: '成员管理' }]),
    { key: 'search', label: '聊天记录' },
    { key: 'files', label: '文件管理' },
    { key: 'settings', label: '设置' }
  ];

  return (
    <div 
      className={`fixed inset-0 flex z-50 transition-opacity duration-200 ${
        isVisible && !isClosing ? 'opacity-100' : 'opacity-0'
      } bg-black/50`}
      onClick={handleClose}
    >
      <div 
        className={`bg-bg-surface overflow-hidden flex flex-col transition-all duration-300 w-full h-full md:w-auto md:h-auto md:max-w-lg md:max-h-[85vh] md:rounded-2xl md:shadow-2xl md:border md:border-border-subtle md:mx-auto md:my-auto ${
          isVisible && !isClosing 
            ? 'translate-y-0 md:scale-100' 
            : 'translate-y-full md:scale-95'
        }`}
        style={{
          transitionTimingFunction: isVisible && !isClosing 
            ? 'cubic-bezier(0.0, 0.0, 0.2, 1)' 
            : 'cubic-bezier(0.4, 0.0, 1, 1)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <h2 className="text-lg font-semibold text-text-primary">群聊信息</h2>
          <button
            onClick={handleClose}
            className="w-8 h-8 rounded-full hover:bg-bg-surface2 flex items-center justify-center text-text-muted"
          >
            ×
          </button>
        </div>

        <div className="flex border-b border-border-subtle overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as TabType)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.key
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'info' && (
            <div className="space-y-6">
              <div className="flex flex-col items-center">
                <div
                  className="w-20 h-20 rounded-xl overflow-hidden shadow-md cursor-pointer hover:opacity-80 transition-opacity relative"
                  onClick={() => !isUploadingAvatar && fileInputRef.current?.click()}
                >
                  {isUploadingAvatar && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
                      <svg className="animate-spin w-6 h-6 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                  )}
                  {group.avatar_url ? (
                    <img src={sanitizeUrl(group.avatar_url)} alt={group.name} className="w-full h-full object-cover" />
                  ) : (
                    <div
                      className="w-full h-full flex items-center justify-center text-white text-2xl font-bold"
                      style={{
                        backgroundColor: (group as any).avatar_color || '#22c55e'
                      }}
                    >
                      {group.name[0]?.toUpperCase()}
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleUpdateAvatar}
                  className="hidden"
                />
                <div className="flex items-center gap-2 mt-2">
                  <p className="text-xs text-text-muted">点击更换群头像</p>
                  <button
                    onClick={() => setShowAvatarColorPicker(!showAvatarColorPicker)}
                    className="text-xs text-accent hover:underline"
                  >
                    选颜色                  </button>
                </div>
                {showAvatarColorPicker && (
                  <div className="mt-2 p-2 bg-bg-surface2 rounded-lg border border-border-subtle">
                    <div className="flex flex-wrap gap-1.5 max-w-[200px]">
                      {GROUP_AVATAR_COLORS.map(color => (
                        <button
                          key={color}
                          onClick={() => handleUpdateAvatarColor(color)}
                          className={`w-7 h-7 rounded-full border-2 transition-all ${
                            (group as any).avatar_color === color ? 'border-text-primary scale-110' : 'border-transparent hover:scale-105'
                          }`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="bg-bg-surface border border-border-subtle rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-text-muted">群聊名称</label>
                    {!editingName && (
                      <button
                        onClick={() => {
                          setGroupName(group.name);
                          setEditingName(true);
                        }}
                        className="text-xs text-accent hover:underline"
                      >
                        编辑
                      </button>
                    )}
                  </div>
                  {editingName ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder="输入群聊名称..."
                        className="w-full px-3 py-2 border border-border-subtle rounded-[10px] focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 bg-bg-surface2 text-text-primary"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setEditingName(false)}
                          className="flex-1 px-3 py-1.5 text-sm btn-secondary"
                        >
                          取消
                        </button>
                        <button
                          onClick={handleSaveName}
                          disabled={saving || !groupName.trim()}
                          className="flex-1 px-3 py-1.5 text-sm btn-primary"
                        >
                          {saving ? '保存中...' : '保存'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-text-primary font-medium">{group.name}</p>
                  )}
                </div>

                <div className="bg-bg-surface border border-border-subtle rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-text-muted">群聊描述</label>
                    {!editingDesc && (
                      <button
                        onClick={() => {
                          setGroupDesc(group.description || '');
                          setEditingDesc(true);
                        }}
                        className="text-xs text-accent hover:underline"
                      >
                        编辑
                      </button>
                    )}
                  </div>
                  {editingDesc ? (
                    <div className="space-y-2">
                      <textarea
                        value={groupDesc}
                        onChange={(e) => setGroupDesc(e.target.value)}
                        placeholder="输入群聊描述..."
                        className="w-full px-3 py-2 border border-border-subtle rounded-[10px] focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none bg-bg-surface2 text-text-primary"
                        rows={2}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => setEditingDesc(false)}
                          className="flex-1 px-3 py-1.5 text-sm btn-secondary"
                        >
                          取消
                        </button>
                        <button
                          onClick={handleSaveDesc}
                          disabled={saving}
                          className="flex-1 px-3 py-1.5 text-sm btn-primary"
                        >
                          {saving ? '保存中...' : '保存'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-text-primary">{group.description || '暂无描述'}</p>
                  )}
                </div>

                <div className="bg-bg-surface border border-border-subtle rounded-xl p-3">
                  <label className="text-xs text-text-muted">创建时间</label>
                  <p className="text-text-primary">
                    {dayjs(group.created_at).format('YYYY年M月D日 HH:mm')}
                  </p>
                </div>

                <div className="bg-bg-surface border border-border-subtle rounded-xl p-3">
                  <label className="text-xs text-text-muted">成员数量</label>
                  <p className="text-text-primary">{aiMembers.length} 个AI</p>
                </div>
              </div>

              <div className="bg-bg-surface border border-border-subtle rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-text-muted">群公告</label>
                  {!editingAnnouncement && (
                    <button
                      onClick={() => {
                        setAnnouncement(group.announcement || '');
                        setEditingAnnouncement(true);
                      }}
                      className="text-xs text-accent hover:underline"
                    >
                      编辑
                    </button>
                  )}
                </div>
                {editingAnnouncement ? (
                  <div className="space-y-2">
                    <textarea
                      value={announcement}
                      onChange={(e) => setAnnouncement(e.target.value)}
                      placeholder="输入群公告..."
                      className="w-full px-3 py-2 border border-border-subtle rounded-[10px] focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none bg-bg-surface2 text-text-primary"
                      rows={3}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditingAnnouncement(false)}
                        className="flex-1 px-3 py-1.5 text-sm btn-secondary"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveAnnouncement}
                        disabled={saving}
                        className="flex-1 px-3 py-1.5 text-sm btn-primary"
                      >
                        {saving ? '保存中...' : '保存'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-text-primary text-sm">
                    {group.announcement || '暂无群公告'}
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'members' && (
            <div className="space-y-4">
              {aiMembers.length === 0 ? (
                <div className="text-center py-8 text-text-muted">
                  <div className="mb-2"><svg className="w-10 h-10 mx-auto text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg></div>
                  <p>暂无成员</p>
                  <p className="text-xs mt-1">在下方添加AI成员开始对话</p>
                </div>
              ) : (
                <div>
                  <h3 className="text-sm font-semibold text-text-primary mb-3">当前成员 ({aiMembers.length})</h3>
                  <div className="space-y-2">
                    {aiMembers.map((aiId: string) => {
                      const persona = personas[aiId];
                      const avatarColor = persona?.color || AI_COLORS[aiId];
                      const avatarUrl = persona?.avatar_url;
                      const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];
                      
                      return (
                        <div key={aiId} className="flex items-center justify-between p-3 bg-bg-surface border border-border-subtle rounded-xl hover:bg-sidebar-hover transition-colors duration-150">
                          <div className="flex items-center gap-3">
                            <div
                              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold overflow-hidden"
                              style={{ 
                                backgroundColor: avatarUrl ? 'transparent' : avatarColor,
                                backgroundImage: avatarUrl ? `url(${sanitizeUrl(avatarUrl)})` : 'none',
                                backgroundSize: 'cover',
                                backgroundPosition: 'center'
                              }}
                            >
                              {!avatarUrl && avatarLetter.toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-text-primary">
                                {persona?.name || AI_NAMES[aiId]}
                              </p>
                              <p className="text-xs text-text-muted">{aiId}</p>
                            </div>
                          </div>
                          {aiMembers.length > 2 && (
                            <button
                              onClick={() => handleRemoveMember(aiId)}
                              className="p-2 rounded-lg hover:bg-sidebar-hover text-xs text-red-500"
                            >
                              移除
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {availableAIs.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-text-primary mb-3">添加成员</h3>
                  <div className="space-y-2">
                    {availableAIs.map((aiId) => {
                      const persona = personas[aiId];
                      const avatarColor = persona?.color || AI_COLORS[aiId];
                      const avatarUrl = persona?.avatar_url;
                      const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];
                      
                      return (
                        <div key={aiId} className="flex items-center justify-between p-3 bg-bg-surface border border-border-subtle rounded-xl hover:bg-sidebar-hover transition-colors duration-150">
                          <div className="flex items-center gap-3">
                            <div
                              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold overflow-hidden"
                              style={{ 
                                backgroundColor: avatarUrl ? 'transparent' : avatarColor,
                                backgroundImage: avatarUrl ? `url(${sanitizeUrl(avatarUrl)})` : 'none',
                                backgroundSize: 'cover',
                                backgroundPosition: 'center'
                              }}
                            >
                              {!avatarUrl && avatarLetter.toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-text-primary">
                                {persona?.name || AI_NAMES[aiId]}
                              </p>
                              <p className="text-xs text-text-muted">{aiId}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleAddMember(aiId)}
                            className="p-2 rounded-lg hover:bg-sidebar-hover text-xs text-accent"
                          >
                            添加
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'search' && (
            <div className="space-y-4">
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索聊天记录..."
                  className="w-full px-4 py-2 pl-10 border border-border-subtle rounded-[10px] focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 bg-bg-surface2 text-text-primary"
                />
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg></span>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>

              <div className="flex gap-2 flex-wrap">
                {[
                  { key: 'all' as SearchFilterType, label: '全部', icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" /></svg> },
                  { key: 'member' as SearchFilterType, label: '群成员', icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg> },
                  { key: 'date' as SearchFilterType, label: '日期', icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg> },
                  { key: 'media' as SearchFilterType, label: '图片与视频', icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" /></svg> },
                  { key: 'file' as SearchFilterType, label: '文件', icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg> },
                ].map(filter => (
                  <button
                    key={filter.key}
                    onClick={() => {
                      setSearchFilter(filter.key);
                      if (filter.key !== 'member') setSelectedMemberId(null);
                      if (filter.key !== 'date') setSelectedDate(null);
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      searchFilter === filter.key
                        ? 'bg-accent text-white'
                        : 'bg-bg-surface2 text-text-secondary hover:bg-bg-surface2/80 border border-border-subtle'
                    }`}
                  >
                    {filter.icon}
                    {filter.label}
                  </button>
                ))}
              </div>

              {searchFilter === 'member' && (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type="text"
                      value={memberSearchQuery}
                      onChange={(e) => setMemberSearchQuery(e.target.value)}
                      placeholder="搜索成员..."
                      className="w-full px-3 py-1.5 pl-8 text-sm border border-border-subtle rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 bg-bg-surface2 text-text-primary"
                    />
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg></span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {groupMembers.map(member => (
                      <button
                        key={member.id}
                        onClick={() => setSelectedMemberId(selectedMemberId === member.id ? null : member.id)}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                          selectedMemberId === member.id
                            ? 'bg-accent/15 border border-accent/40 text-accent'
                            : 'bg-bg-surface border border-border-subtle text-text-secondary hover:border-accent/30'
                        }`}
                      >
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-semibold overflow-hidden flex-shrink-0"
                          style={{
                            backgroundColor: member.avatarUrl ? 'transparent' : member.color,
                            backgroundImage: member.avatarUrl ? `url(${sanitizeUrl(member.avatarUrl)})` : 'none',
                            backgroundSize: 'cover',
                            backgroundPosition: 'center'
                          }}
                        >
                          {!member.avatarUrl && member.letter.toUpperCase()}
                        </div>
                        {member.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {searchFilter === 'date' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">选择日期</span>
                    {selectedDate && (
                      <button
                        onClick={() => setSelectedDate(null)}
                        className="text-xs text-accent hover:underline"
                      >
                        清除选择
                      </button>
                    )}
                  </div>
                  <input
                    type="date"
                    value={selectedDate || ''}
                    onChange={(e) => setSelectedDate(e.target.value || null)}
                    max={dayjs().format('YYYY-MM-DD')}
                    className="w-full px-3 py-1.5 text-sm border border-border-subtle rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 bg-bg-surface2 text-text-primary"
                  />
                  {availableDates.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {availableDates.slice(0, 15).map(date => (
                        <button
                          key={date}
                          onClick={() => setSelectedDate(selectedDate === date ? null : date)}
                          className={`px-2 py-1 rounded text-[11px] transition-colors ${
                            selectedDate === date
                              ? 'bg-accent/15 border border-accent/40 text-accent'
                              : 'bg-bg-surface border border-border-subtle text-text-secondary hover:border-accent/30'
                          }`}
                        >
                          {dayjs(date).format('M/D')}
                        </button>
                      ))}
                      {availableDates.length > 15 && (
                        <span className="text-[11px] text-text-muted px-1 py-1">...</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="text-xs text-text-muted">
                {searchFilter === 'all' && `共${filteredMessages.length} 条消息`}
                {searchFilter === 'member' && (selectedMemberId ? `${groupMembers.find(m => m.id === selectedMemberId)?.name || ''} 的消息 ${filteredMessages.length} 条` : '请选择一位成员')}
                {searchFilter === 'date' && (selectedDate ? `${dayjs(selectedDate).format('YYYY年M月D日')} 的消息 ${filteredMessages.length} 条` : '请选择一个日期')}
                {searchFilter === 'media' && `图片与视频 ${filteredMessages.length} 条`}
                {searchFilter === 'file' && `文件: ${filteredMessages.length} 条`}
              </div>

              <div className="space-y-2">
                {filteredMessages.length === 0 ? (
                  <p className="text-center text-text-muted py-8">
                    {searchQuery ? '没有找到匹配的消息' : searchFilter === 'member' ? '请选择一位群成员' : searchFilter === 'date' ? '请选择一个日期' : searchFilter === 'media' ? '暂无图片与视频' : searchFilter === 'file' ? '暂无文件消息' : '暂无聊天记录'}
                  </p>
                ) : (
                  filteredMessages.slice(-50).reverse().map((msg) => {
                    const senderId = msg.sender_id || '';
                    const senderName = msg.sender_type === 'user'
                      ? '我'
                      : (personas[senderId]?.name || AI_NAMES[senderId] || senderId);
                    const isMediaMsg = msg.attachments?.some(a => a.type?.startsWith('image/') || a.type?.startsWith('video/'));
                    const isFileMsg = msg.attachments?.some(a => !a.type?.startsWith('image/') && !a.type?.startsWith('video/'));

                    return (
                      <div key={msg.id} className="p-3 bg-bg-surface border border-border-subtle rounded-xl hover:border-accent/30 transition-colors">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-sm text-text-primary">{senderName}</span>
                          <span className="text-xs text-text-muted">
                            {dayjs(msg.created_at).format('M/D HH:mm')}
                          </span>
                        </div>
                        {msg.content && (
                          <p className="text-sm text-text-secondary line-clamp-2 mb-1">{msg.content}</p>
                        )}
                        {isMediaMsg && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {msg.attachments?.filter(a => a.type?.startsWith('image/') || a.type?.startsWith('video/')).map(att => (
                              <div key={att.id} className="relative group">
                                {att.type?.startsWith('image/') ? (
                                  <div className="w-16 h-16 rounded-lg overflow-hidden border border-border-subtle">
                                    {att.url ? (
                                      <img src={sanitizeUrl(att.url)} alt={att.name} className="w-full h-full object-cover" />
                                    ) : (
                                      <div className="w-full h-full bg-bg-surface2 flex items-center justify-center">
                                        <svg className="w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" /></svg>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="w-16 h-16 rounded-lg overflow-hidden border border-border-subtle bg-bg-surface2 flex items-center justify-center">
                                    <svg className="w-6 h-6 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" /></svg>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {isFileMsg && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {msg.attachments?.filter(a => !a.type?.startsWith('image/') && !a.type?.startsWith('video/')).map(att => (
                              <div key={att.id} className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-bg-surface2 border border-border-subtle text-xs">
                                <span className="text-text-secondary">{getFileIcon(att.type)}</span>
                                <span className="text-text-secondary truncate max-w-[120px]">{att.name}</span>
                                {att.size > 0 && (
                                  <span className="text-text-muted flex-shrink-0">{formatFileSize(att.size)}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {activeTab === 'files' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary">文件列表</h3>
                <button
                  onClick={loadFiles}
                  disabled={loadingFiles}
                  className="text-xs text-accent hover:underline flex items-center gap-1"
                >
                  {loadingFiles ? <><svg className="w-3 h-3 animate-spin inline" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg> 加载中...</> : <><svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg> 刷新</>}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">共{files.length} 个文件</span>
                <button
                  onClick={() => uploadFileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded-[10px] disabled:opacity-50"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
                  {uploading ? '上传中...' : '上传文件'}
                </button>
                <input
                  ref={uploadFileInputRef}
                  type="file"
                  onChange={handleUploadFile}
                  className="hidden"
                />
              </div>

              {loadingFiles ? (
                <div className="text-center py-8 text-text-muted">
                  <p>加载中...</p>
                </div>
              ) : files.length === 0 ? (
                <div className="text-center py-8 text-text-muted">
                  <p className="mb-2"><svg className="w-10 h-10 mx-auto text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg></p>
                  <p>暂无文件</p>
                  <p className="text-xs mt-1">点击上方按钮上传文件</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {files.map((file) => (
                    <div key={file.id} className="flex items-center justify-between p-3 bg-bg-surface border border-border-subtle rounded-xl hover:border-accent/30 transition-colors">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <span className="flex-shrink-0 text-text-secondary">{getFileIcon(file.type)}</span>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-text-primary truncate">{file.name}</p>
                          <div className="flex items-center gap-2 text-xs text-text-muted">
                            <span>{formatFileSize(file.size)}</span>
                            <span>·</span>
                            <span>{dayjs(file.uploaded_at).format('M/D HH:mm')}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <a
                          href={sanitizeUrl(file.url)}
                          download={file.name}
                          rel="noopener noreferrer"
                          className="p-2 rounded-lg hover:bg-sidebar-hover text-xs text-accent"
                        >
                          下载
                        </a>
                        <button
                          onClick={() => handleDeleteFile(file.id)}
                          className="p-2 rounded-lg hover:bg-sidebar-hover text-xs text-red-500"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-4">
              <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
                <h3 className="text-sm font-semibold text-text-primary mb-3">聊天背景</h3>
                <div className="flex items-center gap-4">
                  <div 
                    className="w-16 h-24 rounded-lg border-2 border-dashed border-border-subtle flex items-center justify-center cursor-pointer hover:border-accent transition-colors overflow-hidden"
                    onClick={() => bgInputRef.current?.click()}
                  >
                    {group.background_url ? (
                      <img src={sanitizeUrl(group.background_url)} alt="背景" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-text-muted text-2xl">+</span>
                    )}
                  </div>
                  <input
                    ref={bgInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleUpdateBackground}
                    className="hidden"
                  />
                  <div className="flex-1">
                    <p className="text-sm text-text-secondary">设置群聊背景图片</p>
                    <p className="text-xs text-text-muted mt-1">点击左侧区域上传图片</p>
                  </div>
                  {group.background_url && (
                    <button
                      onClick={handleResetBackground}
                      disabled={uploading}
                      className="px-3 py-1.5 text-xs rounded-[10px] btn-secondary"
                    >
                      恢复默认
                    </button>
                  )}
                </div>
              </div>

              <div className="bg-bg-surface border border-border-subtle rounded-xl p-4">
                <h3 className="text-sm font-semibold text-text-primary mb-3">其他设置</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">消息通知</span>
                    <button
                      onClick={async () => {
                        try {
                          const nextValue = group.notifications_enabled === false;
                          await api.updateGroupSettings(groupId, { notifications_enabled: nextValue });
                          updateGroupSettings(groupId, { notifications_enabled: nextValue });
                        } catch (error) {
                          console.error('Failed to update notifications setting:', error);
                          showToast({ message: '消息通知设置保存失败，请重试', type: 'error' });
                        }
                      }}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        group.notifications_enabled !== false ? 'bg-accent' : 'bg-bg-surface2'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          group.notifications_enabled !== false ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">置顶群聊</span>
                    <button
                      onClick={async () => {
                        try {
                          await pinGroup(groupId, !group.pinned);
                        } catch (error) {
                          console.error('Failed to toggle pin:', error);
                        }
                      }}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        group.pinned ? 'bg-accent' : 'bg-bg-surface2'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          group.pinned ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              <div className="pt-4 space-y-2">
                <button
                  onClick={async () => {
                    const confirmed = await confirm({ title: '清空聊天记录', description: '确定要清空该群聊的所有聊天记录吗？此操作不可撤销。', danger: true });
                    if (!confirmed) return;
                    setClearingMessages(true);
                    try {
                      await clearAllMessages(groupId);
                      showToast({ message: '聊天记录已清除', type: 'success' });
                    } catch (error) {
                      console.error('Failed to clear messages:', error);
                      showToast({ message: '清空聊天记录失败，请重试', type: 'error' });
                    } finally {
                      setClearingMessages(false);
                    }
                  }}
                  disabled={clearingMessages}
                  className="w-full py-2 text-red-500 p-2 rounded-lg hover:bg-sidebar-hover text-sm disabled:opacity-50"
                >
                  {clearingMessages ? '清空中...' : '清空聊天记录'}
                </button>
                {files.length > 0 && (
                  <button
                    onClick={handleClearFiles}
                    className="w-full py-2 text-red-500 p-2 rounded-lg hover:bg-sidebar-hover text-sm"
                  >
                    清空所有文件
                  </button>
                )}
                {group?.debate_config?.memory_enabled && (
                  <button
                    onClick={() => handleDeleteMemory(group.name)}
                    className="w-full py-2 text-red-500 p-2 rounded-lg hover:bg-sidebar-hover text-sm"
                  >
                    清除AI记忆
                  </button>
                )}
                <button
                  onClick={handleDeleteGroup}
                  className="w-full py-2 text-red-500 p-2 rounded-lg hover:bg-sidebar-hover text-sm font-medium"
                >
                  删除群组
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {ConfirmModal}
      {Toast}
    </div>
  );
}

