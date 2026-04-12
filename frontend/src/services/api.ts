import axios from 'axios';

const getBaseUrl = () => {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  if (backendUrl) {
    return `${backendUrl}/api`;
  }
  return '/api';
};

const BASE_URL = getBaseUrl();

const axiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

axiosInstance.interceptors.response.use(
  response => response,
  error => {
    console.error('API Error:', error);
    return Promise.reject(error);
  }
);

export const api = {
  getGroups: async () => {
    const response = await axiosInstance.get('/groups');
    return response.data;
  },

  getGroup: async (id: string) => {
    const response = await axiosInstance.get(`/groups/${id}`);
    return response.data;
  },

  createGroup: async (name: string, description: string, aiMembers?: string[]) => {
    const response = await axiosInstance.post('/groups', {
      name,
      description,
      ai_members: aiMembers
    });
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

  getMessages: async (groupId: string, limit = 50, before?: string) => {
    const params: Record<string, any> = { limit };
    if (before) params.before = before;
    const response = await axiosInstance.get(`/groups/${groupId}/messages`, { params });
    return response.data;
  },

  sendMessage: async (
    groupId: string,
    content: string,
    senderType = 'user',
    senderId = 'user',
    replyTo?: string,
    metadata?: Record<string, any>
  ) => {
    const response = await axiosInstance.post(`/groups/${groupId}/messages`, {
      content,
      sender_type: senderType,
      sender_id: senderId,
      content_type: 'text',
      reply_to: replyTo,
      metadata
    });
    return response.data;
  },

  deleteMessage: async (messageId: string) => {
    await axiosInstance.delete(`/messages/${messageId}`);
  },

  uploadFile: async (file: File, groupId: string, uploaderId = 'user') => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('group_id', groupId);
    formData.append('uploader_id', uploaderId);

    const response = await axiosInstance.post('/files/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      timeout: 60000
    });
    return response.data;
  },

  getFile: async (fileId: string) => {
    const response = await axiosInstance.get(`/files/${fileId}`);
    return response.data;
  },

  getFileContent: async (fileId: string) => {
    const response = await axiosInstance.get(`/files/${fileId}/content`);
    return response.data;
  },

  // 社交互动API
  evaluateSmartLike: async (message: any, contextMessages: any[], senderInfo: any) => {
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

  updateSmartLikeConfig: async (config: any) => {
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

  likeMessage: async (messageId: string, userId: string) => {
    const response = await fetch(`${BASE_URL}/messages/${messageId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    return response.json();
  },

  unlikeMessage: async (messageId: string, userId: string) => {
    const response = await fetch(`${BASE_URL}/messages/${messageId}/like?user_id=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    return response.json();
  },

  dislikeMessage: async (messageId: string, userId: string = 'user') => {
    const response = await axiosInstance.post(`/messages/${messageId}/dislike`, { userId });
    return response.data;
  },

  undislikeMessage: async (messageId: string, userId: string = 'user') => {
    const response = await axiosInstance.delete(`/messages/${messageId}/dislike`, { data: { userId } });
    return response.data;
  },

  getPersonas: async () => {
    const response = await axiosInstance.get('/personas');
    return response.data.personas;
  },

  updatePersona: async (aiId: string, config: any) => {
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

  updateProfile: async (profile: any) => {
    const response = await axiosInstance.put('/profile', profile);
    return response.data.profile;
  }
};