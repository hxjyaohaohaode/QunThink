import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import dayjs from 'dayjs';
import { useMessagesStore, Message } from '../../stores/messagesStore';
import { useUIStore } from '../../stores/uiStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { MessageBubble } from './MessageBubble';
import { MultiTypingIndicator } from './TypingIndicator';
import { NewMessageBadge } from './NewMessageBadge';

const TIME_GAP_MINUTES = 5;
const SCROLL_THRESHOLD = 50; // 距离底部多少像素以内算是在底部

export function MessageList() {
  const { currentGroup } = useGroupsStore();
  const { messages, loading } = useMessagesStore();
  const { typingIndicators, setReplyingTo } = useUIStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<string | null>(null);
  const prevMessageCount = useRef(0);

  const groupMessages = currentGroup ? messages[currentGroup.id] || [] : [];
  const groupTyping = currentGroup ? typingIndicators[currentGroup.id] || {} : {};

  const typingAiIds = Object.entries(groupTyping)
    .filter(([_, isTyping]) => isTyping)
    .map(([aiId]) => aiId);

  // 检测滚动位置
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const wasAtBottom = isAtBottom;
    const isNowAtBottom = distanceFromBottom <= SCROLL_THRESHOLD;
    
    setIsAtBottom(isNowAtBottom);
    
    // 如果用户滚动到底部，清除未读计数
    if (!wasAtBottom && isNowAtBottom && unreadCount > 0) {
      setUnreadCount(0);
      setFirstUnreadMessageId(null);
    }
  }, [isAtBottom, unreadCount]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // 处理新消息
  useEffect(() => {
    const currentCount = groupMessages.length;
    
    if (currentCount > prevMessageCount.current) {
      if (!isAtBottom) {
        const newMsgCount = currentCount - prevMessageCount.current;
        setUnreadCount(prev => prev + newMsgCount);
        
        if (!firstUnreadMessageId) {
          const newMessages = groupMessages.slice(prevMessageCount.current);
          const firstNewMsg = newMessages.find(m => m.sender_type !== 'system');
          if (firstNewMsg) {
            setFirstUnreadMessageId(firstNewMsg.id);
          }
        }
      }
    }
    
    prevMessageCount.current = currentCount;
  }, [groupMessages.length, isAtBottom]);

  // 初始加载时滚动到底部
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (prevMessageCount.current === 0 && groupMessages.length > 0) {
      const timer = setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      }, 100);
      prevMessageCount.current = groupMessages.length;
      return () => clearTimeout(timer);
    }
  }, [groupMessages.length]);

  // 切换群组时重置状态并自动滚动到底部
  useEffect(() => {
    prevMessageCount.current = 0;
    setUnreadCount(0);
    setIsAtBottom(true);
    setFirstUnreadMessageId(null);

    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [currentGroup?.id]);

  // 消息从loading状态变为有消息时，自动滚动到底部
  useEffect(() => {
    if (!loading && groupMessages.length > 0 && prevMessageCount.current === 0) {
      const timer = setTimeout(() => {
        const container = containerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [loading, groupMessages.length]);

  // 点击新消息提示，滚动到最后一条未读消息
  const scrollToFirstUnread = useCallback(() => {
    if (firstUnreadMessageId) {
      const messageElement = document.querySelector(`[data-message-id="${firstUnreadMessageId}"]`);
      if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageElement.classList.add('unread-highlight');
        setTimeout(() => {
          messageElement.classList.remove('unread-highlight');
        }, 2000);
      }
      setFirstUnreadMessageId(null);
    } else {
      const container = containerRef.current;
      if (container) {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth'
        });
      }
    }
    setUnreadCount(0);
  }, [firstUnreadMessageId]);

  const messagesWithTimeDividers = useMemo(() => {
    const result: Array<{ type: 'message' | 'divider'; data: Message | string }> = [];
    let lastTime: dayjs.Dayjs | null = null;

    groupMessages.forEach((message) => {
      const messageTime = dayjs(message.created_at);
      
      if (lastTime === null || messageTime.diff(lastTime, 'minute') >= TIME_GAP_MINUTES) {
        result.push({ type: 'divider', data: message.created_at });
      }
      
      result.push({ type: 'message', data: message });
      lastTime = messageTime;
    });

    return result;
  }, [groupMessages]);

  if (!currentGroup) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-6xl mb-4">💬</div>
          <p className="text-gray-500 text-lg mb-2">选择一个群组开始聊天</p>
          <p className="text-gray-400 text-sm">或点击左上角 + 创建新对话</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-4 bg-gray-50 relative"
      style={{ backgroundImage: 'linear-gradient(180deg, #f5f5f5 0%, #ebebeb 100%)' }}
    >
      {loading && groupMessages.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-gray-400">加载中...</div>
        </div>
      ) : groupMessages.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="text-6xl mb-4">👋</div>
            <p className="text-gray-500 mb-2">开始你的第一个问题吧！</p>
            <p className="text-gray-400 text-sm">
              试试问：「帮我分析一下这段代码有什么问题」
            </p>
          </div>
        </div>
      ) : (
        <>
          {messagesWithTimeDividers.map((item, index) => {
            if (item.type === 'divider') {
              return (
                <div key={`divider-${index}`} className="message-time-divider">
                  <span>{formatTimeDivider(item.data as string)}</span>
                </div>
              );
            }
            
            const message = item.data as Message;
            const prevItem = messagesWithTimeDividers[index - 1];
            const showTimeDivider = prevItem?.type === 'divider';
            
            return (
              <MessageBubble 
                key={message.id} 
                message={message}
                showTimeDivider={showTimeDivider}
                onReply={() => setReplyingTo(message.id)}
              />
            );
          })}

          {typingAiIds.length > 0 && (
            <div className="mt-2">
              <MultiTypingIndicator aiIds={typingAiIds} />
            </div>
          )}
        </>
      )}

      {/* 新消息提示 */}
      <NewMessageBadge 
        count={unreadCount}
        onClick={scrollToFirstUnread}
      />
    </div>
  );
}

function formatTimeDivider(timestamp: string): string {
  const time = dayjs(timestamp);
  const now = dayjs();
  const diffDays = now.diff(time, 'day');
  const isToday = time.isSame(now, 'day');
  const isYesterday = time.isSame(now.subtract(1, 'day'), 'day');

  if (isToday) {
    return time.format('HH:mm');
  } else if (isYesterday) {
    return '昨天 ' + time.format('HH:mm');
  } else if (diffDays < 7) {
    return time.format('dddd HH:mm');
  } else {
    return time.format('MM月DD日 HH:mm');
  }
}
