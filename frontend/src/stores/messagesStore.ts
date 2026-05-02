import { create } from 'zustand';
import { api } from '../services/api';
import { triggerAITypingIndicators } from '../services/websocket';
import { saveMessagesToIndexedDB, loadMessagesFromIndexedDB, clearAllMessagesFromIndexedDB, clearOldMessagesFromIndexedDB } from '../utils/indexedDB';
import { useGroupsStore } from './groupsStore';
import type { Comment, MessageAttachment, Message } from '../types';

const sendingGroups = new Map<string, boolean>();
const pendingMessages = new Map<string, { tempId: string, groupId: string }>();

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
  sending: boolean;
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
const MESSAGE_STALE_TIME_MS = 10 * 1000;
const messageFetchPromises = new Map<string, Promise<void>>();
const lastMessageFetchAt = new Map<string, number>();

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

export const useMessagesStoreInternal = create<MessagesState>((set, get) => ({
  messages: {},
  streamUpdateCounter: 0,
  pagination: {},
  loading: false,
  sending: false,
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

          lastMessageFetchAt.set(groupId, Date.now());
          set(state => {
            const newState = {
              messages: {
                ...state.messages,
                [groupId]: messages
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
      
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: [...olderMessages, ...currentMessages]
        },
        pagination: {
          ...state.pagination,
          [groupId]: { hasMore, loadingMore: false, oldestMessageId: newOldestMessageId }
        }
      }));
    } catch (error) {
      console.error('Failed to load more messages:', error);
      set(state => ({
        pagination: {
          ...state.pagination,
          [groupId]: { ...pagination, loadingMore: false }
        }
      }));
    }
  },

  sendMessage: async (groupId: string, content: string, replyTo?: string | string[], attachments?: MessageAttachment[]) => {
    if (sendingGroups.get(groupId)) {
      return { success: false, tempId: '', error: '消息正在发送中' };
    }

    sendingGroups.set(groupId, true);
    set({ sending: true, error: null });
    
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
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
    
    try {
      const message = await api.sendMessage(groupId, content, 'text', replyTo, undefined, attachments);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.tempId === tempId ? { ...message, status: 'sent', tempId } : m
          )
        },
        sending: false
      }));

      pendingMessages.delete(tempId);
      
      const groupsStore = useGroupsStore.getState();
      const group = groupsStore.groups?.find(g => g.id === groupId);
      if (group?.ai_members && group.ai_members.length > 0) {
        triggerAITypingIndicators(groupId, group.ai_members);
      }
      
      return { success: true, tempId };
    } catch (error) {
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.tempId === tempId ? { ...m, status: 'failed' } : m
          )
        },
        error: error instanceof Error ? error.message : String(error),
        sending: false
      }));
      
      pendingMessages.delete(tempId);
      return { success: false, tempId, error: error instanceof Error ? error.message : String(error) };
    } finally {
      sendingGroups.delete(groupId);
    }
  },

  retryMessage: async (groupId: string, tempId: string) => {
    const state = get();
    const failedMessage = (state.messages[groupId] || []).find(m => m.tempId === tempId);
    
    if (!failedMessage) {
      return { success: false, error: '消息不存在' };
    }
    
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).map(m =>
          m.tempId === tempId ? { ...m, status: 'sending' } : m
        )
      },
      sending: true,
      error: null
    }));
    
    try {
      const message = await api.sendMessage(groupId, failedMessage.content, 'text', failedMessage.reply_to);
      
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.tempId === tempId ? { ...message, status: 'sent' } : m
          )
        },
        sending: false
      }));
      
      return { success: true };
    } catch (error) {
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.tempId === tempId ? { ...m, status: 'failed' } : m
          )
        },
        error: error instanceof Error ? error.message : String(error),
        sending: false
      }));
      
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  removeFailedMessage: (groupId: string, tempId: string) => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).filter(m => m.tempId !== tempId)
      }
    }));
  },

  deleteMessage: async (messageId: string, groupId: string) => {
    try {
      await api.deleteMessage(messageId);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).filter(m => m.id !== messageId)
        }
      }));

      for (const [tempId, entry] of pendingMessages.entries()) {
        if (entry.groupId === groupId) {
          pendingMessages.delete(tempId);
        }
      }
    } catch (error) {
      console.error('Failed to delete message:', error);
    }
  },

  editMessage: async (messageId: string, groupId: string, content: string) => {
    try {
      const updatedMessage = await api.editMessage(messageId, content);
      
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.id === messageId 
              ? { 
                  ...m, 
                  content: updatedMessage.content || content,
                  is_edited: true,
                  edited_at: updatedMessage.edited_at || new Date().toISOString()
                } 
              : m
          )
        }
      }));
    } catch (error) {
      console.error('Failed to edit message:', error);
      throw error;
    }
  },

  batchDeleteMessages: async (messageIds: string[], groupId: string) => {
    try {
      await api.batchDeleteMessages(messageIds, groupId);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).filter(m => !messageIds.includes(m.id))
        }
      }));
    } catch (error) {
      console.error('Failed to batch delete messages:', error);
      throw error;
    }
  },

  clearAllMessages: async (groupId: string) => {
    try {
      await api.clearAllMessages(groupId);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: []
        }
      }));
      clearAllMessagesFromIndexedDB(groupId);
    } catch (error) {
      console.error('Failed to clear all messages:', error);
      throw error;
    }
  },

  removeMessages: (groupId: string, messageIds: string[]) => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).filter(m => !messageIds.includes(m.id))
      }
    }));
  },

  clearMessages: (groupId: string) => {
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

        if (existing.content === updatedMessage.content &&
            existing.status === updatedMessage.status &&
            existing.is_streaming === updatedMessage.is_streaming &&
            existing.reply_to === updatedMessage.reply_to) {
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
    }
  },

  unlikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
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
    }
  },

  dislikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
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
    }
  },

  undislikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
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
        
        const newComment: Comment = serverComment.id ? {
          id: serverComment.id,
          message_id: serverComment.message_id || messageId,
          parent_id: serverComment.parent_id || parentId,
          reply_to: serverComment.reply_to,
          sender_type: serverComment.sender_type || senderType,
          sender_id: serverComment.sender_id || senderId,
          content: serverComment.content || content,
          created_at: serverComment.created_at || new Date().toISOString(),
          depth: serverComment.depth ?? (parentDepth + 1)
        } : {
          id: `comment_${Date.now()}`,
          message_id: messageId,
          parent_id: parentId,
          sender_type: senderType,
          sender_id: senderId,
          content,
          created_at: new Date().toISOString(),
          depth: parentDepth + 1
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
  },

  updateStreamMessage: (groupId: string, messageId: string, content: string, isDone: boolean) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const newMessages = groupMessages.map(m => {
        if (m.id === messageId) {
          return { 
            ...m, 
            content,
            is_streaming: !isDone,
            updated_at: new Date().toISOString()
          };
        }
        return m;
      });
      
      return {
        messages: {
          ...state.messages,
          [groupId]: [...newMessages]
        },
        streamUpdateCounter: state.streamUpdateCounter + 1
      };
    });
  },

  finalizeStreamMessage: (groupId: string, messageId: string, content: string, replyTo?: string | string[], replyToIds?: string[]) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const existingIndex = groupMessages.findIndex(m => m.id === messageId);
      
      if (existingIndex === -1) {
        if (import.meta.env.DEV) console.log('[Store] finalizeStreamMessage - message not found, skipping:', messageId);
        return state;
      }
      
      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              return { 
                ...m, 
                content,
                reply_to: replyTo,
                reply_to_ids: replyToIds,
                is_streaming: false
              };
            }
            return m;
          })
        }
      };
    });
  }
}));

export function resetMessagesModuleState() {
  sendingGroups.clear();
  pendingMessages.clear();
}

export function useMessagesStore() {
  const {
    messages,
    streamUpdateCounter,
    pagination,
    loading,
    sending,
    error,
    fetchMessages,
    loadMoreMessages,
    sendMessage,
    retryMessage,
    removeFailedMessage,
    likeMessage,
    unlikeMessage,
    dislikeMessage,
    undislikeMessage,
    applyLikeUpdate,
    applyUnlikeUpdate,
    applyDislikeUpdate,
    applyUndislikeUpdate,
    deleteMessage,
    editMessage,
    batchDeleteMessages,
    clearAllMessages,
    addMessage,
    addComment,
    addCommentFromRemote,
    updateMessage,
    removeMessages,
    clearMessages,
    addStreamMessage,
    updateStreamMessage,
    finalizeStreamMessage,
  } = useMessagesStoreInternal();

  return {
    messages,
    streamUpdateCounter,
    pagination,
    loading,
    sending,
    error,
    fetchMessages,
    loadMoreMessages,
    sendMessage,
    retryMessage,
    removeFailedMessage,
    likeMessage,
    unlikeMessage,
    dislikeMessage,
    undislikeMessage,
    applyLikeUpdate,
    applyUnlikeUpdate,
    applyDislikeUpdate,
    applyUndislikeUpdate,
    deleteMessage,
    editMessage,
    batchDeleteMessages,
    clearAllMessages,
    addMessage,
    addComment,
    addCommentFromRemote,
    updateMessage,
    removeMessages,
    clearMessages,
    addStreamMessage,
    updateStreamMessage,
    finalizeStreamMessage,
  };
}
