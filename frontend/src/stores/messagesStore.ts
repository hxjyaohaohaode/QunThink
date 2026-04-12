import { create } from 'zustand';
import { api } from '../services/api';
import { useEffect } from 'react';

export interface Comment {
  id: string;
  message_id: string;
  parent_id?: string; // 父评论ID，支持嵌套结构
  reply_to?: string; // 回复的目标评论ID
  sender_type: 'user' | 'ai';
  sender_id?: string;
  content: string;
  created_at: string;
  depth?: number; // 嵌套深度，用于UI显示控制
  likes?: number; // 评论点赞数
  liked_by?: string[]; // 点赞用户列表
  replies?: Comment[]; // 嵌套回复（前端计算使用）
}

export interface Message {
  id: string;
  group_id: string;
  sender_type: 'user' | 'ai' | 'system';
  sender_id?: string;
  content: string;
  content_type: 'text' | 'code' | 'file' | 'system';
  reply_to?: string;
  reply_to_message?: Message;
  metadata?: Record<string, any>;
  created_at: string;
  likes?: number;
  liked_by?: string[];
  dislikes?: number;
  disliked_by?: string[];
  comments?: Comment[];
  is_edited?: boolean;
}

interface MessagesState {
  messages: Record<string, Message[]>;
  loading: boolean;
  sending: boolean;
  error: string | null;
  fetchMessages: (groupId: string) => Promise<void>;
  sendMessage: (groupId: string, content: string, replyTo?: string) => Promise<void>;
  deleteMessage: (messageId: string, groupId: string) => Promise<void>;
  addMessage: (groupId: string, message: Message) => void;
  clearTyping: (groupId: string, aiId: string) => void;
  likeMessage: (messageId: string, groupId: string, userId?: string) => void;
  unlikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  dislikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  undislikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  addComment: (messageId: string, groupId: string, content: string, senderType: 'user' | 'ai', senderId?: string) => Promise<void>;
  updateMessage: (messageId: string, groupId: string, updates: Partial<Message>) => void;
}

export const useMessagesStoreInternal = create<MessagesState>((set, get) => ({
  messages: {},
  loading: false,
  sending: false,
  error: null,

  fetchMessages: async (groupId: string) => {
    set({ loading: true, error: null });
    try {
      const response = await api.getMessages(groupId);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: response.messages
        },
        loading: false
      }));
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  sendMessage: async (groupId: string, content: string, replyTo?: string) => {
    set({ sending: true, error: null });
    try {
      const message = await api.sendMessage(groupId, content, 'user', 'user', replyTo);
      get().addMessage(groupId, message);
      set({ sending: false });
    } catch (error) {
      set({ error: (error as Error).message, sending: false });
    }
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
    } catch (error) {
      console.error('Failed to delete message:', error);
    }
  },

  addMessage: (groupId: string, message: Message) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const exists = groupMessages.some(m => m.id === message.id);

      if (exists) return state;

      return {
        messages: {
          ...state.messages,
          [groupId]: [...groupMessages, message]
        }
      };
    });
  },

  clearTyping: (_groupId: string, _aiId: string) => {
  },

  likeMessage: async (messageId: string, groupId: string, userId: string = 'user') => {
    try {
      const result = await api.likeMessage(messageId, userId);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.id === messageId ? { ...m, likes: result.likes, likes_count: result.likes_count } : m
          ),
        }
      }));
    } catch (error) {
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.id === messageId ? { ...m, likes: [...(m.likes || []), userId], likes_count: (m.likes_count || 0) + 1 } : m
          ),
        }
      }));
    }
  },

  unlikeMessage: async (messageId: string, groupId: string, userId: string = 'user') => {
    try {
      const result = await api.unlikeMessage(messageId, userId);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.id === messageId ? { ...m, likes: result.likes, likes_count: result.likes_count } : m
          ),
        }
      }));
    } catch (error) {
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.id === messageId ? { ...m, likes: (m.likes || []).filter(id => id !== userId), likes_count: Math.max(0, (m.likes_count || 0) - 1) } : m
          ),
        }
      }));
    }
  },

  dislikeMessage: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              const dislikedBy = m.disliked_by || [];
              if (!dislikedBy.includes(userId)) {
                return {
                  ...m,
                  dislikes: (m.dislikes || 0) + 1,
                  disliked_by: [...dislikedBy, userId]
                };
              }
            }
            return m;
          })
        }
      };
    });
  },

  undislikeMessage: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              const dislikedBy = m.disliked_by || [];
              if (dislikedBy.includes(userId)) {
                return {
                  ...m,
                  dislikes: Math.max(0, (m.dislikes || 0) - 1),
                  disliked_by: dislikedBy.filter(id => id !== userId)
                };
              }
            }
            return m;
          })
        }
      };
    });
  },

  addComment: async (messageId: string, groupId: string, content: string, senderType: 'user' | 'ai', senderId?: string) => {
    try {
      const response = await api.addComment(messageId, content);
      const serverComment = response.comment || response;

      set(state => {
        const groupMessages = state.messages[groupId] || [];
        const newComment: Comment = serverComment.id ? serverComment : {
          id: `comment_${Date.now()}`,
          message_id: messageId,
          sender_type: senderType,
          sender_id: senderId,
          content,
          created_at: new Date().toISOString()
        };

        return {
          messages: {
            ...state.messages,
            [groupId]: groupMessages.map(m => {
              if (m.id === messageId) {
                return {
                  ...m,
                  comments: [...(m.comments || []), newComment]
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
  }
}));

export function useMessagesStore() {
  const {
    messages,
    loading,
    sending,
    error,
    fetchMessages,
    sendMessage,
    likeMessage,
    unlikeMessage,
    dislikeMessage,
    undislikeMessage,
    deleteMessage,
    addMessage,
    addComment,
    updateMessage,
    clearTyping,
  } = useMessagesStoreInternal();

  // 从 localStorage 加载消息
  useEffect(() => {
    const cached = localStorage.getItem('messages_cache');
    if (cached) {
      try {
        const parsedMessages = JSON.parse(cached);
        useMessagesStoreInternal.setState(state => ({
          messages: {
            ...state.messages,
            ...parsedMessages
          }
        }));
      } catch (e) {
        console.error('Failed to parse cached messages:', e);
      }
    }
  }, []);

  // 保存消息到 localStorage
  useEffect(() => {
    localStorage.setItem('messages_cache', JSON.stringify(messages));
  }, [messages]);

  return {
    messages,
    loading,
    sending,
    error,
    fetchMessages,
    sendMessage,
    likeMessage,
    unlikeMessage,
    dislikeMessage,
    undislikeMessage,
    deleteMessage,
    addMessage,
    addComment,
    updateMessage,
    clearTyping,
  };
}
