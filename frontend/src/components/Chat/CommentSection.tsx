import React, { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AI_COLORS, AI_NAMES, AI_AVATAR_LETTERS } from '../../types';
import { useMessagesStore } from '../../stores/messagesStore';
import { usePersonasStore } from '../../stores/personasStore';
import { useProfileStore } from '../../stores/profileStore';
import { sanitizeUrl } from '../../utils/sanitizeUrl';
import type { Comment } from '../../types';

interface CommentSectionProps {
  messageId: string;
  groupId: string;
  comments: Comment[];
  isOpen: boolean;
  onClose: () => void;
}

export const CommentSection = React.memo(function CommentSection({
  messageId,
  groupId,
  comments,
  isOpen,
  onClose
}: CommentSectionProps) {
  const [commentText, setCommentText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyTarget, setReplyTarget] = useState<Comment | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { addComment } = useMessagesStore();
  const { personas } = usePersonasStore();
  const userProfile = useProfileStore(state => state.profile);

  const handleSubmit = useCallback(async () => {
    if (!commentText.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await addComment(
        messageId,
        groupId,
        commentText.trim(),
        'user',
        'user',
        replyTarget?.id,
        replyTarget?.id
      );
      setCommentText('');
      setReplyTarget(null);
    } catch (error) {
      console.error('Failed to add comment:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [commentText, isSubmitting, messageId, groupId, addComment, replyTarget]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  }, [handleSubmit, onClose]);

  const getCommentSenderInfo = (comment: Comment) => {
    const isUser = comment.sender_type === 'user';
    const senderId = comment.sender_id || '';
    const customPersona = personas[senderId];
    const color = customPersona?.color || AI_COLORS[senderId] || AI_COLORS.system;
    const avatarUrl = customPersona?.avatar_url;
    const name = isUser
      ? (userProfile?.nickname || '我')
      : (customPersona?.name || AI_NAMES[senderId] || senderId);
    const avatarLetter = isUser
      ? (userProfile?.nickname?.charAt(0) || '我')
      : (AI_AVATAR_LETTERS[senderId] || name.charAt(0).toUpperCase());
    return { isUser, color, avatarUrl, name, avatarLetter };
  };

  if (!isOpen) return null;

  const MAX_COMMENT_DEPTH = 3;

  const orderedComments = [...comments].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return (
    <AnimatePresence>
      <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="mt-2 overflow-hidden"
        >
          <div className="bg-bg-surface2/50 dark:bg-bg-surface/50 rounded-xl border border-border/50 p-2.5">
            {comments.length > 0 && (
              <div className="space-y-2 mb-2.5 max-h-[200px] overflow-y-auto">
                {orderedComments.map((comment) => {
                  const senderInfo = getCommentSenderInfo(comment);
                  return (
                    <div
                      key={comment.id}
                      className="flex gap-2 items-start"
                      style={{ marginLeft: `${Math.min(comment.depth || 0, MAX_COMMENT_DEPTH) * 12}px` }}
                    >
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[8px] font-semibold flex-shrink-0 shadow-sm overflow-hidden"
                        style={{
                          backgroundColor: senderInfo.avatarUrl ? 'transparent' : senderInfo.color,
                          backgroundImage: senderInfo.avatarUrl ? `url(${sanitizeUrl(senderInfo.avatarUrl)})` : 'none',
                          backgroundSize: 'cover',
                          backgroundPosition: 'center'
                        }}
                      >
                        {!senderInfo.avatarUrl && senderInfo.avatarLetter}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="text-[11px] font-semibold truncate max-w-[80px]"
                            style={{ color: senderInfo.color }}
                          >
                            {senderInfo.name}
                          </span>
                          {senderInfo.isUser && (
                            <span className="text-[9px] px-1 py-0 rounded bg-accent/10 text-accent">
                              用户
                            </span>
                          )}
                          {senderInfo.isUser === false && comment.sender_type === 'ai' && (
                            <span className="text-[9px] px-1 py-0 rounded bg-purple-500/10 text-purple-500">
                              AI跟评
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] text-text-secondary leading-relaxed break-words mt-0.5">
                          {comment.content}
                        </p>
                        <div className="mt-1 flex items-center gap-2">
                          {comment.reply_to && (
                            <span className="text-[10px] text-text-muted">
                              回复层级 {Math.min(comment.depth ?? 0, MAX_COMMENT_DEPTH)}
                            </span>
                          )}
                          {(comment.depth ?? 0) < MAX_COMMENT_DEPTH && (
                            <button
                              onClick={() => {
                                setReplyTarget(comment);
                                inputRef.current?.focus();
                              }}
                              className="text-[10px] text-accent hover:underline"
                            >
                              回复
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {replyTarget && (
              <div className="mb-2 flex items-center justify-between rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-1.5">
                <span className="text-[11px] text-text-secondary truncate">
                  正在回复: {replyTarget.content}
                </span>
                <button
                  onClick={() => setReplyTarget(null)}
                  className="text-[11px] text-accent hover:underline"
                >
                  取消
                </button>
              </div>
            )}

            <div className="flex gap-1.5 items-center">
              <input
                ref={inputRef}
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="写评论..."
                className="flex-1 min-w-0 px-2.5 py-1.5 text-[12px] bg-bg-surface rounded-lg border border-border/50 focus:outline-none focus:border-accent text-text-primary placeholder:text-text-muted transition-colors"
                disabled={isSubmitting}
              />
              <button
                onClick={handleSubmit}
                disabled={!commentText.trim() || isSubmitting}
                className="px-2.5 py-1.5 text-[11px] font-medium bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              >
                {isSubmitting ? '...' : '发送'}
              </button>
            </div>
          </div>
        </motion.div>
    </AnimatePresence>
  );
});
