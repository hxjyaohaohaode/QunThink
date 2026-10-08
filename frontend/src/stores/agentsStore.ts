import { create } from 'zustand';
import { api } from '../services/api';
import { readAgentStream } from '../services/agentStream';
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
  createAgent: (data: { name: string; description: string; openingMessage: string; enableSuggestions: boolean; capabilities: { scheduled_tasks: boolean; web_search: boolean; multimodal: boolean }; avatarUrl?: string | null; modelId?: string | null }) => Promise<Agent>;
  updateAgent: (agentId: string, data: AgentUpdateData) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  fetchAgentMessages: (agentId: string) => Promise<void>;
  sendAgentMessage: (agentId: string, message: string, files?: File[]) => Promise<void>;
  generateQuestions: (data: { name: string; description: string; openingMessage: string }) => Promise<AgentQuestion[]>;
  fetchAgentSuggestions: (agentId: string, context?: string) => Promise<string[]>;
}

// 按 agentId 存储活跃的 AbortController，确保新消息发送时中断旧流
const activeStreamControllers = new Map<string, { controller: AbortController; messageId: string }>();
const messageReadVersions = new Map<string, number>();

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
    const snapshot = get().agentMessages.get(agentId);
    if (activeStreamControllers.has(agentId)) return;
    const version = (messageReadVersions.get(agentId) || 0) + 1;
    messageReadVersions.set(agentId, version);
    const identity = get().agents.find(agent => agent.id === agentId) || get().currentAgent;
    try {
      const messages = await api.getAgentMessages(agentId);
      if (messageReadVersions.get(agentId) !== version || get().agentMessages.get(agentId) !== snapshot ||
          (get().agents.find(agent => agent.id === agentId) || get().currentAgent) !== identity) return;
      set(state => {
        const agentMessages = new Map(state.agentMessages);
        agentMessages.set(agentId, messages);
        return { agentMessages };
      });
    } catch (error) {
      if (messageReadVersions.get(agentId) === version && get().agentMessages.get(agentId) === snapshot && get().currentAgent?.id === agentId) {
        set({ error: error instanceof Error ? error.message : '获取智能体消息失败' });
      }
    }
  },

  sendAgentMessage: async (agentId: string, message: string, files?: File[]) => {
    const previous = activeStreamControllers.get(agentId);
    if (previous && get().agentMessages.get(agentId)?.some(m => m.id === previous.messageId)) {
      throw new Error('当前回复仍在进行，请等待完成后再发送');
    }
    previous?.controller.abort();
    const controller = new AbortController();
    const intentId = crypto.randomUUID();
    const userMessageId = `temp_${intentId}`;
    const agentMessageId = `temp_agent_${intentId}`;
    activeStreamControllers.set(agentId, { controller, messageId: agentMessageId });
    const attachments: AgentMessageAttachment[] | undefined = files?.length ? files.map(file => {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const type = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext) ? 'image'
        : ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext) ? 'audio'
        : ['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(ext) ? 'video' : 'file';
      return { filename: file.name, type };
    }) : undefined;
    const createdAt = new Date().toISOString();
    set(state => {
      const agentMessages = new Map(state.agentMessages);
      agentMessages.set(agentId, [...(agentMessages.get(agentId) || []),
        { id: userMessageId, agent_id: agentId, sender_type: 'user', content: message, created_at: createdAt, attachments },
        { id: agentMessageId, agent_id: agentId, sender_type: 'agent', content: '', created_at: createdAt, is_streaming: true }]);
      return { agentMessages, error: null };
    });
    const current = () => activeStreamControllers.get(agentId)?.controller === controller &&
      Boolean(get().agentMessages.get(agentId)?.some(m => m.id === agentMessageId));
    const updateReply = (changes: Partial<AgentChatMessage>, error?: string) => {
      if (!current()) return;
      set(state => {
        const agentMessages = new Map(state.agentMessages);
        agentMessages.set(agentId, (agentMessages.get(agentId) || []).map(m => m.id === agentMessageId ? { ...m, ...changes } : m));
        return { agentMessages, ...(error && state.currentAgent?.id === agentId ? { error } : {}) };
      });
    };
    let partial = '';
    try {
      const response = files?.length
        ? await api.sendAgentMessageWithFiles(agentId, message, files, controller.signal)
        : await api.sendAgentMessage(agentId, message, controller.signal);
      if (!current()) throw new Error('回复所属会话已改变');
      const content = await readAgentStream(response, value => {
        if (!current()) throw new Error('回复所属会话已改变');
        partial = value;
        updateReply({ content: value });
      });
      if (!current()) throw new Error('回复所属会话已改变');
      updateReply({ content, is_streaming: false });
      const snapshot = get().agentMessages.get(agentId);
      try {
        const messages = await api.getAgentMessages(agentId);
        if (current() && get().agentMessages.get(agentId) === snapshot && messages?.length) {
          set(state => {
            const agentMessages = new Map(state.agentMessages); agentMessages.set(agentId, messages);
            return { agentMessages };
          });
        }
      } catch { /* Keep the displayed reply if authoritative history is temporarily unavailable. */ }
    } catch (error) {
      const reason = error instanceof Error ? error.message : '回复未完成';
      updateReply({ content: partial, is_streaming: false, response_state: partial ? 'incomplete' : 'failed', response_error: reason }, reason);
      throw error;
    } finally {
      controller.abort();
      if (activeStreamControllers.get(agentId)?.controller === controller) activeStreamControllers.delete(agentId);
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
