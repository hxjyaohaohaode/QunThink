import React, { useState, useCallback, useRef } from 'react';
import { useMessagesStore } from '../../stores/messagesStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../services/api';
import { useToast } from '../Common';

interface MessageActionsProps {
  messageId: string;
  isUser: boolean;
  content: string;
  likes?: string[];
  likedBy?: string[];
  likesCount?: number;
  dislikes?: number;
  dislikedBy?: string[];
  commentsCount?: number;
  onReply?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggleComments?: () => void;
  showComments?: boolean;
}

export const MessageActions = React.memo(function MessageActions({
  messageId,
  isUser,
  content,
  likes = [],
  likedBy = [],
  likesCount = 0,
  dislikes = 0,
  dislikedBy = [],
  commentsCount = 0,
  onReply,
  onEdit,
  onDelete,
  onToggleComments,
  showComments
}: MessageActionsProps) {
  const [isLikeAnimating, setIsLikeAnimating] = useState(false);
  const likeProcessingRef = useRef(false);
  const dislikeProcessingRef = useRef(false);
  const { likeMessage, unlikeMessage, dislikeMessage, undislikeMessage } = useMessagesStore();
  const { currentGroup } = useGroupsStore();
  const { addReplyingTo, replyingTo, removeReplyingTo } = useUIStore();
  const { showToast } = useToast();

  const hasLiked = likedBy.includes('user') || likes.includes('user');
  const hasDisliked = dislikedBy?.includes('user');
  const likeCount = likesCount || likedBy.length || likes.length;
  const dislikeCount = dislikes || 0;
  const commentCount = commentsCount;

  const handleLike = useCallback(async () => {
    if (!currentGroup) return;
    if (likeProcessingRef.current) return;
    likeProcessingRef.current = true;
    try {
      if (hasLiked) {
        unlikeMessage(messageId, currentGroup.id);
      } else {
        setIsLikeAnimating(true);
        setTimeout(() => setIsLikeAnimating(false), 300);
        likeMessage(messageId, currentGroup.id);
        try {
          await api.performAutoLike(messageId, currentGroup.id);
        } catch (e) {
          // Silently fail
        }
      }
    } finally {
      likeProcessingRef.current = false;
    }
  }, [hasLiked, currentGroup, messageId, likeMessage, unlikeMessage]);

  const handleDislike = useCallback(async () => {
    if (!currentGroup) return;
    if (dislikeProcessingRef.current) return;
    dislikeProcessingRef.current = true;
    try {
      if (hasDisliked) {
        undislikeMessage(messageId, currentGroup.id);
      } else {
        dislikeMessage(messageId, currentGroup.id);
      }
    } finally {
      dislikeProcessingRef.current = false;
    }
  }, [hasDisliked, currentGroup, messageId, dislikeMessage, undislikeMessage]);

  const isReplying = replyingTo.includes(messageId);

  const handleReply = useCallback(() => {
    if (onReply) onReply();
    if (isReplying) {
      removeReplyingTo(messageId);
    } else {
      addReplyingTo(messageId);
    }
  }, [onReply, addReplyingTo, removeReplyingTo, messageId, isReplying]);

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(content);
      } else {
        const ta = document.createElement('textarea');
        ta.value = content;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast({ message: '已复制到剪贴板', type: 'success' });
    } catch {
      showToast({ message: '复制失败', type: 'error' });
    }
  }, [content, showToast]);

  return (
    <div className={`flex items-center gap-0.5 md:gap-1 bg-bg-surface rounded-lg shadow-sm border border-border p-0.5 md:p-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity`}>
      <ActionButton
        onClick={handleLike}
        active={hasLiked}
        activeColor="text-red-500"
        title="点赞"
        isAnimating={isLikeAnimating}
        count={likeCount > 0 ? likeCount : undefined}
      >
        <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.5c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V3a.75.75 0 01.75-.75A2.25 2.25 0 0116.5 4.5c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H5.904M14.25 9h2.25M5.904 18.75c.083.228.22.442.396.612a2.25 2.25 0 003.398-.155c.381-.482.618-1.05.718-1.647M5.904 18.75H3.75" />
        </svg>
      </ActionButton>

      <ActionButton
        onClick={handleDislike}
        active={hasDisliked}
        activeColor="text-blue-500"
        title="点踩"
        className="hidden md:inline-flex"
        count={dislikeCount > 0 ? dislikeCount : undefined}
      >
        <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 15h2.25m8.024-4.5c.025.29.04.584.04.884 0 2.014-.633 3.886-1.714 5.432-.382.552-.974.884-1.614.884H9.612c-.631 0-1.216-.322-1.592-.852-.344-.485-.612-1.017-.793-1.584M15 9h2.25M5.904 5.25c-.083-.228-.22-.442-.396-.612a2.25 2.25 0 00-3.398.155c-.381.482-.618 1.05-.718 1.647M5.904 5.25H3.75" />
        </svg>
      </ActionButton>

      <ActionButton
        onClick={onToggleComments || (() => {})}
        active={showComments}
        activeColor="text-green-500"
        title="评论"
        count={commentCount > 0 ? commentCount : undefined}
      >
        <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
        </svg>
      </ActionButton>

      <ActionButton onClick={handleReply} title={isReplying ? '取消引用' : '回复引用'} active={isReplying} activeColor="text-accent">
        <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
        </svg>
      </ActionButton>

      <ActionButton onClick={handleCopy} title="复制" className="hidden md:inline-flex">
        <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
        </svg>
      </ActionButton>

      {isUser && onEdit && (
        <ActionButton onClick={onEdit} title="编辑">
          <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
          </svg>
        </ActionButton>
      )}

      {onDelete && (
        <ActionButton onClick={onDelete} title="删除" danger>
          <svg className="w-4 h-4 md:w-3.5 md:h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
        </ActionButton>
      )}
    </div>
  );
});

interface ActionButtonProps {
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  activeColor?: string;
  title?: string;
  danger?: boolean;
  isAnimating?: boolean;
  count?: number;
  className?: string;
}

function ActionButton({ onClick, children, active, activeColor, title, danger, isAnimating, count, className = '' }: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`
        p-2 md:p-1.5 rounded hover:bg-bg-surface2 active:bg-bg-surface3 transition-colors
        touch-manipulation min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0
        flex items-center justify-center
        ${active ? activeColor : danger ? 'text-text-muted hover:text-red-500' : 'text-text-muted'}
        ${isAnimating ? 'animate-like-pop' : ''}
        ${className}
      `}
      title={title}
    >
      <span className="text-base md:text-sm inline-flex items-center gap-0.5">
        {children}
        {count !== undefined && <span className="text-xs">{count}</span>}
      </span>
    </button>
  );
}
