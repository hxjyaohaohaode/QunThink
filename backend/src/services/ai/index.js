import axios from 'axios';
import aiLoadBalancer from './loadBalancer.js';
import { AI_NAMES, calculateSimilarity } from '../../config/constants.js';
import { safeLog } from '../../utils/logger.js';

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
    name: 'mimo-v2.5',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5',
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
    name: 'deepseek-chat',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
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
    name: 'mimo-v2-omni',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2-omni',
    enabled: true,
    priority: 8,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500
    }
  },
  deepseek_reasoner: {
    name: 'deepseek-reasoner',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-reasoner',
    enabled: true,
    priority: 9,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 2000
    }
  },
  mimo_tts: {
    name: 'mimo-v2-tts',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2-tts',
    enabled: true,
    priority: 10,
    isTTS: true,
    params: {
      temperature: 0.30,
      top_p: 0.8,
      max_tokens: 200
    }
  }
};

let aiConfigs = { ...DEFAULT_AI_CONFIGS };

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
    console.log('[AI配置] 已从数据库加载模型配置');
  } catch (error) {
    console.warn('[AI配置] 从数据库加载失败，使用默认配置:', error.message);
  }
}

export async function getUserCustomPersona(userId, aiId) {
  try {
    const { getUserDb } = await import('../../models/db.js');
    const db = await getUserDb(userId);
    await db.read();
    return db.data.customPersonas?.[aiId] || null;
  } catch (error) {
    console.warn('[AI] 获取用户自定义角色失败:', error.message);
    return null;
  }
}

export function getAIConfigs() { return aiConfigs; }
export function getAIConfig(id) { return aiConfigs[id]; }

const aiHealthStatus = new Map();

function getMockResponse(aiId, persona, responseType, recentMessages) {
  return `[${persona?.name || aiId}] 暂时无法连接，请稍后再试。`;
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
  
  if (!config || !config.apiKey) {
    safeLog('warn', `AI ${aiId} 配置不存在，使用模拟回复`, { apiKey: config?.apiKey || '' });
    return getMockResponse(aiId, effectivePersona, responseType, recentMessages);
  }
  
  const maxRetries = 5;
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const startTime = Date.now();
    
    try {
      const response = await callStandardAPI(config, effectivePersona, userMessage, recentMessages, responseType, userProfile, replyToMessages, feedbackInfo, groupMembers, isPrivateChat, privateChatHistory, userAgents);
      
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
              console.warn(`[去重警告] AI ${aiId} 的回复与 ${prevMsg.sender_id} 的消息相似度 ${similarity.toFixed(2)} 过高，可能存在复制行为`);
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
        console.warn('记录指标失败:', metricsError);
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
        console.warn(`AI ${aiId} 客户端错误(${status})，不重试:`, error.message);
        break;
      }
      
      try {
        aiLoadBalancer.recordFailure(aiId, error);
      } catch (metricsError) {
        console.warn('记录失败指标失败:', metricsError);
      }
      
      if (attempt < maxRetries - 1) {
        const delay = status === 429 ? 2000 * (attempt + 1) : 500 * Math.pow(2, attempt);
        console.warn(`AI ${aiId} 调用失败(第${attempt + 1}次)，${delay}ms后重试:`, error.message);
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
    console.warn(`AI ${aiId} 健康检查失败:`, error.message);
    return false;
  }
}

async function checkAllAIHealth() {
  const results = {};
  const promises = Object.keys(aiConfigs).map(async (aiId) => {
    results[aiId] = await checkAIHealth(aiId);
    console.log(`AI ${aiId} 健康状态: ${results[aiId] ? '✅ 正常' : '❌ 异常'}`);
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
    console.warn(`[相关性警告] AI回复可能与用户问题不相关 (分数: ${score.toFixed(2)})`);
    console.warn(`  用户关键词: ${userKeywords.join(', ')}`);
    console.warn(`  匹配关键词: ${matchedKeywords.join(', ')}`);
  }
  
  return score;
}

function normalizeResponse(content) {
  if (!content || typeof content !== 'string') return content;
  
  let normalized = content;
  normalized = normalized.replace(/\r\n/g, '\n');
  normalized = normalized.replace(/\r/g, '\n');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  
  normalized = normalized.replace(/^\[(deepseek-chat|deepseek-reasoner|GLM-4\.5-Air|mimo-v2\.5|mimo-v2-flash|Qwen3\.5-Flash|用户|我)\]\s*/gm, '');
  
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
    console.warn(`AI ${config.model} returned empty content. Raw choice: ${rawResponse.substring(0, 500)}`);
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

  for (let i = 0; i < effectiveMessages.length; i++) {
    const msg = effectiveMessages[i];
    const content = msg.content || '';
    const msgId = msg.id;
    
    if (msg.sender_type === 'user' && msgId === lastUserMsgId && content === userMessage) {
      continue;
    }
    
    if (msg.sender_type === 'user') {
      if (isPrivateChat) {
        messages.push({ role: 'user', content });
      } else {
        const userName = userProfile?.nickname || '用户';
        messages.push({ role: 'user', content: `[${userName}]: ${content}` });
      }
    } else if (msg.sender_type === 'ai' && msg.sender_id === persona.id) {
      messages.push({ role: 'assistant', content });
    } else if (msg.sender_type === 'ai') {
      const aiName = AI_NAMES[msg.sender_id] || msg.sender_id || 'AI';
      const truncated = content.substring(0, 300) + (content.length > 300 ? '...' : '');
      messages.push({ role: 'user', content: `[${aiName}]: ${truncated}` });
    } else {
      messages.push({ role: 'user', content });
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
      return `${senderName}: ${content}${msg.content.length > 200 ? '...' : ''}`;
    }).join('\n');
    messages.push({ role: 'user', content: `[引用消息]\n${quotedContents}` });
  }

  messages.push({ role: 'user', content: userMessage });

  return messages;
}

function buildSystemPrompt(persona, recentMessages = [], userProfile = null, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = [], userAgents = []) {
  let parts = [];

  if (isPrivateChat) {
    parts.push(`你是${persona.name}，正在与用户进行一对一私聊。请按照你的人设来发言。`);
    parts.push('这是你和用户之间的私密对话，请认真回答用户的问题，不要敷衍或回避。你只需要回复用户的消息，不要自言自语。');
  } else {
    parts.push(`你是${persona.name}。请按照你的人设来发言。`);
  }

  if (persona.styleTag) {
    parts.push(`你的风格标签是"${persona.styleTag}"，请在发言中体现这个风格。`);
  }

  if (persona.style) {
    parts.push(`风格：${persona.style}。请在语气、用词、表达方式上符合这个风格。`);
  }

  if (persona.personality) {
    parts.push(`性格：${persona.personality}。你的态度和情感倾向会受此性格影响。`);
  }

  if (persona.replyStyle) {
    parts.push(`说话方式：${persona.replyStyle}。请按照这种方式说话。`);
  }

  if (persona.typicalPhrases && persona.typicalPhrases.length > 0) {
    parts.push(`你的口头禅：${persona.typicalPhrases.join('、')}。在合适的语境中可以自然地使用这些口头禅。`);
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

  if (!isPrivateChat) {
    parts.push('当前场景：这是一个群聊。');
  }

  if (!isPrivateChat && groupMembers && groupMembers.length > 0) {
    const memberNames = groupMembers.map(id => AI_NAMES[id] || id);
    parts.push(`群聊成员：${memberNames.join('、')}`);
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
      return `${senderName}: ${content}${msg.content.length > 200 ? '...' : ''}`;
    }).join('\n');
    parts.push(`\n【你正在回复的消息】\n${quotedContents}`);
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
        try { entry.abort(); } catch {}
        activeStreams.delete(streamId);
        console.warn(`🧹 清理超时流: ${streamId}`);
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
  
  if (!config || !config.apiKey) {
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
  const effectiveTemperature = modelConfig.temperature ?? effectivePersona?.temperature ?? config.params?.temperature ?? 0.7;
  const effectiveMaxTokens = modelConfig.maxTokens ?? effectivePersona?.maxTokens ?? config.params?.max_tokens ?? 1500;
  const effectiveTopP = modelConfig.topP ?? config.params?.top_p ?? 0.9;
  const effectiveFreqPenalty = modelConfig.frequencyPenalty ?? config.params?.frequency_penalty;
  const effectivePresPenalty = modelConfig.presencePenalty ?? config.params?.presence_penalty;

  const controller = new AbortController();
  controller._createdAt = Date.now();
  if (streamId) {
    activeStreams.set(streamId, controller);
  }
  
  try {
    const requestBody = {
      model: config.model,
      messages,
      stream: true,
      temperature: effectiveTemperature,
      max_tokens: effectiveMaxTokens,
      top_p: effectiveTopP
    };
    if (effectiveFreqPenalty !== undefined) requestBody.frequency_penalty = effectiveFreqPenalty;
    if (effectivePresPenalty !== undefined) requestBody.presence_penalty = effectivePresPenalty;

    const response = await axios.post(config.endpoint, requestBody, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream',
      signal: controller.signal,
      timeout: 90000
    });
    
    let fullContent = '';
    
    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
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
            } catch {}
          }
        }
      });
      
      response.data.on('end', () => {
        if (streamId) activeStreams.delete(streamId);
        resolve(fullContent);
      });
      
      response.data.on('error', (err) => {
        if (streamId) activeStreams.delete(streamId);
        reject(err);
      });
    });
  } catch (error) {
    if (streamId) activeStreams.delete(streamId);
    if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
      return '';
    }
    console.error(`[AI流式调用错误] ${aiId}:`, error.message);
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
}

export { aiHealthStatus, checkAIHealth, checkAllAIHealth, checkResponseRelevance, normalizeResponse, applyMessageLengthLimit };

export function buildDebateSystemPrompt(persona, debateRound, totalRounds, debateLevel, recentMessages = [], groupMembers = null, userMessage = '') {
  let parts = [];

  parts.push(`你是${persona.name}，正在参与一场辩论。请按照你的人设来发言。`);

  if (persona.styleTag) {
    parts.push(`你的风格标签是"${persona.styleTag}"，请在辩论中体现这个风格。`);
  }

  if (persona.style) {
    parts.push(`风格：${persona.style}。请在语气、用词、论证方式上符合这个风格。`);
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
  
  if (!config || !config.apiKey) {
    safeLog('warn', `AI ${aiId} 配置不存在，使用模拟回复`, { apiKey: config?.apiKey || '' });
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
      const params = config.params || {};
      const modelConfig = effectivePersona?.modelConfig || {};
      const effectiveTemperature = Math.min((modelConfig.temperature ?? params.temperature ?? 0.7) + 0.1, 1.0);
      const effectiveMaxTokens = modelConfig.maxTokens ?? params.max_tokens ?? 1500;
      const effectiveTopP = modelConfig.topP ?? params.top_p ?? 0.9;

      const requestBody = {
        model: config.model,
        messages,
        max_tokens: effectiveMaxTokens,
        temperature: effectiveTemperature,
        top_p: effectiveTopP
      };

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

      const normalized = normalizeResponse(content);
      if (!normalized || normalized.trim().length === 0) {
        throw new Error(`AI ${aiId} returned empty debate response`);
      }

      return normalized;
    } catch (error) {
      if (attempt < maxRetries - 1) {
        const delay = 2000 * (attempt + 1);
        console.warn(`AI ${aiId} 辩论调用失败(第${attempt + 1}次)，${delay}ms后重试:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  return null;
}
