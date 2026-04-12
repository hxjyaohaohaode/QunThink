export interface Group {
  id: string;
  name: string;
  description: string;
  type: 'preset' | 'custom' | 'private';
  is_private?: boolean;
  pinned?: boolean;
  debate_mode: boolean;
  debate_level: number;
  ai_members: string[];
  created_at: string;
}

export interface Comment {
  id: string;
  message_id: string;
  sender_type: 'user' | 'ai' | 'system';
  sender_id?: string;
  content: string;
  created_at: string;
}

export interface Message {
  id: string;
  group_id: string;
  sender_type: 'user' | 'ai' | 'system';
  sender_id?: string;
  content: string;
  content_type: 'text' | 'code' | 'file' | 'system';
  reply_to?: string;
  metadata?: Record<string, any>;
  liked_by?: string[];
  likes?: number;
  disliked_by?: string[];
  dislikes?: number;
  comments?: Comment[];
  created_at: string;
}

export interface AI {
  id: string;
  name: string;
  color: string;
  style: string;
}

export const AI_COLORS: Record<string, string> = {
  user: '#07c160',
  deepseek: '#fd9744',
  deepseek_reasoner: '#f97316',
  glm: '#34d399',
  mimo: '#f59e0b',
  qwen: '#a78bfa',
  system: '#555d78'
};

export const AI_STATUS_COLORS: Record<string, string> = {
  user: '#07c160',
  deepseek: '#ff9d4d',
  deepseek_reasoner: '#f97316',
  glm: '#34d399',
  mimo: '#242bf9',
  qwen: '#a78bfa',
  system: '#555d78'
};

export const AI_NAMES: Record<string, string> = {
  user: '我',
  deepseek: 'deepseek-chat',
  deepseek_reasoner: 'deepseek-reasoner',
  glm: 'GLM-4.5-Air',
  mimo: 'mimo-v2-flash',
  qwen: 'Qwen3.5-Flash',
  system: '系统'
};

export const AI_AVATAR_LETTERS: Record<string, string> = {
  user: '我',
  deepseek: 'D',
  deepseek_reasoner: 'R',
  glm: 'G',
  mimo: 'M',
  qwen: 'Q',
  system: 'S'
};
