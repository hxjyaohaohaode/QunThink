// Compatibility presets only. The user catalog controls actual requests.
import { normalizeBaseUrl } from '../services/ai/endpoints.js';

export const LEGACY_AI_CONFIGS = {
  glm_flash: {
    name: 'glm-4-flash',
    apiKey: process.env.GLM_API_KEY || '',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    enabled: true,
    priority: 1,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1000,
      frequency_penalty: 0.1,
      presence_penalty: 0.1
    }
  },
  mimo_flash: {
    name: 'mimo-v2.5-pro',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL
      ? `${normalizeBaseUrl(process.env.MIMO_BASE_URL)}/chat/completions`
      : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5-pro',
    enabled: true,
    priority: 2,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1000
    }
  },
  qwen_flash: {
    name: 'Qwen3.5-Flash',
    apiKey: process.env.QWEN_API_KEY || '',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3.5-flash',
    enabled: true,
    priority: 3,
    params: {
      temperature: 0.50,
      top_p: 0.8,
      max_tokens: 1500
    }
  },
  deepseek: {
    name: 'deepseek-v4-flash',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
    enabled: true,
    priority: 4,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500,
      frequency_penalty: 0.3,
      presence_penalty: 0.2
    }
  },
  glm_flashx: {
    name: 'glm-4-flashx',
    apiKey: process.env.GLM_API_KEY || '',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flashx',
    enabled: true,
    priority: 5,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500
    }
  },
  glm_air: {
    name: 'GLM-4.5-Air',
    apiKey: process.env.GLM_API_KEY || '',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'GLM-4.5-Air',
    enabled: true,
    priority: 6,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500
    }
  },
  qwen_turbo: {
    name: 'qwen-turbo',
    apiKey: process.env.QWEN_API_KEY || '',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-turbo',
    enabled: true,
    priority: 7,
    params: {
      temperature: 0.50,
      top_p: 0.8,
      max_tokens: 1500
    }
  },
  mimo_omni: {
    name: 'mimo-v2.5',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL
      ? `${normalizeBaseUrl(process.env.MIMO_BASE_URL)}/chat/completions`
      : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5',
    enabled: true,
    priority: 8,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500
    }
  },
  deepseek_reasoner: {
    name: 'deepseek-v4-pro',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-pro',
    enabled: true,
    priority: 9,
    params: {
      max_tokens: 2000
    },
    note: 'DeepSeek推理模型 - 不支持temperature/top_p/frequency_penalty/presence_penalty参数'
  },
  mimo_tts: {
    name: 'mimo-v2.5-tts',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL
      ? `${normalizeBaseUrl(process.env.MIMO_BASE_URL)}/chat/completions`
      : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5-tts',
    enabled: true,
    priority: 10,
    isTTS: true,
    params: {
      temperature: 0.30,
      top_p: 0.8,
      max_tokens: 200
    }
  },
  glm_4v_flash: {
    name: 'glm-4.6v-flash',
    apiKey: process.env.GLM_API_KEY || '',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4.6v-flash',
    enabled: true,
    priority: 11,
    capabilities: ['vision'],
    note: '智谱视觉模型 - 用于图片内容识别标注，完全免费，不可对话',
    params: {
      temperature: 0.20,
      top_p: 0.9,
      max_tokens: 500
    }
  },
  qwen_vl_plus: {
    name: 'qwen-vl-plus',
    apiKey: process.env.QWEN_API_KEY || '',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-vl-plus',
    enabled: true,
    priority: 12,
    capabilities: ['vision'],
    note: '通义千问视觉模型 - 用于图片内容识别标注，1.5元/百万tokens（直降81%），不可对话',
    params: {
      temperature: 0.20,
      top_p: 0.9,
      max_tokens: 500
    }
  },
  qwen_omni: {
    name: 'qwen2.5-omni-7b',
    apiKey: process.env.QWEN_API_KEY || '',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen2.5-omni-7b',
    enabled: true,
    priority: 13,
    capabilities: ['vision', 'audio', 'video'],
    note: '通义千问全模态模型 - 用于图片/音频/视频标注，2025年7月前免费，不可对话',
    params: {
      temperature: 0.20,
      top_p: 0.9,
      max_tokens: 500
    }
  }
};
