import React, { useState, useMemo, useEffect } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useMessagesStoreInternal } from '../../stores/messagesStore';
import { useAgentsStore } from '../../stores/agentsStore';
import { AI_NAMES, AI_COLORS, AI_AVATAR_LETTERS, AI_LIST } from '../../types';
import { AIPersonaEditor } from './AIPersonaEditor';
import { NewChatModal } from './NewChatModal';
import { UserProfileEditor } from './UserProfileEditor';
import { SearchPanel } from '../Chat/SearchPanel';
import { ThemeToggle } from './ThemeToggle';
import { FontSizeToggle } from './FontSizeToggle';
import { api, notifyAuthExpired } from '../../services/api';
import { joinGroup } from '../../services/websocket';
import { useToast } from '../Common';
import { prefersReducedMotion, getStaggerDelay, staggerPresets } from '../../utils/animations';
import { useGlobalSearch, type SearchFilterTab } from '../../hooks/useGlobalSearch';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

type SidebarView = 'chats' | 'members';

const NON_CHATTABLE_AI = ['mimo_tts', 'glm_4v_flash', 'qwen_vl_plus', 'qwen_omni'];
const EDITABLE_AI_LIST: string[] = AI_LIST.filter(id => !NON_CHATTABLE_AI.includes(id));
const CHATTABLE_AI_LIST: string[] = AI_LIST.filter(id => !NON_CHATTABLE_AI.includes(id));

function GroupAvatar({ group, personas, size = 'md' }: { group: any; personas: any; size?: 'sm' | 'md' }) {
  const sizeClass = size === 'sm' ? 'w-8 h-8' : 'w-11 h-11';
  const textSize = size === 'sm' ? 'text-xs' : 'text-base';
  const gridTextSize = size === 'sm' ? 'text-[7px]' : 'text-[9px]';
  const borderRadius = size === 'sm' ? 'rounded-lg' : 'rounded-xl';

  if (group.avatar_url) {
    return (
      <div className={`${sizeClass} ${borderRadius} overflow-hidden flex-shrink-0`}>
        <img src={group.avatar_url} alt={group.name} className="w-full h-full object-cover" />
      </div>
    );
  }

  if (group.avatar_color) {
    return (
      <div
        className={`${sizeClass} ${borderRadius} flex items-center justify-center text-white ${textSize} font-semibold overflow-hidden flex-shrink-0`}
        style={{ backgroundColor: group.avatar_color }}
      >
        {group.name?.[0]?.toUpperCase() || '群'}
      </div>
    );
  }

  const aiMembers = group.ai_members || [];
  const memberCount = aiMembers.length;

  if (memberCount === 0) {
    return (
      <div className={`${sizeClass} ${borderRadius} bg-gradient-to-br from-bg-surface3 to-bg-surface4 flex items-center justify-center flex-shrink-0`}>
        <svg className={size === 'sm' ? 'w-3.5 h-3.5 text-text-muted' : 'w-5 h-5 text-text-muted'} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </div>
    );
  }

  if (memberCount === 1) {
    const aiId = aiMembers[0];
    const persona = personas[aiId];
    const avatarColor = persona?.color || AI_COLORS[aiId];
    const avatarUrl = persona?.avatar_url;
    const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];

    return (
      <div
        className={`${sizeClass} ${borderRadius} flex items-center justify-center text-white ${textSize} font-semibold overflow-hidden flex-shrink-0`}
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
    if (memberCount === 2) return 'grid-cols-2 grid-rows-1';
    if (memberCount === 3) return 'grid-cols-3 grid-rows-1';
    return 'grid-cols-2 grid-rows-2';
  };

  const displayMembers = aiMembers.slice(0, 4);
  const extraCount = memberCount > 4 ? memberCount - 4 : 0;

  return (
    <div className={`relative ${sizeClass} flex-shrink-0`}>
      <div className={`w-full h-full ${borderRadius} overflow-hidden grid ${getLayoutClass()} gap-0.5 bg-gradient-to-br from-bg-surface2 to-bg-surface3 p-0.5`}>
        {displayMembers.map((aiId: string) => {
          const persona = personas[aiId];
          const avatarColor = persona?.color || AI_COLORS[aiId];
          const avatarUrl = persona?.avatar_url;
          const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];

          return (
            <div
              key={aiId}
              className={`w-full h-full rounded-md flex items-center justify-center text-white ${gridTextSize} font-bold overflow-hidden`}
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
      {extraCount > 0 && (
        <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-bg-surface4 text-text-muted text-[8px] font-bold flex items-center justify-center border border-bg-surface">
          +{extraCount}
        </div>
      )}
    </div>
  );
}

function formatLastMessageTime(timestamp: string, showFullDate: boolean): string {
  const time = dayjs(timestamp);
  const now = dayjs();
  const diffDays = now.diff(time, 'day');

  if (showFullDate) {
    return time.format('YYYY年M月D日 HH:mm');
  }

  if (diffDays === 0) {
    return time.format('HH:mm');
  } else if (diffDays === 1) {
    return '昨天';
  } else if (diffDays < 7) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return weekdays[time.day()];
  } else {
    return time.format('M/D');
  }
}

function GroupItem({ group, isActive, onSelect, onDelete, onPin, showPinButton, messages, personas }: {
  group: any;
  isActive: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  onPin?: (e: React.MouseEvent) => void;
  showPinButton?: boolean;
  messages: any[];
  personas: any;
}) {
  const { timeFormat, setTimeFormat } = useNavigationStore();
  const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : null;
  const lastMessageContent = lastMessage?.content || group.description || '暂无消息';
  const lastMessageTime = lastMessage?.created_at;

  let displayContent = lastMessageContent;
  if (lastMessage) {
    if (lastMessage.sender_type === 'user') {
      displayContent = `我: ${lastMessageContent}`;
    } else if (lastMessage.sender_type === 'ai') {
      const senderName = personas[lastMessage.sender_id]?.name || AI_NAMES[lastMessage.sender_id] || lastMessage.sender_id;
      displayContent = `${senderName}: ${lastMessageContent}`;
    }
  }

  const truncatedContent = displayContent.length > 40 ? displayContent.substring(0, 40) + '...' : displayContent;

  return (
    <div
      className={`chat-item group ${isActive ? 'active' : ''}`}
      onClick={onSelect}
    >
      <GroupAvatar group={group} personas={personas} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 min-w-0">
            {group.is_private && (
              <svg className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            )}
            <span className="font-medium text-[13px] text-text-primary truncate leading-tight">{group.name}</span>
          </div>
          {lastMessageTime && (
            <span
              className="text-[10px] text-text-muted flex-shrink-0 cursor-pointer hover:text-text-secondary select-none"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTimeFormat(timeFormat === 'full' ? 'relative' : 'full');
              }}
            >
              {formatLastMessageTime(lastMessageTime, timeFormat === 'full')}
            </span>
          )}
        </div>
        <div className="text-[11px] text-text-muted truncate mt-0.5 leading-tight">
          {truncatedContent}
        </div>
      </div>

      {showPinButton && onPin && (
        <button
          onClick={onPin}
          className="absolute right-6 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md bg-bg-surface3 text-text-muted flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-bg-surface4 transition-all duration-150"
          title={group.pinned ? '取消置顶' : '置顶'}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
          </svg>
        </button>
      )}

      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500/10 transition-all duration-150"
          title="删除对话"
        >
          ×
        </button>
      )}
    </div>
  );
}

interface MemberItemProps {
  aiId: string;
  index: number;
  total: number;
  personas: any;
  onPrivateChat: (aiId: string) => void;
  onEdit: (aiId: string) => void;
  reducedMotion: boolean;
}

function MemberItem({ aiId, index, total, personas, onPrivateChat, onEdit, reducedMotion }: MemberItemProps) {
  const [isVisible, setIsVisible] = useState(false);
  const customPersona = personas[aiId];
  const avatarColor = customPersona?.color || AI_COLORS[aiId];
  const avatarUrl = customPersona?.avatar_url;
  const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];

  useEffect(() => {
    if (reducedMotion) {
      setIsVisible(true);
      return;
    }

    const delay = getStaggerDelay(index, total, staggerPresets.normal);
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, delay);

    return () => clearTimeout(timer);
  }, [index, total, reducedMotion]);

  const animationStyle = useMemo(() => {
    if (reducedMotion || isVisible) {
      return {};
    }
    return {
      opacity: 0,
      transform: 'translateX(-12px)',
    };
  }, [reducedMotion, isVisible]);

  const isChattable = CHATTABLE_AI_LIST.includes(aiId);

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg member-item-hover group ${
        isChattable ? 'cursor-pointer' : 'cursor-default'
      } ${
        isVisible && !reducedMotion ? 'animate-member-item-in' : ''
      }`}
      style={animationStyle}
      onClick={() => isChattable && onPrivateChat(aiId)}
      title={isChattable 
        ? `点击与 ${AI_NAMES[aiId]} 私聊` 
        : aiId === 'mimo_tts' 
          ? `${AI_NAMES[aiId]} - 语音合成模型，不支持聊天` 
          : `${AI_NAMES[aiId]} - 多模态标注专用模型，不支持聊天（仅用于附件内容识别）`
      }
    >
      <div className="relative flex-shrink-0">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold overflow-hidden"
          style={{
            backgroundColor: avatarUrl ? 'transparent' : avatarColor,
            backgroundImage: avatarUrl ? `url(${avatarUrl})` : 'none',
            backgroundSize: 'cover',
            backgroundPosition: 'center'
          }}
        >
          {!avatarUrl && avatarLetter.toUpperCase()}
        </div>
        <span
          className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent"
          style={{ boxShadow: '0 0 0 2px var(--bg-surface)' }}
        />
      </div>
      <span className="text-[12px] text-text-secondary flex-1 truncate">
        {AI_NAMES[aiId]}
      </span>
      {isChattable && (
        <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          私聊
        </span>
      )}
      {EDITABLE_AI_LIST.includes(aiId) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(aiId);
          }}
          className="w-4 h-4 rounded text-text-muted hover:text-text-secondary hover:bg-bg-surface2 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-150"
          title="编辑 AI 设置"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      )}
    </div>
  );
}

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenAgents?: () => void;
}

export function Sidebar({ collapsed = false, onToggleCollapse, onOpenAgents }: SidebarProps) {
  const { groups, currentGroup, selectGroup, deleteGroup, pinGroup, getOrCreatePrivateChat } = useGroupsStore();
  const { personas } = usePersonasStore();
  const { setSidebarOpen, searchPanelOpen } = useNavigationStore();
  const messages = useMessagesStoreInternal((state) => state.messages);
  const { showToast } = useToast();
  const [activeView, setActiveView] = useState<SidebarView>('chats');
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [editingAiId, setEditingAiId] = useState<string | null>(null);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const globalSearch = useGlobalSearch();
  const { selectAgent } = useAgentsStore();
  const { setScrollToMessageId } = useNavigationStore();
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteModalClosing, setDeleteModalClosing] = useState(false);

  React.useEffect(() => {
    if (showDeleteConfirm) {
      setDeleteModalVisible(true);
      setDeleteModalClosing(false);
    } else {
      setDeleteModalVisible(false);
      setDeleteModalClosing(false);
    }
  }, [showDeleteConfirm]);

  const closeDeleteModal = () => {
    setDeleteModalClosing(true);
    setTimeout(() => {
      setShowDeleteConfirm(null);
    }, 200);
  };

  const handleSelectGroup = (groupId: string) => {
    selectGroup(groupId);
    joinGroup(groupId);
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  const pinnedGroups = groups.filter(g => g.pinned && !g.is_ai_private && g.type !== 'ai_private');
  const unpinnedGroups = groups.filter(g => !g.pinned && !g.is_private && g.type !== 'ai_private');
  const aiPrivateChats = groups.filter(g => g.is_ai_private || g.type === 'ai_private');
  const privateChats = groups.filter(g => g.is_private && !g.is_ai_private && g.type !== 'ai_private');

  const filteredPinnedGroups = useMemo(() => {
    if (!searchQuery) return pinnedGroups;
    return pinnedGroups.filter(g => g.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [pinnedGroups, searchQuery]);

  const filteredUnpinnedGroups = useMemo(() => {
    if (!searchQuery) return unpinnedGroups;
    return unpinnedGroups.filter(g => g.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [unpinnedGroups, searchQuery]);

  const filteredAiPrivateChats = useMemo(() => {
    if (!searchQuery) return aiPrivateChats;
    return aiPrivateChats.filter(g => g.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [aiPrivateChats, searchQuery]);

  const filteredPrivateChats = useMemo(() => {
    if (!searchQuery) return privateChats;
    return privateChats.filter(g => g.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [privateChats, searchQuery]);

  useEffect(() => {
    globalSearch.setQuery(searchQuery);
  }, [searchQuery]);

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteGroup(groupId);
      setShowDeleteConfirm(null);
    } catch (error) {
      console.error('删除对话失败:', error);
    }
  };

  const handlePinGroup = async (groupId: string, pinned: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await pinGroup(groupId, pinned);
    } catch (error) {
      console.error('置顶操作失败:', error);
    }
  };

  const handleStartPrivateChat = async (aiId: string) => {
    try {
      const privateChat = await getOrCreatePrivateChat(aiId);
      joinGroup(privateChat.id);
    } catch (error) {
      console.error('创建私聊失败:', error);
    }
  };

  const renderChatList = () => (
    <div className="flex-1 overflow-y-auto py-1">
      {filteredAiPrivateChats.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 px-4 py-1.5">
            <svg className="w-3.5 h-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
            </svg>
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">AI 私聊</span>
            <span className="text-[9px] text-text-muted/60 ml-1">(只读)</span>
          </div>
          {filteredAiPrivateChats.map((group) => (
            <GroupItem
              key={group.id}
              group={group}
              isActive={currentGroup?.id === group.id}
              onSelect={() => handleSelectGroup(group.id)}
              onDelete={() => setShowDeleteConfirm(group.id)}
              messages={messages[group.id] || []}
              personas={personas}
            />
          ))}
        </div>
      )}

      {filteredPinnedGroups.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 px-4 py-1.5">
            <svg className="w-3.5 h-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
            </svg>
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">置顶</span>
          </div>
          {filteredPinnedGroups.map((group) => (
            <GroupItem
              key={group.id}
              group={group}
              isActive={currentGroup?.id === group.id}
              onSelect={() => handleSelectGroup(group.id)}
              onDelete={(group.type === 'custom' || group.type === 'private') ? () => setShowDeleteConfirm(group.id) : undefined}
              onPin={(e) => handlePinGroup(group.id, false, e)}
              showPinButton={true}
              messages={messages[group.id] || []}
              personas={personas}
            />
          ))}
        </div>
      )}

      {filteredPrivateChats.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 px-4 py-1.5">
            <svg className="w-3.5 h-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">私聊</span>
          </div>
          {filteredPrivateChats.map((group) => (
            <GroupItem
              key={group.id}
              group={group}
              isActive={currentGroup?.id === group.id}
              onSelect={() => handleSelectGroup(group.id)}
              onDelete={() => setShowDeleteConfirm(group.id)}
              messages={messages[group.id] || []}
              personas={personas}
            />
          ))}
        </div>
      )}

      <div className="mb-2">
        <div className="flex items-center gap-1.5 px-4 py-1.5">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">群组</span>
        </div>
        {filteredUnpinnedGroups.map((group) => (
          <GroupItem
            key={group.id}
            group={group}
            isActive={currentGroup?.id === group.id}
            onSelect={() => handleSelectGroup(group.id)}
            onDelete={group.type === 'custom' ? () => setShowDeleteConfirm(group.id) : undefined}
            onPin={(e) => handlePinGroup(group.id, true, e)}
            showPinButton={true}
            messages={messages[group.id] || []}
            personas={personas}
          />
        ))}
      </div>
    </div>
  );

  const renderMembersList = () => (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">在线成员</span>
        <button
          onClick={() => setShowNewChatModal(true)}
          className="flex items-center gap-1 text-[10px] text-accent hover:underline"
          title="创建 AI 私聊"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
          </svg>
          AI私聊
        </button>
      </div>
      <div className="space-y-0.5">
        <div
          className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer rounded-lg member-item-hover group"
          onClick={() => setShowProfileEditor(true)}
        >
          <div className="relative flex-shrink-0">
            <span
              className="w-2 h-2 rounded-full block"
              style={{ backgroundColor: AI_COLORS.user }}
            />
          </div>
          <span className="text-[12px] text-text-primary">用户</span>
        </div>
        {AI_LIST.map((aiId, index) => (
          <MemberItem
            key={aiId}
            aiId={aiId}
            index={index}
            total={AI_LIST.length}
            personas={personas}
            onPrivateChat={handleStartPrivateChat}
            onEdit={setEditingAiId}
            reducedMotion={reducedMotion}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div
      className={`h-full flex flex-col bg-bg-surface border-r border-border-subtle overflow-hidden flex-shrink-0 transition-all duration-300 ${
        collapsed ? 'w-16' : 'w-full max-w-[280px] min-w-[220px] sm:w-[260px]'
      }`}
      style={{
        transitionTimingFunction: reducedMotion ? 'none' : 'cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Top Section: Logo + App name + Actions */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
          <svg viewBox="0 0 200 200" className="w-7 h-7">
            <defs>
              <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#6C5CE7"/>
                <stop offset="100%" stopColor="#A29BFE"/>
              </linearGradient>
              <filter id="logoShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#1A1A2E" floodOpacity="0.25"/>
              </filter>
            </defs>
            <g filter="url(#logoShadow)">
              <rect x="55" y="50" width="85" height="85" rx="20" fill="#1A1A2E" opacity="0.9" transform="rotate(-12, 97, 92)"/>
              <rect x="70" y="48" width="85" height="85" rx="20" fill="#6C5CE7" opacity="0.6" transform="rotate(8, 112, 90)"/>
              <rect x="82" y="58" width="85" height="85" rx="20" fill="url(#logoGrad)"/>
            </g>
          </svg>
        </div>
        {!collapsed && (
          <span className="text-[14px] font-semibold text-text-primary truncate">群想</span>
        )}
        {!collapsed && (
          <div className="flex items-center gap-0.5 ml-auto">
            {onOpenAgents && (
              <button
                onClick={onOpenAgents}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-hover transition-all duration-150"
                title="智能体"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setShowNewChatModal(true)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-hover transition-all duration-150"
              title="新建对话"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
            {onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-hover transition-all duration-150"
                title="收起侧栏"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Collapsed: Action buttons only */}
      {collapsed && (
        <div className="flex flex-col items-center gap-0.5 px-2 py-2 border-b border-border-subtle">
          <button
            onClick={() => setShowNewChatModal(true)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-hover transition-all duration-150"
            title="新建对话"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
          {onOpenAgents && (
            <button
              onClick={onOpenAgents}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-hover transition-all duration-150"
              title="智能体"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
              </svg>
            </button>
          )}
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-hover transition-all duration-150"
              title="展开侧栏"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Search Input (expanded only) */}
      {!collapsed && (
        <div className="px-3 py-2 flex-shrink-0">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索群聊、消息、文件、智能体..."
              className="w-full pl-8 pr-8 py-1.5 text-[12px] border border-border-subtle rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 bg-bg-surface2 text-text-primary placeholder-text-muted transition-all duration-200"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          {searchQuery && globalSearch.searchData && (
            <div className="flex mt-1.5 border-b border-border-subtle overflow-x-auto">
              {([
                { key: 'all' as SearchFilterTab, label: '全部', count: globalSearch.searchData.total },
                { key: 'groups' as SearchFilterTab, label: '群聊', count: globalSearch.searchData.groups?.length || 0 },
                { key: 'messages' as SearchFilterTab, label: '消息', count: globalSearch.searchData.messages?.length || 0 },
                { key: 'files' as SearchFilterTab, label: '文件', count: globalSearch.searchData.files?.length || 0 },
                { key: 'agents' as SearchFilterTab, label: '智能体', count: globalSearch.searchData.agents?.length || 0 },
                { key: 'personas' as SearchFilterTab, label: 'AI角色', count: globalSearch.searchData.personas?.length || 0 },
                { key: 'comments' as SearchFilterTab, label: '评论', count: globalSearch.searchData.comments?.length || 0 },
              ]).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => globalSearch.setActiveTab(tab.key)}
                  className={`px-2 py-1 text-[9px] whitespace-nowrap transition-colors border-b-2 flex-shrink-0 ${
                    globalSearch.activeTab === tab.key
                      ? 'border-accent text-accent font-medium'
                      : 'border-transparent text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {tab.label}{tab.count > 0 ? ` ${tab.count}` : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* View Tabs (expanded only) */}
      {!collapsed && !searchQuery && (
        <div className="flex px-3 gap-1 flex-shrink-0">
          <button
            onClick={() => setActiveView('chats')}
            className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg transition-all duration-150 ${
              activeView === 'chats'
                ? 'bg-sidebar-active text-accent'
                : 'text-text-muted hover:text-text-secondary hover:bg-sidebar-hover'
            }`}
          >
            聊天
          </button>
          <button
            onClick={() => setActiveView('members')}
            className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg transition-all duration-150 ${
              activeView === 'members'
                ? 'bg-sidebar-active text-accent'
                : 'text-text-muted hover:text-text-secondary hover:bg-sidebar-hover'
            }`}
          >
            成员
          </button>
        </div>
      )}

      {/* Chat/Members List or Search Results (expanded only) */}
      {!collapsed && (
        <>
          {searchQuery ? (
            <div className="flex-1 overflow-y-auto">
              {globalSearch.loading ? (
                <div className="flex items-center justify-center h-20">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent"></div>
                </div>
              ) : !globalSearch.searchData || globalSearch.searchData.total === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-text-muted">
                  <svg className="w-8 h-8 mb-2 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <span className="text-[11px]">未找到 "{searchQuery}" 的结果</span>
                </div>
              ) : (
                <>
                  {(globalSearch.activeTab === 'all' || globalSearch.activeTab === 'groups') && (globalSearch.searchData.groups || []).map(r => (
                    <div key={r.id} onClick={() => { handleSelectGroup(r.id); setSearchQuery(''); }} className="px-3 py-2 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded bg-accent/10 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" /></svg>
                        </div>
                        <span className="text-[11px] font-medium text-text-primary truncate">{r.name}</span>
                        <span className="text-[9px] text-text-muted ml-auto">{r.memberCount} 人</span>
                      </div>
                    </div>
                  ))}
                  {(globalSearch.activeTab === 'all' || globalSearch.activeTab === 'messages') && (globalSearch.searchData.messages || []).map(r => {
                    const senderName = r.sender_type === 'user' ? '用户' : (personas[r.sender_id || '']?.name || AI_NAMES[r.sender_id || ''] || r.sender_id || '?');
                    return (
                      <div key={r.id} onClick={() => { selectGroup(r.group_id); joinGroup(r.group_id); setScrollToMessageId(r.id); setSearchQuery(''); }} className="px-3 py-2 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                        <div className="flex items-start gap-1.5">
                          <div className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[7px] font-semibold flex-shrink-0" style={{ backgroundColor: r.sender_type === 'user' ? '#171717' : (personas[r.sender_id || '']?.color || AI_COLORS[r.sender_id || ''] || '#737373') }}>
                            {r.sender_type === 'user' ? 'U' : (AI_AVATAR_LETTERS[r.sender_id || ''] || senderName[0])}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] font-medium text-text-primary">{senderName}</span>
                              <span className="text-[8px] text-accent/70 truncate max-w-[50px]">{r.group_name}</span>
                              <span className="text-[8px] text-text-muted ml-auto">{dayjs(r.created_at).format('M/D HH:mm')}</span>
                            </div>
                            <p className="text-[10px] text-text-secondary line-clamp-1">{r.content}</p>
                            {r.attachment_match_preview && (
                              <p className="text-[9px] text-accent/70 line-clamp-1 mt-0.5">{r.attachment_match_preview.split('\n')[0]}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {(globalSearch.activeTab === 'all' || globalSearch.activeTab === 'files') && (globalSearch.searchData.files || []).map(r => (
                    <div key={r.id} onClick={() => { selectGroup(r.group_id); joinGroup(r.group_id); if (r.linked_message_id) setScrollToMessageId(r.linked_message_id); setSearchQuery(''); }} className="px-3 py-2 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] font-medium text-text-primary truncate block">{r.filename}</span>
                          <span className="text-[8px] text-text-muted">{r.group_name} 路 {r.mime_type?.split('/')[1] || '文件'}</span>
                          {r.media_description && (
                            <p className="text-[9px] text-accent/70 line-clamp-1 mt-0.5">AI: {r.media_description.substring(0, 60)}</p>
                          )}
                          {r.content_preview && !r.media_description && (
                            <p className="text-[9px] text-text-muted line-clamp-1 mt-0.5">{r.content_preview.substring(0, 60)}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {(globalSearch.activeTab === 'all' || globalSearch.activeTab === 'agents') && (globalSearch.searchData.agents || []).map(r => (
                    <div key={r.id} onClick={() => { selectAgent(r.id); setSearchQuery(''); }} className="px-3 py-2 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3 h-3 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" /></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] font-medium text-text-primary truncate block">{r.name}</span>
                          {r.description && <span className="text-[8px] text-text-muted line-clamp-1 block">{r.description}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                  {(globalSearch.activeTab === 'all' || globalSearch.activeTab === 'personas') && (globalSearch.searchData.personas || []).map(r => (
                    <div key={r.id} className="px-3 py-2 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                      <div className="flex items-center gap-1.5">
                        <div className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[7px] font-semibold flex-shrink-0" style={{ backgroundColor: r.color || '#6b7280' }}>
                          {AI_AVATAR_LETTERS[r.id] || r.name?.[0] || '?'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-[10px] font-medium text-text-primary">{r.name}</span>
                          {r.personality && <span className="text-[8px] text-text-muted ml-1 line-clamp-1">{r.personality}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                  {(globalSearch.activeTab === 'all' || globalSearch.activeTab === 'comments') && (globalSearch.searchData.comments || []).map(r => {
                    const senderName = r.sender_type === 'user' ? '用户' : (personas[r.sender_id || '']?.name || AI_NAMES[r.sender_id || ''] || r.sender_id || '?');
                    return (
                      <div key={r.id} onClick={() => { if (r.group_id) { selectGroup(r.group_id); joinGroup(r.group_id); setScrollToMessageId(r.message_id); } setSearchQuery(''); }} className="px-3 py-2 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                        <div className="flex items-start gap-1.5">
                          <div className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[7px] font-semibold flex-shrink-0" style={{ backgroundColor: r.sender_type === 'user' ? '#171717' : (personas[r.sender_id || '']?.color || AI_COLORS[r.sender_id || ''] || '#737373') }}>
                            {r.sender_type === 'user' ? 'U' : (AI_AVATAR_LETTERS[r.sender_id || ''] || senderName[0])}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] font-medium text-text-primary">{senderName}</span>
                              <span className="text-[8px] text-text-muted">评论人 {r.group_name}</span>
                            </div>
                            <p className="text-[10px] text-text-secondary line-clamp-1">{r.content}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          ) : (
            <>
              {activeView === 'chats' && renderChatList()}
              {activeView === 'members' && renderMembersList()}
            </>
          )}
        </>
      )}

      {/* Bottom Section */}
      {!collapsed ? (
        <div className="border-t border-border-subtle flex-shrink-0 px-3 py-2 space-y-1.5">
          <ThemeToggle />
          <FontSizeToggle />
          <div className="flex items-center justify-between pt-0.5">
            <button
              onClick={() => setShowProfileEditor(true)}
              className="w-7 h-7 rounded-full bg-gradient-to-br from-accent to-accent-hover flex items-center justify-center text-white text-[11px] font-semibold flex-shrink-0 hover:opacity-90 transition-opacity"
              title="个人资料"
            >
              U
            </button>
            <button
              onClick={async () => {
                try {
                  await api.logout();
                  showToast({ message: '已退出登录', type: 'success' });
                  notifyAuthExpired();
                } catch (err) {
                  showToast({ message: '退出失败', type: 'error' });
                }
              }}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-all duration-150"
              title="退出登录"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-border-subtle flex-shrink-0 flex flex-col items-center py-2">
          <button
            onClick={async () => {
              try {
                await api.logout();
                showToast({ message: '已退出登录', type: 'success' });
                notifyAuthExpired();
              } catch (err) {
                showToast({ message: '退出失败', type: 'error' });
              }
            }}
            className="flex flex-col items-center gap-0.5 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg p-1 transition-all duration-150"
            title="退出登录"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span className="text-[9px] leading-none">退出登录</span>
          </button>
        </div>
      )}

      {showDeleteConfirm && (
        <div
          className={`fixed inset-0 flex items-center justify-center z-50 p-4 transition-opacity duration-200 ${
            deleteModalVisible && !deleteModalClosing ? 'opacity-100' : 'opacity-0'
          } bg-black/50 backdrop-blur-sm`}
          onClick={closeDeleteModal}
        >
          <div
            className={`bg-bg-surface rounded-2xl p-6 w-full max-w-sm md:w-80 shadow-xl transition-all duration-[250ms] ${
              deleteModalVisible && !deleteModalClosing ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
            }`}
            style={{
              transitionTimingFunction: deleteModalVisible && !deleteModalClosing
                ? 'cubic-bezier(0.175, 0.885, 0.32, 1.275)'
                : 'cubic-bezier(0.4, 0.0, 1, 1)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-text-primary mb-2">确认删除</h3>
            <p className="text-sm text-text-secondary mb-6">
              确定要删除这个对话吗？此操作不可撤销。
            </p>

            <div className="flex gap-2">
              <button
                onClick={closeDeleteModal}
                className="flex-1 px-4 py-2 border border-border rounded-xl text-text-secondary hover:bg-bg-surface2 transition-all duration-200 text-sm font-medium"
              >
                取消
              </button>
              <button
                onClick={() => handleDeleteGroup(showDeleteConfirm)}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-xl hover:bg-red-600 transition-all duration-200 text-sm font-medium"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {editingAiId && (
        <AIPersonaEditor
          aiId={editingAiId}
          isOpen={true}
          onClose={() => setEditingAiId(null)}
        />
      )}

      <NewChatModal
        isOpen={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onSelectGroup={(groupId) => { handleSelectGroup(groupId); }}
      />

      <UserProfileEditor
        isOpen={showProfileEditor}
        onClose={() => setShowProfileEditor(false)}
      />

      {searchPanelOpen && <SearchPanel />}
    </div>
  );
}

