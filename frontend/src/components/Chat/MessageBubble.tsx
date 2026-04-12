import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { Message, Comment, AI_COLORS, AI_NAMES, AI_AVATAR_LETTERS } from '../../types';
import { useMessagesStore } from '../../stores/messagesStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { api } from '../../services/api';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

function preprocessMarkdown(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .replace(/([^\n])\n([^\n])/g, '$1  \n$2');
}

interface MessageBubbleProps {
  message: Message;
  showActions?: boolean;
  onReply?: (messageId: string) => void;
  showTimeDivider?: boolean;
}

export function MessageBubble({ message, showActions: _showActions = true, onReply, showTimeDivider }: MessageBubbleProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const { deleteMessage, likeMessage, unlikeMessage, dislikeMessage, undislikeMessage, addComment, messages } = useMessagesStore();
  const { currentGroup } = useGroupsStore();
  const { personas } = usePersonasStore();
  
  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';
  const senderId = message.sender_id || 'system';
  
  // 获取自定义设置
  const customPersona = personas[senderId];
  const color = customPersona?.color || AI_COLORS[senderId] || AI_COLORS.system;
  const avatarUrl = customPersona?.avatar_url;
  const name = customPersona?.name || AI_NAMES[senderId] || senderId;
  const avatarLetter = AI_AVATAR_LETTERS[senderId] || name.charAt(0).toUpperCase();
  
  const hasLiked = message.liked_by?.includes('user');
  const hasDisliked = message.disliked_by?.includes('user');
  const likeCount = message.likes || 0;
  const dislikeCount = message.dislikes || 0;
  const commentCount = message.comments?.length || 0;

  const replyToMessage = message.reply_to 
    ? messages[message.group_id]?.find(m => m.id === message.reply_to)
    : null;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setShowContextMenu(false);
  };

  const handleDelete = () => {
    if (window.confirm('确定要删除这条消息吗？')) {
      deleteMessage(message.id, message.group_id);
    }
    setShowContextMenu(false);
  };

  const handleLike = async () => {
    if (!currentGroup) return;
    
    if (hasLiked) {
      unlikeMessage(message.id, currentGroup.id);
    } else {
      likeMessage(message.id, currentGroup.id);
      try {
        await api.performAutoLike(message.id, currentGroup.id);
      } catch (e) {
      }
    }
  };

  const handleDislike = async () => {
    if (!currentGroup) return;
    
    if (hasDisliked) {
      undislikeMessage(message.id, currentGroup.id);
      try {
        await api.undislikeMessage(message.id, 'user');
      } catch (e) {
      }
    } else {
      dislikeMessage(message.id, currentGroup.id);
      try {
        await api.dislikeMessage(message.id, 'user');
      } catch (e) {
      }
    }
  };

  const handleReply = () => {
    if (onReply) {
      onReply(message.id);
    }
  };

  const handleAddComment = () => {
    if (commentInput.trim() && currentGroup) {
      addComment(message.id, currentGroup.id, commentInput.trim(), 'user', 'user');
      setCommentInput('');
    }
  };

  const processedContent = useMemo(() => {
    if (message.content_type === 'text' || !message.content_type) {
      return preprocessMarkdown(message.content);
    }
    return message.content;
  }, [message.content, message.content_type]);

  if (isSystem) {
    return (
      <div className="flex justify-center my-4 animate-fade-in">
        <div className="text-xs text-gray-400 bg-gray-100 px-3 py-1 rounded-full">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <>
      {showTimeDivider && (
        <div className="message-time-divider">
          <span>{formatTimeDivider(message.created_at)}</span>
        </div>
      )}
      
      <div
        className={`flex gap-2 mb-3 ${isUser ? 'flex-row-reverse' : 'flex-row'} animate-fade-in group`}
        data-message-id={message.id}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onContextMenu={handleContextMenu}
      >
        {!isUser && (
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 shadow-sm overflow-hidden"
            style={{ 
              backgroundColor: avatarUrl ? 'transparent' : color,
              backgroundImage: avatarUrl ? `url(${avatarUrl})` : 'none',
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }}
          >
            {!avatarUrl && avatarLetter}
          </div>
        )}

        <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[70%]`}>
          {!isUser && (
            <div className="flex items-center gap-2 mb-1 ml-1">
              <span className="text-xs font-medium" style={{ color }}>
                {name}
              </span>
            </div>
          )}

          {replyToMessage && (
            <div className={`mb-1 px-2 py-1 bg-gray-100 rounded text-xs max-w-[200px] truncate ${isUser ? 'mr-2' : 'ml-1'}`}>
              <span className="text-gray-400">回复 </span>
              <span style={{ color: AI_COLORS[replyToMessage.sender_id || 'system'] }}>
                {AI_NAMES[replyToMessage.sender_id || ''] || replyToMessage.sender_id}
              </span>
              <span className="text-gray-400">: </span>
              <span className="text-gray-500">{replyToMessage.content.substring(0, 30)}...</span>
            </div>
          )}

          <div
            className={`message-bubble ${isUser ? 'user-message' : 'ai-message'}`}
          >
            {message.content_type === 'text' || !message.content_type ? (
              <div className="markdown-content text-[15px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {processedContent}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-[15px] font-mono">
                {message.content}
              </pre>
            )}
          </div>

          <div className={`flex items-center gap-2 mt-1 ${isUser ? 'flex-row-reverse mr-2' : 'ml-1'}`}>
            <span className="text-xs text-gray-400">
              {dayjs(message.created_at).format('HH:mm')}
            </span>
            
            {isUser && (
              <div className="message-status sent">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>
            )}
          </div>

          {likeCount > 0 && message.liked_by && message.liked_by.length > 0 && (
            <div className={`flex items-center gap-1 mt-1 ${isUser ? 'flex-row-reverse mr-2' : 'ml-1'}`}>
              {message.liked_by.slice(0, 5).map((likerId) => {
                const isAiLiker = likerId.startsWith('ai_');
                const aiId = isAiLiker ? likerId.replace('ai_', '') : likerId;
                const likerPersona = personas[aiId];
                const likerColor = isAiLiker ? (likerPersona?.color || AI_COLORS[aiId] || '#888') : AI_COLORS.user;
                const likerName = isAiLiker ? (likerPersona?.name || AI_NAMES[aiId] || aiId) : '我';
                return (
                  <div
                    key={likerId}
                    className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[8px] flex-shrink-0"
                    style={{ backgroundColor: likerColor }}
                    title={likerName}
                  >
                    {likerName.charAt(0)}
                  </div>
                );
              })}
              {likeCount > 5 && (
                <span className="text-xs text-gray-400">+{likeCount - 5}</span>
              )}
            </div>
          )}

          {showComments && (
            <div className={`mt-2 bg-gray-50 rounded-lg p-3 w-full max-w-[300px] ${isUser ? 'mr-2' : ''}`}>
              {message.comments && message.comments.length > 0 && (
                <div className="space-y-2 mb-3">
                  {message.comments.map((comment) => (
                    <div key={comment.id} className="animate-fade-in">
                      <CommentItem comment={comment} />
                    </div>
                  ))}
                </div>
              )}
              
              <div className="flex gap-2">
                <input
                  type="text"
                  value={commentInput}
                  onChange={(e) => setCommentInput(e.target.value)}
                  placeholder="写下你的评论..."
                  className="flex-1 px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:border-green-400"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddComment()}
                />
                <button
                  onClick={handleAddComment}
                  disabled={!commentInput.trim()}
                  className="px-3 py-1.5 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600 disabled:opacity-50"
                >
                  发送
                </button>
              </div>
            </div>
          )}
        </div>

        <div className={`flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? 'items-start' : 'items-end'}`}>
          <div className="flex items-center gap-1 bg-white rounded-lg shadow-sm border border-gray-200 p-1">
            <button
              onClick={handleLike}
              className={`p-1.5 rounded hover:bg-gray-100 transition-colors ${hasLiked ? 'text-red-500' : 'text-gray-400'}`}
              title="点赞"
            >
              <span className="text-sm">👍</span>
              {likeCount > 0 && <span className="text-xs ml-0.5">{likeCount}</span>}
            </button>
            
            <button
              onClick={handleDislike}
              className={`p-1.5 rounded hover:bg-gray-100 transition-colors ${hasDisliked ? 'text-blue-500' : 'text-gray-400'}`}
              title="点踩"
            >
              <span className="text-sm">👎</span>
              {dislikeCount > 0 && <span className="text-xs ml-0.5">{dislikeCount}</span>}
            </button>
            
            <button
              onClick={() => setShowComments(!showComments)}
              className={`p-1.5 rounded hover:bg-gray-100 transition-colors ${showComments ? 'text-green-500' : 'text-gray-400'}`}
              title="评论"
            >
              <span className="text-sm">💬</span>
              {commentCount > 0 && <span className="text-xs ml-0.5">{commentCount}</span>}
            </button>
            
            <button
              onClick={handleReply}
              className="p-1.5 rounded hover:bg-gray-100 transition-colors text-gray-400"
              title="回复引用"
            >
              <span className="text-sm">↩️</span>
            </button>

            <button
              onClick={handleDelete}
              className="p-1.5 rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-red-500"
              title="删除"
            >
              <span className="text-sm">🗑️</span>
            </button>
          </div>
        </div>

        {isUser && isHovered && !showContextMenu && (
          <div className="flex items-end pb-2">
            <button
              onClick={handleDelete}
              className="text-xs text-gray-400 hover:text-red-500"
            >
              删除
            </button>
          </div>
        )}
      </div>

      {showContextMenu && (
        <ContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          onClose={() => setShowContextMenu(false)}
          onCopy={handleCopy}
          onDelete={handleDelete}
          onReply={handleReply}
        />
      )}
    </>
  );
}

function formatTimeDivider(timestamp: string): string {
  const time = dayjs(timestamp);
  const now = dayjs();
  const diffMinutes = now.diff(time, 'minute');
  const diffHours = now.diff(time, 'hour');
  const diffDays = now.diff(time, 'day');

  if (diffMinutes < 5) return '刚刚';
  if (diffHours < 1) return `${diffMinutes}分钟前`;
  if (diffDays < 1) return time.format('HH:mm');
  if (diffDays === 1) return '昨天 ' + time.format('HH:mm');
  if (diffDays < 7) return `${diffDays}天前`;
  return time.format('MM-DD HH:mm');
}

function ContextMenu({ x, y, onClose, onCopy, onDelete, onReply }: {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onDelete?: () => void;
  onReply: () => void;
}) {
  React.useEffect(() => {
    const handleClick = () => onClose();
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [onClose]);

  return (
    <div
      className="fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
      style={{ left: x, top: y }}
    >
      <button
        onClick={onCopy}
        className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
      >
        📋 复制
      </button>
      <button
        onClick={onReply}
        className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
      >
        ↩️ 回复
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 text-red-500 flex items-center gap-2"
        >
          🗑️ 删除
        </button>
      )}
    </div>
  );
}

function CommentItem({ comment }: { comment: Comment }) {
  const senderId = comment.sender_id || 'system';
  const { personas } = usePersonasStore();
  const customPersona = personas[senderId];
  const color = customPersona?.color || AI_COLORS[senderId] || AI_COLORS.system;
  const avatarUrl = customPersona?.avatar_url;
  const name = customPersona?.name || AI_NAMES[senderId] || senderId;

  return (
    <div className="flex gap-2 items-start">
      <div
        className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] flex-shrink-0 overflow-hidden"
        style={{ 
          backgroundColor: avatarUrl ? 'transparent' : color,
          backgroundImage: avatarUrl ? `url(${avatarUrl})` : 'none',
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }}
      >
        {!avatarUrl && name.charAt(0)}
      </div>
      <div className="flex-1">
        <span className="text-xs font-medium" style={{ color }}>{name}</span>
        <span className="text-xs text-gray-500 ml-1">{comment.content}</span>
      </div>
    </div>
  );
}
