import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGroupsStore } from '../../stores/groupsStore';
import { useMessagesStore } from '../../stores/messagesStore';
import { usePersonasStore } from '../../stores/personasStore';
import { useAgentsStore } from '../../stores/agentsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { AI_NAMES, AI_COLORS, AI_AVATAR_LETTERS, type Group } from '../../types';
import { ChatListSkeleton } from '../Common';
import { useGlobalSearch, type SearchFilterTab } from '../../hooks/useGlobalSearch';
import { replaceOldModelNames } from '../../utils/modelNames';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

interface ChatListProps {
  onNewChat?: () => void;
  onBack?: () => void;
  onSelectGroup?: (groupId: string) => void;
}

interface GroupedGroups {
  pinned: Group[];
  today: Group[];
  yesterday: Group[];
  thisWeek: Group[];
  earlier: Group[];
}

function groupGroupsByTime(groups: Group[], getGroupLastMessageTime: (group: Group) => number): GroupedGroups {
  const now = dayjs();
  const startOfToday = now.startOf('day');
  const startOfYesterday = startOfToday.subtract(1, 'day');
  const startOfThisWeek = now.startOf('week');

  return groups.reduce<GroupedGroups>((acc, group) => {
    if (group.pinned) {
      acc.pinned.push(group);
      return acc;
    }

    const msgTime = dayjs(getGroupLastMessageTime(group));

    if (msgTime.isAfter(startOfToday)) {
      acc.today.push(group);
    } else if (msgTime.isAfter(startOfYesterday)) {
      acc.yesterday.push(group);
    } else if (msgTime.isAfter(startOfThisWeek)) {
      acc.thisWeek.push(group);
    } else {
      acc.earlier.push(group);
    }

    return acc;
  }, { pinned: [], today: [], yesterday: [], thisWeek: [], earlier: [] });
}

const GROUP_CONFIG: Record<string, { label: string; icon: ReactNode }> = {
  pinned: { label: '置顶', icon: <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" /></svg> },
  today: { label: '今天', icon: <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg> },
  yesterday: { label: '昨天', icon: <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg> },
  thisWeek: { label: '本周', icon: <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg> },
  earlier: { label: '更早', icon: <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg> },
};

function formatFileSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function highlightText(text: string, searchRegex: RegExp | null) {
  if (!searchRegex) return text;
  const parts = text.split(searchRegex);
  const testRegex = new RegExp(searchRegex.source, 'i');
  return parts.map((part, index) =>
    testRegex.test(part) ? (
      <mark key={index} className="bg-yellow-200 dark:bg-yellow-800/60 text-inherit rounded px-0.5">{part}</mark>
    ) : (
      part
    )
  );
}

function getFileIcon(mimeType: string): ReactNode {
  if (mimeType.startsWith('image/')) return <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" /></svg>;
  if (mimeType.startsWith('video/')) return <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" /></svg>;
  if (mimeType.startsWith('audio/')) return <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" /></svg>;
  return <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>;
}

export function ChatList({ onNewChat, onSelectGroup }: ChatListProps) {
  const { groups, currentGroup, selectGroup, loading, deleteGroup, fetchGroups } = useGroupsStore();
  const { messages } = useMessagesStore();
  const { personas } = usePersonasStore();
  const { selectAgent } = useAgentsStore();
  const { setScrollToMessageId } = useNavigationStore();
  const reducedMotion = useReducedMotion();
  const [showSearch, setShowSearch] = useState(false);
  const [timeUpdateKey, setTimeUpdateKey] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['pinned', 'today', 'yesterday', 'thisWeek', 'earlier']));
  const inputRef = useRef<HTMLInputElement>(null);

  const globalSearch = useGlobalSearch();

  const searchRegex = useMemo(() => {
    const query = globalSearch.query;
    if (!query?.trim()) return null;
    try {
      return new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    } catch {
      return null;
    }
  }, [globalSearch.query]);

  useEffect(() => {
    if (showSearch && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showSearch]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeUpdateKey(prev => prev + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetchGroups(true).catch(() => { });
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchGroups(true).catch(() => { });
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [fetchGroups]);

  const getGroupLastMessage = useCallback((group: Group) => {
    const groupMessages = messages[group.id] || [];
    if (groupMessages.length === 0) return null;
    return groupMessages[groupMessages.length - 1];
  }, [messages]);

  const getGroupLastMessageTime = useCallback((group: Group): number => {
    if (group.last_message_at) {
      return new Date(group.last_message_at).getTime();
    }
    const lastMsg = getGroupLastMessage(group);
    if (lastMsg) {
      return new Date(lastMsg.created_at).getTime();
    }
    return new Date(group.created_at).getTime();
  }, [getGroupLastMessage]);

  const getGroupAvatarInfo = useCallback((group: Group) => {
    if (group.avatar_url) {
      return { color: 'transparent', letter: '', avatarUrl: group.avatar_url, name: null, isGroup: false };
    }
    if (group.ai_members && group.ai_members.length === 1) {
      const aiId = group.ai_members[0];
      const persona = personas[aiId];
      return {
        color: persona?.color || AI_COLORS[aiId] || '#888',
        letter: persona?.name?.charAt(0) || AI_AVATAR_LETTERS[aiId] || 'A',
        avatarUrl: persona?.avatar_url || null,
        name: persona?.name || AI_NAMES[aiId] || aiId,
        isGroup: false
      };
    }
    const letter = (group.name || '群')[0].toUpperCase();
    return { color: '#95B1D4', letter, avatarUrl: null, name: null, isGroup: false };
  }, [personas]);

  const formatTime = useCallback((dateStr: string) => {
    const time = dayjs(dateStr);
    const now = dayjs();
    const diffDays = now.diff(time, 'day');

    if (diffDays === 0) {
      return time.fromNow();
    } else if (diffDays === 1) {
      return '昨天';
    } else if (diffDays < 7) {
      return time.format('ddd');
    } else {
      return time.format('MM-DD');
    }
  }, [timeUpdateKey]);

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return getGroupLastMessageTime(b) - getGroupLastMessageTime(a);
    });
  }, [groups, getGroupLastMessageTime]);

  const groupedGroups = useMemo(() => {
    return groupGroupsByTime(sortedGroups, getGroupLastMessageTime);
  }, [sortedGroups, getGroupLastMessageTime]);

  const handleSelectGroup = (groupId: string) => {
    selectGroup(groupId);
    if (onSelectGroup) {
      onSelectGroup(groupId);
    }
  };

  const handleDeleteGroup = async (e: React.MouseEvent, groupId: string) => {
    e.stopPropagation();
    const confirmed = window.confirm('确定要删除该聊天吗？所有聊天记录将被清除。');
    if (!confirmed) return;
    await deleteGroup(groupId);
  };

  const toggleGroup = (groupKey: string, e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setExpandedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupKey)) {
        newSet.delete(groupKey);
      } else {
        newSet.add(groupKey);
      }
      return newSet;
    });
  };

  const handleExitSearch = () => {
    setShowSearch(false);
    globalSearch.resetSearch();
  };

  const getSenderName = (senderType: string, senderId?: string) => {
    if (senderType === 'user') return '用户';
    if (senderType === 'system') return '系统';
    const persona = personas[senderId || ''];
    return persona?.name || AI_NAMES[senderId || ''] || senderId;
  };

  const getSenderColor = (senderType: string, senderId?: string) => {
    if (senderType === 'user') return AI_COLORS.user;
    if (senderType === 'system') return AI_COLORS.system;
    const persona = personas[senderId || ''];
    return persona?.color || AI_COLORS[senderId || ''];
  };

  const getAvatarLetter = (senderType: string, senderId?: string) => {
    if (senderType === 'user') return 'U';
    if (senderType === 'system') return 'S';
    return AI_AVATAR_LETTERS[senderId || ''] || senderId?.[0]?.toUpperCase() || '?';
  };

  const renderChatItem = (group: Group, _index: number, _groupKey: string) => {
    const lastMsg = getGroupLastMessage(group);
    const avatarInfo = getGroupAvatarInfo(group);
    const isHovered = hoveredId === group.id;
    const displayTime = lastMsg ? formatTime(lastMsg.created_at) : (group.last_message_at ? formatTime(group.last_message_at) : dayjs(group.created_at).fromNow());
    const displayPreview = replaceOldModelNames(lastMsg
      ? (lastMsg.sender_type === 'user' ? '[我] ' : '') + lastMsg.content.substring(0, 40) + (lastMsg.content.length > 40 ? '...' : '')
      : (group.last_message_preview || group.description || '暂无消息'));

    return (
      <motion.div
        key={group.id}
        initial={reducedMotion ? { opacity: 1 } : { opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        exit={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
        transition={reducedMotion ? { duration: 0.1 } : { duration: 0.2, ease: [0.0, 0.0, 0.2, 1] }}
        onClick={() => handleSelectGroup(group.id)}
        onMouseEnter={() => setHoveredId(group.id)}
        onMouseLeave={() => setHoveredId(null)}
        className={`
          chat-item group ${currentGroup?.id === group.id ? 'active' : ''}
          overflow-hidden
        `}
      >
        <div className={`flex items-center gap-3 px-3 py-2.5 ${group.pinned ? 'bg-[rgb(var(--sidebar-pinned))]' : ''
          }`}>
          <div className="relative flex-shrink-0">
            <div
              className="w-9 h-9 rounded flex items-center justify-center text-white text-sm font-semibold overflow-hidden transition-transform duration-150"
              style={{
                backgroundColor: avatarInfo.color,
                transform: isHovered ? 'scale(1.02)' : 'scale(1)',
              }}
            >
              {avatarInfo.letter && (
                <span className="absolute inset-0 flex items-center justify-center">{avatarInfo.letter}</span>
              )}
              {avatarInfo.avatarUrl && (
                <img
                  src={avatarInfo.avatarUrl}
                  alt=""
                  className="w-full h-full object-cover relative z-10"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium text-text-primary text-sm truncate transition-colors duration-150">
                  {replaceOldModelNames(group.name)}
                </span>
                {group.pinned && (
                  <svg className="w-3 h-3 text-text-muted flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                  </svg>
                )}
              </div>
              <span className="text-xs text-text-muted ml-2 flex-shrink-0 select-none">
                {displayTime}
              </span>
            </div>
            <div className="mt-0.5">
              <p className="text-xs text-text-secondary truncate">
                {lastMsg ? (
                  <>{displayPreview}</>
                ) : (
                  <span className="text-text-muted">{displayPreview}</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-150 flex-shrink-0">
            {group.pinned && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  useGroupsStore.getState().updateGroupSettings(group.id, { pinned: !group.pinned } as Partial<Group>);
                }}
                className="w-5 h-5 rounded flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-hover"
                title="取消置顶"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" /></svg>
              </button>
            )}
            <button
              onClick={(e) => handleDeleteGroup(e, group.id)}
              className="w-5 h-5 rounded flex items-center justify-center text-text-muted hover:text-red-400 hover:bg-red-500/10"
              title="删除聊天"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
      </motion.div>
    );
  };

  const renderGroupSection = (groupKey: keyof GroupedGroups, groups: Group[]) => {
    if (groups.length === 0) return null;

    const config = GROUP_CONFIG[groupKey];
    const isExpanded = expandedGroups.has(groupKey);
    let itemIndex = 0;

    return (
      <div key={groupKey}>
        <button
          onClick={(e) => toggleGroup(groupKey, e)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-text-muted hover:bg-sidebar-hover/50 transition-colors duration-150 select-none"
        >
          <svg
            className={`w-3 h-3 transition-transform duration-200 ${isExpanded ? '' : '-rotate-90'}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          {config.icon}
          <span>{config.label}</span>
        </button>

        <div
          className={`
            overflow-hidden transition-all duration-200 ease-out
            ${isExpanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'}
          `}
        >
          <AnimatePresence>
            {groups.map((group) => {
              const currentIndex = itemIndex++;
              return renderChatItem(group, currentIndex, groupKey);
            })}
          </AnimatePresence>
        </div>
      </div>
    );
  };

  const renderSearchResults = () => {
    const { searchData, loading, query, activeTab } = globalSearch;
    if (!query.trim()) {
      return (
        <div className="flex flex-col items-center justify-center h-64 text-text-muted animate-fade-in">
          <svg className="w-12 h-12 mb-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <span className="text-sm">搜索全部内容</span>
          <div className="flex flex-wrap justify-center gap-1.5 mt-3 max-w-[240px]">
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent">群聊</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500">消息</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">文件</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-500">AI 角色</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-500">智能体</span>
          </div>
        </div>
      );
    }

    if (loading) {
      return (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
        </div>
      );
    }

    if (!searchData || searchData.total === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-64 text-text-muted animate-fade-in">
          <svg className="w-12 h-12 mb-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <span className="text-sm">未找到 "{query}" 的结果</span>
        </div>
      );
    }

    const groupResults = searchData.groups || [];
    const messageResults = searchData.messages || [];
    const fileResults = searchData.files || [];
    const agentResults = searchData.agents || [];
    const personaResults = searchData.personas || [];
    const commentResults = searchData.comments || [];

    return (
      <div className="space-y-1">
        {(activeTab === 'all' || activeTab === 'groups') && groupResults.length > 0 && (
          <div>
            {activeTab === 'all' && (
              <div className="flex items-center gap-1.5 px-4 py-1.5">
                <svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" /></svg>
                <span className="text-[10px] font-medium text-accent">群聊</span>
                <span className="text-[10px] text-text-muted">{groupResults.length}</span>
              </div>
            )}
            {groupResults.map(r => (
              <div key={r.id} onClick={() => { handleSelectGroup(r.id); handleExitSearch(); }} className="px-4 py-2.5 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                    <svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" /></svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-[11px] text-text-primary">{highlightText(r.name, searchRegex)}</span>
                    <span className="text-[10px] text-text-muted ml-1">{r.memberCount} 位成员</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {(activeTab === 'all' || activeTab === 'messages') && messageResults.length > 0 && (
          <div>
            {activeTab === 'all' && (
              <div className="flex items-center gap-1.5 px-4 py-1.5">
                <svg className="w-3 h-3 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" /></svg>
                <span className="text-[10px] font-medium text-blue-500">消息</span>
                <span className="text-[10px] text-text-muted">{messageResults.length}</span>
              </div>
            )}
            {messageResults.map(r => (
              <div key={r.id} onClick={() => { selectGroup(r.group_id); setScrollToMessageId(r.id); handleExitSearch(); }} className="px-4 py-2.5 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                <div className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-semibold flex-shrink-0" style={{ backgroundColor: getSenderColor(r.sender_type, r.sender_id) }}>
                    {getAvatarLetter(r.sender_type, r.sender_id)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="font-medium text-[11px] text-text-primary">{getSenderName(r.sender_type, r.sender_id)}</span>
                      <span className="text-[9px] text-accent/70 truncate max-w-[60px]">{r.group_name}</span>
                      {r.match_type === 'attachment' && <span className="text-[9px] px-1 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">附件</span>}
                      <span className="text-[9px] text-text-muted ml-auto flex-shrink-0">{dayjs(r.created_at).format('M/D HH:mm')}</span>
                    </div>
                    {r.match_type === 'content' && r.content && (
                      <p className="text-[11px] text-text-secondary line-clamp-2">{highlightText(r.content, searchRegex)}</p>
                    )}
                    {r.match_type === 'attachment' && r.attachment_match && (
                      <p className="text-[10px] text-text-muted">📎 {highlightText(r.attachment_match.filename, searchRegex)}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {(activeTab === 'all' || activeTab === 'files') && fileResults.length > 0 && (
          <div>
            {activeTab === 'all' && (
              <div className="flex items-center gap-1.5 px-4 py-1.5">
                <svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                <span className="text-[10px] font-medium text-emerald-500">文件</span>
                <span className="text-[10px] text-text-muted">{fileResults.length}</span>
              </div>
            )}
            {fileResults.map(r => (
              <div key={r.id} onClick={() => { selectGroup(r.group_id); if (r.linked_message_id) setScrollToMessageId(r.linked_message_id); handleExitSearch(); }} className="px-4 py-2.5 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0 text-emerald-500">
                    {getFileIcon(r.mime_type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="font-medium text-[11px] text-text-primary truncate">{highlightText(r.filename, searchRegex)}</span>
                      <span className="text-[9px] text-text-muted flex-shrink-0">{formatFileSize(r.file_size)}</span>
                    </div>
                    {r.search_description && <p className="text-[10px] text-text-secondary line-clamp-1">{highlightText(r.search_description, searchRegex)}</p>}
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[9px] text-accent/70">{r.group_name}</span>
                      <span className="text-[9px] px-1 rounded bg-bg-surface2 text-text-muted">
                        {r.match_field === 'filename' ? '文件名' : r.match_field === 'description' ? 'AI 描述' : r.match_field === 'tags' ? '标签' : '内容'}
                      </span>
                      <span className="text-[9px] text-text-muted ml-auto">{dayjs(r.created_at).format('M/D')}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {(activeTab === 'all' || activeTab === 'agents') && agentResults.length > 0 && (
          <div>
            {activeTab === 'all' && (
              <div className="flex items-center gap-1.5 px-4 py-1.5">
                <svg className="w-3 h-3 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" /></svg>
                <span className="text-[10px] font-medium text-purple-500">智能体</span>
                <span className="text-[10px] text-text-muted">{agentResults.length}</span>
              </div>
            )}
            {agentResults.map(r => (
              <div key={r.id} onClick={() => { selectAgent(r.id); handleExitSearch(); }} className="px-4 py-2.5 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                    <svg className="w-3.5 h-3.5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" /></svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-[11px] text-text-primary">{highlightText(r.name, searchRegex)}</span>
                    {r.description && <p className="text-[10px] text-text-muted line-clamp-1">{highlightText(r.description, searchRegex)}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {(activeTab === 'all' || activeTab === 'personas') && personaResults.length > 0 && (
          <div>
            {activeTab === 'all' && (
              <div className="flex items-center gap-1.5 px-4 py-1.5">
                <svg className="w-3 h-3 text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" /></svg>
                <span className="text-[10px] font-medium text-cyan-500">AI角色</span>
                <span className="text-[10px] text-text-muted">{personaResults.length}</span>
              </div>
            )}
            {personaResults.map(r => (
              <div key={r.id} className="px-4 py-2.5 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[9px] font-semibold flex-shrink-0" style={{ backgroundColor: r.color || '#6b7280' }}>
                    {AI_AVATAR_LETTERS[r.id] || r.name?.[0] || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-[11px] text-text-primary">{highlightText(r.name, searchRegex)}</span>
                    {r.personality && <p className="text-[10px] text-text-muted line-clamp-1">{highlightText(r.personality, searchRegex)}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {(activeTab === 'all' || activeTab === 'comments') && commentResults.length > 0 && (
          <div>
            {activeTab === 'all' && (
              <div className="flex items-center gap-1.5 px-4 py-1.5">
                <svg className="w-3 h-3 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
                <span className="text-[10px] font-medium text-amber-500">评论</span>
                <span className="text-[10px] text-text-muted">{commentResults.length}</span>
              </div>
            )}
            {commentResults.map(r => (
              <div key={r.id} onClick={() => { if (r.group_id) { selectGroup(r.group_id); setScrollToMessageId(r.message_id); } handleExitSearch(); }} className="px-4 py-2.5 hover:bg-sidebar-hover transition-colors cursor-pointer border-b border-border-subtle/30">
                <div className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-semibold flex-shrink-0" style={{ backgroundColor: getSenderColor(r.sender_type, r.sender_id) }}>
                    {getAvatarLetter(r.sender_type, r.sender_id)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="font-medium text-[11px] text-text-primary">{getSenderName(r.sender_type, r.sender_id)}</span>
                      <span className="text-[9px] text-text-muted">评论人 {r.group_name}</span>
                      <span className="text-[9px] text-text-muted ml-auto">{dayjs(r.created_at).format('M/D HH:mm')}</span>
                    </div>
                    <p className="text-[11px] text-text-secondary line-clamp-2">{highlightText(r.content, searchRegex)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (showSearch) {
    const tabs: { key: SearchFilterTab; label: string; count: number }[] = [
      { key: 'all', label: '全部', count: globalSearch.searchData?.total || 0 },
      { key: 'groups', label: '群聊', count: globalSearch.searchData?.groups?.length || 0 },
      { key: 'messages', label: '消息', count: globalSearch.searchData?.messages?.length || 0 },
      { key: 'files', label: '文件', count: globalSearch.searchData?.files?.length || 0 },
      { key: 'agents', label: '智能体', count: globalSearch.searchData?.agents?.length || 0 },
      { key: 'personas', label: 'AI角色', count: globalSearch.searchData?.personas?.length || 0 },
      { key: 'comments', label: '评论', count: globalSearch.searchData?.comments?.length || 0 },
    ];

    return (
      <div className="h-full flex flex-col bg-bg-primary">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <button onClick={handleExitSearch} className="text-text-secondary text-sm hover:text-text-primary transition-colors duration-150">取消</button>
          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            value={globalSearch.query}
            onChange={(e) => globalSearch.setQuery(e.target.value)}
            placeholder="搜索群聊、消息、文件、智能体..."
            className="flex-1 px-3 py-1.5 bg-bg-surface2 rounded-lg text-sm outline-none text-text-primary placeholder-text-muted focus:ring-2 focus:ring-accent/30 transition-all duration-150"
          />
          {globalSearch.query && (
            <button
              onClick={() => globalSearch.setQuery('')}
              className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-sidebar-hover text-text-muted"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {globalSearch.query && globalSearch.searchData && (
          <div className="flex border-b border-border-subtle flex-shrink-0 overflow-x-auto">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => globalSearch.setActiveTab(tab.key)}
                className={`px-2.5 py-2 text-[10px] whitespace-nowrap transition-colors border-b-2 flex-shrink-0 ${globalSearch.activeTab === tab.key
                  ? 'border-accent text-accent font-medium'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
                  }`}
              >
                {tab.label}
                {tab.count > 0 && <span className="ml-0.5">{tab.count}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto pb-safe">
          {renderSearchResults()}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <h1 className="text-[13px] font-semibold text-text-primary">聊天</h1>
        <div className="flex items-center gap-1">
          {onNewChat && (
            <button onClick={onNewChat} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-sidebar-hover transition-colors duration-150 active:scale-95">
              <svg className="w-4 h-4 text-text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 4v16m8-8H4" />
              </svg>
            </button>
          )}
          <button onClick={() => setShowSearch(true)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-sidebar-hover transition-colors duration-150 active:scale-95">
            <svg className="w-4 h-4 text-text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-safe">
        <AnimatePresence mode="wait">
          {loading && groups.length === 0 ? (
            <motion.div
              key="chat-list-skeleton"
              initial={{ opacity: 1 }}
              exit={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <ChatListSkeleton count={8} />
            </motion.div>
          ) : (
            <motion.div
              key="chat-list-content"
              initial={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, ease: [0.0, 0.0, 0.2, 1] }}
            >
              {renderGroupSection('pinned', groupedGroups.pinned)}
              {renderGroupSection('today', groupedGroups.today)}
              {renderGroupSection('yesterday', groupedGroups.yesterday)}
              {renderGroupSection('thisWeek', groupedGroups.thisWeek)}
              {renderGroupSection('earlier', groupedGroups.earlier)}

              {!loading && sortedGroups.length === 0 && (
                <div className="flex flex-col items-center justify-center h-64 text-text-muted animate-fade-in">
                  <svg className="w-16 h-16 mb-4 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="text-sm">还没有聊天</span>
                  <span className="text-xs mt-1">点击右上角 + 创建新聊天</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
