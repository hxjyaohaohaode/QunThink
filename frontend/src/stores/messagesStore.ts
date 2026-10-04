import { create } from 'zustand';
import { api } from '../services/api';
import { saveMessagesToIndexedDB, loadMessagesFromIndexedDB, deleteMessageFromIndexedDB, clearAllMessagesFromIndexedDB, clearOldMessagesFromIndexedDB } from '../utils/indexedDB';
import { useGroupsStore } from './groupsStore';
import { useAudioStore } from './audioStore';
import type { Comment, MessageAttachment, Message } from '../types';

const sendingGroups = new Map<string, boolean>();
const pendingMessages = new Map<string, { tempId: string, groupId: string }>();

function sendFailure(error: unknown): { message: string; terminal: boolean } {
  const status = (error as { status?: number } | null)?.status;
  if (status === 410) return { message: '原消息已删除，不能重试这次发送。内容仍保留，请复制后作为新消息发送。', terminal: true };
  if (status === 409) return { message: '发送标识与已有消息冲突，不能重试这次发送。内容仍保留，请复制后作为新消息发送。', terminal: true };
  return { message: error instanceof Error ? error.message : String(error), terminal: false };
}

function reconcileDeliveredMessage(groupId: string, messages: Message[], tempId: string, delivered: Message): Message[] {
  let matched = false;
  const next: Message[] = [];
  for (const current of messages) {
    if (current.tempId === tempId || current.id === delivered.id) {
      if (!matched) {
        next.push({ ...current, ...delivered, tempId, status: 'sent' });
        matched = true;
      }
    } else {
      next.push(current);
    }
  }
  if (!matched) next.push({ ...delivered, tempId, status: 'sent' });
  persistMessages(groupId, next);
  return next;
}

interface PaginationState {
  hasMore: boolean;
  loadingMore: boolean;
  oldestMessageId: string | null;
}

interface MessagesState {
  messages: Record<string, Message[]>;
  streamUpdateCounter: number;
  pagination: Record<string, PaginationState>;
  loading: boolean;
  sending: Record<string, boolean>;
  error: string | null;
  fetchMessages: (groupId: string) => Promise<void>;
  loadMoreMessages: (groupId: string) => Promise<void>;
  sendMessage: (groupId: string, content: string, replyTo?: string | string[], attachments?: MessageAttachment[]) => Promise<{ success: boolean; tempId: string; error?: string }>;
  retryMessage: (groupId: string, tempId: string) => Promise<{ success: boolean; error?: string }>;
  removeFailedMessage: (groupId: string, tempId: string) => void;
  deleteMessage: (messageId: string, groupId: string) => Promise<void>;
  editMessage: (messageId: string, groupId: string, content: string) => Promise<void>;
  batchDeleteMessages: (messageIds: string[], groupId: string) => Promise<void>;
  clearAllMessages: (groupId: string) => Promise<void>;
  addMessage: (groupId: string, message: Message) => void;
  likeMessage: (messageId: string, groupId: string, userId?: string) => void;
  unlikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  dislikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  undislikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  applyLikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  applyUnlikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  applyDislikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  applyUndislikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  addComment: (messageId: string, groupId: string, content: string, senderType: 'user' | 'ai', senderId?: string, parentId?: string, replyTo?: string) => Promise<void>;
  addCommentFromRemote: (messageId: string, groupId: string, comment: Comment) => void;
  updateMessage: (messageId: string, groupId: string, updates: Partial<Message>) => void;
  removeMessages: (groupId: string, messageIds: string[]) => void;
  clearMessages: (groupId: string) => void;
  addStreamMessage: (groupId: string, messageId: string, senderId: string) => void;
  updateStreamMessage: (groupId: string, messageId: string, content: string, isDone: boolean) => void;
  finalizeStreamMessage: (groupId: string, messageId: string, content: string, replyTo?: string | string[], replyToIds?: string[]) => void;
}

const persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const pendingSaveMessages: Record<string, Message[]> = {};
const MAX_CACHED_GROUPS = 15;
const MAX_COMMENT_DEPTH = 10;
const MESSAGE_STALE_TIME_MS = 3 * 1000;
const messageFetchPromises = new Map<string, Promise<void>>();
const lastMessageFetchAt = new Map<string, number>();
const streamTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// 清理指定消息的流式超时定时器
function clearStreamTimeout(messageId: string) {
  const timer = streamTimeouts.get(messageId);
  if (timer) {
    clearTimeout(timer);
    streamTimeouts.delete(messageId);
  }
}

// 清理指定群组所有消息的流式超时定时器
function clearStreamTimeoutsForGroup(messages: Message[]) {
  for (const msg of messages) {
    if (msg.is_streaming) {
      clearStreamTimeout(msg.id);
    }
  }
}

function applyLikeState(messages: Message[], messageId: string, userId: string, liked: boolean): Message[] {
  return messages.map(message => {
    if (message.id !== messageId) {
      return message;
    }
    const likes = Array.isArray(message.likes) ? message.likes : (Array.isArray(message.liked_by) ? message.liked_by : []);
    const nextLikes = liked
      ? (likes.includes(userId) ? likes : [...likes, userId])
      : likes.filter(id => id !== userId);
    return {
      ...message,
      likes: nextLikes,
      liked_by: nextLikes,
      likes_count: nextLikes.length
    };
  });
}

function applyDislikeState(messages: Message[], messageId: string, userId: string, disliked: boolean): Message[] {
  return messages.map(message => {
    if (message.id !== messageId) {
      return message;
    }
    const dislikedBy = Array.isArray(message.disliked_by) ? message.disliked_by : [];
    const nextDislikedBy = disliked
      ? (dislikedBy.includes(userId) ? dislikedBy : [...dislikedBy, userId])
      : dislikedBy.filter(id => id !== userId);
    return {
      ...message,
      disliked_by: nextDislikedBy,
      dislikes: nextDislikedBy.length
    };
  });
}

function evictLeastRecentlyUsedMessages(state: MessagesState) {
  const groupIds = Object.keys(state.messages);
  if (groupIds.length <= MAX_CACHED_GROUPS) return;

  const groupsStore = useGroupsStore.getState();
  const currentGroupId = groupsStore.currentGroup?.id;

  const sortedByActivity = groupIds
    .filter(id => id !== currentGroupId)
    .map(id => {
      const msgs = state.messages[id];
      const lastTime = msgs.length > 0
        ? new Date(msgs[msgs.length - 1].created_at).getTime()
        : 0;
      return { id, lastTime };
    })
    .sort((a, b) => a.lastTime - b.lastTime);

  const toEvict = sortedByActivity.slice(0, groupIds.length - MAX_CACHED_GROUPS);
  const evictIds = new Set(toEvict.map(e => e.id));

  const { messages: newMessages, pagination: newPagination } = Array.from(evictIds).reduce(
    (acc: { messages: Record<string, Message[]>; pagination: Record<string, PaginationState> }, id: string) => {
      const { [id]: _msg, ...restMessages } = acc.messages;
      const { [id]: _pag, ...restPagination } = acc.pagination;
      if (persistTimers[id]) {
        clearTimeout(persistTimers[id]);
        delete persistTimers[id];
      }
      delete pendingSaveMessages[id];
      return { messages: restMessages, pagination: restPagination };
    },
    { messages: state.messages, pagination: state.pagination }
  );

  state.messages = newMessages;
  state.pagination = newPagination;
}

function persistMessages(groupId: string, messages: Message[]) {
  if (persistTimers[groupId]) {
    clearTimeout(persistTimers[groupId]);
  }
  const validMessages = messages.filter(m => !m.is_streaming && m.status !== 'sending');
  pendingSaveMessages[groupId] = validMessages;
  persistTimers[groupId] = setTimeout(() => {
    const toSave = pendingSaveMessages[groupId];
    if (toSave) {
      saveMessagesToIndexedDB(toSave);
      clearOldMessagesFromIndexedDB(groupId);
      delete pendingSaveMessages[groupId];
    }
  }, 2000);
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: {},
  streamUpdateCounter: 0,
  pagination: {},
  loading: false,
  sending: {},
  error: null,

  fetchMessages: async (groupId: string) => {
    const state = get();
    const hasLocalMessages = (state.messages[groupId] || []).length > 0;
    const isFresh = hasLocalMessages && (Date.now() - (lastMessageFetchAt.get(groupId) || 0) < MESSAGE_STALE_TIME_MS);

    if (isFresh) {
      return;
    }

    const existingPromise = messageFetchPromises.get(groupId);
    if (existingPromise) {
      return existingPromise;
    }

    set({ loading: true, error: null });

    const fetchPromise = (async () => {
      try {
        const cachedMessages = await loadMessagesFromIndexedDB(groupId);

        if (cachedMessages.length > 0 && !hasLocalMessages) {
          set(state => {
            const newState = {
              messages: {
                ...state.messages,
                [groupId]: cachedMessages
              },
              pagination: {
                ...state.pagination,
                [groupId]: { hasMore: true, loadingMore: false, oldestMessageId: cachedMessages[0]?.id }
              },
              loading: false
            };
            evictLeastRecentlyUsedMessages(newState as any);
            return newState;
          });
        }

        try {
          const response = await api.getMessages(groupId, 50);
          const messages = response.messages || [];
          const hasMore = response.hasMore || false;
          const oldestMessageId = messages.length > 0 ? messages[0].id : null;
          const confirmedClientIds = new Set(messages.map(message => (message as Message & { client_message_id?: string }).client_message_id).filter((id): id is string => !!id));

          lastMessageFetchAt.set(groupId, Date.now());
          set(state => {
            const failedDrafts = (state.messages[groupId] || []).filter(message => message.status === 'failed' && message.tempId && !confirmedClientIds.has(message.tempId));
            const merged = [...messages, ...failedDrafts].sort((a, b) => a.created_at.localeCompare(b.created_at));
            const newState = {
              messages: {
                ...state.messages,
                [groupId]: merged
              },
              pagination: {
                ...state.pagination,
                [groupId]: { hasMore, loadingMore: false, oldestMessageId }
              },
              loading: false
            };
            evictLeastRecentlyUsedMessages(newState as any);
            return newState;
          });
          for (const clientId of confirmedClientIds) void deleteMessageFromIndexedDB(clientId);
          if (messages.length > 0) {
            saveMessagesToIndexedDB(messages);
          }
        } catch (apiError) {
          if (cachedMessages.length > 0 || hasLocalMessages) {
            set({ loading: false });
          } else {
            set({ error: (apiError as Error).message, loading: false });
          }
        }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error), loading: false });
      } finally {
        messageFetchPromises.delete(groupId);
      }
    })();

    messageFetchPromises.set(groupId, fetchPromise);
    return fetchPromise;
  },

  loadMoreMessages: async (groupId: string) => {
    const state = get();
    const pagination = state.pagination[groupId];

    if (!pagination || pagination.loadingMore || !pagination.hasMore) {
      return;
    }

    const currentMessages = state.messages[groupId] || [];
    if (currentMessages.length === 0) return;

    const oldestMessage = currentMessages[0];
    const before = oldestMessage.created_at;

    set(state => ({
      pagination: {
        ...state.pagination,
        [groupId]: { ...pagination, loadingMore: true }
      }
    }));

    try {
      const response = await api.getMessages(groupId, 50, before);
      const olderMessages = response.messages || [];
      const hasMore = response.hasMore || false;
      const newOldestMessageId = olderMessages.length > 0 ? olderMessages[0].id : pagination.oldestMessageId;

      set(state => {
        const latestMessages = state.messages[groupId] || [];
        const existingIds = new Set(latestMessages.map(m => m.id));
        const dedupedOlderMessages = olderMessages.filter(m => !existingIds.has(m.id));

        return {
          messages: {
            ...state.messages,
            [groupId]: [...dedupedOlderMessages, ...latestMessages]
          },
          pagination: {
            ...state.pagination,
            [groupId]: { hasMore, loadingMore: false, oldestMessageId: newOldestMessageId }
          }
        };
      });
    } catch (error) {
      console.error('Failed to load more messages:', error);
      set(state => ({
        pagination: {
          ...state.pagination,
          [groupId]: { ...(state.pagination[groupId] || pagination), loadingMore: false }
        },
        error: error instanceof Error ? error.message : '加载更多消息失败'
      }));
    }
  },

  sendMessage: async (groupId: string, content: string, replyTo?: string | string[], attachments?: MessageAttachment[]) => {
    if (sendingGroups.get(groupId)) {
      return { success: false, tempId: '', error: '消息正在发送中' };
    }

    sendingGroups.set(groupId, true);
    set(state => ({ sending: { ...state.sending, [groupId]: true }, error: null }));

    const tempId = `temp_${crypto.randomUUID()}`;
    const tempMessage: Message = {
      id: tempId,
      group_id: groupId,
      sender_type: 'user',
      sender_id: 'user',
      content,
      content_type: 'text',
      reply_to: replyTo,
      attachments: attachments,
      created_at: new Date().toISOString(),
      status: 'sending',
      tempId
    };

    get().addMessage(groupId, tempMessage);
    pendingMessages.set(tempId, { tempId, groupId });

    try {
      const message = await api.sendMessage(groupId, content, 'text', replyTo, undefined, attachments, tempId);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: reconcileDeliveredMessage(groupId, state.messages[groupId] || [], tempId, message)
        },
        sending: { ...state.sending, [groupId]: false }
      }));

      pendingMessages.delete(tempId);
      await deleteMessageFromIndexedDB(tempId);

      return { success: true, tempId };
    } catch (error) {
      const failure = sendFailure(error);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (() => {
            const next = (state.messages[groupId] || []).map(m =>
              m.tempId === tempId ? { ...m, status: 'failed' as const, metadata: { ...m.metadata, send_error: failure.message, send_terminal: failure.terminal } } : m
            );
            persistMessages(groupId, next);
            return next;
          })()
        },
        error: failure.message,
        sending: { ...state.sending, [groupId]: false }
      }));

      pendingMessages.delete(tempId);
      const failed = get().messages[groupId]?.find(m => m.tempId === tempId);
      if (failed) await saveMessagesToIndexedDB([failed]);
      return { success: false, tempId, error: failure.message };
    } finally {
      sendingGroups.delete(groupId);
    }
  },

  retryMessage: async (groupId: string, tempId: string) => {
    if (sendingGroups.get(groupId)) return { success: false, error: '消息正在发送中' };
    const state = get();
    const failedMessage = (state.messages[groupId] || []).find(m => m.tempId === tempId);

    if (!failedMessage) {
      return { success: false, error: '消息不存在' };
    }
    if (failedMessage.metadata?.send_terminal === true) {
      return { success: false, error: String(failedMessage.metadata.send_error || '这次发送不能重试，请复制内容后重新发送') };
    }

    sendingGroups.set(groupId, true);

    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).map(m =>
          m.tempId === tempId ? { ...m, status: 'sending' } : m
        )
      },
      sending: { ...state.sending, [groupId]: true },
      error: null
    }));

    try {
      const message = await api.sendMessage(groupId, failedMessage.content, 'text', failedMessage.reply_to, undefined, failedMessage.attachments, tempId);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: reconcileDeliveredMessage(groupId, state.messages[groupId] || [], tempId, message)
        },
        sending: { ...state.sending, [groupId]: false }
      }));

      await deleteMessageFromIndexedDB(tempId);

      return { success: true };
    } catch (error) {
      const failure = sendFailure(error);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (() => {
            const next = (state.messages[groupId] || []).map(m =>
              m.tempId === tempId ? { ...m, status: 'failed' as const, metadata: { ...m.metadata, send_error: failure.message, send_terminal: failure.terminal } } : m
            );
            persistMessages(groupId, next);
            return next;
          })()
        },
        error: failure.message,
        sending: { ...state.sending, [groupId]: false }
      }));

      const failed = get().messages[groupId]?.find(m => m.tempId === tempId);
      if (failed) await saveMessagesToIndexedDB([failed]);
      return { success: false, error: failure.message };
    } finally {
      sendingGroups.delete(groupId);
    }
  },

  removeFailedMessage: (groupId: string, tempId: string) => {
    set(state => {
      const next = (state.messages[groupId] || []).filter(m => m.tempId !== tempId);
      persistMessages(groupId, next);
      return { messages: { ...state.messages, [groupId]: next } };
    });
    void deleteMessageFromIndexedDB(tempId);
  },

  deleteMessage: async (messageId: string, groupId: string) => {
    const originalMessages = get().messages[groupId] || [];
    const removedIndex = originalMessages.findIndex(m => m.id === messageId);
    const removedMessages = removedIndex >= 0 ? [originalMessages[removedIndex]] : [];
    // 清理被删除消息的流式超时定时器
    clearStreamTimeout(messageId);
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).filter(m => m.id !== messageId)
      }
    }));
    try {
      await api.deleteMessage(messageId);
      // 精确清理：仅删除该消息对应的pending条目（如有）
      for (const [tempId, entry] of pendingMessages.entries()) {
        if (entry.groupId === groupId && tempId === messageId) {
          pendingMessages.delete(tempId);
        }
      }
    } catch (error) {
      console.error('Failed to delete message:', error);
      set({ error: error instanceof Error ? error.message : '删除消息失败' });
      // 回滚：按原始索引恢复消息，保持时间顺序
      if (removedMessages.length > 0 && removedIndex >= 0) {
        set(state => {
          const currentMsgs = state.messages[groupId] || [];
          const newMsgs = [...currentMsgs];
          newMsgs.splice(Math.min(removedIndex, newMsgs.length), 0, removedMessages[0]);
          return {
            messages: {
              ...state.messages,
              [groupId]: newMsgs
            }
          };
        });
      }
    }
  },

  editMessage: async (messageId: string, groupId: string, content: string) => {
    try {
      const updatedMessage = await api.editMessage(messageId, content);
      if (!updatedMessage.metadata?.tts) useAudioStore.getState().removeTTSAudio(messageId);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.id === messageId
              ? {
                ...m,
                content: updatedMessage.content || content,
                metadata: updatedMessage.metadata,
                is_edited: true,
                edited_at: updatedMessage.edited_at || new Date().toISOString()
              }
              : m
          )
        }
      }));
    } catch (error) {
      console.error('Failed to edit message:', error);
      set({ error: error instanceof Error ? error.message : '编辑消息失败' });
      throw error;
    }
  },

  batchDeleteMessages: async (messageIds: string[], groupId: string) => {
    const removedMessages = (get().messages[groupId] || []).filter(m => messageIds.includes(m.id));
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).filter(m => !messageIds.includes(m.id))
      }
    }));
    try {
      await api.batchDeleteMessages(messageIds, groupId);
    } catch (error) {
      console.error('Failed to batch delete messages:', error);
      set({ error: error instanceof Error ? error.message : '批量删除消息失败' });
      if (removedMessages.length > 0) {
        set(state => ({
          messages: {
            ...state.messages,
            [groupId]: [...(state.messages[groupId] || []), ...removedMessages]
          }
        }));
      }
      throw error;
    }
  },

  clearAllMessages: async (groupId: string) => {
    try {
      await api.clearAllMessages(groupId);

      // 清理该群组所有流式超时定时器和持久化定时器
      const groupMsgs = get().messages[groupId] || [];
      clearStreamTimeoutsForGroup(groupMsgs);
      if (persistTimers[groupId]) {
        clearTimeout(persistTimers[groupId]);
        delete persistTimers[groupId];
      }
      delete pendingSaveMessages[groupId];

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: []
        }
      }));
      clearAllMessagesFromIndexedDB(groupId);
    } catch (error) {
      console.error('Failed to clear all messages:', error);
      set({ error: error instanceof Error ? error.message : '清空消息失败' });
      throw error;
    }
  },

  removeMessages: (groupId: string, messageIds: string[]) => {
    // 清理被删除消息的流式超时定时器
    for (const id of messageIds) {
      clearStreamTimeout(id);
    }
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).filter(m => !messageIds.includes(m.id))
      }
    }));
  },

  clearMessages: (groupId: string) => {
    // 清理该群组所有流式超时定时器
    const groupMsgs = get().messages[groupId] || [];
    clearStreamTimeoutsForGroup(groupMsgs);
    // 清理该群组的持久化定时器
    if (persistTimers[groupId]) {
      clearTimeout(persistTimers[groupId]);
      delete persistTimers[groupId];
    }
    delete pendingSaveMessages[groupId];
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: []
      }
    }));
  },

  addMessage: (groupId: string, message: Message) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const existingIndex = groupMessages.findIndex(m => m.id === message.id || (m.tempId && m.tempId === message.tempId && message.tempId));

      if (existingIndex !== -1) {
        const existing = groupMessages[existingIndex];
        const isTempMatch = existing.tempId && existing.tempId === message.tempId && message.tempId;
        const updatedMessage = isTempMatch
          ? { ...message, status: 'sent' as const }
          : { ...existing, ...message, status: (message.status || existing.status) as Message['status'] };

        // 仅当所有关键字段都相同时才跳过更新；
        // 但 metadata/attachments/likes/comments 等字段变化仍需触发更新
        const contentUnchanged = existing.content === updatedMessage.content;
        const statusUnchanged = existing.status === updatedMessage.status;
        const streamingUnchanged = existing.is_streaming === updatedMessage.is_streaming;
        const replyUnchanged = existing.reply_to === updatedMessage.reply_to;
        const metadataUnchanged = JSON.stringify(existing.metadata) === JSON.stringify(updatedMessage.metadata);
        if (contentUnchanged && statusUnchanged && streamingUnchanged && replyUnchanged && metadataUnchanged) {
          return state;
        }

        const newGroupMessages = [...groupMessages];
        newGroupMessages[existingIndex] = updatedMessage;
        persistMessages(groupId, newGroupMessages);
        return {
          messages: {
            ...state.messages,
            [groupId]: newGroupMessages
          }
        };
      }

      const newGroupMessages = [...groupMessages, message];
      persistMessages(groupId, newGroupMessages);
      return {
        messages: {
          ...state.messages,
          [groupId]: newGroupMessages
        }
      };
    });
  },

  likeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    get().applyLikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.likeMessage(messageId);
      set(state => {
        const nextLikes = result.likes || result.liked_by || [];
        return {
          messages: {
            ...state.messages,
            [groupId]: (state.messages[groupId] || []).map(message =>
              message.id === messageId
                ? { ...message, likes: nextLikes, liked_by: nextLikes, likes_count: result.likes_count ?? nextLikes.length }
                : message
            ),
          }
        };
      });
    } catch (error) {
      console.error('Failed to like message:', error);
      get().applyUnlikeUpdate(messageId, groupId, _userId);
    }
  },

  unlikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    get().applyUnlikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.unlikeMessage(messageId);
      set(state => {
        const nextLikes = result.likes || result.liked_by || [];
        return {
          messages: {
            ...state.messages,
            [groupId]: (state.messages[groupId] || []).map(message =>
              message.id === messageId
                ? { ...message, likes: nextLikes, liked_by: nextLikes, likes_count: result.likes_count ?? nextLikes.length }
                : message
            ),
          }
        };
      });
    } catch (error) {
      console.error('Failed to unlike message:', error);
      get().applyLikeUpdate(messageId, groupId, _userId);
    }
  },

  dislikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    get().applyDislikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.dislikeMessage(messageId);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(message =>
            message.id === messageId
              ? {
                ...message,
                disliked_by: result.disliked_by || [],
                dislikes: result.dislikes ?? (result.disliked_by || []).length
              }
              : message
          )
        }
      }));
    } catch (error) {
      console.error('Failed to dislike message:', error);
      get().applyUndislikeUpdate(messageId, groupId, _userId);
    }
  },

  undislikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    get().applyUndislikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.undislikeMessage(messageId);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(message =>
            message.id === messageId
              ? {
                ...message,
                disliked_by: result.disliked_by || [],
                dislikes: result.dislikes ?? (result.disliked_by || []).length
              }
              : message
          )
        }
      }));
    } catch (error) {
      console.error('Failed to undislike message:', error);
      get().applyDislikeUpdate(messageId, groupId, _userId);
    }
  },

  applyLikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyLikeState(state.messages[groupId] || [], messageId, userId, true)
      }
    }));
  },

  applyUnlikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyLikeState(state.messages[groupId] || [], messageId, userId, false)
      }
    }));
  },

  applyDislikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyDislikeState(state.messages[groupId] || [], messageId, userId, true)
      }
    }));
  },

  applyUndislikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyDislikeState(state.messages[groupId] || [], messageId, userId, false)
      }
    }));
  },

  addComment: async (messageId: string, groupId: string, content: string, senderType: 'user' | 'ai', senderId?: string, parentId?: string, replyTo?: string) => {
    try {
      const response = await api.addComment(messageId, content, parentId, replyTo);
      const serverComment = response.comment || response;

      set(state => {
        const groupMessages = state.messages[groupId] || [];
        const existingComments = groupMessages.find(m => m.id === messageId)?.comments || [];
        const existingCommentIds = new Set(existingComments.map(c => c.id));

        if (serverComment.id && existingCommentIds.has(serverComment.id)) {
          return state;
        }

        const parentComment = parentId ? existingComments.find(c => c.id === parentId) : null;
        const parentDepth = parentComment?.depth || 0;
        const effectiveParentId = parentDepth >= MAX_COMMENT_DEPTH ? undefined : parentId;
        const effectiveReplyTo = parentDepth >= MAX_COMMENT_DEPTH ? undefined : replyTo;
        const commentDepth = parentDepth >= MAX_COMMENT_DEPTH ? 0 : parentDepth + 1;

        const newComment: Comment = serverComment.id ? {
          id: serverComment.id,
          message_id: serverComment.message_id || messageId,
          parent_id: serverComment.parent_id || effectiveParentId,
          reply_to: serverComment.reply_to || effectiveReplyTo,
          sender_type: serverComment.sender_type || senderType,
          sender_id: serverComment.sender_id || senderId,
          content: serverComment.content || content,
          created_at: serverComment.created_at || new Date().toISOString(),
          depth: serverComment.depth ?? commentDepth
        } : {
          id: `comment_${Date.now()}`,
          message_id: messageId,
          parent_id: effectiveParentId,
          reply_to: effectiveReplyTo,
          sender_type: senderType,
          sender_id: senderId,
          content,
          created_at: new Date().toISOString(),
          depth: commentDepth
        };

        return {
          messages: {
            ...state.messages,
            [groupId]: groupMessages.map(m => {
              if (m.id === messageId) {
                const currentComments = m.comments || [];
                if (currentComments.some(c => c.id === newComment.id)) {
                  return m;
                }
                return {
                  ...m,
                  comments: [...currentComments, newComment]
                };
              }
              return m;
            })
          }
        };
      });
    } catch (error) {
      console.error('Failed to add comment:', error);
      set({ error: error instanceof Error ? error.message : '添加评论失败' });
    }
  },

  addCommentFromRemote: (messageId: string, groupId: string, comment: Comment) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const existingMessage = groupMessages.find(m => m.id === messageId);
      if (!existingMessage) return state;

      const existingComments = existingMessage.comments || [];
      if (existingComments.some(c => c.id === comment.id)) {
        return state;
      }

      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              return {
                ...m,
                comments: [...(m.comments || []), comment]
              };
            }
            return m;
          })
        }
      };
    });
  },

  updateMessage: (messageId: string, groupId: string, updates: Partial<Message>) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              return { ...m, ...updates };
            }
            return m;
          })
        }
      };
    });
  },

  addStreamMessage: (groupId: string, messageId: string, senderId: string) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const exists = groupMessages.some(m => m.id === messageId);

      if (exists) return state;

      const streamMessage: Message = {
        id: messageId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: senderId,
        content: '',
        content_type: 'text',
        created_at: new Date().toISOString(),
        is_streaming: true
      };

      return {
        messages: {
          ...state.messages,
          [groupId]: [...groupMessages, streamMessage]
        }
      };
    });

    if (streamTimeouts.has(messageId)) {
      clearTimeout(streamTimeouts.get(messageId)!);
    }
    streamTimeouts.set(messageId, setTimeout(() => {
      get().finalizeStreamMessage(groupId, messageId, '[流式传输超时，请重新发送]');
    }, 120000));
  },

  updateStreamMessage: (groupId: string, messageId: string, content: string, isDone: boolean) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const index = groupMessages.findIndex(m => m.id === messageId);
      if (index === -1) return state;
      const updated = { ...groupMessages[index], content, is_streaming: !isDone, updated_at: new Date().toISOString() };
      const newMessages = [...groupMessages.slice(0, index), updated, ...groupMessages.slice(index + 1)];

      return {
        messages: {
          ...state.messages,
          [groupId]: newMessages
        },
        streamUpdateCounter: state.streamUpdateCounter + 1
      };
    });
  },

  finalizeStreamMessage: (groupId: string, messageId: string, content: string, replyTo?: string | string[], replyToIds?: string[]) => {
    if (streamTimeouts.has(messageId)) {
      clearTimeout(streamTimeouts.get(messageId)!);
      streamTimeouts.delete(messageId);
    }
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const existingIndex = groupMessages.findIndex(m => m.id === messageId);

      if (existingIndex === -1) {
        if (import.meta.env.DEV) console.log('[Store] finalizeStreamMessage - message not found, skipping:', messageId);
        return state;
      }

      // 避免重复finalize：若消息已非streaming且内容已包含超时提示，跳过
      const existing = groupMessages[existingIndex];
      if (!existing.is_streaming && existing.content === content) {
        return state;
      }

      // 避免 message_stream_end 的空 content 覆盖已流式累积的非空内容
      const finalContent = (!content || content.trim().length === 0) && existing.content?.trim().length > 0
        ? existing.content
        : content;

      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              return {
                ...m,
                content: finalContent,
                reply_to: replyTo,
                reply_to_ids: replyToIds,
                is_streaming: false
              };
            }
            return m;
          })
        },
        // 流式结束时也需更新 streamUpdateCounter，触发 MessageList 的滚动到底部逻辑
        // 否则流式输出停止后视图停留在中间位置，需手动滚动
        streamUpdateCounter: state.streamUpdateCounter + 1
      };
    });
  }
}));

export function resetMessagesModuleState() {
  sendingGroups.clear();
  pendingMessages.clear();
  for (const timeout of streamTimeouts.values()) {
    clearTimeout(timeout);
  }
  streamTimeouts.clear();
  for (const timer of Object.values(persistTimers)) {
    clearTimeout(timer);
  }
  Object.keys(persistTimers).forEach(key => {
    delete persistTimers[key];
  });
  Object.keys(pendingSaveMessages).forEach(key => {
    delete pendingSaveMessages[key];
  });
}
