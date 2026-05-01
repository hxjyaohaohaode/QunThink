import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
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
  const { currentGroup } = useGroupsStore();
  const { messages, pagination, loading, batchDeleteMessages, clearAllMessages, loadMoreMessages, streamUpdateCounter } = useMessagesStore();
  const { typingIndicators, setReplyingTo } = useUIStore();
  const { scrollToMessageId, setScrollToMessageId } = useNavigationStore();
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
  const [showDebatePanel, setShowDebatePanel] = useState(false);
  const selectedMessageIdsKey = Array.from(selectedMessageIds).sort().join(',');

  const visibleMessageIds = useRef<Set<string>>(new Set());

  const markAsRead = async (messageId: string) => {
    if (!currentGroup) return;
    try {
      await api.markMessageRead(currentGroup.id, messageId);
    } catch (error) {}
  };
  
  const isDebateMode = currentGroup?.debate_mode || false;

  const groupMessages = currentGroup ? messages[currentGroup.id] || [] : [];
  const groupTyping = currentGroup ? typingIndicators[currentGroup.id] || {} : {};
  const groupPagination = currentGroup ? pagination[currentGroup.id] || { hasMore: false, loadingMore: false, oldestMessageId: null } : { hasMore: false, loadingMore: false, oldestMessageId: null };

  const typingAiIds = Object.entries(groupTyping)
    .filter(([_, isTyping]) => isTyping)
    .map(([aiId]) => aiId);

  const hasStreamingMessages = groupMessages.some(m => m.is_streaming);

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

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    const wasAtBottom = isAtBottom;

    if (!atBottom && awaitingResponseRef.current && !isScrollingRef.current) {
      return;
    }

    setIsAtBottom(atBottom);
    
    if (!atBottom) {
      if (isScrollingRef.current) {
        clearAwaitingResponse();
      }
    }
    
    if (!wasAtBottom && atBottom && unreadCount > 0) {
      setUnreadCount(0);
      setFirstUnreadMessageId(null);
    }
  }, [isAtBottom, unreadCount, clearAwaitingResponse]);

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
        setTimeout(() => {
          loadingMoreRef.current = false;
        }, 100);
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
        awaitingResponseRef.current = true;
        if (awaitingResponseTimerRef.current) {
          clearTimeout(awaitingResponseTimerRef.current);
        }
        awaitingResponseTimerRef.current = setTimeout(() => {
          awaitingResponseRef.current = false;
          awaitingResponseTimerRef.current = null;
        }, 30000);
        setTimeout(() => scrollToBottom('smooth'), 50);
      }
      
      if (!isAtBottom && !awaitingResponseRef.current) {
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

      if (awaitingResponseRef.current && !hasUserMessage) {
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
    if (typingAiIds.length > 0 && awaitingResponseRef.current) {
      setTimeout(() => scrollToBottom('smooth'), 50);
    }
  }, [typingAiIds.length, listItems.length, scrollToBottom]);

  useEffect(() => {
    if (hasStreamingMessages && awaitingResponseRef.current) {
      const now = Date.now();
      if (now - lastStreamScrollRef.current >= 150) {
        lastStreamScrollRef.current = now;
        requestAnimationFrame(() => {
          scrollToBottom('auto');
        });
      }
    }
  }, [streamUpdateCounter, hasStreamingMessages, scrollToBottom]);

  useEffect(() => {
    if (awaitingResponseRef.current && typingAiIds.length === 0 && !hasStreamingMessages) {
      const lastMsg = groupMessages[groupMessages.length - 1];
      if (lastMsg && lastMsg.sender_type === 'ai' && !lastMsg.is_streaming) {
        clearAwaitingResponse();
      }
    }
  }, [typingAiIds.length, hasStreamingMessages, groupMessages, clearAwaitingResponse]);

  useEffect(() => {
    if (scrollToMessageId && groupMessages.length > 0) {
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
      }
      
      setScrollToMessageId(null);
    }
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

  const renderItem = useCallback((_index: number, item: ListItem) => {
    const message = item.data as Message;
    const isSelected = selectedMessageIds.has(message.id);
    const isRecentNew = newMessageIdsRef.current.has(message.id) && !initialLoadRef.current;
    const isNearBottom = _index >= listItems.length - MAX_ANIMATED_MESSAGES;
    const isNew = isRecentNew && isNearBottom;
    
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
                className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                  isSelected
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
              onReply={() => !isMultiSelectMode && setReplyingTo(message.id)}
              isMultiSelectMode={isMultiSelectMode}
              isDebateMode={isDebateMode}
            />
          </div>
        </div>
      </MessageItemWrapper>
    );
  }, [selectedMessageIdsKey, isMultiSelectMode, toggleMessageSelection, setReplyingTo, isDebateMode, reducedMotion, listItems.length]);

  if (!currentGroup) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gradient-to-b from-bg-primary to-bg-surface2">
        <div className="text-center">
          <div className="text-6xl mb-4"><svg className="w-16 h-16 mx-auto text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.75}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg></div>
          <p className="text-text-secondary text-lg mb-2">选择一个群组开始聊天</p>
          <p className="text-text-muted text-sm">或点击左上角 + 创建新对话</p>
        </div>
      </div>
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
        
        {loading && groupMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <MessageListSkeleton count={6} />
          </div>
        ) : groupMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="text-6xl mb-4">👋</div>
              <p className="text-text-secondary mb-2">开始你的第一个问题吧！</p>
              <p className="text-text-muted text-sm">
                试试问：「帮我分析一下这段代码有什么问题」
              </p>
            </div>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={listItems}
            itemContent={renderItem}
            scrollerRef={(ref) => { scrollerRef.current = ref; }}
            isScrolling={handleIsScrolling}
            atBottomStateChange={handleAtBottomStateChange}
            atTopStateChange={handleAtTopStateChange}
            increaseViewportBy={{ top: 200, bottom: 200 }}
            overscan={5}
            style={{ flex: 1, minHeight: 0 }}
            rangeChanged={handleRangeChanged}
            followOutput={isAtBottom ? 'smooth' : false}
            components={virtuosoComponents}
          />
        )}

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
