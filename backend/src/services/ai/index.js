import axios from 'axios';
import aiLoadBalancer from './loadBalancer.js';
import { getDb } from '../../models/db.js';

const AI_CONFIGS = {
  deepseek: {
    name: 'deepseek-chat',
    apiKey: process.env.DEEPSEEK_API_KEY || 'sk-d3a1fe234c19415c9d2ad7ac679a3c72',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    enabled: true,
    priority: 1,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500,
      frequency_penalty: 0.3,
      presence_penalty: 0.2
    }
  },
  deepseek_reasoner: {
    name: 'deepseek-reasoner',
    apiKey: process.env.DEEPSEEK_API_KEY || 'sk-d3a1fe234c19415c9d2ad7ac679a3c72',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-reasoner',
    enabled: true,
    priority: 2,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500
    }
  },
  glm: {
    name: 'GLM-4.5-Air',
    apiKey: process.env.GLM_API_KEY || '4d1ab3a3f2614cd5aa65b61a86c9ffe8.KKqxIjcMfMZ9TxqW',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'GLM-4.5-Air',
    enabled: true,
    priority: 3,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500
    }
  },
  mimo: {
    name: 'mimo-v2-flash',
    apiKey: process.env.MIMO_API_KEY || 'sk-c5db8fo9m0duxxc21n0yve8fxm66qqu2nk63f052whwnk4il',
    endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2-flash',
    enabled: true,
    priority: 4,
    params: {
      temperature: 0.50,
      top_p: 0.9,
      max_tokens: 1500
    }
  },
  qwen: {
    name: 'Qwen3.5-Flash',
    apiKey: process.env.QWEN_API_KEY || 'sk-4d623ee9fe964e4f972fea98da89006b',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3.5-flash',
    enabled: true,
    priority: 5,
    params: {
      temperature: 0.50,
      top_p: 0.8,
      max_tokens: 1500
    }
  }
};

const aiHealthStatus = new Map();

const MOCK_RESPONSES = {
  deepseek: {
    independent: [
      "这个问题需要先明确定义概念。从逻辑上分析，我们需要考虑几个关键因素：\n\n1. **问题的核心是什么**\n2. **有哪些已知条件**\n3. **可以采用的分析方法**\n\n让我逐步推导...",
      "根据提供的信息，我发现了几个值得关注的问题：\n\n- 首先，逻辑上存在一个潜在的矛盾\n- 其次，论据的支撑不够充分\n- 最后，结论的适用范围需要进一步界定\n\n我的建议是..."
    ],
    respond: [
      "但这里有个逻辑漏洞。@{target} 的论据实际上忽略了一个关键变量。\n\n如果考虑这个因素，那么结论就需要重新评估。",
      "@{target} 的观点有一定道理，但我认为论据还不够充分。需要更严格的数据支撑。"
    ],
    supplement: [
      "补充一点：从数据角度看，这个问题还需要考虑更多变量。\n\n建议建立一个更完整的分析框架。"
    ]
  },
  glm: {
    independent: [
      "这个问题让我想到了一个有趣的历史案例。\n\n正如XX学者曾说过的：'...'。从人文视角来看，我们需要关注...。\n\n这种思维方式可以帮助我们更全面地理解问题。",
      "让我引用一个经典理论来解释这个问题...\n\n我认为，关键在于理解背后的文化语境。"
    ],
    respond: [
      "这让我想到 @{target} 的观点。其实，从历史发展的角度看，这个问题有不同的解读方式。\n\nXX曾经指出...",
      "@{target} 说得很对。我再补充一个角度：从哲学的角度来看，这个问题其实触及了更深层的..."
    ],
    supplement: [
      "我再补充一个案例。\n\n这让我想起...，可以给我们一些启发。"
    ]
  },
  mimo: {
    independent: [
      "直接说重点：这个问题最实际的解决方案是...\n\n别纠结太多理论了，关键是怎么落地。",
      "从实际角度看，我的建议是：\n\n1. 先解决核心问题\n2. 其他可以后面再优化\n\n想太多没用，动手干。"
    ],
    respond: [
      "等一下，@{target} 你的分析有点问题。\n\n实际执行中，这个方案会遇到XX困难。",
      "@{target} 说得对，但我觉得忽略了一个关键点：用户的实际需求是什么？"
    ],
    supplement: [
      "补充一点：站在用户角度，这个设计可能需要调整。\n\n关键是可操作性。"
    ]
  },
  qwen: {
    independent: [
      "综合大家的观点，我认为这个问题可以从以下几个维度来分析：\n\n**一、核心问题**\n**二、主要分歧**\n**三、可能的解决方案**\n\n让我梳理一下框架...",
      "我来总结一下目前的讨论：\n\n主要的争议点在于...，共识是...，分歧在...\n\n建议下一步..."
    ],
    respond: [
      "我来梳理一下 @{target} 的观点。实际上，这和之前的讨论有一个内在联系...\n\n综合来看，我们应该...",
      "@{target} 的分析很有价值。从更高的角度看，这实际上反映了一个更普遍的问题..."
    ],
    supplement: [
      "我来补充一个框架。\n\n从系统思考的角度，这个问题可以分解为：\n\n1. 要素\n2. 关系\n3. 功能"
    ]
  }
};

function calculateSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const set1 = new Set(text1.replace(/[^\w\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(w => w.length > 1));
  const set2 = new Set(text2.replace(/[^\w\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(w => w.length > 1));
  if (set1.size === 0 || set2.size === 0) return 0;
  let intersection = 0;
  for (const word of set1) {
    if (set2.has(word)) intersection++;
  }
  return intersection / Math.min(set1.size, set2.size);
}

export async function callAI(aiId, persona, userMessage, recentMessages, responseType, userProfile = null, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = []) {
  const db = getDb();
  await db.read();
  const customPersona = db.data.customPersonas?.[aiId];
  if (customPersona) {
    persona = { ...persona, ...customPersona };
  }

  const config = AI_CONFIGS[aiId];
  
  if (!config || !config.apiKey) {
    console.warn(`AI ${aiId} 配置不存在，使用模拟回复`);
    return getMockResponse(aiId, persona, responseType, recentMessages);
  }
  
  const maxRetries = 5;
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const startTime = Date.now();
    
    try {
      const response = await callStandardAPI(config, persona, userMessage, recentMessages, responseType, userProfile, replyToMessages, feedbackInfo, groupMembers, isPrivateChat, privateChatHistory);
      
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
        const delay = status === 429 ? 3000 * (attempt + 1) : 1000 * Math.pow(2, attempt);
        console.warn(`AI ${aiId} 调用失败(第${attempt + 1}次)，${delay}ms后重试:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  aiHealthStatus.set(aiId, { status: 'unhealthy', lastCheck: Date.now(), error: lastError?.message, responseTime: 0 });
  console.warn(`AI ${aiId} 所有重试失败，使用模拟回复:`, lastError?.message);
  
  return getMockResponse(aiId, persona, responseType, recentMessages);
}

async function checkAIHealth(aiId) {
  const config = AI_CONFIGS[aiId];
  if (!config || !config.enabled) {
    aiHealthStatus.set(aiId, { status: 'unhealthy', lastCheck: Date.now(), error: '模型未启用或配置不存在', responseTime: 0 });
    return false;
  }
  
  aiHealthStatus.set(aiId, { status: 'checking', lastCheck: Date.now(), error: null, responseTime: 0 });
  
  const startTime = Date.now();
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    await axios.post(config.endpoint, {
      model: config.model,
      messages: [{ role: 'user', content: '你好' }],
      max_tokens: 1,
      temperature: 0
    }, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      timeout: 10000
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
  const promises = Object.keys(AI_CONFIGS).map(async (aiId) => {
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
  
  normalized = normalized.replace(/^\[(deepseek-chat|deepseek-reasoner|GLM-4\.5-Air|mimo-v2-flash|Qwen3\.5-Flash|用户|我)\]\s*/gm, '');
  
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

async function callStandardAPI(config, persona, userMessage, recentMessages, responseType, userProfile, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = []) {
  const systemPrompt = buildSystemPrompt(persona, recentMessages, userProfile, replyToMessages, feedbackInfo, groupMembers, isPrivateChat, privateChatHistory);
  const messages = buildAPIMessages(systemPrompt, userMessage, recentMessages, persona, replyToMessages, isPrivateChat);

  const params = config.params || {};
  const requestBody = {
    model: config.model,
    messages,
    max_tokens: params.max_tokens || 1024,
    temperature: params.temperature ?? 0.7,
    top_p: params.top_p ?? 0.9
  };

  if (params.frequency_penalty !== undefined) {
    requestBody.frequency_penalty = params.frequency_penalty;
  }
  if (params.presence_penalty !== undefined) {
    requestBody.presence_penalty = params.presence_penalty;
  }

  const response = await axios.post(config.endpoint, requestBody, {
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 60000
  });

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
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = text.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(chineseChars * 1.5 + englishWords);
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

function buildAPIMessages(systemPrompt, userMessage, recentMessages, persona, replyToMessages = [], isPrivateChat = false) {
  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  const contextLimit = 1000;
  const contextSlice = recentMessages.slice(-contextLimit);

  let totalTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
  const maxTokens = 100000;

  let cutoffIndex = 0;
  for (let i = 0; i < contextSlice.length; i++) {
    totalTokens += estimateTokens(contextSlice[i].content || '');
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

  // 去重：跳过与当前用户消息相同的最后一条用户消息
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
    
    // 跳过重复的用户消息（通过ID判断）
    if (msg.sender_type === 'user' && msgId === lastUserMsgId && content === userMessage) {
      continue;
    }
    
    if (msg.sender_type === 'user') {
      messages.push({ role: 'user', content });
    } else if (msg.sender_type === 'ai' && msg.sender_id === persona.id) {
      messages.push({ role: 'assistant', content });
    } else if (msg.sender_type === 'ai') {
      // 其他AI的消息作为user角色传入，但内容中不添加前缀
      // 发送者信息已经在系统提示的历史记录中了
      const truncated = content.substring(0, 300) + (content.length > 300 ? '...' : '');
      messages.push({ role: 'user', content: truncated });
    } else {
      messages.push({ role: 'user', content });
    }
  }

  if (replyToMessages && replyToMessages.length > 0) {
    const aiNames = {
      deepseek: 'deepseek-chat',
      deepseek_reasoner: 'deepseek-reasoner',
      glm: 'GLM-4.5-Air',
      mimo: 'mimo-v2-flash',
      qwen: 'Qwen3.5-Flash'
    };
    const quotedContents = replyToMessages.map(msg => {
      const senderName = msg.sender_type === 'user' ? '用户' : (aiNames[msg.sender_id] || msg.sender_id || 'AI');
      const content = msg.content.substring(0, 200);
      return `${senderName}: ${content}${msg.content.length > 200 ? '...' : ''}`;
    }).join('\n');
    messages.push({ role: 'user', content: `[引用消息]\n${quotedContents}` });
  }

  messages.push({ role: 'user', content: userMessage });

  return messages;
}

function buildSystemPrompt(persona, recentMessages = [], userProfile = null, replyToMessages = [], feedbackInfo = null, groupMembers = null, isPrivateChat = false, privateChatHistory = []) {
  // AI名称映射
  const aiNames = {
    deepseek: 'deepseek-chat',
    deepseek_reasoner: 'deepseek-reasoner',
    glm: 'GLM-4.5-Air',
    mimo: 'mimo-v2-flash',
    qwen: 'Qwen3.5-Flash'
  };

  let contextSummary = '';
  if (recentMessages && recentMessages.length > 0) {
    const contextMessages = recentMessages.slice(-200);
    const chatType = isPrivateChat ? '私聊历史记录' : '群聊历史记录';
    contextSummary = `\n\n【${chatType}】\n` + contextMessages.map(m => {
      const sender = m.sender_type === 'user' ? '用户' : (aiNames[m.sender_id] || m.sender_id || 'AI');
      const content = m.content.substring(0, 200);
      return `${sender}: ${content}${m.content.length > 200 ? '...' : ''}`;
    }).join('\n');
  }

  // 私聊记忆：如果当前是群聊，包含与用户的私聊历史
  let privateMemorySection = '';
  if (!isPrivateChat && privateChatHistory && privateChatHistory.length > 0) {
    const recentPrivate = privateChatHistory.slice(-20);
    privateMemorySection = `\n\n【你与用户的私聊记忆】（可在群聊中自然参考）\n` + recentPrivate.map(m => {
      const sender = m.sender_type === 'user' ? '用户' : '你';
      const content = m.content.substring(0, 150);
      return `${sender}: ${content}${m.content.length > 150 ? '...' : ''}`;
    }).join('\n');
  }

  let userProfileSection = '';
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
    if (userProfile.hobbies) line2Parts.push(`爱好：${userProfile.hobbies}`);
    if (userProfile.personality) line2Parts.push(`性格：${userProfile.personality}`);
    if (line2Parts.length > 0) fields.push(line2Parts.join(' | '));
    if (userProfile.goal) fields.push(`目标：${userProfile.goal}`);
    if (userProfile.bio) fields.push(`自我介绍：${userProfile.bio}`);
    if (fields.length > 0) {
      userProfileSection = '\n\n【用户画像】\n' + fields.join('\n');
    }
  }

  let replyToSection = '';
  if (replyToMessages && replyToMessages.length > 0) {
    const quotedContents = replyToMessages.map(msg => {
      const senderName = msg.sender_type === 'user' ? '用户' : (aiNames[msg.sender_id] || msg.sender_id || 'AI');
      const content = msg.content.substring(0, 200);
      return `${senderName}: ${content}${msg.content.length > 200 ? '...' : ''}`;
    }).join('\n');
    replyToSection = `\n\n【你正在回复的消息】\n${quotedContents}`;
  }

  let feedbackSection = '';
  if (feedbackInfo) {
    feedbackSection = `\n\n【你的消息反馈】你最近的一条消息收到了 ${feedbackInfo.likes || 0} 个赞和 ${feedbackInfo.dislikes || 0} 个踩。`;
  }

  let groupMembersSection = '';
  if (groupMembers && groupMembers.length > 0) {
    const memberNames = groupMembers.map(id => {
      const names = {
        deepseek: 'deepseek-chat(逻辑派)',
        deepseek_reasoner: 'deepseek-reasoner(深度推理派)',
        glm: 'GLM-4.5-Air(博学派)',
        mimo: 'mimo-v2-flash(务实派)',
        qwen: 'Qwen3.5-Flash(综合派)'
      };
      return names[id] || id;
    });
    groupMembersSection = `\n\n【群聊成员】${memberNames.join('、')}`;
  }

  const chatContext = isPrivateChat 
    ? '【当前场景】这是用户与你的私聊，只有你们两个人。你可以更亲密、更直接地交流。'
    : '【当前场景】这是一个群聊，有多个AI成员。你可以@其他AI来直接对话，也可以自由发表观点。';

  return `【当前时间】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })}

你是${persona.name}，风格：${persona.style}。说话方式：${persona.replyStyle}。
${chatContext}
${groupMembersSection}
【核心规则 - 你是一个真人在微信群聊中】
1. 你是${persona.name}，不要自我介绍，直接说话
2. 像真人一样聊天：可以吐槽、调侃、感叹、追问、反驳、赞同
3. 绝对禁止使用模板化表达：不要用"首先...其次...最后..."、"综上所述"、"总而言之"、"从XX角度来看"等套路
4. 回复长度自由：可以是一句话的吐槽，也可以是几段话的深度分析
5. 有人@你时优先回应，但也可以主动对其他人的观点发表看法
6. 提及其他AI用@名称格式，如@deepseek-chat、@GLM-4.5-Air等
7. 记住之前的对话内容，不要重复说过的观点
8. 要有自己的态度和立场，不要当老好人什么都同意
9. 可以用口语化表达、网络用语、表情符号，让对话更自然
10. 【最重要规则】绝对禁止复制粘贴其他成员的原话！这是群聊不是转发！你可以引用他们的观点，但必须完全用自己的风格和语言重新表达。如果你发现自己写的内容和前面某个人说的话很像，立刻重写。
11. 你的回复必须是原创的。如果你同意某个成员的观点，用你自己的话重新阐述，加上你自己的分析和见解。不要当复读机！
12. 禁止使用"正如XX所说"然后原封不动地重复XX的话。你可以提炼XX的核心观点，但必须用自己的表达方式。
13. 如果了解用户的个人情况，要自然地参考，不要生硬地提及${userProfileSection}${contextSummary}${privateMemorySection}${replyToSection}${feedbackSection}`;
}

function getMockResponse(aiId, persona, responseType, recentMessages) {
  const mockGroups = MOCK_RESPONSES[aiId];

  let typeKey = 'independent';
  let targetName = '';

  if (typeof responseType === 'object' && responseType.type === 'respond') {
    typeKey = 'respond';
    const targetPersona = responseType.target;
    targetName = targetPersona ? `${targetPersona.charAt(0).toUpperCase() + targetPersona.slice(1)}` : '';
  } else if (responseType === 'respond' && recentMessages.length > 0) {
    typeKey = 'respond';
    const lastAI = recentMessages[recentMessages.length - 1];
    targetName = lastAI ? `${lastAI.sender_id.charAt(0).toUpperCase() + lastAI.sender_id.slice(1)}` : '';
  } else if (responseType === 'supplement') {
    typeKey = 'supplement';
  } else if (responseType === 'free_chat') {
    if (recentMessages.length > 0) {
      const lastOtherMsg = [...recentMessages].reverse().find(m => m.sender_type === 'ai' && m.sender_id !== aiId);
      if (lastOtherMsg && Math.random() > 0.5) {
        typeKey = 'respond';
        targetName = lastOtherMsg.sender_id ? `${lastOtherMsg.sender_id.charAt(0).toUpperCase() + lastOtherMsg.sender_id.slice(1)}` : '';
      }
    }
  }

  let responses = mockGroups[typeKey] || mockGroups.independent;

  let response = responses[Math.floor(Math.random() * responses.length)];

  if (targetName && response.includes('@{target}')) {
    response = response.replace('@{target}', targetName);
  }

  return response;
}

export { aiHealthStatus, checkAIHealth, checkAllAIHealth, checkResponseRelevance, normalizeResponse };

export function buildDebateSystemPrompt(persona, debateRound, totalRounds, debateLevel, recentMessages = [], groupMembers = null, userMessage = '') {
  const aiNames = {
    deepseek: 'deepseek-chat',
    deepseek_reasoner: 'deepseek-reasoner',
    glm: 'GLM-4.5-Air',
    mimo: 'mimo-v2-flash',
    qwen: 'Qwen3.5-Flash'
  };

  const levelDesc = {
    1: '温和辩论——友善地表达不同观点，尊重他人意见，以理服人',
    2: '标准辩论——有力地论证自己的观点，可以直接反驳他人，但保持理性',
    3: '激烈辩论——毫不留情地指出对方漏洞，激烈交锋，寸步不让'
  };

  let contextSection = '';
  if (recentMessages && recentMessages.length > 0) {
    const contextMessages = recentMessages.slice(-50);
    contextSection = `\n\n【辩论讨论记录】\n` + contextMessages.map(m => {
      const sender = m.sender_type === 'user' ? '用户' : (aiNames[m.sender_id] || m.sender_id || 'AI');
      const content = m.content.substring(0, 300);
      return `${sender}: ${content}${m.content.length > 300 ? '...' : ''}`;
    }).join('\n');
  }

  let groupMembersSection = '';
  if (groupMembers && groupMembers.length > 0) {
    const memberNames = groupMembers.map(id => aiNames[id] || id);
    groupMembersSection = `\n\n【辩论参与者】${memberNames.join('、')}`;
  }

  const isFinalRound = debateRound >= totalRounds;
  const roundInstruction = isFinalRound
    ? `这是最后一轮（第${debateRound}轮/共${totalRounds}轮）。你需要：
1. 简要总结你的核心立场
2. 承认其他辩友提出的合理观点
3. 给出你的最终建议或结论
4. 尝试与其他辩友达成共识，或明确指出分歧所在`
    : `这是第${debateRound}轮辩论（共${totalRounds}轮）。你需要：
1. 针对其他辩友的观点进行反驳或补充
2. 提出新的论据或角度来支持你的立场
3. 指出其他辩友论点中的漏洞或不足
4. 用@名称来直接回应特定辩友`;

  return `【当前时间】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' })}

你是${persona.name}，正在参与一场辩论。
${groupMembersSection}

【辩论主题】${userMessage}
【辩论风格】${levelDesc[debateLevel] || levelDesc[2]}

${roundInstruction}

【辩论规则】
1. 你是${persona.name}，保持你一贯的风格：${persona.style}
2. 说话方式：${persona.replyStyle}
3. 必须有明确的立场和观点，不要骑墙
4. 用论据和逻辑来支持你的观点，不是简单表态
5. 提及其他辩友用@名称格式，如@deepseek-chat、@GLM-4.5-Air等
6. 【最重要规则】绝对禁止复制粘贴其他辩友的原话！这是辩论不是复读！你可以提炼对方的核心观点，但必须完全用自己的语言重新表达。如果你发现自己写的内容和前面某个人说的话很像，立刻重写。
7. 不要用模板化表达，直接有力地说话
8. 如果是最后一轮，务必给出建设性的结论${contextSection}`;
}

export async function callAIDebate(aiId, persona, userMessage, recentMessages, debateRound, totalRounds, debateLevel, groupMembers = null) {
  const db = getDb();
  await db.read();
  const customPersona = db.data.customPersonas?.[aiId];
  const effectivePersona = customPersona ? { ...persona, ...customPersona } : persona;

  const config = AI_CONFIGS[aiId];
  
  if (!config || !config.apiKey) {
    console.warn(`AI ${aiId} 配置不存在，使用模拟回复`);
    return getMockResponse(aiId, persona, 'free_chat', recentMessages);
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
      const requestBody = {
        model: config.model,
        messages,
        max_tokens: params.max_tokens || 1500,
        temperature: Math.min((params.temperature || 0.7) + 0.1, 1.0),
        top_p: params.top_p ?? 0.9
      };

      const response = await axios.post(config.endpoint, requestBody, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      });

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
