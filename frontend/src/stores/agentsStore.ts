import { create } from 'zustand';
import { api } from '../services/api';
import { Agent, AgentChatMessage, AgentQuestion, AgentMessageAttachment } from '../types';

interface AgentUpdateData {
  name?: string;
  description?: string;
  system_prompt?: string;
  opening_message?: string;
  avatar_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

interface AgentsState {
  agents: Agent[];
  currentAgent: Agent | null;
  agentMessages: Map<string, AgentChatMessage[]>;
  loading: boolean;
  error: string | null;
  creatingAgent: boolean;
  fetchAgents: () => Promise<void>;
  selectAgent: (agentId: string) => void;
  createAgent: (data: { name: string; description: string; openingMessage: string; enableSuggestions: boolean; capabilities: { scheduled_tasks: boolean; web_search: boolean; multimodal: boolean }; avatarUrl?: string | null }) => Promise<Agent>;
  updateAgent: (agentId: string, data: AgentUpdateData) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  fetchAgentMessages: (agentId: string) => Promise<void>;
  sendAgentMessage: (agentId: string, message: string, files?: File[]) => Promise<void>;
  generateQuestions: (data: { name: string; description: string; openingMessage: string }) => Promise<AgentQuestion[]>;
  fetchAgentSuggestions: (agentId: string, context?: string) => Promise<string[]>;
}

// 按 agentId 存储活跃的 AbortController，确保新消息发送时中断旧流
const activeStreamControllers = new Map<string, AbortController>();

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  currentAgent: null,
  agentMessages: new Map(),
  loading: false,
  error: null,
  creatingAgent: false,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const agents = await api.getAgents();
      const currentAgentId = get().currentAgent?.id;
      const updatedCurrentAgent = currentAgentId
        ? agents.find((a: Agent) => a.id === currentAgentId) || null
        : null;
      set({
        agents,
        currentAgent: updatedCurrentAgent,
        loading: false
      });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  selectAgent: (agentId: string) => {
    if (!agentId) {
      set({ currentAgent: null });
      return;
    }
    const agent = get().agents.find(a => a.id === agentId);
    if (agent) {
      set({ currentAgent: agent });
      if (!get().agentMessages.has(agentId)) {
        get().fetchAgentMessages(agentId);
      }
    }
  },

  createAgent: async (data) => {
    set({ creatingAgent: true, error: null });
    try {
      const newAgent = await api.createAgent(data);
      set(state => ({
        agents: [...state.agents, newAgent],
        currentAgent: newAgent,
        creatingAgent: false
      }));
      return newAgent;
    } catch (error) {
      set({ error: (error as Error).message, creatingAgent: false });
      throw error;
    }
  },

  updateAgent: async (agentId: string, data: AgentUpdateData) => {
    try {
      const updated = await api.updateAgent(agentId, data);
      set(state => ({
        agents: state.agents.map(a => a.id === agentId ? updated : a),
        currentAgent: state.currentAgent?.id === agentId ? updated : state.currentAgent
      }));
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  deleteAgent: async (agentId: string) => {
    try {
      await api.deleteAgent(agentId);
      set(state => {
        const newAgentMessages = new Map(state.agentMessages);
        newAgentMessages.delete(agentId);
        return {
          agents: state.agents.filter(a => a.id !== agentId),
          currentAgent: state.currentAgent?.id === agentId ? null : state.currentAgent,
          agentMessages: newAgentMessages
        };
      });
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  fetchAgentMessages: async (agentId: string) => {
    try {
      const messages = await api.getAgentMessages(agentId);
      set(state => {
        const newAgentMessages = new Map(state.agentMessages);
        newAgentMessages.set(agentId, messages);
        return { agentMessages: newAgentMessages };
      });
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to fetch agent messages:', error);
      set({ error: error instanceof Error ? error.message : '获取智能体消息失败' });
    }
  },

  sendAgentMessage: async (agentId: string, message: string, files?: File[]) => {
    let attachments: AgentMessageAttachment[] | undefined;
    if (files && files.length > 0) {
      attachments = files.map(f => {
        const ext = f.name.split('.').pop()?.toLowerCase() || '';
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
        const isAudio = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext);
        const isVideo = ['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(ext);
        return {
          filename: f.name,
          type: isImage ? 'image' as const : isAudio ? 'audio' as const : isVideo ? 'video' as const : 'file' as const,
        };
      });
    }

    const userMessage: AgentChatMessage = {
      id: `temp_${Date.now()}`,
      agent_id: agentId,
      sender_type: 'user',
      content: message,
      created_at: new Date().toISOString(),
      attachments,
    };

    const agentMessageId = `temp_agent_${Date.now()}`;
    const agentMessage: AgentChatMessage = {
      id: agentMessageId,
      agent_id: agentId,
      sender_type: 'agent',
      content: '',
      created_at: new Date().toISOString(),
      is_streaming: true
    };

    set(state => {
      const newAgentMessages = new Map(state.agentMessages);
      const existing = newAgentMessages.get(agentId) || [];
      newAgentMessages.set(agentId, [...existing, userMessage, agentMessage]);
      return { agentMessages: newAgentMessages };
    });

    try {
      // 中断同一 agent 的旧流请求
      const oldController = activeStreamControllers.get(agentId);
      if (oldController) {
        oldController.abort();
      }
      const abortController = new AbortController();
      activeStreamControllers.set(agentId, abortController);

      let response;
      if (files && files.length > 0) {
        response = await api.sendAgentMessageWithFiles(agentId, message, files);
      } else {
        response = await api.sendAgentMessage(agentId, message);
      }

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      if (reader) {
        try {
          while (true) {
            // 30秒超时读取
            const readResult = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('SSE read timeout')), 30000)
              )
            ]);
            const { done, value } = readResult;
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data.trim() === '[DONE]') continue;

                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content) {
                    fullContent += parsed.content;
                    set(state => {
                      const newAgentMessages = new Map(state.agentMessages);
                      const messages = newAgentMessages.get(agentId) || [];
                      const updatedMessages = messages.map(m =>
                        m.id === agentMessageId
                          ? { ...m, content: fullContent }
                          : m
                      );
                      newAgentMessages.set(agentId, updatedMessages);
                      return { agentMessages: newAgentMessages };
                    });
                  }
                } catch {
                  fullContent += data;
                  set(state => {
                    const newAgentMessages = new Map(state.agentMessages);
                    const messages = newAgentMessages.get(agentId) || [];
                    const updatedMessages = messages.map(m =>
                      m.id === agentMessageId
                        ? { ...m, content: fullContent }
                        : m
                    );
                    newAgentMessages.set(agentId, updatedMessages);
                    return { agentMessages: newAgentMessages };
                  });
                }
              }
            }
          }
        } catch (readError) {
          console.error('SSE流读取错误:', readError);
        } finally {
          reader.releaseLock();
          activeStreamControllers.delete(agentId);
        }
      }

      // 流式完成后，从后端重新加载消息以获取真实 ID（替换临时 ID）
      set(state => {
        const newAgentMessages = new Map(state.agentMessages);
        const messages = newAgentMessages.get(agentId) || [];
        const updatedMessages = messages.map(m =>
          m.id === agentMessageId
            ? { ...m, content: fullContent || 'No response', is_streaming: false }
            : m
        );
        newAgentMessages.set(agentId, updatedMessages);
        return { agentMessages: newAgentMessages };
      });

      // 同步后端真实消息数据，替换前端临时 ID
      try {
        const backendMessages = await api.getAgentMessages(agentId);
        if (backendMessages && backendMessages.length > 0) {
          set(state => {
            const newAgentMessages = new Map(state.agentMessages);
            newAgentMessages.set(agentId, backendMessages);
            return { agentMessages: newAgentMessages };
          });
        }
      } catch { /* 静默失败，前端临时消息仍然可用 */ }
    } catch (error) {
      activeStreamControllers.delete(agentId);
      set(state => {
        const newAgentMessages = new Map(state.agentMessages);
        const messages = newAgentMessages.get(agentId) || [];
        const updatedMessages = messages.map(m =>
          m.id === agentMessageId
            ? { ...m, content: 'Failed to get response', is_streaming: false }
            : m
        );
        newAgentMessages.set(agentId, updatedMessages);
        return { agentMessages: newAgentMessages, error: (error as Error).message };
      });
    }
  },

  generateQuestions: async (data) => {
    try {
      if (import.meta.env.DEV) console.log('[generateQuestions] Calling with data:', data);
      const result = await api.generateAgentQuestions(data);
      if (import.meta.env.DEV) console.log('[generateQuestions] Result:', result);
      return result;
    } catch (error: unknown) {
      if (import.meta.env.DEV) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Failed to generate questions:', message);
        if (error instanceof Error && 'response' in error) {
          const response = (error as Error & { response?: { status?: number; data?: unknown } }).response;
          console.error('[generateQuestions] Error response:', response);
          console.error('[generateQuestions] Error status:', response?.status);
          console.error('[generateQuestions] Error data:', response?.data);
        }
      }
      set({ error: error instanceof Error ? error.message : '生成问题失败' });
      throw error;
    }
  },

  fetchAgentSuggestions: async (agentId, context) => {
    try {
      const result = await api.getAgentSuggestions(agentId, context);
      return result.suggestions || [];
    } catch {
      set({ error: '获取建议失败' });
      return [];
    }
  }
}));
