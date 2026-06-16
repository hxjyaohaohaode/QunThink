import axios from 'axios';
import aiLoadBalancer from './loadBalancer.js';
import { AI_NAMES, AI_MENTION_ALIASES, calculateSimilarity } from '../../config/constants.js';
import { safeLog } from '../../utils/logger.js';
import { getEffectiveRelationship } from '../../config/personas.js';

const DEFAULT_AI_CONFIGS = {
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
    endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions',
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
    endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions',
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
    name: 'mimo-v2.5-tts-voicedesign',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5-tts-voicedesign',
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

let aiConfigs = { ...DEFAULT_AI_CONFIGS };

// 模型ID到厂商映射
function mapModelToVendor(modelId) {
  if (modelId === 'deepseek' || modelId === 'deepseek_reasoner') return 'deepseek';
  if (modelId.startsWith('glm_')) return 'zhipu';
  if (modelId.startsWith('mimo_')) return 'mimo';
  if (modelId.startsWith('qwen_')) return 'qwen';
  return null;
}

// Vision-capable model IDs
const VISION_MODELS = ['glm_4v_flash', 'qwen_vl_plus', 'qwen_omni'];

/**
 * 获取用户对特定模型的API配置
 * @param {string} userId
 * @param {string} modelId - AI模型ID (如 deepseek, glm_flash, etc.)
 * @returns {object|null} { apiKey, baseUrl } or null
 */
export async function getUserApiConfigForModel(userId, modelId) {
  if (!userId || !modelId) return null;
  try {
    const { getUserDb } = await import('../../models/db.js');
    const db = await getUserDb(userId);
    await db.read();
    const aiApiConfigs = db.data.aiApiConfigs || {};
    const vendor = mapModelToVendor(modelId);
    if (!vendor) return null;
    const vendorConfig = aiApiConfigs[vendor];
    if (!vendorConfig) return null;
    const result = {};
    if (vendorConfig.apiKey && vendorConfig.apiKey.trim().length > 0) {
      result.apiKey = vendorConfig.apiKey.trim();
    }
    if (vendorConfig.baseUrl && vendorConfig.baseUrl.trim().length > 0) {
      result.baseUrl = vendorConfig.baseUrl.trim();
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    safeLog('warn', '[AI配置] 获取用户API配置失败', { error: error.message });
    return null;
  }
}

/**
 * 检查消息中是否包含图片
 */
export function messagesContainImages(attachments) {
  if (!attachments || attachments.length === 0) return false;
  return attachments.some(att => {
    const ext = (att.name || att.filename || '').split('.').pop()?.toLowerCase();
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
    return imageExts.includes(ext) || (att.type && att.type.startsWith('image/'));
  });
}

/**
 * 根据消息中的附件选择合适的视觉模型
 */
export function selectVisionModel(modelId) {
  if (VISION_MODELS.includes(modelId)) return modelId;
  // 如果当前模型不是视觉模型，选择对应的视觉模型
  const vendor = mapModelToVendor(modelId);
  if (vendor === 'zhipu') return 'glm_4v_flash';
  if (vendor === 'qwen') return 'qwen_vl_plus';
  // 如果都不匹配，默认使用免费的智谱视觉模型
  return 'glm_4v_flash';
}

export async function loadAIConfigsFromDB(userId) {
  try {
    const { getUserDb } = await import('../../models/db.js');
    const db = await getUserDb(userId || 'default');
    await db.read();
    const customConfigs = db.data.aiModels || {};
    for (const [id, custom] of Object.entries(customConfigs)) {
      if (aiConfigs[id]) {
        aiConfigs[id] = { ...aiConfigs[id], ...custom };
      } else {
        aiConfigs[id] = custom;
      }
    }

    // 加载用户自定义API配置
    if (userId) {
      const aiApiConfigs = db.data.aiApiConfigs || {};
      for (const [vendor, cfg] of Object.entries(aiApiConfigs)) {
        if (!cfg || typeof cfg !== 'object') continue;
        for (const [modelId, config] of Object.entries(aiConfigs)) {
          if (mapModelToVendor(modelId) !== vendor) continue;
          if (cfg.apiKey && cfg.apiKey.trim().length > 0) {
            aiConfigs[modelId] = { ...aiConfigs[modelId], apiKey: cfg.apiKey.trim() };
          }
          if (cfg.baseUrl && cfg.baseUrl.trim().length > 0) {
            aiConfigs[modelId] = { ...aiConfigs[modelId], endpoint: cfg.baseUrl.trim() };
          }
        }
      }
    }

    safeLog('info', '[AI配置] 已从数据库加载模型配置');
  } catch (error) {
    safeLog('warn', '[AI配置] 从数据库加载失败，使用默认配置', { error: error.message });
  }
}

export async function getUserCustomPersona(userId, aiId) {
  try {
    const { getUserDb } = await import('../../models/db.js');
    const db = await getUserDb(userId);
    await db.read();
    return db.data.customPersonas?.[aiId] || null;
  } catch (error) {
    safeLog('warn', '[AI] 获取用户自定义角色失败', { error: error.message });
    return null;
  }
}

export function getAIConfigs() { return aiConfigs; }
export function getAIConfig(id) { return aiConfigs[id]; }

const aiHealthStatus = new Map();

function getMockResponse(aiId, persona, responseType, recentMessages) {
  return `[${persona?.name || aiId}] 暂时无法连接，请稍后再试。`;
}

/**
 * 判断AI是否应该回复 - 拟人化随机回复决策
 * @param {object} persona - AI角色配置
 * @param {array} recentMessages - 最近消息列表
 * @param {string} aiId - AI的ID
 * @param {object} options - 额外选项
 * @param {string} options.lastMessageText - 最后一条消息的文本内容（用于@提及检测）
 * @returns {{ shouldReply: boolean, delay: number }} 是否应该回复，以及建议延迟时间(ms)
 */
export function shouldAIReply(persona, recentMessages = [], aiId, options = {}) {
  const responseConfig = persona?.responseConfig || {};
  const replyProbability = responseConfig.responseFrequency != null ? responseConfig.responseFrequency : 0.4;

  if (recentMessages && recentMessages.length > 0) {
    const lastMsg = recentMessages[recentMessages.length - 1];
    const lastMsgContent = options.lastMessageText || lastMsg.content || '';

    // 规则1: @提及强制回复 - 如果最后一条消息@了该AI，100%回复
    const isMentioned = isAIMentioned(lastMsgContent, aiId);
    if (isMentioned) {
      const baseDelay = responseConfig.minDelay != null ? responseConfig.minDelay : 500;
      const maxDelay = responseConfig.maxDelay != null ? responseConfig.maxDelay : 3000;
      const delay = baseDelay + Math.floor(Math.random() * (maxDelay - baseDelay + 1));
      return { shouldReply: true, delay };
    }

    // 规则2: 区分消息来源，采用不同回复概率
    let effectiveProbability = replyProbability;
    if (lastMsg.sender_type === 'user') {
      // 用户发消息，提高回复概率（用户期望得到回应）
      effectiveProbability = Math.min(replyProbability * 1.5, 0.95);
    } else if (lastMsg.sender_type === 'ai') {
      // 其他AI发消息，降低回复概率（避免AI之间过度对话）
      effectiveProbability = replyProbability * 0.6;
    }

    // 随机决策
    const roll = Math.random();
    if (roll > effectiveProbability) return { shouldReply: false, delay: 0 };

    // 规则3: 去重逻辑 - 避免短时间内重复回复
    const recent = recentMessages.slice(-8);

    // 如果该AI是最后一条消息的发送者，大幅降低再次回复概率
    if (lastMsg.sender_id === aiId) {
      // 自己刚说完话，不立即接话，80%概率跳过
      if (Math.random() < 0.8) return { shouldReply: false, delay: 0 };
    }

    // 检查该AI在最近3条AI消息中是否已经发过言
    const recentAISenders = recent
      .filter(m => m.sender_type === 'ai')
      .slice(-4)
      .map(m => m.sender_id);

    // 如果该AI在最近4条AI消息中已经出现过，降低回复概率
    if (recentAISenders.includes(aiId)) {
      if (Math.random() < 0.6) return { shouldReply: false, delay: 0 };
    }

    // 检查最近消息是否已经有多个AI发言（避免AI刷屏）
    const aiCountInRecent = recentAISenders.length;
    if (aiCountInRecent >= 3 && !recentAISenders.includes(aiId)) {
      // 已经有3个以上的AI在说话了，减少新AI加入的概率
      if (Math.random() < 0.5) return { shouldReply: false, delay: 0 };
    }
  }

  // 使用 persona 配置的回复延迟范围（minDelay/maxDelay），叠加±30%随机波动
  const baseMinDelay = responseConfig.minDelay != null ? responseConfig.minDelay : 2000;
  const baseMaxDelay = responseConfig.maxDelay != null ? responseConfig.maxDelay : 5000;
  const variation = 0.3; // ±30%
  const minDelay = Math.round(baseMinDelay * (1 - variation));
  const maxDelay = Math.round(baseMaxDelay * (1 + variation));
  const delay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));

  return { shouldReply: true, delay };
}

/**
 * 检测消息中是否@提到了指定的AI
 * @param {string} messageContent - 消息文本内容
 * @param {string} aiId - AI的ID
 * @returns {boolean} 是否被提到
 */
function isAIMentioned(messageContent, aiId) {
  if (!messageContent || typeof messageContent !== 'string') return false;
  const content = messageContent.toLowerCase();

  // 获取该AI的所有别名
  const aliases = AI_MENTION_ALIASES[aiId] || [];
  if (aliases.length === 0) return false;

  // 检查是否包含@别名
  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase();
    // 检查 @别名 模式
    if (content.includes(`@${aliasLower}`)) return true;
    // 也检查 @别名 后面跟空格或标点的情况
    const mentionRegex = new RegExp(`@${escapeRegex(aliasLower)}(?=[\\s，。！？；、,.:;!?\\-]|$)`, 'i');
    if (mentionRegex.test(content)) return true;
  }

  // 对于"用户"标签，检查常见的@用户模式
  if (aiId === 'user') {
    if (/@用户/.test(content)) return true;
  }

  return false;
}

/**
 * 转义正则表达式特殊字符
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyMessageLengthLimit(content, persona) {
  const maxMessageLength = persona?.socialConfig?.maxMessageLength || persona?.maxMessageLength || 500;
  if (content.length <= maxMessageLength) return content;

  const truncated = content.substring(0, maxMessageLength);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('！'),
    truncated.lastIndexOf('？'),
    truncated.lastIndexOf('；'),
    truncated.lastIndexOf('…'),
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?'),
    truncated.lastIndexOf(';'),
    truncated.lastIndexOf('\n')
  );

  if (lastSentenceEnd > maxMessageLength * 0.3) {
    return truncated.substring(0, lastSentenceEnd + 1);
  }

  const lastComma = Math.max(
    truncated.lastIndexOf('，'),
    truncated.lastIndexOf(','),
    truncated.lastIndexOf('、')
  );
  if (lastComma > maxMessageLength * 0.5) {
    return truncated.substring(0, lastComma) + '…';
  }

  return truncated + '…';
}

export async function callAI(aiId, persona, userMessage, recentMessages, responseType, userProfile = null, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = [], userId = null, userAgents = null) {
  let effectivePersona = persona;
  if (userId) {
    const customPersona = await getUserCustomPersona(userId, aiId);
    if (customPersona) {
      effectivePersona = {
        ...persona,
        ...customPersona,
        modelConfig: { ...(persona.modelConfig || {}), ...(customPersona.modelConfig || {}) },
        responseConfig: { ...(persona.responseConfig || {}), ...(customPersona.responseConfig || {}) },
        socialConfig: { ...(persona.socialConfig || {}), ...(customPersona.socialConfig || {}) },
        debateConfig: { ...(persona.debateConfig || {}), ...(customPersona.debateConfig || {}) }
      };
    }
  }

  const config = aiConfigs[aiId];

  // 应用用户自定义API配置
  let effectiveConfig = config;
  if (userId && config) {
    const userApiConfig = await getUserApiConfigForModel(userId, aiId);
    if (userApiConfig) {
      effectiveConfig = { ...config };
      if (userApiConfig.apiKey) {
        effectiveConfig.apiKey = userApiConfig.apiKey;
      }
      if (userApiConfig.baseUrl) {
        effectiveConfig.endpoint = userApiConfig.baseUrl;
      }
    }
  }

  if (!effectiveConfig || !effectiveConfig.apiKey) {
    safeLog('warn', `AI ${aiId} 配置不存在，使用模拟回复`, { apiKey: effectiveConfig?.apiKey || '' });
    return getMockResponse(aiId, effectivePersona, responseType, recentMessages);
  }

  const maxRetries = 5;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const startTime = Date.now();

    try {
      const response = await callStandardAPI(effectiveConfig, effectivePersona, userMessage, recentMessages, responseType, userProfile, replyToMessages, feedbackInfo, groupMembers, isPrivateChat, privateChatHistory, userAgents);

      const normalizedResponse = normalizeResponse(response);

      if (!normalizedResponse || normalizedResponse.trim().length === 0) {
        throw new Error(`AI ${aiId} returned empty normalized response on attempt ${attempt + 1}`);
      }

      if (recentMessages && recentMessages.length > 0) {
        const recentOtherMessages = recentMessages
          .filter(m => m.sender_id !== aiId && m.sender_type === 'ai')
          .slice(-3);

        for (const prevMsg of recentOtherMessages) {
          const prevContent = prevMsg.content || '';
          if (prevContent.length > 20) {
            const similarity = calculateSimilarity(normalizedResponse, prevContent);
            if (similarity > 0.7) {
              safeLog('warn', `[去重警告] AI ${aiId} 的回复与 ${prevMsg.sender_id} 的消息相似度过高，可能存在复制行为`, { similarity: similarity.toFixed(2) });
              break;
            }
          }
        }
      }

      const responseTime = Date.now() - startTime;

      try {
        const relevanceScore = aiLoadBalancer.calculateRelevanceScore(userMessage, normalizedResponse);
        aiLoadBalancer.recordSuccess(aiId, responseTime, relevanceScore);
      } catch (metricsError) {
        safeLog('warn', '记录指标失败', { error: metricsError?.message || metricsError });
      }

      try {
        checkResponseRelevance(userMessage, normalizedResponse);
      } catch (e) {
      }

      aiHealthStatus.set(aiId, { status: 'healthy', lastCheck: Date.now(), error: null, responseTime });

      return normalizedResponse;

    } catch (error) {
      lastError = error;
      const responseTime = Date.now() - startTime;

      const status = error.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        safeLog('warn', `AI ${aiId} 客户端错误(${status})，不重试`, { error: error.message });
        break;
      }

      try {
        aiLoadBalancer.recordFailure(aiId, error);
      } catch (metricsError) {
        safeLog('warn', '记录失败指标失败', { error: metricsError?.message || metricsError });
      }

      if (attempt < maxRetries - 1) {
        const delay = status === 429 ? 2000 * (attempt + 1) : 500 * Math.pow(2, attempt);
        safeLog('warn', `AI ${aiId} 调用失败(第${attempt + 1}次)，${delay}ms后重试`, { error: error.message });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  aiHealthStatus.set(aiId, { status: 'unhealthy', lastCheck: Date.now(), error: lastError?.message, responseTime: 0 });
  safeLog('warn', `AI ${aiId} 所有重试失败，使用模拟回复`, { error: lastError?.message });

  return getMockResponse(aiId, effectivePersona, responseType, recentMessages);
}

async function checkAIHealth(aiId) {
  const config = aiConfigs[aiId];
  if (!config || !config.enabled) {
    aiHealthStatus.set(aiId, { status: 'unhealthy', lastCheck: Date.now(), error: '模型未启用或配置不存在', responseTime: 0 });
    return false;
  }

  if (config.skipHealthCheck) {
    aiHealthStatus.set(aiId, { status: 'healthy', lastCheck: Date.now(), error: null, responseTime: 0 });
    return true;
  }

  aiHealthStatus.set(aiId, { status: 'checking', lastCheck: Date.now(), error: null, responseTime: 0 });

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const requestBody = config.isTTS
      ? {
        model: config.model,
        modalities: ['text', 'audio'],
        audio: {
          voice: 'mimo_default',
          format: 'wav'
        },
        messages: [
          { role: 'user', content: '请将下一条 assistant 消息转成语音。' },
          { role: 'assistant', content: '你好' }
        ],
        stream: false
      }
      : {
        model: config.model,
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 5,
        temperature: 0
      };

    await axios.post(config.endpoint, requestBody, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      timeout: 20000
    });

    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    aiHealthStatus.set(aiId, { status: 'healthy', lastCheck: Date.now(), error: null, responseTime });
    return true;
  } catch (error) {
    const responseTime = Date.now() - startTime;
    aiHealthStatus.set(aiId, { status: 'unhealthy', lastCheck: Date.now(), error: error.message, responseTime });
    safeLog('warn', `AI ${aiId} 健康检查失败`, { error: error.message });
    return false;
  }
}

async function checkAllAIHealth() {
  const results = {};
  const promises = Object.keys(aiConfigs).map(async (aiId) => {
    results[aiId] = await checkAIHealth(aiId);
    safeLog('info', `AI ${aiId} 健康状态: ${results[aiId] ? '正常' : '异常'}`);
  });

  await Promise.allSettled(promises);
  return results;
}

function checkResponseRelevance(userMessage, aiResponse) {
  const stopWords = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '他', '她', '它', '们', '什么', '怎么', '如何', '为什么', '哪', '哪个', '吗', '呢', '吧', '啊', '哦', '嗯']);

  const userKeywords = userMessage
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w));

  if (userKeywords.length === 0) return 1.0;

  const responseLower = aiResponse.toLowerCase();
  const matchedKeywords = userKeywords.filter(kw => responseLower.includes(kw.toLowerCase()));

  const score = matchedKeywords.length / userKeywords.length;

  if (score < 0.3) {
    safeLog('warn', `[相关性警告] AI回复可能与用户问题不相关`, { score: score.toFixed(2) });
    safeLog('warn', '用户关键词', { keywords: userKeywords.join(', ') });
    safeLog('warn', '匹配关键词', { keywords: matchedKeywords.join(', ') });
  }

  return score;
}

// 行首"[发送者名]:" 标签清洗白名单 —— 动态从 AI_NAMES 构建,避免名字遗漏或新增AI后失配
const SENDER_LABEL_PATTERN = (() => {
  const names = Object.values(AI_NAMES || {})
    .map(n => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean);
  // 兜底手动补充若干常见自称
  names.push('用户', '我');
  return new RegExp(`^\\[(${names.join('|')})\\]\\s*`, 'gm');
})();

function normalizeResponse(content) {
  if (!content || typeof content !== 'string') return content;

  let normalized = content;
  normalized = normalized.replace(/\r\n/g, '\n');
  normalized = normalized.replace(/\r/g, '\n');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');

  // 去掉行首的"[发送者名称]:" 标签(用动态白名单,与 AI_NAMES 保持同步)
  normalized = normalized.replace(SENDER_LABEL_PATTERN, '');

  normalized = normalized.replace(/^【[^】]*】\s*/gm, '');

  normalized = normalized.replace(/^(?:我|作为\w+?)[：:]\s*/gm, '');

  const thinkMatch = normalized.match(/<think[^>]*>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    const thinkContent = thinkMatch[1].trim();
    normalized = normalized.replace(/<think[^>]*>[\s\S]*?<\/think>/g, '');
    if (normalized.trim().length === 0 && thinkContent.length > 0) {
      normalized = thinkContent;
    }
  }
  normalized = normalized.replace(/<think[^>]*>[\s\S]*?<\/think>/g, '');

  normalized = normalized.trim();

  return normalized;
}

async function callStandardAPI(config, persona, userMessage, recentMessages, responseType, userProfile, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = [], userAgents = []) {
  const systemPrompt = buildSystemPrompt(persona, recentMessages, userProfile, replyToMessages, feedbackInfo, groupMembers, isPrivateChat, privateChatHistory, userAgents);
  const messages = buildAPIMessages(systemPrompt, userMessage, recentMessages, persona, replyToMessages, isPrivateChat, userProfile);

  const params = config.params || {};
  const modelConfig = persona?.modelConfig || {};
  const effectiveTemperature = modelConfig.temperature ?? params.temperature ?? 0.7;
  const effectiveMaxTokens = modelConfig.maxTokens ?? params.max_tokens ?? 1500;
  const effectiveTopP = modelConfig.topP ?? params.top_p ?? 0.9;
  const effectiveFreqPenalty = modelConfig.frequencyPenalty ?? params.frequency_penalty;
  const effectivePresPenalty = modelConfig.presencePenalty ?? params.presence_penalty;

  const requestBody = {
    model: config.model,
    messages,
    max_tokens: effectiveMaxTokens,
    temperature: effectiveTemperature,
    top_p: effectiveTopP
  };

  if (effectiveFreqPenalty !== undefined) {
    requestBody.frequency_penalty = effectiveFreqPenalty;
  }
  if (effectivePresPenalty !== undefined) {
    requestBody.presence_penalty = effectivePresPenalty;
  }

  if (config.note && config.note.includes('不支持temperature')) {
    delete requestBody.temperature;
    delete requestBody.top_p;
    delete requestBody.frequency_penalty;
    delete requestBody.presence_penalty;
  }

  const response = await axios.post(config.endpoint, requestBody, {
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 60000
  });

  if (!response.data?.choices?.[0]?.message) {
    throw new Error('AI API返回了无效响应格式');
  }

  let content = response.data.choices[0].message.content;

  if (!content || content.trim().length === 0) {
    if (response.data.choices[0].reasoning_content) {
      content = response.data.choices[0].reasoning_content;
    }
  }

  if (!content || content.trim().length === 0) {
    const choice = response.data.choices[0];
    if (choice.message && choice.message.tool_calls) {
      const toolContent = choice.message.tool_calls
        .map(tc => tc.function?.arguments || '')
        .filter(a => a.length > 0)
        .join('\n');
      if (toolContent.length > 0) {
        content = toolContent;
      }
    }
  }

  if (!content || content.trim().length === 0) {
    const rawResponse = JSON.stringify(response.data.choices[0]);
    safeLog('warn', `AI ${config.model} returned empty content`, { raw: rawResponse.substring(0, 500) });
    throw new Error(`AI ${config.model} returned empty response`);
  }

  return content;
}

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = text.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(chineseChars * 1.5 + englishWords);
}

// 更精确的token估算，用于关键场景
function estimateTokensPrecise(text) {
  if (!text || typeof text !== 'string') return 0;
  // 基于字节对编码(BPE)的粗略估算
  // 中文：约1.5 tokens/字
  // 英文：约0.25 tokens/字符
  // 代码/标点：约0.5 tokens/字符
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishText = text.replace(/[\u4e00-\u9fff]/g, '');
  const codeChars = (englishText.match(/[{}()[\];,.'"+=\-*/<>!&|]/g) || []).length;
  const normalEnglishChars = englishText.length - codeChars;
  return Math.ceil(chineseChars * 1.5 + normalEnglishChars * 0.25 + codeChars * 0.5);
}

function generateSummary(messages) {
  const grouped = {};
  for (const msg of messages) {
    const sender = msg.sender_type === 'user' ? '用户' : (msg.sender_id || 'AI');
    if (!grouped[sender]) grouped[sender] = [];
    grouped[sender].push(msg.content || '');
  }
  const summaries = [];
  for (const [sender, contents] of Object.entries(grouped)) {
    const keyPoints = contents.join(' ').substring(0, 200);
    summaries.push(`${sender}主要说了: ${keyPoints}`);
  }
  return summaries.join('\n');
}

function buildAttachmentHint(attachments, hasTextContent) {
  if (!attachments || attachments.length === 0) return '';
  const attParts = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const fname = att.name || att.filename || '未知文件';
    const ext = fname.includes('.') ? fname.split('.').pop().toLowerCase() : '';
    let typeLabel = '文件';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext) || (att.type && att.type.startsWith('image/'))) {
      typeLabel = '图片';
    } else if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'].includes(ext) || (att.type && att.type.startsWith('audio/'))) {
      typeLabel = '音频';
    } else if (['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv'].includes(ext) || (att.type && att.type.startsWith('video/'))) {
      typeLabel = '视频';
    } else if (['pdf'].includes(ext) || (att.type && att.type.includes('pdf'))) {
      typeLabel = 'PDF文档';
    } else if (['doc', 'docx'].includes(ext)) {
      typeLabel = 'Word文档';
    } else if (['xls', 'xlsx', 'csv'].includes(ext)) {
      typeLabel = '表格';
    } else if (['ppt', 'pptx'].includes(ext)) {
      typeLabel = 'PPT演示';
    } else if (['py', 'js', 'ts', 'java', 'c', 'cpp', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sql', 'html', 'css', 'vue', 'svelte'].includes(ext)) {
      typeLabel = '代码文件';
    }

    const desc = att.media_description || att.search_description || '';
    const parsedContent = att.parsed_content || '';
    if (desc) {
      attParts.push(`附件${i + 1}(${typeLabel}: ${fname}): ${desc}`);
    } else if (parsedContent && typeof parsedContent === 'string' && parsedContent.length > 0) {
      const snippet = parsedContent.substring(0, 500);
      attParts.push(`附件${i + 1}(${typeLabel}: ${fname}) 内容摘要:\n${snippet}`);
    } else {
      attParts.push(`附件${i + 1}(${typeLabel}: ${fname})`);
    }
  }
  if (attParts.length === 0) return '';
  if (hasTextContent) {
    return `\n【用户上传的附件内容】\n${attParts.join('\n')}\n【附件内容结束，以下是用户的文字消息】`;
  }
  return `\n【用户上传的附件内容】\n${attParts.join('\n')}\n【附件内容结束】`;
}

function buildAPIMessages(systemPrompt, userMessage, recentMessages, persona, replyToMessages = [], isPrivateChat = false, userProfile = null) {
  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  const contextLimit = 1000;
  const contextSlice = recentMessages.slice(-contextLimit);

  let totalTokens = estimateTokensPrecise(systemPrompt) + estimateTokensPrecise(userMessage);
  const maxTokens = 80000;

  let cutoffIndex = 0;
  for (let i = 0; i < contextSlice.length; i++) {
    totalTokens += estimateTokensPrecise(contextSlice[i].content || '');
    if (totalTokens > maxTokens) {
      cutoffIndex = i;
      break;
    }
  }

  if (cutoffIndex > 0) {
    const truncatedMessages = contextSlice.slice(0, cutoffIndex);
    const summary = generateSummary(truncatedMessages);
    messages.push({ role: 'user', content: `[更早的对话摘要]\n${summary}` });
  }

  const effectiveMessages = cutoffIndex > 0 ? contextSlice.slice(cutoffIndex) : contextSlice;

  let lastUserMsgId = null;
  for (let i = effectiveMessages.length - 1; i >= 0; i--) {
    if (effectiveMessages[i].sender_type === 'user') {
      lastUserMsgId = effectiveMessages[i].id;
      break;
    }
  }

  let lastUserMsgAttachmentHint = '';
  for (let i = 0; i < effectiveMessages.length; i++) {
    const msg = effectiveMessages[i];
    let content = msg.content || '';
    const msgId = msg.id;

    if (msg.sender_type === 'user' && msgId === lastUserMsgId && content === userMessage) {
      lastUserMsgAttachmentHint = buildAttachmentHint(msg.attachments, !!(userMessage && userMessage.trim().length > 0));
      continue;
    }

    // 改进的引用回复处理 - 标准化的引用格式
    let replyHint = '';
    if (msg.reply_to) {
      const replyMsg = effectiveMessages.find(m => m.id === msg.reply_to);
      if (replyMsg) {
        const replySenderName = replyMsg.sender_type === 'user'
          ? (userProfile?.nickname || '用户')
          : (AI_NAMES[replyMsg.sender_id] || replyMsg.sender_id || 'AI');
        const replyContentPreview = (replyMsg.content || '').substring(0, 100);
        if (isPrivateChat) {
          replyHint = `\n「引用回复 - ${replySenderName}：${replyContentPreview}${replyMsg.content?.length > 100 ? '...' : ''}」`;
        } else {
          replyHint = `\n「引用 @${replySenderName}：${replyContentPreview}${replyMsg.content?.length > 100 ? '...' : ''}」`;
        }
      }
    }

    // 为所有消息包含附件内容（parsed_content, media_description）
    let attachmentHint = buildAttachmentHint(msg.attachments, !!(content && content.trim().length > 0));

    const fullContent = content + attachmentHint;

    if (msg.sender_type === 'user') {
      if (isPrivateChat) {
        messages.push({ role: 'user', content: fullContent + replyHint });
      } else {
        const userName = userProfile?.nickname || '用户';
        messages.push({ role: 'user', content: `[${userName}]: ${fullContent}${replyHint}` });
      }
    } else if (msg.sender_type === 'ai' && msg.sender_id === persona.id) {
      // 自己的消息也包含附件提示
      messages.push({ role: 'assistant', content: fullContent + replyHint });
    } else if (msg.sender_type === 'ai') {
      const aiName = AI_NAMES[msg.sender_id] || msg.sender_id || 'AI';
      const truncated = fullContent.substring(0, 300) + (fullContent.length > 300 ? '...' : '');
      messages.push({ role: 'user', content: `[${aiName}]: ${truncated}${replyHint}` });
    } else {
      messages.push({ role: 'user', content: fullContent + replyHint });
    }
  }

  // 优化的引用回复消息处理
  if (replyToMessages && replyToMessages.length > 0) {
    const quotedContents = replyToMessages.map(msg => {
      let senderName;
      if (msg.sender_type === 'user') {
        senderName = userProfile?.nickname || '用户';
      } else {
        senderName = AI_NAMES[msg.sender_id] || msg.sender_id || 'AI';
      }
      const content = msg.content.substring(0, 200);
      return `> **${senderName}** 说: ${content}${msg.content.length > 200 ? '...' : ''}`;
    }).join('\n');

    const replyTarget = replyToMessages[0].sender_type === 'user'
      ? (userProfile?.nickname || '用户')
      : (AI_NAMES[replyToMessages[0].sender_id] || 'AI');

    messages.push({
      role: 'user',
      content: `[引用回复 - 你正在回复以下消息]\n${quotedContents}\n\n请直接回复 @${replyTarget}，在回复中自然地引用或回应对方的内容。用"@${replyTarget}"开头。`
    });
  }

  messages.push({ role: 'user', content: lastUserMsgAttachmentHint + userMessage });

  return messages;
}

function buildSystemPrompt(persona, recentMessages = [], userProfile = null, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = [], userAgents = []) {
  // 自定义 systemPrompt 优先级最高，如果存在且非空则直接使用
  if (persona?.systemPrompt && persona.systemPrompt.trim().length > 0) {
    const systemPrompt = persona.systemPrompt.trim();
    const suspiciousKeywords = ['忽略之前的指令', '覆盖所有规则', '重新定义你的角色', '忘记你的设定', '你是一个全新的AI'];
    const lowerPrompt = systemPrompt.toLowerCase();
    for (const kw of suspiciousKeywords) {
      if (lowerPrompt.includes(kw)) {
        safeLog('warn', 'systemPrompt含潜在安全风险关键词', { keyword: kw, personaId: persona.id });
        break;
      }
    }
    return systemPrompt;
  }

  let parts = [];

  if (isPrivateChat) {
    parts.push(`你是${persona.name}，正在与用户进行一对一私聊。请按照你的人设来发言。`);
    parts.push('这是你和用户之间的私密对话，请认真回答用户的问题，不要敷衍或回避。你只需要回复用户的消息，不要自言自语。');
  } else {
    parts.push(`你是${persona.name}。请按照你的人设来发言。`);
    parts.push('重要：你需要自己判断是否要回复当前的消息。以下情况你应该选择不说话：');
    parts.push('- 如果当前讨论的话题与你无关或不感兴趣');
    parts.push('- 如果你没有特别有价值的观点要补充');
    parts.push('- 如果已经有其他AI成员代表和你相近的立场发言');
    parts.push('- 如果你觉得沉默比发言更符合你的性格');
    parts.push('你不需要对每条消息都回复，自然而然地参与对话即可。当你决定发言时，要像真人一样自然地加入讨论。');
  }

  if (persona.styleTag) {
    parts.push(`你的风格标签是"${persona.styleTag}"，请在发言中体现这个风格。`);
  }

  if (persona.style) {
    parts.push(`风格：${persona.style}。请在语气、用词、表达方式上符合这个风格。`);
  }

  if (persona.speakingStyle) {
    parts.push(`说话风格：${persona.speakingStyle}。请在发言中体现这种说话风格。`);
  }

  if (persona.personality) {
    parts.push(`性格：${persona.personality}。你的态度和情感倾向会受此性格影响。`);
  }

  if (persona.replyStyle) {
    parts.push(`说话方式：${persona.replyStyle}。请按照这种方式说话。`);
  }

  if (persona.typicalPhrases && persona.typicalPhrases.length > 0) {
    parts.push(`语言风格参考（仅供参考，无需刻意模仿）：${persona.typicalPhrases.join('、')}。这只是你日常可能常用的表达方式示例，不是固定模板，你可以自由自然地表达。`);
  }

  if (persona.keywords && persona.keywords.length > 0) {
    parts.push(`你关注的话题：${persona.keywords.join('、')}。当聊天涉及这些话题时，可以更积极地发言。`);
  }

  if (persona.firstSpeakerTopics && persona.firstSpeakerTopics.length > 0) {
    parts.push(`你擅长发起的话题：${persona.firstSpeakerTopics.join('、')}。当群聊冷场或话题相关时，可以主动提出这些话题。`);
  }

  if (persona.expertise && persona.expertise.length > 0) {
    parts.push(`你擅长的领域：${persona.expertise.join('、')}。涉及这些领域时，可以展现专业深度。`);
  }

  if (persona.interests && persona.interests.length > 0) {
    parts.push(`你感兴趣的话题：${persona.interests.join('、')}。讨论这些话题时你会更加活跃，愿意分享观点。`);
  }

  if (persona.speakingTraits) {
    parts.push(`你的说话特点：${persona.speakingTraits}。`);
  }

  if (persona.debateTendency) {
    const debateGuide = {
      low: '你的辩论倾向是温和型，倾向于赞同和附和他人，避免激烈争论。',
      medium: '你的辩论倾向是平衡型，会理性地表达不同意见，既不回避也不激进。',
      high: '你的辩论倾向是激进型，会主动反驳和质疑，热衷于激烈辩论。'
    };
    if (debateGuide[persona.debateTendency]) {
      parts.push(debateGuide[persona.debateTendency]);
    }
  }

  if (persona.questionProbability && persona.questionProbability > 0.3) {
    parts.push('你会在回复中主动提出问题来引导讨论方向。');
  }

  if (persona.messageLength) {
    const lengthGuide = {
      short: '请将回复控制在50-150字以内，简短精炼。',
      medium: '请将回复控制在150-300字左右，表达清晰完整。',
      long: '请写300-500字的详细回复，深入分析，充分展开。'
    };
    parts.push(lengthGuide[persona.messageLength] || '');
  }

  if (persona.preferredRole && persona.preferredRole !== 'analyst') {
    const roleGuide = {
      expert: '你以专家身份发言，提供权威解答和深入分析。',
      student: '你以学习者身份发言，谦虚提问，共同探讨。',
      critic: '你以评论家身份发言，用批判性思维指出问题。',
      mediator: '你以调解者身份发言，平衡各方观点，化解分歧。',
      innovator: '你以创新者身份发言，提出新想法，突破常规。',
      supporter: '你以支持者身份发言，鼓励肯定，提供帮助。',
      challenger: '你以挑战者身份发言，提出质疑，激发思考。',
      teacher: '你以导师身份发言，循循善诱，启发思考。',
      storyteller: '你以故事家身份发言，善用故事和比喻表达。',
      pragmatist: '你以实用主义者身份发言，注重实际，追求效率。',
      philosopher: '你以哲学家身份发言，深度思考，追求本质。',
      humorist: '你以幽默家身份发言，风趣幽默，活跃气氛。',
      skeptic: '你以怀疑论者身份发言，理性怀疑，追求真相。',
      optimist: '你以乐观主义者身份发言，积极向上，充满希望。',
      realist: '你以现实主义者身份发言，客观冷静，直面现实。',
      custom: persona.customRoleName ? `你的角色定位：${persona.customRoleName}。` : ''
    };
    if (roleGuide[persona.preferredRole]) {
      parts.push(roleGuide[persona.preferredRole]);
    }
  }

  const socialConfig = persona.socialConfig || {};
  if (socialConfig.enableQuoting) {
    const quoteProb = socialConfig.quoteProbability ?? 0.4;
    const maxQuotes = socialConfig.maxQuotesPerMessage ?? 2;
    if (quoteProb > 0.5) {
      parts.push(`你经常引用别人的消息来回复，使用格式 "> 对方名字: 对方说的话" 来引用。每次最多引用${maxQuotes}条消息。`);
    } else if (quoteProb > 0.2) {
      parts.push(`你可以在合适时引用别人的消息来回复，使用格式 "> 对方名字: 对方说的话" 来引用。每次最多引用${maxQuotes}条消息。`);
    }
  }

  // 注入 responseConfig 中的参数信息
  const responseConfig = persona.responseConfig || {};
  if (responseConfig.enabled === false) {
    parts.push('注意：你当前处于静默模式，请尽量少发言或保持沉默。');
  } else if (responseConfig.responseFrequency !== undefined) {
    if (responseConfig.responseFrequency > 0.8) {
      parts.push('你是一个活跃的聊天参与者，倾向于积极地参与各种话题的讨论。');
    } else if (responseConfig.responseFrequency > 0.5) {
      parts.push('你会适度参与群聊讨论，在有价值的话题上发言。');
    } else if (responseConfig.responseFrequency > 0.2) {
      parts.push('你较为安静，只在特别感兴趣的话题上发言。');
    } else {
      parts.push('你很少主动发言，通常只在被直接提到时才回应。');
    }
  }

  // 注入 modelConfig 参数提示
  const modelConfig = persona.modelConfig || {};
  if (modelConfig.temperature !== undefined) {
    if (modelConfig.temperature > 0.8) {
      parts.push('你的回复风格偏向创造性，可以适度发挥想象力和创造性思维。');
    } else if (modelConfig.temperature < 0.3) {
      parts.push('你的回复风格偏向严谨精确，请保持回答的准确性和一致性。');
    }
  }

  if (!isPrivateChat) {
    parts.push('当前场景：这是一个多人群聊，你是群聊中的一名AI成员。群聊中有真实用户和其他AI成员同时参与讨论。');
    parts.push('群聊核心规则：');
    parts.push('1. 每条消息前都有发送者名称标记，格式为"[发送者名称]: 消息内容"。标题行"[最近的群聊消息]"下面就是群里的实际对话记录。');
    parts.push('2. 标记为"用户"（或用户昵称）的消息来自真实用户，你需要特别关注并真诚回应。标记为其他名称（如"deepseek-v4-flash"、"GLM-4.5-Air"等）的消息来自其他AI成员。');
    parts.push('3. 当你回复某人的消息时，必须用"@"+对方名字明确指出你在回复谁，例如"@用户"回复用户，或"@deepseek-v4-flash"回应另一个AI。');
    parts.push('4. 如果你在引用某人的消息，请用"> 对方名字: 对方说的话"的格式引用。');
    parts.push('5. 严禁把不同人说的话混淆。不要把用户的消息当成其他AI的，也不要把其他AI的消息当成用户的。');
    parts.push('6. 对于用户的消息，你应该认真、真诚地回应，帮助用户解决问题或参与讨论。对于其他AI的消息，你可以赞同、补充、反驳或忽略，取决于你的人设和话题相关性。');
    parts.push('7. 你不是唯一在说话的AI——还有其他AI同时参与讨论。关注其他AI的发言，但不能直接替其他AI说话。');
  }

  if (!isPrivateChat && groupMembers && groupMembers.length > 0) {
    const otherMembers = groupMembers.filter(id => id !== persona.id);
    // 注入【关系感知】:让 AI 知道它和每个其他成员的关系,从而分清彼此
    if (otherMembers.length > 0) {
      const relationshipLines = otherMembers.map(id => {
        const otherName = AI_NAMES[id] || id;
        const rel = getEffectiveRelationship(persona.id, id, persona);
        const stanceText = rel.stance === 'ally' ? '友好' : rel.stance === 'rival' ? '对立' : '中立';
        const tendencyText = rel.stance === 'ally'
          ? '倾向支持、附和Ta'
          : rel.stance === 'rival'
            ? '倾向反驳、质疑Ta'
            : '保持客观';
        const noteText = rel.note ? `(${rel.note})` : '';
        return `- ${otherName}:关系【${stanceText}】,亲和度${rel.affinity.toFixed(1)},${tendencyText}${noteText}`;
      });
      parts.push(`【你与群成员的关系】\n你必须根据以下关系来决定对每个人的态度和回应方式:\n${relationshipLines.join('\n')}`);
    }
    const memberNames = groupMembers.map(id => AI_NAMES[id] || id);
    parts.push(`群聊成员：${memberNames.join('、')}`);
    // 注入【随机发言指引】
    parts.push('【发言方式】这是自由流动的群聊,没有固定发言顺序。你凭自己的感觉决定是否加入对话:可以中途插话、可以保持沉默、可以连续发言,也可以只回复特定的人。不要为了说话而说话,只在你想说的时候说。');
  }

  if (recentMessages && recentMessages.length > 0) {
    const contextLimit = isPrivateChat ? 30 : 15;
    const contextMessages = recentMessages.slice(-contextLimit);
    const chatType = isPrivateChat ? '私聊历史记录' : '最近的群聊消息';
    const history = contextMessages.map(m => {
      let sender;
      if (m.sender_type === 'user') {
        sender = userProfile?.nickname || '用户';
      } else {
        sender = AI_NAMES[m.sender_id] || m.sender_id || 'AI';
      }
      const content = m.content.substring(0, 200);
      return `${sender}: ${content}${m.content.length > 200 ? '...' : ''}`;
    }).join('\n');
    parts.push(`\n【${chatType}】\n${history}`);
  }

  if (!isPrivateChat && privateChatHistory && privateChatHistory.length > 0) {
    const recentPrivate = privateChatHistory.slice(-20);
    const privateHistory = recentPrivate.map(m => {
      const sender = m.sender_type === 'user' ? (userProfile?.nickname || '用户') : '你';
      const content = m.content.substring(0, 150);
      return `${sender}: ${content}${m.content.length > 150 ? '...' : ''}`;
    }).join('\n');
    parts.push(`\n【你与用户的私聊记忆】\n${privateHistory}`);
  }

  if (userProfile) {
    const fields = [];
    const line1Parts = [];
    if (userProfile.nickname) line1Parts.push(`昵称：${userProfile.nickname}`);
    if (userProfile.gender) line1Parts.push(`性别：${userProfile.gender}`);
    if (userProfile.age) line1Parts.push(`年龄：${userProfile.age}`);
    if (userProfile.occupation) line1Parts.push(`职业：${userProfile.occupation}`);
    if (userProfile.education) line1Parts.push(`学历：${userProfile.education}`);
    if (line1Parts.length > 0) fields.push(line1Parts.join(' | '));
    const line2Parts = [];
    if (userProfile.hobbies) line2Parts.push(`爱好：${Array.isArray(userProfile.hobbies) ? userProfile.hobbies.join('、') : userProfile.hobbies}`);
    if (userProfile.personality) line2Parts.push(`性格：${userProfile.personality}`);
    if (line2Parts.length > 0) fields.push(line2Parts.join(' | '));
    if (userProfile.goal) fields.push(`目标：${userProfile.goal}`);
    if (userProfile.bio) fields.push(`自我介绍：${userProfile.bio}`);
    if (fields.length > 0) {
      parts.push(`\n【用户画像】\n${fields.join('\n')}`);
    }
  }

  if (replyToMessages && replyToMessages.length > 0) {
    const quotedContents = replyToMessages.map(msg => {
      let senderName;
      if (msg.sender_type === 'user') {
        senderName = userProfile?.nickname || '用户';
      } else {
        senderName = AI_NAMES[msg.sender_id] || msg.sender_id || 'AI';
      }
      const content = msg.content.substring(0, 200);
      return `> ${senderName}: ${content}${msg.content.length > 200 ? '...' : ''}`;
    }).join('\n');
    parts.push(`\n【你正在回复的消息】\n${quotedContents}\n请明确回复这条消息的发送者，使用"@${replyToMessages[0].sender_type === 'user' ? (userProfile?.nickname || '用户') : (AI_NAMES[replyToMessages[0].sender_id] || 'AI')}"来指明你在回复谁。`);
  }

  if (feedbackInfo) {
    parts.push(`\n【你的消息反馈】你最近的一条消息收到了 ${feedbackInfo.likes || 0} 个赞和 ${feedbackInfo.dislikes || 0} 个踩。`);
  }

  if (!isPrivateChat && userAgents && userAgents.length > 0) {
    const agentList = userAgents.map(agent =>
      `- 智能体名称: ${agent.name}，功能: ${agent.description}，ID: ${agent.id}`
    ).join('\n');
    parts.push(`\n【用户创建的智能体】\n你可以调用以下用户创建的智能体来辅助回答问题。当判断需要调用智能体时，在回复中插入标记 [CALL_AGENT:智能体ID]，系统会自动执行智能体并将结果整合到你的回复中。\n${agentList}`);
  }

  return parts.join('\n');
}

const activeStreams = new Map();

if (process.env.NODE_ENV !== 'test') {
  const streamCleanupTimer = setInterval(() => {
    const maxAge = 10 * 60 * 1000;
    const now = Date.now();
    for (const [streamId, entry] of activeStreams.entries()) {
      const createdAt = entry._createdAt || 0;
      if (now - createdAt > maxAge) {
        try { entry.abort(); } catch { }
        activeStreams.delete(streamId);
        safeLog('info', '清理超时流', { streamId });
      }
    }
  }, 60 * 1000);

  if (typeof streamCleanupTimer.unref === 'function') {
    streamCleanupTimer.unref();
  }
}

export function cancelStream(streamId) {
  if (streamId && activeStreams.has(streamId)) {
    const controller = activeStreams.get(streamId);
    controller.abort();
    activeStreams.delete(streamId);
  }
}

export async function callAIStream(aiId, persona, userMessage, recentMessages, responseType, userProfile = null, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = [], customPrompt = null, groupOperations = [], onChunk = null, streamId = null, userId = null, userAgents = null) {
  let effectivePersona = persona;
  if (userId) {
    const customPersona = await getUserCustomPersona(userId, aiId);
    if (customPersona) {
      effectivePersona = {
        ...persona,
        ...customPersona,
        modelConfig: { ...(persona.modelConfig || {}), ...(customPersona.modelConfig || {}) },
        responseConfig: { ...(persona.responseConfig || {}), ...(customPersona.responseConfig || {}) },
        socialConfig: { ...(persona.socialConfig || {}), ...(customPersona.socialConfig || {}) },
        debateConfig: { ...(persona.debateConfig || {}), ...(customPersona.debateConfig || {}) }
      };
    }
  }

  const config = aiConfigs[aiId];

  // 应用用户自定义API配置
  let effectiveConfig = config;
  if (userId && config) {
    const userApiConfig = await getUserApiConfigForModel(userId, aiId);
    if (userApiConfig) {
      effectiveConfig = { ...config };
      if (userApiConfig.apiKey) {
        effectiveConfig.apiKey = userApiConfig.apiKey;
      }
      if (userApiConfig.baseUrl) {
        effectiveConfig.endpoint = userApiConfig.baseUrl;
      }
    }
  }

  if (!effectiveConfig || !effectiveConfig.apiKey) {
    const mockResponse = getMockResponse(aiId, effectivePersona, responseType, recentMessages);
    if (onChunk) {
      const words = mockResponse.split('');
      for (let i = 0; i < words.length; i++) {
        onChunk(words[i]);
        await new Promise(r => setTimeout(r, 30));
      }
    }
    return mockResponse;
  }

  const systemPrompt = customPrompt || buildSystemPrompt(effectivePersona, recentMessages, userProfile, replyToMessages, feedbackInfo, groupMembers, isPrivateChat, privateChatHistory, userAgents || []);
  const messages = buildAPIMessages(systemPrompt, userMessage, recentMessages, effectivePersona, replyToMessages, isPrivateChat, userProfile);

  const modelConfig = effectivePersona?.modelConfig || {};
  const effectiveTemperature = modelConfig.temperature ?? effectivePersona?.temperature ?? effectiveConfig.params?.temperature ?? 0.7;
  const effectiveMaxTokens = modelConfig.maxTokens ?? effectivePersona?.maxTokens ?? effectiveConfig.params?.max_tokens ?? 1500;
  const effectiveTopP = modelConfig.topP ?? effectiveConfig.params?.top_p ?? 0.9;
  const effectiveFreqPenalty = modelConfig.frequencyPenalty ?? effectiveConfig.params?.frequency_penalty;
  const effectivePresPenalty = modelConfig.presencePenalty ?? effectiveConfig.params?.presence_penalty;

  const controller = new AbortController();
  controller._createdAt = Date.now();
  if (streamId) {
    activeStreams.set(streamId, controller);
  }

  try {
    const requestBody = {
      model: effectiveConfig.model,
      messages,
      stream: true,
      temperature: effectiveTemperature,
      max_tokens: effectiveMaxTokens,
      top_p: effectiveTopP
    };
    if (effectiveFreqPenalty !== undefined) requestBody.frequency_penalty = effectiveFreqPenalty;
    if (effectivePresPenalty !== undefined) requestBody.presence_penalty = effectivePresPenalty;
    if (effectiveConfig.note && effectiveConfig.note.includes('不支持temperature')) {
      delete requestBody.temperature;
      delete requestBody.top_p;
      delete requestBody.frequency_penalty;
      delete requestBody.presence_penalty;
    }

    const response = await axios.post(effectiveConfig.endpoint, requestBody, {
      headers: {
        'Authorization': `Bearer ${effectiveConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream',
      signal: controller.signal,
      timeout: 120000
    });

    let fullContent = '';
    let streamTimedOut = false;

    const streamResult = new Promise((resolve, reject) => {
      const streamTimeout = setTimeout(() => {
        streamTimedOut = true;
        if (streamId) activeStreams.delete(streamId);
        try { response.data.destroy(); } catch { }
        reject(new Error('AI流式调用超时(120s)'));
      }, 120000);

      response.data.on('data', (chunk) => {
        if (streamTimedOut) return;
        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                fullContent += content;
                if (onChunk) onChunk(content);
              }
            } catch (parseError) {
              safeLog('warn', '流式SSE JSON解析失败', { raw: line ? line.substring(0, 100) : '(empty)' });
            }
          }
        }
      });

      response.data.on('end', () => {
        clearTimeout(streamTimeout);
        if (streamId) activeStreams.delete(streamId);
        resolve(fullContent);
      });

      response.data.on('error', (err) => {
        clearTimeout(streamTimeout);
        if (streamId) activeStreams.delete(streamId);
        reject(err);
      });
    });

    return streamResult;
  } catch (error) {
    if (streamId) activeStreams.delete(streamId);
    if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
      return '';
    }
    safeLog('error', `[AI流式调用错误] ${aiId}`, { error: error.message });
    const mockResponse = getMockResponse(aiId, effectivePersona, responseType, recentMessages);
    if (onChunk) {
      const words = mockResponse.match(/.{1,2}/g) || [mockResponse];
      for (let i = 0; i < words.length; i++) {
        onChunk(words[i]);
        await new Promise(r => setTimeout(r, 10));
      }
    }
    return mockResponse;
  }
}

export { aiHealthStatus, checkAIHealth, checkAllAIHealth, checkResponseRelevance, normalizeResponse, applyMessageLengthLimit };

export function buildDebateSystemPrompt(persona, debateRound, totalRounds, debateLevel, recentMessages = [], groupMembers = null, userMessage = '') {
  // 自定义 systemPrompt 优先级最高
  if (persona?.systemPrompt && persona.systemPrompt.trim().length > 0) {
    return persona.systemPrompt.trim();
  }

  let parts = [];

  parts.push(`你是${persona.name}，正在参与一场辩论。请按照你的人设来发言。`);

  if (persona.styleTag) {
    parts.push(`你的风格标签是"${persona.styleTag}"，请在辩论中体现这个风格。`);
  }

  if (persona.style) {
    parts.push(`风格：${persona.style}。请在语气、用词、论证方式上符合这个风格。`);
  }

  if (persona.speakingStyle) {
    parts.push(`说话风格：${persona.speakingStyle}。请在辩论中体现这种说话风格。`);
  }

  if (persona.personality) {
    parts.push(`性格：${persona.personality}。你的态度和论证思路会受此性格影响。`);
  }

  if (persona.replyStyle) {
    parts.push(`说话方式：${persona.replyStyle}。请按照这种方式说话。`);
  }

  if (persona.typicalPhrases && persona.typicalPhrases.length > 0) {
    parts.push(`你的口头禅：${persona.typicalPhrases.join('、')}。在辩论中可以自然地使用这些口头禅。`);
  }

  if (persona.keywords && persona.keywords.length > 0) {
    parts.push(`你关注的话题：${persona.keywords.join('、')}。当辩论涉及这些话题时，可以更积极地发言。`);
  }

  if (persona.firstSpeakerTopics && persona.firstSpeakerTopics.length > 0) {
    parts.push(`你擅长发起的话题：${persona.firstSpeakerTopics.join('、')}。当辩论陷入僵局时，可以主动提出这些话题。`);
  }

  if (persona.expertise && persona.expertise.length > 0) {
    parts.push(`你擅长的领域：${persona.expertise.join('、')}。涉及这些领域时，可以展现专业深度。`);
  }

  if (persona.interests && persona.interests.length > 0) {
    parts.push(`你感兴趣的话题：${persona.interests.join('、')}。辩论涉及这些话题时你会更加活跃。`);
  }

  if (persona.speakingTraits) {
    parts.push(`你的说话特点：${persona.speakingTraits}。`);
  }

  if (persona.debateTendency) {
    const debateGuide = {
      low: '你的辩论倾向是温和型，倾向于温和表达，寻找共识，避免过于激烈的对抗。',
      medium: '你的辩论倾向是平衡型，会平衡表达自己的观点，既坚持立场也尊重他人。',
      high: '你的辩论倾向是激进型，会非常激进地反驳对手的每一个论点。'
    };
    if (debateGuide[persona.debateTendency]) {
      parts.push(debateGuide[persona.debateTendency]);
    }
  }

  if (persona.questionProbability && persona.questionProbability > 0.3) {
    parts.push('你会在辩论中主动向对手提出尖锐的问题来引导讨论方向。');
  }

  if (persona.messageLength) {
    const lengthGuide = {
      short: '请将发言控制在50-150字以内，简短有力。',
      medium: '请将发言控制在150-300字左右，论点清晰。',
      long: '请写300-500字的详细发言，深入论证，充分展开。'
    };
    if (lengthGuide[persona.messageLength]) {
      parts.push(lengthGuide[persona.messageLength]);
    }
  }

  if (persona.preferredRole && persona.preferredRole !== 'analyst') {
    const roleGuide = {
      expert: '你以专家身份辩论，提供权威论证和深入分析。',
      student: '你以学习者身份辩论，谦虚探讨，共同进步。',
      critic: '你以评论家身份辩论，用批判性思维指出对方每一个逻辑漏洞。',
      mediator: '你以调解者身份辩论，平衡各方论点，化解分歧。',
      supporter: '你以支持者身份辩论，为队友提供有力补充和证据支持。',
      innovator: '你以创新者身份辩论，提出新颖独特的论点和角度。',
      challenger: '你以挑战者身份辩论，不断质疑对方观点，激发深层思考。',
      teacher: '你以导师身份辩论，循循善诱，用启发式提问引导对方暴露弱点。',
      storyteller: '你以故事家身份辩论，善用故事和比喻来论证。',
      pragmatist: '你以实用主义者身份辩论，用实际案例和数据说话。',
      philosopher: '你以哲学家身份辩论，从本质和底层逻辑出发论证。',
      humorist: '你以幽默家身份辩论，风趣幽默地反驳对手。',
      skeptic: '你以怀疑论者身份辩论，理性怀疑一切论点，追求真相。',
      optimist: '你以乐观主义者身份辩论，积极向上地论证，充满希望。',
      realist: '你以现实主义者身份辩论，客观冷静地分析，直面现实。',
      custom: persona.customRoleName ? `你的辩论角色定位：${persona.customRoleName}。` : ''
    };
    if (roleGuide[persona.preferredRole]) {
      parts.push(roleGuide[persona.preferredRole]);
    }
  }

  const socialConfig = persona.socialConfig || {};
  if (socialConfig.enableQuoting) {
    const quoteProb = socialConfig.quoteProbability ?? 0.4;
    if (quoteProb > 0.5) {
      parts.push('你经常引用对手的原话来反驳，使用格式 "> 对方名字: 对方说的话" 来引用。');
    } else if (quoteProb > 0.2) {
      parts.push('你可以在合适时引用对手的原话来反驳，使用格式 "> 对方名字: 对方说的话" 来引用。');
    }
  }

  parts.push(`\n辩论主题：${userMessage}`);
  parts.push(`这是第${debateRound}轮辩论（共${totalRounds}轮）。`);

  if (debateRound >= totalRounds) {
    parts.push('这是最后一轮，请总结你的核心立场并给出最终结论。');
  }

  if (groupMembers && groupMembers.length > 0) {
    const memberNames = groupMembers.map(id => AI_NAMES[id] || id);
    parts.push(`辩论参与者：${memberNames.join('、')}`);
  }

  if (recentMessages && recentMessages.length > 0) {
    const contextMessages = recentMessages.slice(-50);
    const history = contextMessages.map(m => {
      const sender = m.sender_type === 'user' ? '用户' : (AI_NAMES[m.sender_id] || m.sender_id || 'AI');
      const content = m.content.substring(0, 300);
      return `${sender}: ${content}${m.content.length > 300 ? '...' : ''}`;
    }).join('\n');
    parts.push(`\n【辩论讨论记录】\n${history}`);
  }

  return parts.join('\n');
}

export async function callAIDebate(aiId, persona, userMessage, recentMessages, debateRound, totalRounds, debateLevel, groupMembers = null, userId = null) {
  const customPersona = userId ? await getUserCustomPersona(userId, aiId) : null;
  const effectivePersona = customPersona ? {
    ...persona,
    ...customPersona,
    modelConfig: { ...(persona.modelConfig || {}), ...(customPersona.modelConfig || {}) },
    responseConfig: { ...(persona.responseConfig || {}), ...(customPersona.responseConfig || {}) },
    socialConfig: { ...(persona.socialConfig || {}), ...(customPersona.socialConfig || {}) },
    debateConfig: { ...(persona.debateConfig || {}), ...(customPersona.debateConfig || {}) }
  } : persona;

  const config = aiConfigs[aiId];

  // 应用用户自定义API配置
  let effectiveConfig = config;
  if (userId && config) {
    const userApiConfig = await getUserApiConfigForModel(userId, aiId);
    if (userApiConfig) {
      effectiveConfig = { ...config };
      if (userApiConfig.apiKey) {
        effectiveConfig.apiKey = userApiConfig.apiKey;
      }
      if (userApiConfig.baseUrl) {
        effectiveConfig.endpoint = userApiConfig.baseUrl;
      }
    }
  }

  if (!effectiveConfig || !effectiveConfig.apiKey) {
    safeLog('warn', `AI ${aiId} 配置不存在，使用模拟回复`, { apiKey: effectiveConfig?.apiKey || '' });
    return getMockResponse(aiId, effectivePersona, 'free_chat', recentMessages);
  }

  const systemPrompt = buildDebateSystemPrompt(effectivePersona, debateRound, totalRounds, debateLevel, recentMessages, groupMembers, userMessage);

  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  const contextLimit = 30;
  const contextSlice = recentMessages.slice(-contextLimit);

  for (const msg of contextSlice) {
    const content = msg.content || '';
    if (msg.sender_type === 'user') {
      messages.push({ role: 'user', content });
    } else if (msg.sender_type === 'ai' && msg.sender_id === aiId) {
      messages.push({ role: 'assistant', content });
    } else if (msg.sender_type === 'ai') {
      const truncated = content.substring(0, 300) + (content.length > 300 ? '...' : '');
      messages.push({ role: 'user', content: truncated });
    }
  }

  const debatePrompt = debateRound === 1
    ? `请就"${userMessage}"这个话题发表你的观点，开始辩论。`
    : `请继续辩论，回应其他辩友的观点。`;

  messages.push({ role: 'user', content: debatePrompt });

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const params = effectiveConfig.params || {};
      const modelConfig = effectivePersona?.modelConfig || {};
      const effectiveTemperature = Math.min((modelConfig.temperature ?? params.temperature ?? 0.7) + 0.1, 1.0);
      const effectiveMaxTokens = modelConfig.maxTokens ?? params.max_tokens ?? 1500;
      const effectiveTopP = modelConfig.topP ?? params.top_p ?? 0.9;

      const requestBody = {
        model: effectiveConfig.model,
        messages,
        max_tokens: effectiveMaxTokens,
        temperature: effectiveTemperature,
        top_p: effectiveTopP
      };

      if (effectiveConfig.note && effectiveConfig.note.includes('不支持temperature')) {
        delete requestBody.temperature;
        delete requestBody.top_p;
      }

      const response = await axios.post(effectiveConfig.endpoint, requestBody, {
        headers: {
          'Authorization': `Bearer ${effectiveConfig.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      });

      if (!response.data?.choices?.[0]?.message) {
        throw new Error('AI API返回了无效响应格式');
      }

      let content = response.data.choices[0].message.content;
      if (!content || content.trim().length === 0) {
        if (response.data.choices[0].reasoning_content) {
          content = response.data.choices[0].reasoning_content;
        }
      }

      const normalized = normalizeResponse(content);
      if (!normalized || normalized.trim().length === 0) {
        throw new Error(`AI ${aiId} returned empty debate response`);
      }

      return normalized;
    } catch (error) {
      if (attempt < maxRetries - 1) {
        const delay = 2000 * (attempt + 1);
        safeLog('warn', `AI ${aiId} 辩论调用失败(第${attempt + 1}次)，${delay}ms后重试`, { error: error.message });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  return null;
}
