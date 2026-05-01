import axios from 'axios';
import type { Group, GroupFile, Message } from '../types';
import type { FileUploadResponse, GroupCreateInput, GroupSettingsInput, MessageCreateInput, PaginatedMessagesResponse } from '../../../shared/contracts';
import { getApiBaseUrl, getApiBaseUrlCandidates, rememberBackendOrigin } from './runtimeConfig';

const DEFAULT_AUTH_MODE = 'session';

type AuthEventListener = () => void;
const authEventListeners: Set<AuthEventListener> = new Set();

export function onAuthExpired(listener: AuthEventListener): () => void {
  authEventListeners.add(listener);
  return () => authEventListeners.delete(listener);
}

export function notifyAuthExpired() {
  authEventListeners.forEach(listener => {
    try { listener(); } catch {}
  });
}

export const axiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  },
  withCredentials: true
});

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

function getAuthMode() {
  return import.meta.env.VITE_AUTH_MODE || DEFAULT_AUTH_MODE;
}

function getCookie(name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escapedName}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function isMutatingMethod(method?: string): boolean {
  const normalizedMethod = method?.toUpperCase();
  return normalizedMethod === 'POST' || normalizedMethod === 'PUT' || normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE';
}

let csrfTokenPromise: Promise<string | null> | null = null;

async function ensureCsrfToken(): Promise<string | null> {
  if (getAuthMode() === 'dev') {
    return null;
  }

  const existingToken = getCookie('XSRF-TOKEN');
  if (existingToken) {
    return existingToken;
  }

  if (!csrfTokenPromise) {
    csrfTokenPromise = (async () => {
      const candidates = getApiBaseUrlCandidates();
      for (const baseUrl of candidates) {
        try {
          const response = await axios.get(`${baseUrl}/csrf-token`, { withCredentials: true });
          rememberBackendOrigin(baseUrl.replace(/\/api$/, ''));
          const token = response.data?.csrfToken || getCookie('XSRF-TOKEN');
          if (token) {
            return token;
          }
        } catch {}
      }

      return getCookie('XSRF-TOKEN');
    })()
      .finally(() => {
        csrfTokenPromise = null;
      });
  }

  return csrfTokenPromise;
}

function rememberBackendOriginFromUrl(url: string | null | undefined) {
  if (!url) {
    return;
  }

  try {
    const resolvedUrl = new URL(url, window.location.origin);
    rememberBackendOrigin(resolvedUrl.origin);
  } catch {}
}

function getBaseUrlCandidates(): string[] {
  const candidates = getApiBaseUrlCandidates();
  return candidates.length > 0 ? candidates : [getApiBaseUrl()];
}

async function buildRequestHeaders(includeJsonContentType = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const authMode = getAuthMode();

  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json';
  }

  if (authMode === 'dev') {
    headers['x-user-id'] = getDevUserId();
    return headers;
  }

  const csrfToken = await ensureCsrfToken();
  if (csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }

  return headers;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const getDevUserId = () => {
  const key = 'dev_user_id';
  let userId = localStorage.getItem(key);
  if (!userId) {
    userId = 'dev_user_bm1srus5';
    localStorage.setItem(key, userId);
  }
  return userId;
};

axiosInstance.interceptors.request.use(
  async (config) => {
    const runtimeBaseUrl = getApiBaseUrl();
    const requestConfig = config as typeof config & {
      baseUrlCandidates?: string[];
      activeBaseUrlIndex?: number;
    };

    requestConfig.baseUrlCandidates = requestConfig.baseUrlCandidates || getBaseUrlCandidates();
    requestConfig.activeBaseUrlIndex = requestConfig.baseUrlCandidates.indexOf(runtimeBaseUrl);
    if (requestConfig.activeBaseUrlIndex < 0) {
      requestConfig.activeBaseUrlIndex = 0;
    }
    requestConfig.baseURL = requestConfig.baseUrlCandidates[requestConfig.activeBaseUrlIndex] || runtimeBaseUrl;

    const authMode = getAuthMode();
    config.headers = config.headers || {};
    if (authMode === 'dev') {
      const userId = getDevUserId();
      config.headers['x-user-id'] = userId;
      if (import.meta.env.DEV) {
        console.log(`[API Request] ${config.method?.toUpperCase()} ${config.baseURL}${config.url} | userId: ${userId} | data:`, config.data);
      }
    } else {
      config.withCredentials = true;
      if (isMutatingMethod(config.method)) {
        const csrfToken = await ensureCsrfToken();
        if (csrfToken) {
          config.headers['x-csrf-token'] = csrfToken;
        }
      }
      if (import.meta.env.DEV) {
        console.log(`[API Request] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

axiosInstance.interceptors.response.use(
  (response) => {
    rememberBackendOriginFromUrl(response.request?.responseURL || response.config.baseURL);
    if (import.meta.env.DEV) {
      console.log(`[API Response] ${response.config.method?.toUpperCase()} ${response.config.url} -> ${response.status}`);
    }
    if (typeof response.data !== 'object' || response.data === null) {
      const error = new Error('服务器返回了非预期的响应格式，请稍后重试');
      return Promise.reject(error);
    }
    return response;
  },
  async (error) => {
    const config = error.config as (typeof error.config & {
      retryCount?: number;
      baseUrlCandidates?: string[];
      activeBaseUrlIndex?: number;
    }) | undefined;
    
    if (!config) {
      return Promise.reject(error);
    }
    
    if (typeof config.retryCount !== 'number') {
      config.retryCount = 0;
    }
    
    const isNetworkError = !error.response && (error.code === 'ERR_NETWORK' || error.code === 'ECONNABORTED');
    const isServerError = error.response && (error.response.status === 500 || error.response.status === 502 || error.response.status === 503);
    const isCsrfError = error.response?.status === 403 && error.response?.data?.error === 'CSRF token validation failed';

    if (isCsrfError && isMutatingMethod(config.method) && config.retryCount < 1) {
      config.retryCount++;
      csrfTokenPromise = null;
      document.cookie = 'XSRF-TOKEN=; Path=/; Max-Age=0';
      const newToken = await ensureCsrfToken();
      if (newToken) {
        config.headers['x-csrf-token'] = newToken;
        if (import.meta.env.DEV) {
          console.warn('[API] CSRF token验证失败，已重新获取token并重试');
        }
        return axiosInstance(config);
      }
    }

    if (isNetworkError && Array.isArray(config.baseUrlCandidates)) {
      const nextBaseUrlIndex = (config.activeBaseUrlIndex ?? 0) + 1;
      if (nextBaseUrlIndex < config.baseUrlCandidates.length) {
        config.activeBaseUrlIndex = nextBaseUrlIndex;
        config.baseURL = config.baseUrlCandidates[nextBaseUrlIndex];
        config.retryCount = 0;
        if (import.meta.env.DEV) {
          console.warn(`[API Fallback] 切换后端地址到 ${config.baseURL}`);
        }
        return axiosInstance(config);
      }
    }
    
    if ((isNetworkError || isServerError) && config.retryCount < MAX_RETRIES) {
      config.retryCount++;
      
      const delayMs = RETRY_DELAY * Math.pow(2, config.retryCount - 1);
      if (import.meta.env.DEV) {
        console.log(`[API Retry] 第${config.retryCount}次重试，${config.method?.toUpperCase()} ${config.url}，等待 ${delayMs}ms`);
      }
      
      await delay(delayMs);
      
      try {
        return await axiosInstance(config);
      } catch (retryError) {
        if (config.retryCount >= MAX_RETRIES) {
          if (import.meta.env.DEV) {
            console.error(`[API Retry Failed] 重试${MAX_RETRIES}次后仍然失败`);
          }
        }
        return Promise.reject(retryError);
      }
    }
    
    if (import.meta.env.DEV) {
      const isExpected401 = error.response?.status === 401 && error.config?.url?.includes('/auth/token');
      if (!isExpected401) {
        console.error('[API Error]', error.message, error.code);
      }
    }
    
    if (!error.response) {
      const networkError = new Error('网络连接失败，请检查网络后重试');
      return Promise.reject(networkError);
    }

    if (error.response.status === 401 && error.response?.data?.requiresAuth) {
      notifyAuthExpired();
      return Promise.reject(error);
    }

    if (typeof error.response.data === 'object' && error.response.data !== null && error.response.data.error) {
      const detailedError = new Error(error.response.data.error);
      return Promise.reject(detailedError);
    }

    if (typeof error.response.data !== 'object' || error.response.data === null) {
      const status = error.response.status;
      let message = '服务器发生错误，请稍后重试';
      if (status === 502) {
        message = '服务器正在维护中，请稍后重试';
      } else if (status === 503) {
        message = '服务暂时不可用，请稍后重试';
      }
      const friendlyError = new Error(message);
      return Promise.reject(friendlyError);
    }

    return Promise.reject(error);
  }
);

export const api = {
  getGroups: async (): Promise<Group[]> => {
    const response = await axiosInstance.get('/groups');
    return response.data;
  },

  getGroup: async (id: string) => {
    const response = await axiosInstance.get(`/groups/${id}`);
    return response.data;
  },

  createGroup: async (name: string, description: string, aiMembers?: string[], avatarUrl?: string) => {
    const payload: GroupCreateInput = {
      name,
      description,
      ai_members: aiMembers,
      avatar_url: avatarUrl
    };
    const response = await axiosInstance.post('/groups', payload);
    return response.data;
  },

  deleteGroup: async (groupId: string) => {
    const response = await axiosInstance.delete(`/groups/${groupId}`);
    return response.data;
  },

  updateDebateMode: async (groupId: string, debateMode: boolean, debateLevel?: number) => {
    const body: Record<string, any> = { debate_mode: debateMode };
    if (debateLevel !== undefined) {
      body.debate_level = debateLevel;
    }
    const response = await axiosInstance.put(`/groups/${groupId}/debate`, body);
    return response.data;
  },

  pinGroup: async (groupId: string, pinned: boolean) => {
    const response = await axiosInstance.put(`/groups/${groupId}/pin`, { pinned });
    return response.data;
  },

  getOrCreatePrivateChat: async (aiId: string) => {
    const response = await axiosInstance.post(`/private-chat/${aiId}`);
    return response.data;
  },

  addGroupMember: async (groupId: string, aiId: string) => {
    const response = await axiosInstance.post(`/groups/${groupId}/members`, { aiId });
    return response.data;
  },

  removeGroupMember: async (groupId: string, aiId: string) => {
    const response = await axiosInstance.delete(`/groups/${groupId}/members/${aiId}`);
    return response.data;
  },

  getAIPrivateChats: async () => {
    const response = await axiosInstance.get('/ai-private-chats');
    return response.data;
  },

  createAIPrivateChat: async (aiMembers: string[], topic?: string, customName?: string) => {
    const response = await axiosInstance.post('/ai-private-chat', { aiMembers, topic, customName });
    return response.data;
  },

  deleteAIPrivateChat: async (chatId: string) => {
    const response = await axiosInstance.delete(`/ai-private-chats/${chatId}`);
    return response.data;
  },

  startAIPrivateChat: async (chatId: string, topic?: string) => {
    const response = await axiosInstance.post(`/ai-private-chats/${chatId}/start`, { topic });
    return response.data;
  },

  continueAIPrivateChat: async (chatId: string) => {
    const response = await axiosInstance.post(`/ai-private-chats/${chatId}/continue`);
    return response.data;
  },

  stopAIPrivateChat: async (chatId: string) => {
    const response = await axiosInstance.post(`/ai-private-chats/${chatId}/stop`);
    return response.data;
  },

  getAIPrivateChatStatus: async (chatId: string) => {
    const response = await axiosInstance.get(`/ai-private-chats/${chatId}/status`);
    return response.data;
  },

  getMessages: async (groupId: string, limit = 50, before?: string, after?: string): Promise<PaginatedMessagesResponse> => {
    const params: Record<string, any> = { limit };
    if (before) params.before = before;
    if (after) params.after = after;
    const response = await axiosInstance.get(`/groups/${groupId}/messages`, { params });
    return response.data;
  },

  sendMessage: async (
    groupId: string,
    content: string,
    contentType: 'text' | 'code' | 'file' | 'system' = 'text',
    replyTo?: string,
    metadata?: Record<string, any>,
    attachments?: { id: string; name: string; type: string; size: number; url?: string }[]
  ): Promise<Message> => {
    const payload: MessageCreateInput = {
      content,
      content_type: contentType,
      reply_to: replyTo,
      metadata,
      attachments
    };
    const response = await axiosInstance.post(`/groups/${groupId}/messages`, payload);
    return response.data;
  },

  deleteMessage: async (messageId: string) => {
    await axiosInstance.delete(`/messages/${messageId}`);
  },

  editMessage: async (messageId: string, content: string) => {
    const response = await axiosInstance.put(`/messages/${messageId}`, { content });
    return response.data;
  },

  batchDeleteMessages: async (messageIds: string[], groupId: string) => {
    const response = await axiosInstance.post('/messages/batch-delete', {
      message_ids: messageIds,
      group_id: groupId
    });
    return response.data;
  },

  clearAllMessages: async (groupId: string) => {
    const response = await axiosInstance.delete(`/groups/${groupId}/messages`);
    return response.data;
  },

  uploadFile: async (files: File | File[], groupId: string): Promise<FileUploadResponse> => {
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    const MAX_FILE_COUNT = 10;
    const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.vbs', '.js', '.msi', '.com', '.scr', '.dll', '.pif', '.reg', '.wsf', '.ws'];

    const fileArray = Array.isArray(files) ? files : [files];

    if (fileArray.length > MAX_FILE_COUNT) {
      throw new Error(`最多只能上传${MAX_FILE_COUNT}个文件`);
    }

    for (const file of fileArray) {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (DANGEROUS_EXTENSIONS.includes(ext!)) {
        throw new Error('不允许上传可执行文件');
      }
      if (file.size > MAX_FILE_SIZE) {
        throw new Error('文件大小不能超过50MB');
      }
    }

    const formData = new FormData();
    for (const file of fileArray) {
      formData.append('files', file);
    }
    formData.append('group_id', groupId);

    const response = await axiosInstance.post('/files/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 120000
    });
    return response.data;
  },

  getFile: async (fileId: string, groupId?: string) => {
    const response = await axiosInstance.get(`/files/${fileId}`, {
      params: groupId ? { group_id: groupId } : undefined
    });
    return response.data;
  },

  getFileContent: async (fileId: string, groupId?: string) => {
    const response = await axiosInstance.get(`/files/${fileId}/content`, {
      params: groupId ? { group_id: groupId } : undefined
    });
    return response.data;
  },

  getFileMediaDescription: async (fileId: string, groupId?: string) => {
    const response = await axiosInstance.get(`/files/${fileId}/media-description`, {
      params: groupId ? { group_id: groupId } : undefined
    });
    return response.data;
  },

  evaluateSmartLike: async (message: Record<string, unknown>, contextMessages: Record<string, unknown>[], senderInfo: Record<string, unknown>) => {
    const response = await axiosInstance.post('/social/evaluate-like', {
      message,
      contextMessages,
      senderInfo
    });
    return response.data;
  },

  performAutoLike: async (messageId: string, groupId: string) => {
    const response = await axiosInstance.post('/social/auto-like', {
      messageId,
      groupId
    });
    return response.data;
  },

  getSocialStats: async (timeRange: string = 'all') => {
    const response = await axiosInstance.get('/social/stats', {
      params: { timeRange }
    });
    return response.data;
  },

  getTopMessages: async (limit: number = 10, metric: string = 'overallScore') => {
    const response = await axiosInstance.get('/social/top-messages', {
      params: { limit, metric }
    });
    return response.data;
  },

  getActiveParticipants: async (limit: number = 10) => {
    const response = await axiosInstance.get('/social/active-participants', {
      params: { limit }
    });
    return response.data;
  },

  getSmartLikeConfig: async () => {
    const response = await axiosInstance.get('/social/smart-like-config');
    return response.data;
  },

  updateSmartLikeConfig: async (config: Record<string, unknown>) => {
    const response = await axiosInstance.put('/social/smart-like-config', {
      config
    });
    return response.data;
  },

  addComment: async (messageId: string, content: string, parentId?: string, replyTo?: string) => {
    const response = await axiosInstance.post('/comments', {
      message_id: messageId,
      content,
      parent_id: parentId || null,
      reply_to: replyTo || null
    });
    return response.data;
  },

  likeMessage: async (messageId: string) => {
    const response = await axiosInstance.post(`/messages/${messageId}/like`);
    return response.data;
  },

  unlikeMessage: async (messageId: string) => {
    const response = await axiosInstance.delete(`/messages/${messageId}/like`);
    return response.data;
  },

  dislikeMessage: async (messageId: string) => {
    const response = await axiosInstance.post(`/messages/${messageId}/dislike`);
    return response.data;
  },

  undislikeMessage: async (messageId: string) => {
    const response = await axiosInstance.delete(`/messages/${messageId}/dislike`);
    return response.data;
  },

  getPersonas: async () => {
    const response = await axiosInstance.get('/personas');
    return response.data.personas;
  },

  updatePersona: async (aiId: string, config: Record<string, unknown>) => {
    const response = await axiosInstance.put(`/personas/${aiId}`, config);
    return response.data.persona;
  },

  resetPersona: async (aiId: string) => {
    const response = await axiosInstance.put(`/personas/${aiId}/reset`);
    return response.data.persona;
  },

  getProfile: async () => {
    const response = await axiosInstance.get('/profile');
    return response.data.profile;
  },

  updateProfile: async (profile: Record<string, unknown>) => {
    const response = await axiosInstance.put('/profile', profile);
    return response.data.profile;
  },

  startFormalDebate: async (groupId: string, topic: string, rolePreferences?: Record<string, string>, debateLevel?: number, selectedParticipants?: string[]) => {
    const body: Record<string, any> = { topic };
    if (rolePreferences) body.rolePreferences = rolePreferences;
    if (debateLevel !== undefined) body.debateLevel = debateLevel;
    if (selectedParticipants) body.selectedParticipants = selectedParticipants;
    const response = await axiosInstance.post(`/groups/${groupId}/formal-debate/start`, body);
    return response.data;
  },

  stopFormalDebate: async (groupId: string) => {
    const response = await axiosInstance.post(`/groups/${groupId}/formal-debate/stop`);
    return response.data;
  },

  getFormalDebateStatus: async (groupId: string) => {
    const response = await axiosInstance.get(`/groups/${groupId}/formal-debate/status`);
    return response.data;
  },

  allocateDebateRoles: async (groupId: string, rolePreferences?: Record<string, string>, selectedParticipants?: string[]) => {
    const body: Record<string, any> = {};
    if (rolePreferences) body.rolePreferences = rolePreferences;
    if (selectedParticipants) body.selectedParticipants = selectedParticipants;
    const response = await axiosInstance.post(`/groups/${groupId}/formal-debate/allocate-roles`, body);
    return response.data;
  },

  triggerAudienceComment: async (groupId: string, audienceMembers: string[]) => {
    const response = await axiosInstance.post(`/groups/${groupId}/formal-debate/audience-comment`, { audienceMembers });
    return response.data;
  },

  updateGroupSettings: async (groupId: string, settings: GroupSettingsInput) => {
    const response = await axiosInstance.put(`/groups/${groupId}/settings`, settings);
    return response.data;
  },

  uploadBackground: async (groupId: string, file: File): Promise<{ background_url: string }> => {
    const formData = new FormData();
    formData.append('background', file);
    const response = await axiosInstance.post(`/groups/${groupId}/upload-background`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  getGroupFiles: async (groupId: string): Promise<GroupFile[]> => {
    const response = await axiosInstance.get(`/groups/${groupId}/files`);
    return response.data?.files || [];
  },

  uploadGroupFile: async (groupId: string, file: File): Promise<GroupFile | null> => {
    const response = await api.uploadFile(file, groupId);
    const uploadedFile = response.file;
    if (!uploadedFile) {
      return null;
    }
    return {
      id: uploadedFile.id,
      group_id: uploadedFile.group_id,
      name: uploadedFile.original_name || uploadedFile.filename || file.name,
      url: uploadedFile.url || `/api/files/${uploadedFile.id}/download?group_id=${encodeURIComponent(uploadedFile.group_id)}`,
      size: uploadedFile.file_size ?? file.size,
      type: uploadedFile.mime_type || file.type,
      uploaded_at: uploadedFile.created_at
    };
  },

  deleteGroupFile: async (groupId: string, fileId: string) => {
    const response = await axiosInstance.delete(`/groups/${groupId}/files/${fileId}`);
    return response.data;
  },

  deleteFile: async (fileId: string, groupId?: string) => {
    const response = await axiosInstance.delete(`/files/${fileId}`, {
      data: groupId ? { group_id: groupId } : undefined
    });
    return response.data;
  },

  startAutonomousChat: async (groupId: string, topic?: string) => {
    const response = await axiosInstance.post(`/groups/${groupId}/autonomous-chat/start`, { topic });
    return response.data;
  },

  stopAutonomousChat: async (groupId: string) => {
    const response = await axiosInstance.post(`/groups/${groupId}/autonomous-chat/stop`);
    return response.data;
  },

  getAutonomousChatStatus: async (groupId: string) => {
    const response = await axiosInstance.get(`/groups/${groupId}/autonomous-chat/status`);
    return response.data;
  },

  startPrivateChat: async (groupId: string, topic?: string) => {
    const response = await axiosInstance.post(`/groups/${groupId}/private-chat/start`, { topic });
    return response.data;
  },

  stopPrivateChat: async (groupId: string) => {
    const response = await axiosInstance.post(`/groups/${groupId}/private-chat/stop`);
    return response.data;
  },

  getPrivateChatStatus: async (groupId: string) => {
    const response = await axiosInstance.get(`/groups/${groupId}/private-chat/status`);
    return response.data;
  },

  globalSearch: async (query: string, options?: { type?: string; groupId?: string; limit?: number }) => {
    const params: Record<string, any> = { q: query };
    if (options?.type) params.type = options.type;
    if (options?.groupId) params.groupId = options.groupId;
    if (options?.limit) params.limit = options.limit;
    const response = await axiosInstance.get('/search', { params });
    return response.data;
  },

  reindexFiles: async () => {
    const response = await axiosInstance.post('/files/reindex');
    return response.data;
  },

  markMessageRead: async (groupId: string, messageId: string) => {
    const response = await axiosInstance.post(`/groups/${groupId}/messages/${messageId}/read`);
    return response.data;
  },

  getTTSVoices: async () => {
    const response = await axiosInstance.get('/tts/voices');
    return response.data;
  },

  synthesizeSpeech: async (text: string, voice: string, tone?: string, messageId?: string) => {
    const response = await axiosInstance.post('/tts/synthesize', { text, voice, tone, messageId });
    return response.data;
  },

  getTTSMessageAudio: async (messageId: string) => {
    const response = await axiosInstance.get(`/tts/messages/${messageId}`);
    return response.data;
  },

  deleteTTSMessageAudio: async (messageId: string) => {
    const response = await axiosInstance.delete(`/tts/messages/${messageId}`);
    return response.data;
  },

  getTTSAudioUrl: (audioId: string) => {
    const filename = /\.[a-z0-9]+$/i.test(audioId) ? audioId : `${audioId}.wav`;
    return `${getApiBaseUrl()}/tts/audio/${filename}`;
  },

  storeMemory: async (content: string, category?: string, metadata?: Record<string, unknown>) => {
    const response = await axiosInstance.post('/memory/store', { content, category, metadata });
    return response.data;
  },

  retrieveMemories: async (query: string, category?: string, senderId?: string, dateRange?: { start: string; end: string }, limit?: number) => {
    const response = await axiosInstance.post('/memory/retrieve', { query, category, senderId, dateRange, limit });
    return response.data;
  },

  retrieveForConversation: async (groupId: string, limit?: number) => {
    const response = await axiosInstance.post('/memory/retrieve-for-conversation', { groupId, limit });
    return response.data;
  },

  getMemoryStats: async () => {
    const response = await axiosInstance.get('/memory/stats');
    return response.data;
  },

  getMemoryConfig: async () => {
    const response = await axiosInstance.get('/memory/config');
    return response.data;
  },

  updateMemoryConfig: async (config: Record<string, unknown>) => {
    const response = await axiosInstance.put('/memory/config', { config });
    return response.data;
  },

  autoStoreImportant: async (groupId: string, timeRange?: string, threshold?: number) => {
    const response = await axiosInstance.post('/memory/auto-store-important', { groupId, timeRange, threshold });
    return response.data;
  },

  clearMemories: async () => {
    const response = await axiosInstance.post('/memory/clear', { confirm: 'CLEAR_ALL_MEMORIES' });
    return response.data;
  },

  getInteractionLogs: async (params?: Record<string, unknown>) => {
    const response = await axiosInstance.get('/interaction/logs', { params });
    return response.data;
  },

  getInteractionStats: async (timeRange?: string, groupId?: string) => {
    const response = await axiosInstance.get('/interaction/stats', { params: { timeRange, groupId } });
    return response.data;
  },

  getInteractionQuality: async (timeRange?: string) => {
    const response = await axiosInstance.get('/interaction/quality', { params: { timeRange } });
    return response.data;
  },

  exportInteractionLogs: async (format: string, type?: string, filters?: Record<string, unknown>) => {
    const response = await axiosInstance.get('/interaction/export', { params: { format, type, ...filters } });
    return response.data;
  },

  getInteractionParticipation: async (groupId: string, timeRange?: string) => {
    const response = await axiosInstance.get('/interaction/participation', { params: { groupId, timeRange } });
    return response.data;
  },

  login: async (username: string, password: string) => {
    const response = await axiosInstance.post('/auth/login', { username, password });
    return response.data;
  },

  loginPhone: async (phone: string, password: string) => {
    const response = await axiosInstance.post('/auth/login-phone', { phone, password });
    return response.data;
  },

  register: async (username: string, password: string, nickname?: string) => {
    const response = await axiosInstance.post('/auth/register', { username, password, nickname });
    return response.data;
  },

  registerSms: async (phone: string, password: string, code: string, nickname?: string) => {
    const response = await axiosInstance.post('/auth/register-sms', { phone, password, code, nickname });
    return response.data;
  },

  logout: async () => {
    const response = await axiosInstance.post('/auth/logout');
    return response.data;
  },

  getBootstrap: async () => {
    const response = await axiosInstance.get('/bootstrap');
    return response.data;
  },

  getCurrentUser: async () => {
    const response = await axiosInstance.get('/auth/me');
    return response.data;
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    const response = await axiosInstance.post('/auth/change-password', { currentPassword, newPassword });
    return response.data;
  },

  sendSmsCode: async (phone: string) => {
    const response = await axiosInstance.post('/sms/send', { phone });
    return response.data;
  },

  verifySmsCode: async (phone: string, code: string) => {
    const response = await axiosInstance.post('/sms/verify', { phone, code });
    return response.data;
  },

  getAuthStatus: async () => {
    const response = await axiosInstance.get('/auth/token');
    return response.data;
  },

  getAgents: async (): Promise<any[]> => {
    const response = await axiosInstance.get('/agents');
    return response.data;
  },

  getAgent: async (agentId: string): Promise<any> => {
    const response = await axiosInstance.get(`/agents/${agentId}`);
    return response.data;
  },

  createAgent: async (data: { name: string; description: string; openingMessage: string; enableSuggestions: boolean; capabilities: { scheduled_tasks: boolean; web_search: boolean; multimodal: boolean }; avatarUrl?: string | null }) => {
    const response = await axiosInstance.post('/agents', data);
    return response.data;
  },

  generateAgentQuestions: async (data: { name: string; description: string; openingMessage: string }) => {
    if (import.meta.env.DEV) console.log('[api.generateAgentQuestions] 准备发送请求:', data);
    const response = await axiosInstance.post('/agents/generate-questions', data);
    if (import.meta.env.DEV) console.log('[api.generateAgentQuestions] 收到响应:', response.data);
    return response.data;
  },

  updateAgent: async (agentId: string, data: any) => {
    const response = await axiosInstance.put(`/agents/${agentId}`, data);
    return response.data;
  },

  deleteAgent: async (agentId: string) => {
    const response = await axiosInstance.delete(`/agents/${agentId}`);
    return response.data;
  },

  getAgentMessages: async (agentId: string, limit = 50, before?: string) => {
    const params: any = { limit };
    if (before) params.before = before;
    const response = await axiosInstance.get(`/agents/${agentId}/messages`, { params });
    return response.data;
  },

  sendAgentMessage: async (agentId: string, message: string) => {
    const headers = await buildRequestHeaders(true);
    const response = await fetch(`${axiosInstance.defaults.baseURL}/agents/${agentId}/chat`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ message })
    });
    return response;
  },

  sendAgentMessageWithFiles: async (agentId: string, message: string, files: File[]) => {
    const formData = new FormData();
    formData.append('message', message);
    files.forEach(file => {
      formData.append('files', file);
    });

    const headers = await buildRequestHeaders();
    const response = await fetch(`${axiosInstance.defaults.baseURL}/agents/${agentId}/chat-with-files`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: formData
    });
    return response;
  },

  invokeAgent: async (agentId: string, context: string) => {
    const response = await axiosInstance.post(`/agents/${agentId}/invoke`, { context });
    return response.data;
  },

  getAgentSuggestions: async (agentId: string, context?: string) => {
    const params = context ? { context } : {};
    const response = await axiosInstance.get(`/agents/${agentId}/suggestions`, { params });
    return response.data;
  }
};
