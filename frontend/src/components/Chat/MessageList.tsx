import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { motion, AnimatePresence } from 'framer-motion';
import dayjs from 'dayjs';
import { useMessagesStore } from '../../stores/messagesStore';
import type { Message } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { MessageBubble } from './MessageBubble';
import { MultiTypingIndicator } from './TypingIndicator';
import { NewMessageBadge } from './NewMessageBadge';
import { DebateControlPanel } from './DebateControlPanel';
import { api } from '../../services/api';
import { useConfirm, useToast, MessageListSkeleton, LoadingSpinner } from '../Common';
import { useReducedMotion } from '../../hooks/useReducedMotion';

const TIME_GAP_MINUTES = 5;

const FlexScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function FlexScroller(props, ref) {
  const { style, className, children, ...rest } = props;
  return (
    <div
      ref={ref}
      className={className}
      style={{ ...style, flex: 1, minHeight: 0, overflowY: 'auto' }}
      data-message-scroller="true"
      {...rest}
    >
      {children}
    </div>
  );
});

function VirtuosoHeader({ hasMore, loadingMore }: { hasMore: boolean; loadingMore: boolean }) {
  if (!hasMore && !loadingMore) return null;
  return (
    <div className="py-3 text-center">
      {loadingMore ? (
        <div className="flex items-center justify-center gap-2 text-text-muted text-sm">
          <LoadingSpinner size="small" />
          加载更多消息...
        </div>
      ) : (
        <div className="text-text-muted text-xs">
          ↑ 向上滚动加载更多
        </div>
      )}
    </div>
  );
}

function VirtuosoFooter({ typingAiIds }: { typingAiIds: string[] }) {
  if (typingAiIds.length === 0) return null;
  return (
    <div className="mt-2 pb-2">
      <MultiTypingIndicator aiIds={typingAiIds} />
    </div>
  );
}

type ListItem =
  | { type: 'message'; data: Message; showTimeDivider: boolean };

const MAX_ANIMATED_MESSAGES = 2;

const MessageItemWrapper = React.memo(({
  children,
  isNew = false,
  reducedMotion = false,
}: {
  children: React.ReactNode;
  isNew?: boolean;
  reducedMotion?: boolean;
}) => {
  if (reducedMotion || !isNew) {
    return <>{children}</>;
  }

  return (
    <div className="animate-new-message-enter">
      {children}
    </div>
  );
});

export function MessageList() {
  const currentGroup = useGroupsStore((s) => s.currentGroup);
  const currentGroupId = currentGroup?.id ?? null;
  const rawGroupMessages = useMessagesStore((s) => (currentGroupId ? s.messages[currentGroupId] : undefined));
  const loading = useMessagesStore((s) => s.loading);
  const streamUpdateCounter = useMessagesStore((s) => s.streamUpdateCounter);
  const rawPagination = useMessagesStore((s) => (currentGroupId ? s.pagination[currentGroupId] : undefined));
  const batchDeleteMessages = useMessagesStore((s) => s.batchDeleteMessages);
  const clearAllMessages = useMessagesStore((s) => s.clearAllMessages);
  const loadMoreMessages = useMessagesStore((s) => s.loadMoreMessages);
  const rawTyping = useUIStore((s) => (currentGroupId ? s.typingIndicators[currentGroupId] : undefined));
  const addReplyingTo = useUIStore((s) => s.addReplyingTo);
  const scrollToMessageId = useNavigationStore((s) => s.scrollToMessageId);
  const setScrollToMessageId = useNavigationStore((s) => s.setScrollToMessageId);
  const { confirm, ConfirmModal } = useConfirm();
  const { showToast, Toast } = useToast();
  const virtuosoRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | Window | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);
  const prevMessageCount = useRef(0);
  const prevGroupId = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const reducedMotion = useReducedMotion();
  const newMessageIdsRef = useRef<Set<string>>(new Set());
  const scrollPositionRef = useRef<number>(0);
  const initialLoadRef = useRef(true);
  const awaitingResponseRef = useRef(false);
  const isScrollingRef = useRef(false);
  const awaitingResponseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamScrollRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (awaitingResponseTimerRef.current) {
        clearTimeout(awaitingResponseTimerRef.current);
      }
    };
  }, []);

  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const selectedMessageIdsRef = useRef<Set<string>>(new Set());
  const [showDebatePanel, setShowDebatePanel] = useState(false);

  // 同步 selectedMessageIds 到 ref，避免 renderItem 不必要的重渲染
  useEffect(() => {
    selectedMessageIdsRef.current = selectedMessageIds;
  }, [selectedMessageIds]);

  const visibleMessageIds = useRef<Set<string>>(new Set());

  // 已读回执批量防抖：逐条 POST 会在进入含大量历史消息的群时瞬间打满限流桶，
  // 连带把真正的消息发送挤成 429。收集后 800ms 合并为一次批量请求。
  const pendingReadIdsRef = useRef<Set<string>>(new Set());
  const readFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markAsRead = useCallback((messageId: string) => {
    if (!currentGroup) return;
    pendingReadIdsRef.current.add(messageId);
    if (readFlushTimerRef.current) return;
    readFlushTimerRef.current = setTimeout(async () => {
      readFlushTimerRef.current = null;
      const ids = [...pendingReadIdsRef.current];
      pendingReadIdsRef.current.clear();
      if (ids.length === 0 || !currentGroup) return;
      try {
        await api.markMessagesReadBatch(currentGroup.id, ids);
      } catch { /* 已读回执失败可静默，下次可见范围变化会重试 */ }
    }, 800);
  }, [currentGroup]);

  const isDebateMode = currentGroup?.debate_mode || false;

  const groupMessages = useMemo(() => rawGroupMessages || [], [rawGroupMessages]);
  const groupTyping = useMemo(() => rawTyping || {}, [rawTyping]);
  const groupPagination = useMemo(
    () => rawPagination || { hasMore: false, loadingMore: false, oldestMessageId: null },
    [rawPagination]
  );

  const typingAiIds = useMemo(() => Object.entries(groupTyping)
    .filter(([_, isTyping]) => isTyping)
    .map(([aiId]) => aiId), [groupTyping]);

  const hasStreamingMessages = useMemo(() => groupMessages.some(m => m.is_streaming), [groupMessages]);

  const listItems = useMemo(() => {
    const result: ListItem[] = [];

    groupMessages.forEach((message, index) => {
      const messageTime = dayjs(message.created_at);
      const prevMessage = index > 0 ? groupMessages[index - 1] : null;
      const prevTime = prevMessage ? dayjs(prevMessage.created_at) : null;
      const shouldShowDivider = prevTime === null || messageTime.diff(prevTime, 'minute') >= TIME_GAP_MINUTES;

      result.push({
        type: 'message',
        data: message,
        showTimeDivider: shouldShowDivider
      });
    });

    return result;
  }, [groupMessages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const scroller = scrollerRef.current;
    if (scroller && scroller instanceof HTMLElement) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    } else {
      virtuosoRef.current?.scrollToIndex({
        index: listItems.length - 1,
        behavior: behavior === 'smooth' ? 'smooth' : 'auto',
        align: 'end'
      });
    }
  }, [listItems.length]);

  const handleRangeChanged = useCallback(({ startIndex, endIndex }: { startIndex: number; endIndex: number }) => {
    for (let i = startIndex; i <= endIndex && i < listItems.length; i++) {
      const item = listItems[i];
      if (item?.type === 'message' && item.data?.id && item.data.sender_type === 'ai') {
        const msgId = item.data.id;
        if (!visibleMessageIds.current.has(msgId)) {
          visibleMessageIds.current.add(msgId);
          markAsRead(msgId);
        }
      }
    }
  }, [listItems, markAsRead]);

  const virtuosoComponents = useMemo(() => ({
    Scroller: FlexScroller,
    Header: () => (<VirtuosoHeader hasMore={groupPagination.hasMore} loadingMore={groupPagination.loadingMore} />),
    Footer: () => (<VirtuosoFooter typingAiIds={typingAiIds} />)
  }), [groupPagination.hasMore, groupPagination.loadingMore, typingAiIds]);

  const handleIsScrolling = useCallback((scrolling: boolean) => {
    isScrollingRef.current = scrolling;
  }, []);

  const clearAwaitingResponse = useCallback(() => {
    awaitingResponseRef.current = false;
    if (awaitingResponseTimerRef.current) {
      clearTimeout(awaitingResponseTimerRef.current);
      awaitingResponseTimerRef.current = null;
    }
  }, []);

  // 用户主动上滚意图：仅由 wheel/touch 事件设置（程序化滚动不触发），
  // 用于在等待 AI 回复期间让用户能够脱离底部跟随。
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!(el instanceof HTMLElement)) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -5) {
        userScrolledUpRef.current = true;
        if (awaitingResponseRef.current) clearAwaitingResponse();
      } else if (e.deltaY > 5) {
        userScrolledUpRef.current = false;
      }
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchStartY > 8) {
        userScrolledUpRef.current = true;
        if (awaitingResponseRef.current) clearAwaitingResponse();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [currentGroup?.id, clearAwaitingResponse]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    const wasAtBottom = isAtBottom;

    setIsAtBottom(atBottom);
    if (atBottom) {
      userScrolledUpRef.current = false;
    }

    if (!wasAtBottom && atBottom && unreadCount > 0) {
      setUnreadCount(0);
      setFirstUnreadMessageId(null);
    }
  }, [isAtBottom, unreadCount]);

  const handleAtTopStateChange = useCallback((atTop: boolean) => {
    if (atTop && currentGroup && groupPagination.hasMore && !groupPagination.loadingMore && !loadingMoreRef.current) {
      if (virtuosoRef.current) {
        const virtuosoState = virtuosoRef.current.getState?.();
        if (virtuosoState?.scrollTop !== undefined) {
          scrollPositionRef.current = virtuosoState.scrollTop;
        }
      }

      loadingMoreRef.current = true;

      loadMoreMessages(currentGroup.id).then(() => {
        // 在加载完成后立即重置，不再使用固定100ms定时器
        loadingMoreRef.current = false;
      }).catch(() => {
        loadingMoreRef.current = false;
      });
    }
  }, [currentGroup, groupPagination.hasMore, groupPagination.loadingMore, loadMoreMessages]);

  useEffect(() => {
    const currentCount = groupMessages.length;

    if (currentCount > prevMessageCount.current) {
      const newMessages = groupMessages.slice(prevMessageCount.current);
      newMessages.forEach(msg => {
        newMessageIdsRef.current.add(msg.id);
        setTimeout(() => {
          newMessageIdsRef.current.delete(msg.id);
        }, 1000);
      });

      const hasUserMessage = newMessages.some(m => m.sender_type === 'user');
      if (hasUserMessage) {
        setIsAtBottom(true);
        userScrolledUpRef.current = false;
        awaitingResponseRef.current = true;
        if (awaitingResponseTimerRef.current) {
          clearTimeout(awaitingResponseTimerRef.current);
        }
        // 超时时间延长至 120 秒，覆盖长回复场景（推理模型、长文本生成等）
        // 在流式输出过程中会通过 hasStreamingMessages 重置此定时器
        awaitingResponseTimerRef.current = setTimeout(() => {
          awaitingResponseRef.current = false;
          awaitingResponseTimerRef.current = null;
        }, 120000);
        setTimeout(() => scrollToBottom('smooth'), 50);
      }

      if (!isAtBottom && !awaitingResponseRef.current && !userScrolledUpRef.current) {
        const aiMessageCount = newMessages.filter(m => m.sender_type === 'ai').length;
        if (aiMessageCount > 0) {
          setUnreadCount(prev => prev + aiMessageCount);

          if (!firstUnreadMessageId) {
            const firstNewAiMsg = newMessages.find(m => m.sender_type === 'ai');
            if (firstNewAiMsg) {
              setFirstUnreadMessageId(firstNewAiMsg.id);
            }
          }
        }
      }

      if (awaitingResponseRef.current && !hasUserMessage && !userScrolledUpRef.current) {
        setTimeout(() => scrollToBottom('smooth'), 50);
      }
    }

    prevMessageCount.current = currentCount;
  }, [groupMessages.length, isAtBottom, listItems.length, scrollToBottom, firstUnreadMessageId]);

  useEffect(() => {
    if (prevGroupId.current !== currentGroup?.id) {
      prevGroupId.current = currentGroup?.id || null;
      prevMessageCount.current = 0;
      setUnreadCount(0);
      setIsAtBottom(true);
      setFirstUnreadMessageId(null);
      setIsMultiSelectMode(false);
      setSelectedMessageIds(new Set());
      visibleMessageIds.current = new Set();
      newMessageIdsRef.current = new Set();
      initialLoadRef.current = true;
      clearAwaitingResponse();

      if (currentGroup) {
        setTimeout(() => scrollToBottom('auto'), 100);
      }
    }
  }, [currentGroup?.id, listItems.length, scrollToBottom, clearAwaitingResponse]);

  useEffect(() => {
    if (!loading && groupMessages.length > 0 && prevMessageCount.current === 0) {
      initialLoadRef.current = false;
      setTimeout(() => scrollToBottom('smooth'), 150);
    }
  }, [loading, groupMessages.length, listItems.length, scrollToBottom]);

  useEffect(() => {
    if (typingAiIds.length > 0 && awaitingResponseRef.current && !userScrolledUpRef.current) {
      setTimeout(() => scrollToBottom('smooth'), 50);
    }
  }, [typingAiIds.length, listItems.length, scrollToBottom]);

  useEffect(() => {
    if (hasStreamingMessages && awaitingResponseRef.current) {
      const now = Date.now();
      if (now - lastStreamScrollRef.current >= 100) {
        lastStreamScrollRef.current = now;
        if (!userScrolledUpRef.current) scrollToBottom('auto');
      }
      // 流式输出过程中持续重置 awaitingResponse 定时器，避免长回复超时
      if (awaitingResponseTimerRef.current) {
        clearTimeout(awaitingResponseTimerRef.current);
        awaitingResponseTimerRef.current = setTimeout(() => {
          awaitingResponseRef.current = false;
          awaitingResponseTimerRef.current = null;
        }, 120000);
      }
    }
  }, [streamUpdateCounter, hasStreamingMessages, scrollToBottom]);

  useEffect(() => {
    if (awaitingResponseRef.current && typingAiIds.length === 0 && !hasStreamingMessages) {
      const lastMsg = groupMessages[groupMessages.length - 1];
      if (lastMsg && lastMsg.sender_type === 'ai' && !lastMsg.is_streaming) {
        clearAwaitingResponse();
        // 流式结束且 AI 回复完成时，强制滚动到底部，确保完整消息可见
        if (!userScrolledUpRef.current) {
          setTimeout(() => scrollToBottom('smooth'), 50);
        }
      }
    }
  }, [typingAiIds.length, hasStreamingMessages, groupMessages, clearAwaitingResponse, scrollToBottom]);

  useEffect(() => {
    if (!scrollToMessageId) return;

    // 5 秒内未能定位到目标消息则消费掉导航请求，避免永久悬挂
    const consumeTimeoutId = setTimeout(() => {
      setScrollToMessageId(null);
    }, 5000);

    if (groupMessages.length > 0) {
      const itemIndex = listItems.findIndex(
        item => item.type === 'message' && item.data.id === scrollToMessageId
      );

      if (itemIndex !== -1) {
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({
            index: itemIndex,
            behavior: 'smooth',
            align: 'center'
          });

          setTimeout(() => {
            const messageElement = document.querySelector(`[data-message-id="${scrollToMessageId}"]`);
            if (messageElement) {
              messageElement.classList.add('search-highlight');
              setTimeout(() => {
                messageElement.classList.remove('search-highlight');
              }, 3000);
            }
          }, 300);
        }, 100);

        setScrollToMessageId(null);
      }
    }

    return () => clearTimeout(consumeTimeoutId);
  }, [scrollToMessageId, groupMessages.length, listItems, setScrollToMessageId]);

  const toggleMultiSelectMode = useCallback(() => {
    setIsMultiSelectMode(prev => {
      if (prev) {
        setSelectedMessageIds(new Set());
      }
      return !prev;
    });
  }, []);

  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedMessageIds.size === groupMessages.length) {
      setSelectedMessageIds(new Set());
    } else {
      setSelectedMessageIds(new Set(groupMessages.map(m => m.id)));
    }
  }, [groupMessages, selectedMessageIds.size]);

  const handleDeleteSelected = useCallback(async () => {
    if (!currentGroup || selectedMessageIds.size === 0) return;
    const confirmed = await confirm({
      title: '删除消息',
      description: `确定删除选中的 ${selectedMessageIds.size} 条消息吗？`,
      danger: true,
    });
    if (confirmed) {
      await batchDeleteMessages(Array.from(selectedMessageIds), currentGroup.id);
      setSelectedMessageIds(new Set());
      setIsMultiSelectMode(false);
      showToast({ message: '消息已删除', type: 'success' });
    }
  }, [currentGroup, selectedMessageIds, batchDeleteMessages, confirm, showToast]);

  const handleClearConfirm = useCallback(async () => {
    if (!currentGroup) return;
    const confirmed = await confirm({
      title: '清空聊天记录',
      description: '确定要清空所有聊天记录吗？此操作不可撤销。',
      danger: true,
    });
    if (confirmed) {
      await clearAllMessages(currentGroup.id);
      setIsMultiSelectMode(false);
      showToast({ message: '聊天记录已清空', type: 'success' });
    }
  }, [currentGroup, clearAllMessages, confirm, showToast]);

  const scrollToFirstUnread = useCallback(() => {
    if (firstUnreadMessageId) {
      const itemIndex = listItems.findIndex(
        item => item.type === 'message' && item.data.id === firstUnreadMessageId
      );
      if (itemIndex !== -1) {
        virtuosoRef.current?.scrollToIndex({
          index: itemIndex,
          behavior: 'smooth',
          align: 'center'
        });

        setTimeout(() => {
          const messageElement = document.querySelector(`[data-message-id="${firstUnreadMessageId}"]`);
          if (messageElement) {
            messageElement.classList.add('unread-highlight');
            setTimeout(() => {
              messageElement.classList.remove('unread-highlight');
            }, 2000);
          }
        }, 300);
      }
      setFirstUnreadMessageId(null);
    } else {
      scrollToBottom('smooth');
    }
    setUnreadCount(0);
  }, [firstUnreadMessageId, listItems, scrollToBottom]);

  const renderItem = useCallback((_index: number, item: ListItem, context: { selectedIds: Set<string> }) => {
    const message = item.data as Message;
    const isSelected = context.selectedIds.has(message.id) || selectedMessageIdsRef.current.has(message.id);
    const isRecentNew = newMessageIdsRef.current.has(message.id) && !initialLoadRef.current;
    const isNearBottom = _index >= listItems.length - MAX_ANIMATED_MESSAGES;
    const isNew = isRecentNew && isNearBottom;

    // 计算是否为同发送者最后一条消息（避免每条消息都订阅store）
    const nextItem = _index < listItems.length - 1 ? listItems[_index + 1] : null;
    const nextMessage = nextItem?.data as Message | undefined;
    const isLastInGroup = !nextMessage ||
      nextMessage.sender_type !== message.sender_type ||
      nextMessage.sender_id !== message.sender_id;

    return (
      <MessageItemWrapper
        key={message.id}
        isNew={isNew}
        reducedMotion={reducedMotion}
      >
        <div
          className={`relative ${isMultiSelectMode ? 'cursor-pointer' : ''}`}
          onClick={() => isMultiSelectMode && toggleMessageSelection(message.id)}
          data-message-id={message.id}
        >
          {isMultiSelectMode && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-6 z-10">
              <div
                className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${isSelected
                  ? 'bg-blue-500 border-blue-500'
                  : 'border-border bg-bg-surface'
                  }`}
              >
                {isSelected && (
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
            </div>
          )}
          <div className={`transition-all duration-200 ${isSelected ? 'bg-blue-500/10 dark:bg-blue-500/20 rounded-lg' : ''}`}>
            <MessageBubble
              message={message}
              showTimeDivider={item.showTimeDivider}
              onReply={() => !isMultiSelectMode && addReplyingTo(message.id)}
              isMultiSelectMode={isMultiSelectMode}
              isDebateMode={isDebateMode}
              isLastInGroup={isLastInGroup}
            />
          </div>
        </div>
      </MessageItemWrapper>
    );
  }, [isMultiSelectMode, toggleMessageSelection, addReplyingTo, isDebateMode, reducedMotion, listItems.length]);

  // 通过 virtuoso context 下发选中集合，勾选变化时触发可见项重渲染
  const virtuosoContext = useMemo(() => ({ selectedIds: selectedMessageIds }), [selectedMessageIds]);

  if (!currentGroup) {
    return (
      <motion.div
        className="flex-1 flex items-center justify-center bg-gradient-to-b from-bg-primary to-bg-surface2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        <div className="text-center">
          <div className="text-6xl mb-4"><svg className="w-16 h-16 mx-auto text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.75}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg></div>
          <p className="text-text-secondary text-lg mb-2">选择一个群组开始聊天</p>
          <p className="text-text-muted text-sm">或点击左上角 + 创建新对话</p>
        </div>
      </motion.div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 flex flex-col relative" style={{ minHeight: 0 }}>
      {isMultiSelectMode && (
        <div className="bg-bg-surface border-b border-border px-2 md:px-4 py-2 md:py-3 flex items-center justify-between gap-2 z-10 flex-wrap">
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            <span className="text-xs md:text-sm font-medium text-text-primary truncate">
              已选择 {selectedMessageIds.size} 条消息
            </span>
            <button
              onClick={toggleSelectAll}
              className="text-xs md:text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 flex-shrink-0"
            >
              {selectedMessageIds.size === groupMessages.length ? '取消全选' : '全选'}
            </button>
          </div>
          <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
            <button
              onClick={handleClearConfirm}
              className="px-2 md:px-3 py-1.5 text-xs md:text-sm text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20 rounded-lg transition-colors"
            >
              清空所有
            </button>
            <button
              onClick={() => selectedMessageIds.size > 0 && handleDeleteSelected()}
              disabled={selectedMessageIds.size === 0}
              className="px-2 md:px-3 py-1.5 text-xs md:text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              删除 ({selectedMessageIds.size})
            </button>
            <button
              onClick={toggleMultiSelectMode}
              className="px-2 md:px-3 py-1.5 text-xs md:text-sm text-text-secondary hover:bg-bg-surface2 rounded-lg transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div
        className="flex-1 relative flex flex-col bg-gradient-to-b from-bg-primary to-bg-surface2"
        style={{ minHeight: 0 }}
      >
        {!isMultiSelectMode && groupMessages.length > 0 && (
          <div className="absolute top-4 right-4 z-10 flex gap-2">
            {isDebateMode && (
              <button
                onClick={() => setShowDebatePanel(true)}
                className="px-3 py-1.5 bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-sm rounded-lg shadow-md hover:from-indigo-600 hover:to-purple-600 transition-all"
              >
                <svg className="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3l7.07 7.07M21 21l-7.07-7.07M3 21l7.07-7.07M21 3l-7.07 7.07" /></svg> 辩论控制
              </button>
            )}
            <button
              onClick={toggleMultiSelectMode}
              className="px-3 py-1.5 bg-bg-surface/90 backdrop-blur-sm text-sm text-text-secondary rounded-lg shadow-sm border border-border hover:bg-bg-surface transition-colors"
            >
              选择消息
            </button>
          </div>
        )}

        <AnimatePresence>
          {loading && groupMessages.length === 0 ? (
            <motion.div
              key="message-loading"
              className="flex items-center justify-center h-full"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <MessageListSkeleton count={6} />
            </motion.div>
          ) : groupMessages.length === 0 ? (
            <motion.div
              key="message-empty"
              className="flex items-center justify-center h-full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="text-center">
                <div className="flex justify-center mb-4">
                  <svg className="w-14 h-14 text-accent/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
                  </svg>
                </div>
                <p className="text-text-secondary mb-2">从一条消息、一个想法开始</p>
                <p className="text-text-muted text-sm">
                  {currentGroup?.space_category === 'play' ? '聊一个故事或角色设定，也可以一起写出下一幕。' : currentGroup?.space_category === 'social' ? '放进活动材料、交流想法，再从「文稿」整理成邀请或记录。' : '讨论计划、保存材料，或打开「文稿」直接写作。'}
                </p>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="message-content"
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              <Virtuoso
                ref={virtuosoRef}
                data={listItems}
                itemContent={renderItem}
                context={virtuosoContext}
                scrollerRef={(ref) => { scrollerRef.current = ref; }}
                isScrolling={handleIsScrolling}
                atBottomStateChange={handleAtBottomStateChange}
                atTopStateChange={handleAtTopStateChange}
                increaseViewportBy={{ top: 400, bottom: 400 }}
                overscan={10}
                style={{ flex: 1, minHeight: 0 }}
                rangeChanged={handleRangeChanged}
                followOutput={isAtBottom ? 'smooth' : false}
                components={virtuosoComponents}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <NewMessageBadge
          count={unreadCount}
          onClick={scrollToFirstUnread}
        />
      </div>

      {currentGroup && (
        <DebateControlPanel
          groupId={currentGroup.id}
          isOpen={showDebatePanel}
          onClose={() => setShowDebatePanel(false)}
        />
      )}
      {ConfirmModal}
      {Toast}
    </div>
  );
}
