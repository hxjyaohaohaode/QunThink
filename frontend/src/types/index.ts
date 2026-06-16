export type {
  Comment,
  Group,
  GroupFile,
  Message,
  MessageAttachment,
  MessageTTSAudio,
  UploadedFile
} from '../../../shared/contracts';

export interface AI {
  id: string;
  name: string;
  color: string;
  style: string;
}

export const AI_COLORS: Record<string, string> = {
  user: '#171717',
  deepseek: '#f97316',
  deepseek_reasoner: '#ea580c',
  mimo_flash: '#f59e0b',
  mimo_omni: '#06b6d4',
  mimo_tts: '#f472b6',
  glm_air: '#10b981',
  glm_flash: '#10b981',
  glm_flashx: '#059669',
  qwen_flash: '#8b5cf6',
  qwen_turbo: '#8b5cf6',
  glm_4v_flash: '#22d3ee',
  qwen_vl_plus: '#a78bfa',
  qwen_omni: '#f472b6',
  system: '#737373'
};

export const AI_NAMES: Record<string, string> = {
  user: '用户',
  deepseek: 'deepseek-v4-flash',
  deepseek_reasoner: 'deepseek-v4-pro',
  mimo_flash: 'mimo-v2.5-pro',
  mimo_omni: 'mimo-v2.5',
  mimo_tts: 'mimo-v2.5-tts-voicedesign',
  glm_air: 'GLM-4.5-Air',
  glm_flash: 'GLM-4.7-Flash',
  glm_flashx: 'GLM-4.7-FlashX',
  qwen_flash: 'Qwen3.5-Flash',
  qwen_turbo: 'qwen-turbo',
  glm_4v_flash: 'GLM-4.6V-Flash',
  qwen_vl_plus: 'Qwen-VL-Plus',
  qwen_omni: 'Qwen2.5-Omni-7B',
  system: '系统'
};

export const AI_AVATAR_LETTERS: Record<string, string> = {
  user: 'U',
  deepseek: 'D',
  deepseek_reasoner: 'R',
  mimo_flash: 'MF',
  mimo_omni: 'MO',
  mimo_tts: 'TTS',
  glm_air: 'GA',
  glm_flash: 'GF',
  glm_flashx: 'GX',
  qwen_flash: 'QF',
  qwen_turbo: 'QT',
  glm_4v_flash: 'GV',
  qwen_vl_plus: 'VP',
  qwen_omni: 'QO',
  system: 'S'
};

export const AI_LIST = ['deepseek', 'deepseek_reasoner', 'mimo_flash', 'mimo_omni', 'mimo_tts', 'glm_air', 'glm_flash', 'glm_flashx', 'qwen_flash', 'qwen_turbo', 'glm_4v_flash', 'qwen_vl_plus', 'qwen_omni'] as const;

export type DebateStyle = 'moderate' | 'standard' | 'intense';

export type DebateRole = 'proponent' | 'opponent' | 'judge' | 'audience';

export interface DebateConfig {
  topic: string;
  style: DebateStyle;
  participants: {
    aiId: string;
    role: DebateRole;
    position?: string;
  }[];
  isActive: boolean;
  currentRound: number;
  maxRounds: number;
  currentSpeaker: string | null;
}

export interface DebateStatus {
  isRunning: boolean;
  currentSpeaker: string | null;
  currentRound: number;
  status: 'idle' | 'running' | 'paused' | 'finished';
  topic?: string;
}

export const DEBATE_STYLE_NAMES: Record<DebateStyle, string> = {
  moderate: '温和辩论',
  standard: '标准辩论',
  intense: '激烈辩论'
};

export const DEBATE_ROLE_NAMES: Record<DebateRole, string> = {
  proponent: '正方',
  opponent: '反方',
  judge: '评审',
  audience: '观众'
};

export const DEBATE_ROLE_COLORS: Record<DebateRole, string> = {
  proponent: '#22c55e',
  opponent: '#ef4444',
  judge: '#3b82f6',
  audience: '#6b7280'
};

export const DEBATE_ROLE_ICONS: Record<DebateRole, string> = {
  proponent: 'P',
  opponent: 'O',
  judge: 'J',
  audience: 'A'
};

export interface AgentModelRole {
  modelId: string;
  role: string;
  description: string;
}

export interface Agent {
  id: string;
  name: string;
  avatar_url?: string | null;
  description: string;
  opening_message: string;
  enable_suggestions: boolean;
  capabilities: {
    scheduled_tasks: boolean;
    web_search: boolean;
    multimodal: boolean;
  };
  model_roles: AgentModelRole[];
  model_selection_reasoning?: string;
  system_prompt: string;
  created_at: string;
  updated_at?: string;
}

export interface AgentChatMessage {
  id: string;
  agent_id: string;
  sender_type: 'user' | 'agent' | 'system';
  content: string;
  created_at: string;
  is_streaming?: boolean;
  suggestions?: string[];
  attachments?: AgentMessageAttachment[];
}

export interface AgentMessageAttachment {
  filename: string;
  type: 'image' | 'audio' | 'video' | 'file';
  description?: string;
  content_preview?: string;
}

export interface AgentQuestion {
  id: string;
  question: string;
  answer?: string;
}

