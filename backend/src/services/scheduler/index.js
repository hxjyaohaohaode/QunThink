import { v4 as uuidv4 } from 'uuid';
import { getUserDb, listUserDatabases, updateGroupActivityById, withWriteLock } from '../../models/db.js';
import { callAI, callAIStream, cancelStream, normalizeResponse, applyMessageLengthLimit } from '../ai/index.js';
import { broadcastToGroup, broadcastStreamChunk, broadcastStreamStart, broadcastStreamEnd, broadcastTypingStatus, broadcastAIMessage } from '../../websocket/index.js';
import { AI_PERSONAS } from '../../config/personas.js';
import { decryptText } from '../../utils/encryption.js';
import { AI_NAMES, AI_MENTION_ALIASES, calculateSimilarity } from '../../config/constants.js';
import { invokeAgentInGroup } from '../agent/index.js';
import { getUserDb as getUserDbForFiles } from '../../models/db.js';
import { generateMediaDescription } from '../fileAnnotation/index.js';
import { parseFile } from '../fileParser/index.js';
import path from 'path';
const activeGroups = new Map();
const autonomousTimers = new Map();
const groupToUserMap = new Map();
const customPersonasCache = new Map();

export async function loadCustomPersonas(userId) {
  if (!userId) return;
  try {
    const db = await getUserDb(userId);
    await db.read();
    customPersonasCache.set(userId, db.data.customPersonas || {});
  } catch (e) {
    console.warn('[AI人设] 加载自定义人设失败:', e.message);
  }
}

export function invalidateCustomPersonasCache(userId = null) {
  if (userId) {
    customPersonasCache.delete(userId);
  } else {
    customPersonasCache.clear();
  }
}

const defaultModelConfig = {
  maxTokens: 1500,
  temperature: 0.5,
  topP: 0.9,
  frequencyPenalty: 0.3,
  presencePenalty: 0.2
};

const defaultResponseConfig = {
  enabled: true,
  responseFrequency: 0.8,
  minDelay: 1000,
  maxDelay: 4000,
  activeHours: { start: 0, end: 24 },
  maxResponsesPerConversation: 10,
  cooldownBetweenResponses: 2000
};

const defaultSocialConfig = {
  maxMessageLength: 800,
  enableQuoting: true,
  enableSocialFeedback: true,
  quoteProbability: 0.4,
  maxQuotesPerMessage: 2,
  likeProbability: 0.3,
  commentProbability: 0.15,
  dislikeProbability: 0.05,
  interactionProbability: 0.75
};

export function getEffectivePersona(aiId, userId = null) {
  const defaultPersona = AI_PERSONAS[aiId];
  if (!defaultPersona) return null;

  const baseModelConfig = defaultPersona.modelConfig || defaultModelConfig;
  const baseSocialConfig = defaultPersona.socialConfig || defaultSocialConfig;
  const baseResponseConfig = defaultPersona.responseConfig || defaultResponseConfig;
  const baseDebateConfig = defaultPersona.debateConfig || {};

  if (userId) {
    const userCustoms = customPersonasCache.get(userId);
    if (userCustoms && userCustoms[aiId]) {
      const custom = userCustoms[aiId];
      return {
        ...defaultPersona,
        ...custom,
        responseConfig: { ...baseResponseConfig, ...(custom.responseConfig || {}) },
        socialConfig: { ...baseSocialConfig, ...(custom.socialConfig || {}) },
        modelConfig: { ...baseModelConfig, ...(custom.modelConfig || {}) },
        debateConfig: { ...baseDebateConfig, ...(custom.debateConfig || {}) }
      };
    }
  }

  return {
    ...defaultPersona,
    responseConfig: { ...baseResponseConfig },
    socialConfig: { ...baseSocialConfig },
    modelConfig: { ...baseModelConfig },
    debateConfig: { ...baseDebateConfig }
  };
}

export function populateGroupCache(userId, db) {
  if (db.data && db.data.groups) {
    for (const group of db.data.groups) {
      groupToUserMap.set(group.id, userId);
    }
  }
}

const REFUSAL_REASONS = [
  '太无聊了',
  '缺乏深度',
  '没有营养',
  '太过肤浅',
  '不够有趣',
  '逻辑不通',
  '毫无根据',
  '过于主观',
  '不太认同',
  '无法苟同',
  '缺乏逻辑支撑',
  '非常搞笑',
  '傻得有点可爱',
  '太无聊了',
  '太没有创意了',
  '太过平淡无奇',
  '没有讨论价值',
  '偏离了主题',
  '没什么新意',
  '不太合适',
  '这种说法不够严谨',
  '有点怪怪的',
  '与你人格不符',
  '过于武断了',
];

function generateRefusalMessage(aiId, userId = null) {
  const persona = getEffectivePersona(aiId, userId);
  const name = persona?.name || aiId;
  const reason = REFUSAL_REASONS[Math.floor(Math.random() * REFUSAL_REASONS.length)];
  return `${name}觉得你的发言${reason}所以拒绝回答`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRecentMessages(groupId, limit = 50) {
  const cachedUserId = groupToUserMap.get(groupId);
  if (cachedUserId) {
    const db = await getUserDb(cachedUserId);
    await db.read();
    const messages = db.data.messages
      .filter(m => m.group_id === groupId)
      .slice(-limit);
    if (messages.length > 0) return decryptMessages(messages);
  }
  
  const userIds = await listUserDatabases();
  for (const userId of userIds) {
    const db = await getUserDb(userId);
    await db.read();
    populateGroupCache(userId, db);
    const messages = db.data.messages
      .filter(m => m.group_id === groupId)
      .slice(-limit);
    if (messages.length > 0) return decryptMessages(messages);
  }
  return [];
}

function decryptMessages(messages) {
  return messages.map(msg => {
    if (msg.metadata?.encryption?.encrypted && typeof msg.content === 'string') {
      try {
        return { ...msg, content: decryptText(msg.content) };
      } catch (error) {
        console.warn(`[解密] 消息 ${msg.id} 解密失败:`, error.message);
      }
    }
    return msg;
  });
}

async function findGroupInAnyUserDb(groupId) {
  const cachedUserId = groupToUserMap.get(groupId);
  if (cachedUserId) {
    const db = await getUserDb(cachedUserId);
    await db.read();
    const group = db.data.groups.find(g => g.id === groupId);
    if (group) return { db, userId: cachedUserId, group };
  }
  
  const userIds = await listUserDatabases();
  for (const userId of userIds) {
    const db = await getUserDb(userId);
    await db.read();
    populateGroupCache(userId, db);
    const group = db.data.groups.find(g => g.id === groupId);
    if (group) return { db, userId, group };
  }
  return null;
}

async function findGroupAndMessagesInAnyUserDb(groupId) {
  const cachedUserId = groupToUserMap.get(groupId);
  if (cachedUserId) {
    const db = await getUserDb(cachedUserId);
    await db.read();
    const group = db.data.groups.find(g => g.id === groupId);
    if (group) {
      const messages = db.data.messages.filter(m => m.group_id === groupId);
      return { db, userId: cachedUserId, group, messages };
    }
  }
  
  const userIds = await listUserDatabases();
  for (const userId of userIds) {
    const db = await getUserDb(userId);
    await db.read();
    populateGroupCache(userId, db);
    const group = db.data.groups.find(g => g.id === groupId);
    if (group) {
      const messages = db.data.messages.filter(m => m.group_id === groupId);
      return { db, userId, group, messages };
    }
  }
  return null;
}

export function startAutonomousChatTimer(groupId) {
  if (autonomousTimers.has(groupId)) {
    return;
  }
  
  const checkAndStartChat = async () => {
    const result = await findGroupInAnyUserDb(groupId);
    if (!result) return;
    
    const { group } = result;
    if (!group || !group.ai_members || group.ai_members.length < 2) {
      return;
    }
    
    const recentMessages = await getRecentMessages(groupId, 10);
    
    if (recentMessages.length === 0) {
      console.log(`[AI自发对话] 群组 ${groupId} 没有消息，开始自发对话`);
      await triggerSpontaneousChat(groupId, group.ai_members);
      return;
    }
    
    const lastMessage = recentMessages[recentMessages.length - 1];
    const timeSinceLastMessage = Date.now() - new Date(lastMessage.created_at).getTime();
    
    if (timeSinceLastMessage > 60000 && Math.random() < 0.3) {
      console.log(`[AI自发对话] 群组 ${groupId} 空闲超过1分钟，开始自发对话`);
      await triggerSpontaneousChat(groupId, group.ai_members);
    }
  };
  
  const timer = setInterval(checkAndStartChat, 30000);
  autonomousTimers.set(groupId, timer);
  
  console.log(`[AI自发对话] 群组 ${groupId} 启动自发对话定时器`);
}

export function stopAutonomousChatTimer(groupId) {
  const timer = autonomousTimers.get(groupId);
  if (timer) {
    clearInterval(timer);
    autonomousTimers.delete(groupId);
    console.log(`[AI自发对话] 群组 ${groupId} 停止自发对话定时器`);
  }
}

async function triggerSpontaneousChat(groupId, aiMembers) {
  const chatKey = `autonomous:${groupId}`;
  
  if (activeGroups.has(chatKey)) {
    return;
  }

  let spontaneousUserId = null;
  try {
    const dbResult = await findGroupInAnyUserDb(groupId);
    if (dbResult) spontaneousUserId = dbResult.userId;
  } catch (e) {}

  if (spontaneousUserId) {
    await loadCustomPersonas(spontaneousUserId);
  }
  
  let maxConversationDepth = 6;
  if (aiMembers && aiMembers.length > 0) {
    const depths = aiMembers.map(aiId => {
      const persona = getEffectivePersona(aiId, spontaneousUserId);
      return persona?.responseConfig?.maxResponsesPerConversation || 6;
    });
    maxConversationDepth = depths.reduce((a, b) => Math.max(a, b), 6);
  }
  
  const context = { 
    cancel: false,
    conversationDepth: 0,
    maxConversationDepth,
    lastSpeakerId: null,
    conversationActive: true,
    isAutonomous: true
  };
  activeGroups.set(chatKey, context);
  
  try {
    const db = await findGroupInAnyUserDb(groupId);
    if (!db) {
      console.error(`[AI自发对话] 找不到群组 ${groupId}`);
      return;
    }
    
    const { db: userDb, group, userId: spontaneousUserId } = db;
    const recentMessages = await getRecentMessages(groupId, 20);
    
    let spontaneousUserAgents = [];
    try {
      const agentDb = await getUserDb(spontaneousUserId);
      await agentDb.read();
      if (agentDb.data.agents && agentDb.data.agents.length > 0) {
        spontaneousUserAgents = agentDb.data.agents.map(a => ({ id: a.id, name: a.name, description: a.description }));
      }
    } catch (e) {}
    
    const starterAi = aiMembers[Math.floor(Math.random() * aiMembers.length)];
    
    broadcastTypingStatus(groupId, starterAi, true);
    
    const persona = getEffectivePersona(starterAi, spontaneousUserId);
    if (persona) {
      const topics = [
        '最近在思考一个问题...',
        '今天看到一件有趣的事',
        '大家觉得怎么样？',
        '我有个想法想分享一下',
        '刚才想到了一个观点',
        '有个问题想和大家讨论'
      ];
      
      const randomTopic = topics[Math.floor(Math.random() * topics.length)];
      
      const { systemPrompt, userMessage: promptMessage } = buildWeChatStylePrompt(
        persona,
        randomTopic,
        recentMessages,
        aiMembers
      );
      
      const rawContent = await callAI(starterAi, persona, promptMessage, recentMessages, 'free_chat', null, [], null, aiMembers, false, [], spontaneousUserId);
      let content = normalizeResponse(rawContent);
      
      if (content && content.trim().length > 0) {
        content = applyMessageLengthLimit(content, persona);
        
        const messageId = uuidv4();
        const message = {
          id: messageId,
          group_id: groupId,
          sender_type: 'ai',
          sender_id: starterAi,
          content,
          content_type: 'text',
          created_at: new Date().toISOString()
        };
        
        await withWriteLock(spontaneousUserId, async () => {
          await userDb.read();
          userDb.data.messages.push(message);
          updateGroupActivityById(userDb, groupId, message);
          await userDb.write();
        });
        
        broadcastAIMessage(groupId, starterAi, content, null, messageId);
        context.lastSpeakerId = starterAi;
        
        console.log(`[AI自发对话] ${starterAi} 发起对话: ${content.substring(0, 50)}...`);
      }
      
      broadcastTypingStatus(groupId, starterAi, false);
    }
    
    await continueAIConversation(groupId, context, aiMembers, spontaneousUserAgents, null, spontaneousUserId);
    
  } catch (error) {
    console.error(`[AI自发对话] 错误:`, error);
  } finally {
    activeGroups.delete(chatKey);
  }
}

function parseReplyReference(content, recentMessages = []) {
  const oldReplyRegex = /【回复消息ID:([a-zA-Z0-9-]+)】/;
  const oldMatch = content.match(oldReplyRegex);
  
  const likeRegex = /【点赞】/g;
  const dislikeRegex = /【点踩】/g;
  const commentRegex = /【评论[：:]\s*([^】]+)】/g;
  
  let replyToId = null;
  let replyToIds = null;
  let cleanedContent = content;
  const socialActions = [];
  
  if (oldMatch) {
    replyToId = oldMatch[1];
    cleanedContent = cleanedContent.replace(oldReplyRegex, '').trim();
  } else {
    const quoteRegex = /^> (.+?)(?:\n([\s\S]*))?$/gm;
    const allQuoteMatches = [...content.matchAll(quoteRegex)];
    
    if (allQuoteMatches.length > 0 && recentMessages.length > 0) {
      replyToIds = [];
      let lastQuoteEndIndex = 0;
      
      for (const qm of allQuoteMatches) {
        const quotedText = qm[1].trim();
        const quotedContent = quotedText.replace(/^[^：:]+[：:]\s*/, '');
        
        let bestMatch = null;
        let bestScore = 0;
        
        for (const msg of recentMessages) {
          const msgContent = (msg.content || '').substring(0, 100);
          const similarity = calculateSimilarity(quotedContent, msgContent);
          
          if (similarity > bestScore && similarity > 0.3) {
            bestScore = similarity;
            bestMatch = msg;
          }
        }
        
        if (bestMatch && !replyToIds.includes(bestMatch.id)) {
          replyToIds.push(bestMatch.id);
        }
        
        lastQuoteEndIndex = qm.index + qm[0].length;
      }
      
      cleanedContent = content.substring(lastQuoteEndIndex).trim();
      
      if (replyToIds.length === 0) {
        replyToIds = null;
        cleanedContent = content;
      }
    }
  }
  
  const likeMatches = cleanedContent.match(likeRegex);
  if (likeMatches) {
    likeMatches.forEach(() => socialActions.push({ type: 'like' }));
    cleanedContent = cleanedContent.replace(likeRegex, '').trim();
  }
  
  const dislikeMatches = cleanedContent.match(dislikeRegex);
  if (dislikeMatches) {
    dislikeMatches.forEach(() => socialActions.push({ type: 'dislike' }));
    cleanedContent = cleanedContent.replace(dislikeRegex, '').trim();
  }
  
  let commentMatch;
  while ((commentMatch = commentRegex.exec(cleanedContent)) !== null) {
    socialActions.push({ type: 'comment', content: commentMatch[1].trim() });
  }
  cleanedContent = cleanedContent.replace(commentRegex, '').trim();
  
  return { replyToId, replyToIds, cleanedContent, socialActions };
}

async function processSocialActions(groupId, targetMessageId, aiId, socialActions) {
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result) return;
  
  const { db: userDb, userId: ownerUserId } = result;
  await userDb.read();
  
  const targetMessage = userDb.data.messages.find(m => m.id === targetMessageId);
  if (!targetMessage) return;
  
  for (const action of socialActions) {
    await sleep(300 + Math.random() * 500);
    
    if (action.type === 'like') {
      if (!targetMessage.liked_by) targetMessage.liked_by = [];
      
      const aiLikeId = `ai_${aiId}`;
      if (!targetMessage.liked_by.includes(aiLikeId)) {
        targetMessage.liked_by.push(aiLikeId);
        targetMessage.likes_count = (targetMessage.likes_count || 0) + 1;
        
        broadcastToGroup(groupId, {
          type: 'message_liked',
          group_id: groupId,
          message_id: targetMessageId,
          liked_by: aiId,
          liked_by_type: 'ai',
          timestamp: new Date().toISOString()
        });
      }
    } else if (action.type === 'dislike') {
      if (!targetMessage.disliked_by) targetMessage.disliked_by = [];
      
      const aiDislikeId = `ai_${aiId}`;
      if (!targetMessage.disliked_by.includes(aiDislikeId)) {
        targetMessage.disliked_by.push(aiDislikeId);
        targetMessage.dislikes_count = (targetMessage.dislikes_count || 0) + 1;
        
        broadcastToGroup(groupId, {
          type: 'message_disliked',
          group_id: groupId,
          message_id: targetMessageId,
          disliked_by: aiId,
          disliked_by_type: 'ai',
          timestamp: new Date().toISOString()
        });
      }
    } else if (action.type === 'comment' && action.content) {
      const commentId = `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const comment = {
        id: commentId,
        message_id: targetMessageId,
        sender_type: 'ai',
        sender_id: aiId,
        content: action.content,
        created_at: new Date().toISOString()
      };
      
      if (!targetMessage.comments) targetMessage.comments = [];
      targetMessage.comments.push(comment);
      
      broadcastToGroup(groupId, {
        type: 'new_comment',
        group_id: groupId,
        message_id: targetMessageId,
        comment: {
          id: commentId,
          message_id: targetMessageId,
          sender_type: 'ai',
          sender_id: aiId,
          content: action.content,
          created_at: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      });
    }
  }
  
  await withWriteLock(ownerUserId, async () => {
    await userDb.write();
  });
}

export function cancelGroupGeneration(groupId) {
  const chatKey = `group:${groupId}`;
  const aiChatKey = `ai_private:${groupId}`;
  const autonomousKey = `autonomous:${groupId}`;
  
  let cancelled = false;
  
  if (activeGroups.has(chatKey)) {
    const context = activeGroups.get(chatKey);
    context.cancel = true;
    
    if (context.streamId) {
      cancelStream(context.streamId);
    }
    
    activeGroups.delete(chatKey);
    cancelled = true;
  }
  
  if (activeGroups.has(aiChatKey)) {
    const context = activeGroups.get(aiChatKey);
    context.cancel = true;
    context.isRunning = false;
    
    if (context.streamId) {
      cancelStream(context.streamId);
    }
    
    activeGroups.delete(aiChatKey);
    cancelled = true;
  }
  
  if (activeGroups.has(autonomousKey)) {
    const context = activeGroups.get(autonomousKey);
    context.cancel = true;
    context.conversationActive = false;
    
    if (context.streamId) {
      cancelStream(context.streamId);
    }
    
    activeGroups.delete(autonomousKey);
    stopAutonomousChatTimer(groupId);
    cancelled = true;
  }
  
  return cancelled;
}

function buildWeChatStylePrompt(persona, userMessage, recentMessages, groupMembers, isMentioned = false, userAgents = null, isPrivateChat = false, userProfile = null, mentionedByName = null, attachmentDescriptions = null) {
  let parts = [];

  if (isPrivateChat) {
    parts.push(`你是${persona.name}，正在与用户进行一对一私聊。你必须严格按照你的人设来发言，不得偏离。`);
    parts.push('这是你和用户之间的私密对话，你必须认真回答用户的每一个问题，不得敷衍或回避。你只需要回复用户的消息，不要自言自语，不要自己和自己对话。');
  } else {
    parts.push(`你是${persona.name}。你必须严格按照你的人设来发言，不得偏离你的人设设定。`);
  }

  if (persona.styleTag) {
    parts.push(`你的风格标签是"${persona.styleTag}"。这是你的核心风格标识，你的每一句话、每一个用词都必须严格体现"${persona.styleTag}"这个风格，绝对不能偏离。`);
  }

  if (persona.style) {
    parts.push(`风格：${persona.style}。你必须始终贯彻这个风格，你的语气、用词、表达方式都要完全符合这个风格描述，不得有任何偏离。`);
  }

  if (persona.personality) {
    parts.push(`性格：${persona.personality}。你的每句话都必须体现这种性格，你的态度、情感倾向、思考方式都要严格受此性格驱动，不得表现出与此性格矛盾的特征。`);
  }

  if (persona.replyStyle) {
    parts.push(`说话方式：${persona.replyStyle}。你必须严格按照这种方式说话，包括你的语气、句式、修辞手法都要符合这个说话方式，不得使用与此方式矛盾的表达。`);
  }

  if (persona.typicalPhrases && persona.typicalPhrases.length > 0) {
    parts.push(`你必须经常使用以下口头禅：${persona.typicalPhrases.join('、')}。在合适的语境中必须自然地插入这些口头禅，这是你说话的标志性特征，不得遗漏。`);
  }

  if (persona.keywords && persona.keywords.length > 0) {
    parts.push(`你特别关注这些关键词和话题：${persona.keywords.join('、')}。当聊天涉及这些话题时，你必须更积极地发言，展现你在这方面的见解，不得对这些话题保持沉默。`);
  }

  if (persona.firstSpeakerTopics && persona.firstSpeakerTopics.length > 0) {
    parts.push(`你擅长主动发起以下话题：${persona.firstSpeakerTopics.join('、')}。当群聊冷场或话题相关时，你必须主动提出这些话题来引导讨论。`);
  }

  if (persona.expertise && persona.expertise.length > 0) {
    parts.push(`你擅长的专业领域：${persona.expertise.join('、')}。当聊天涉及这些领域时，你必须展现专业深度，提供有见地的分析，不得给出肤浅或外行的回答。`);
  }

  if (persona.speakingTraits) {
    parts.push(`你的说话特点：${persona.speakingTraits}。你的每一句话都必须体现这些说话特点，包括你的用词习惯、句式结构、表达节奏都要严格符合，不得偏离。`);
  }

  if (persona.debateTendency) {
    const debateGuide = {
      low: '你的辩论倾向是温和型。你必须倾向于赞同和附和他人，避免激烈争论。即使不同意，也必须委婉表达，不得直接反驳或激烈对抗。',
      medium: '你的辩论倾向是平衡型。你必须理性地表达不同意见，既不回避也不激进。你会平衡表达自己的观点，坚持立场的同时尊重他人。',
      high: '你的辩论倾向是激进型。你必须主动反驳和质疑，热衷于激烈辩论。你必须主动寻找对方观点的漏洞并猛烈反驳，绝不轻易退让。'
    };
    if (debateGuide[persona.debateTendency]) {
      parts.push(debateGuide[persona.debateTendency]);
    }
  }

  if (persona.questionProbability && persona.questionProbability > 0.3) {
    parts.push(`你必须在回复中主动提出问题来引导讨论方向，这是你说话的重要特征之一，不得忽略。`);
  }

  if (persona.messageLength) {
    const lengthGuide = {
      short: '你必须将回复控制在50-150字以内，简短精炼，直击要点，不得超出此长度范围。',
      medium: '你必须将回复控制在150-300字左右，表达清晰完整，不得过短或过长。',
      long: '你必须写300-500字的详细回复，深入分析，充分展开论证，不得过于简略。'
    };
    parts.push(lengthGuide[persona.messageLength] || '');
  }

  if (persona.preferredRole && persona.preferredRole !== 'analyst') {
    const roleGuide = {
      expert: '你必须以专家身份发言，提供权威解答和深入分析，不得给出非专业的回答。',
      student: '你必须以学习者身份发言，谦虚提问，共同探讨，不得以权威姿态发言。',
      critic: '你必须以评论家身份发言，用批判性思维指出问题，不得盲目认同。',
      mediator: '你必须以调解者身份发言，平衡各方观点，化解分歧，不得偏袒任何一方。',
      innovator: '你必须以创新者身份发言，提出新想法，突破常规，不得因循守旧。',
      supporter: '你必须以支持者身份发言，鼓励肯定，提供帮助，不得打击或否定他人。',
      challenger: '你必须以挑战者身份发言，提出质疑，激发思考，不得轻易接受现有观点。',
      teacher: '你必须以导师身份发言，循循善诱，启发思考，不得直接给出答案而不解释。',
      storyteller: '你必须以故事家身份发言，善用故事和比喻表达，不得使用干巴巴的陈述。',
      pragmatist: '你必须以实用主义者身份发言，注重实际，追求效率，不得空谈理论。',
      philosopher: '你必须以哲学家身份发言，深度思考，追求本质，不得停留在表面。',
      humorist: '你必须以幽默家身份发言，风趣幽默，活跃气氛，不得严肃刻板。',
      skeptic: '你必须以怀疑论者身份发言，理性怀疑，追求真相，不得轻信任何未经验证的说法。',
      optimist: '你必须以乐观主义者身份发言，积极向上，充满希望，不得消极悲观。',
      realist: '你必须以现实主义者身份发言，客观冷静，直面现实，不得回避或美化问题。',
      custom: persona.customRoleName ? `你的角色定位：${persona.customRoleName}。你必须严格按照这个角色定位来发言。` : ''
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
      parts.push(`你必须经常引用别人的消息来回复，使用格式 "> 对方名字: 对方说的话" 来引用。每次最多引用${maxQuotes}条消息。这是你重要的互动方式，不得忽略。`);
    } else if (quoteProb > 0.2) {
      parts.push(`你可以在合适时引用别人的消息来回复，使用格式 "> 对方名字: 对方说的话" 来引用。每次最多引用${maxQuotes}条消息。`);
    }
  } else {
    parts.push('你不需要引用别人的消息，直接回复即可。');
  }

  if (isMentioned) {
    if (mentionedByName) {
      parts.push(`${mentionedByName} @了你，你必须回复。`);
    } else {
      parts.push('有人@了你，你必须回复。');
    }
  }

  if (!isPrivateChat && userAgents && userAgents.length > 0) {
    const agentsInfo = userAgents.map(agent => {
      const caps = [];
      if (agent.capabilities?.scheduled_tasks) caps.push('定时任务');
      if (agent.capabilities?.web_search) caps.push('网络搜索');
      if (agent.capabilities?.multimodal) caps.push('多模态');
      return `- ${agent.name}：${agent.description}${caps.length > 0 ? `（能力：${caps.join('、')}）` : ''}`;
    }).join('\n');
    parts.push(`\n【用户创建的智能体】\n你可以在合适的时机调用这些智能体来完成任务。\n使用格式：[CALL_AGENT:智能体ID] 来调用智能体，调用后在消息旁标注"此消息调用了XX智能体"\n${agentsInfo}`);
  }

  if (isPrivateChat && userProfile) {
    const userFields = [];
    if (userProfile.nickname) userFields.push(`昵称：${userProfile.nickname}`);
    if (userProfile.gender) userFields.push(`性别：${userProfile.gender}`);
    if (userProfile.age) userFields.push(`年龄：${userProfile.age}`);
    if (userProfile.occupation) userFields.push(`职业：${userProfile.occupation}`);
    if (userProfile.hobbies && userProfile.hobbies.length > 0) userFields.push(`爱好：${Array.isArray(userProfile.hobbies) ? userProfile.hobbies.join('、') : userProfile.hobbies}`);
    if (userProfile.bio) userFields.push(`自我介绍：${userProfile.bio}`);
    if (userFields.length > 0) {
      parts.push(`\n【用户信息】\n${userFields.join('\n')}`);
    }
  }

  if (!isPrivateChat) {
    const otherMembers = groupMembers?.filter(id => id !== persona.id) || [];
    if (otherMembers.length > 0) {
      const otherNames = otherMembers.map(id => {
        const p = getEffectivePersona(id);
        return p?.name || id;
      }).join('、');
      parts.push(`群里还有：${otherNames}`);
    }
  }

  if (recentMessages && recentMessages.length > 0) {
    const contextLimit = isPrivateChat ? 30 : 20;
    const recent = recentMessages.slice(-contextLimit);
    const history = recent.map(m => {
      let sender;
      if (m.sender_type === 'user') {
        sender = userProfile?.nickname || '用户';
      } else {
        sender = AI_NAMES[m.sender_id] || m.sender_id || '某人';
      }
      return `${sender}: ${m.content}`;
    }).join('\n');
    parts.push(`\n【${isPrivateChat ? '私聊' : '聊天'}记录】\n${history}`);
  }

  if (attachmentDescriptions && attachmentDescriptions.length > 0) {
    const attachmentParts = attachmentDescriptions.map(att => {
      if (att.type === 'image') {
        return `【用户上传的图片: ${att.name}】\n图片内容描述: ${att.description}`;
      } else if (att.type === 'audio') {
        return `【用户上传的音频: ${att.name}】\n音频内容描述: ${att.description}`;
      } else if (att.type === 'video') {
        return `【用户上传的视频: ${att.name}】\n视频内容描述: ${att.description}`;
      } else {
        return `【用户上传的文件: ${att.name}】\n文件内容: ${att.description}`;
      }
    }).join('\n\n');
    parts.push(`\n【用户上传的附件内容】\n${attachmentParts}`);
  }

  if (userMessage) {
    if (isPrivateChat) {
      const userName = userProfile?.nickname || '用户';
      parts.push(`\n${userName}说：${userMessage}`);
    } else {
      parts.push(`\n用户说：${userMessage}`);
    }
  }

  let lastOtherAiMessageId = null;
  if (!isPrivateChat && recentMessages && recentMessages.length > 0) {
    const recent = recentMessages.slice(-20);
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (m.sender_type === 'ai' && m.sender_id !== persona.id) {
        lastOtherAiMessageId = m.id;
        break;
      }
    }
  }

  return {
    systemPrompt: parts.join('\n'),
    userMessage: userMessage || (isPrivateChat ? '你好' : '开始聊天吧'),
    suggestedReplyTo: lastOtherAiMessageId
  };
}

async function generateAIResponse(aiId, groupId, userMessage, recentMessages, groupMembers, context, isMentioned = false, userAgents = null, isPrivateChat = false, userProfile = null, mentionedByName = null, userId = null, attachmentDescriptions = null) {
  if (context.cancel) return null;
  
  const persona = getEffectivePersona(aiId, userId);
  if (!persona) return null;
  
  const responseConfig = persona.responseConfig || {};
  if (responseConfig.enabled === false) return null;

  if (responseConfig.activeHours) {
    const currentHour = new Date().getHours();
    const start = responseConfig.activeHours.start ?? 0;
    const end = responseConfig.activeHours.end ?? 24;
    if (end > start) {
      if (currentHour < start || currentHour >= end) return null;
    } else if (end < start) {
      if (currentHour >= end && currentHour < start) return null;
    }
  }

  if (isPrivateChat) {
    const lastUserMessage = recentMessages && recentMessages.length > 0
      ? [...recentMessages].reverse().find(m => m.sender_type === 'user')
      : null;
    if (!lastUserMessage && !userMessage) {
      return null;
    }
  }
  
  let responseFrequency = responseConfig.responseFrequency ?? 0.8;
  if (isMentioned) {
    responseFrequency = 1.0;
  }
  if (isPrivateChat) {
    responseFrequency = 1.0;
  }
  
  if (Math.random() > responseFrequency) {
    return null;
  }

  const silenceProbability = persona.silenceProbability ?? 0;
  if (!isMentioned && !isPrivateChat && Math.random() < silenceProbability) {
    return null;
  }
  
  const socialConfig = persona.socialConfig || {};
  let interactionProbability = socialConfig.interactionProbability ?? 0.9;
  if (isMentioned) {
    interactionProbability = 1.0;
  }
  if (isPrivateChat) {
    interactionProbability = 1.0;
  }
  
  const lastOtherAiMessage = !isPrivateChat && recentMessages && recentMessages.length > 0
    ? [...recentMessages].reverse().find(m => m.sender_type === 'ai' && m.sender_id !== aiId)
    : null;
  
  const lastUserMessage = recentMessages && recentMessages.length > 0
    ? [...recentMessages].reverse().find(m => m.sender_type === 'user')
    : null;
  
  let shouldInteractWithAi = false;
  if (!isPrivateChat && lastOtherAiMessage && Math.random() < interactionProbability) {
    const timeSinceLastAi = Date.now() - new Date(lastOtherAiMessage.created_at).getTime();
    if (timeSinceLastAi < 120000) {
      shouldInteractWithAi = true;
    }
  }
  
  const minDelay = isPrivateChat ? 200 : (responseConfig.minDelay ?? 300);
  const maxDelay = isPrivateChat ? 800 : (responseConfig.maxDelay ?? 1500);
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  await sleep(delay);
  
  if (context.cancel) return null;
  
  broadcastTypingStatus(groupId, aiId, true);
  
  const messageId = uuidv4();
  const streamId = `stream_${groupId}_${aiId}_${messageId}`;
  
  try {
    const { systemPrompt, userMessage: promptMessage, suggestedReplyTo } = buildWeChatStylePrompt(
      persona, 
      userMessage, 
      recentMessages, 
      groupMembers,
      isMentioned,
      isPrivateChat ? null : userAgents,
      isPrivateChat,
      userProfile,
      mentionedByName,
      attachmentDescriptions
    );
    
    let accumulatedContent = '';
    let lastBroadcastTime = Date.now();
    let lastBroadcastLength = 0;
    const broadcastThrottleMs = 50;
    
    broadcastStreamStart(groupId, aiId, messageId);
    
    const onChunk = (chunk) => {
      if (context.cancel) return;
      accumulatedContent += chunk;
      
      const now = Date.now();
      if (now - lastBroadcastTime >= broadcastThrottleMs) {
        const incremental = accumulatedContent.substring(lastBroadcastLength);
        broadcastStreamChunk(groupId, aiId, messageId, accumulatedContent, false, incremental);
        lastBroadcastLength = accumulatedContent.length;
        lastBroadcastTime = now;
      }
    };
    
    context.streamId = streamId;
    
    const rawContent = await callAIStream(
      aiId, 
      persona, 
      promptMessage, 
      recentMessages, 
      isPrivateChat ? 'private_chat' : 'wechat_chat', 
      userProfile,
      [], 
      null, 
      groupMembers, 
      isPrivateChat, 
      [],
      null,
      [],
      onChunk,
      streamId,
      userId,
      isPrivateChat ? null : userAgents
    );
    
    let content = normalizeResponse(rawContent);
    
    if (!content || content.trim().length === 0) {
      broadcastTypingStatus(groupId, aiId, false);
      broadcastStreamEnd(groupId, aiId, messageId, '', null, null);
      return null;
    }
    
    content = applyMessageLengthLimit(content, persona);
    
    broadcastTypingStatus(groupId, aiId, false);
    
    return { 
      aiId, 
      content, 
      persona,
      suggestedReplyTo,
      shouldInteractWithAi,
      messageId
    };
    
  } catch (error) {
    console.error(`AI ${aiId} 生成消息失败:`, error.message);
    broadcastTypingStatus(groupId, aiId, false);
    broadcastStreamEnd(groupId, aiId, messageId, '', null, null);
    return null;
  }
}

async function collectAttachmentDescriptions(groupId, userId) {
  const descriptions = [];
  try {
    const db = await getUserDbForFiles(userId);
    await db.read();
    const recentMessages = db.data.messages
      .filter(m => m.group_id === groupId)
      .slice(-5);

    for (const msg of recentMessages) {
      if (msg.sender_type !== 'user' || !msg.attachments || msg.attachments.length === 0) continue;

      for (const att of msg.attachments) {
        const fileId = att.id || att.url?.split('/').pop() || att.url?.split('/files/').pop()?.replace('/download', '');
        if (!fileId) continue;

        const fileRecord = db.data.files.find(f => f.id === fileId);
        if (!fileRecord) continue;

        const ext = path.extname(fileRecord.filename).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
        const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'].includes(ext);
        const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'].includes(ext);

        let description = fileRecord.media_description || '';
        if (!description) {
          if (typeof fileRecord.parsed_content === 'string' && fileRecord.parsed_content.length > 0) {
            description = fileRecord.parsed_content.substring(0, 500);
          } else if (fileRecord.search_description) {
            description = fileRecord.search_description;
          }
        }

        if (description) {
          descriptions.push({
            id: fileRecord.id,
            name: fileRecord.filename,
            type: isImage ? 'image' : isAudio ? 'audio' : isVideo ? 'video' : 'file',
            description
          });
        }
      }
    }
  } catch (error) {
    console.warn('[附件描述收集] 失败:', error.message);
  }
  return descriptions;
}

export async function queueAIMessages(groupId, userMessage, replyTo = null) {
  console.log(`[AI消息队列] 开始处理群组 ${groupId} 的消息: "${userMessage?.substring(0, 50)}..."`);
  
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result || !result.group || !result.group.ai_members || result.group.ai_members.length === 0) {
    console.log(`[AI消息队列] 群组 ${groupId} 没有 AI 成员，跳过`);
    return;
  }
  
  const { db: userDb, group, userId } = result;

  await loadCustomPersonas(userId);

  const isPrivateChat = group.is_ai_private === true || group.type === 'ai_private' || (group.is_private === true && group.ai_members && group.ai_members.length === 1 && group.type !== 'ai_private');
  
  let userAgents = [];
  let userProfile = null;
  try {
    const profileDb = await getUserDb(userId);
    await profileDb.read();
    if (profileDb.data.agents && profileDb.data.agents.length > 0) {
      userAgents = profileDb.data.agents.map(a => ({ id: a.id, name: a.name, description: a.description }));
    }
    if (profileDb.data.userProfile) {
      userProfile = profileDb.data.userProfile;
    }
  } catch (e) {
    console.warn(`[AI消息队列] 加载用户数据失败:`, e.message);
  }
  
  console.log(`[AI消息队列] 群组 ${groupId} 有 ${group.ai_members.length} 个 AI 成员: ${group.ai_members.join(', ')}${isPrivateChat ? ' (私聊模式)' : ''}`);
  
  const chatKey = `group:${groupId}`;
  if (activeGroups.has(chatKey)) {
    const existingContext = activeGroups.get(chatKey);
    existingContext.cancel = true;
    
    if (existingContext.streamId) {
      cancelStream(existingContext.streamId);
    }
    
    activeGroups.delete(chatKey);
    console.log(`[AI消息队列] 群组 ${groupId} 已有活跃对话，已取消旧对话`);
  }
  
  let maxConversationDepth = isPrivateChat ? 1 : 8;
  if (!isPrivateChat && group.ai_members && group.ai_members.length > 0) {
    const depths = group.ai_members.map(aiId => {
      const persona = getEffectivePersona(aiId, userId);
      return persona?.responseConfig?.maxResponsesPerConversation || 8;
    });
    maxConversationDepth = depths.reduce((a, b) => Math.max(a, b), 8);
  }
  
  const mentionedAIs = [];
  const mentionedByNames = {};
  if (userMessage) {
    const mentionRegex = /@([a-zA-Z0-9_.\u4e00-\u9fff\s-]+)/g;
    let match;
    while ((match = mentionRegex.exec(userMessage)) !== null) {
      const mentionText = match[1].trim();
      
      for (const [aiId, aliases] of Object.entries(AI_MENTION_ALIASES)) {
        if (aliases.some(alias => alias.toLowerCase() === mentionText.toLowerCase())) {
          if (group.ai_members.includes(aiId) && !mentionedAIs.includes(aiId)) {
            mentionedAIs.push(aiId);
            mentionedByNames[aiId] = userProfile?.nickname || '用户';
          }
          break;
        }
      }
      
      if (!mentionedAIs.length) {
        for (const aiId of group.ai_members) {
          const persona = getEffectivePersona(aiId, userId);
          if (persona && persona.name && mentionText.toLowerCase() === persona.name.toLowerCase()) {
            if (!mentionedAIs.includes(aiId)) {
              mentionedAIs.push(aiId);
              mentionedByNames[aiId] = userProfile?.nickname || '用户';
            }
            break;
          }
        }
      }
    }
  }
  
  const context = { 
    cancel: false,
    conversationDepth: 0,
    maxConversationDepth,
    lastSpeakerId: null,
    conversationActive: !isPrivateChat,
    mentionedAIs,
    isPrivateChat
  };
  activeGroups.set(chatKey, context);
  
  const recentMessages = await getRecentMessages(groupId);

  let attachmentDescriptions = [];
  try {
    attachmentDescriptions = await collectAttachmentDescriptions(groupId, userId);
  } catch (error) {
    console.warn('[AI消息队列] 收集附件描述失败:', error.message);
  }

  let orderedAiMembers = [...group.ai_members];
  orderedAiMembers.sort((a, b) => {
    const aMentioned = mentionedAIs.includes(a);
    const bMentioned = mentionedAIs.includes(b);
    if (aMentioned && !bMentioned) return -1;
    if (!aMentioned && bMentioned) return 1;
    const aPersona = getEffectivePersona(a, userId);
    const bPersona = getEffectivePersona(b, userId);
    const aOrder = aPersona?.speakingOrder ?? 3;
    const bOrder = bPersona?.speakingOrder ?? 3;
    return aOrder - bOrder;
  });
  
  if (isPrivateChat) {
    orderedAiMembers = orderedAiMembers.slice(0, 1);
  }
  
  const aiPromises = orderedAiMembers.map(async aiId => {
    const isMentioned = mentionedAIs.includes(aiId);
    const mentionedByName = mentionedByNames[aiId] || null;
    const result = await generateAIResponse(aiId, groupId, userMessage, recentMessages, group.ai_members, context, isMentioned, userAgents, isPrivateChat, userProfile, mentionedByName, userId, attachmentDescriptions);
    
    if (context.cancel) return null;
    
    if (!result) {
      const refusalMsg = generateRefusalMessage(aiId, userId);
      const refusalMessageId = uuidv4();
      const refusalMessage = {
        id: refusalMessageId,
        group_id: groupId,
        sender_type: 'system',
        sender_id: aiId,
        content: refusalMsg,
        content_type: 'system',
        created_at: new Date().toISOString()
      };
      
      await withWriteLock(userId, async () => {
        await userDb.read();
        userDb.data.messages.push(refusalMessage);
        updateGroupActivityById(userDb, groupId, refusalMessage);
        await userDb.write();
      });
      
      broadcastToGroup(groupId, {
        type: 'system_message',
        group_id: groupId,
        content: refusalMsg,
        sender_id: aiId,
        timestamp: new Date().toISOString()
      });
      
      return null;
    }
    
    const { aiId: resultAiId, content, suggestedReplyTo, shouldInteractWithAi, messageId } = result;
    
    const { replyToId, replyToIds, cleanedContent, socialActions } = parseReplyReference(content, recentMessages);
    
    if (!cleanedContent || cleanedContent.trim().length === 0) {
      console.warn(`[AI消息] ${resultAiId} 的内容在清理后为空，跳过保存`);
      return null;
    }
    
    let finalContent = cleanedContent;
    let agentCallInfo = null;
    
    const agentCallRegex = /\[CALL_AGENT:([a-zA-Z0-9_-]+)\]/g;
    const agentCallMatches = [...finalContent.matchAll(agentCallRegex)];
    
    if (agentCallMatches.length > 0) {
      for (const match of agentCallMatches) {
        const agentId = match[1];
        try {
          const agentResponse = await invokeAgentInGroup(userId, agentId, finalContent);
          const agentName = userAgents.find(a => a.id === agentId)?.name || agentId;
          finalContent = finalContent.replace(match[0], agentResponse || '');
          agentCallInfo = { agentId, agentName };
        } catch (e) {
          console.warn(`[AI消息] 调用智能体 ${agentId} 失败:`, e.message);
          finalContent = finalContent.replace(match[0], `[智能体${agentId}调用失败]`);
        }
      }
    }
    
    let effectiveReplyTo = replyToId || replyTo;
    
    if (!effectiveReplyTo && shouldInteractWithAi && suggestedReplyTo) {
      effectiveReplyTo = suggestedReplyTo;
    }
    
    const finalReplyToIds = replyToIds && replyToIds.length > 0 ? replyToIds : null;
    
    const finalMessageId = messageId || uuidv4();
    const message = {
      id: finalMessageId,
      group_id: groupId,
      sender_type: 'ai',
      sender_id: resultAiId,
      content: finalContent,
      content_type: 'text',
      reply_to: effectiveReplyTo,
      reply_to_ids: finalReplyToIds,
      metadata: agentCallInfo ? { agent_call: agentCallInfo } : undefined,
      created_at: new Date().toISOString()
    };
    
    await withWriteLock(userId, async () => {
      await userDb.read();
      userDb.data.messages.push(message);
      updateGroupActivityById(userDb, groupId, message);
      await userDb.write();
    });
    
    broadcastStreamEnd(groupId, resultAiId, finalMessageId, finalContent, effectiveReplyTo, finalReplyToIds);
    
    console.log(`[AI消息] ${resultAiId} 消息已广播，messageId: ${finalMessageId}, content_len: ${cleanedContent.length}`);
    
    if (socialActions && socialActions.length > 0 && effectiveReplyTo) {
      await processSocialActions(groupId, effectiveReplyTo, resultAiId, socialActions);
    }
    
    context.lastSpeakerId = resultAiId;
    
    return result;
  });
  
  const results = await Promise.allSettled(aiPromises);
  const successfulResults = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
  
  if (successfulResults.length > 0 && !context.cancel && !isPrivateChat) {
    await continueAIConversation(groupId, context, group.ai_members, userAgents, userProfile, userId);
  }
  
  activeGroups.delete(chatKey);
  
  if (!isPrivateChat) {
    startAutonomousChatTimer(groupId);
  }
}

async function continueAIConversation(groupId, context, aiMembers, userAgents = null, userProfile = null, userId = null) {
  let dbResult = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!dbResult) return;
  
  while (context.conversationActive && context.conversationDepth < context.maxConversationDepth && !context.cancel) {
    context.conversationDepth++;
    console.log(`[AI对话] 群组 ${groupId} 第 ${context.conversationDepth} 轮对话开始`);
    
    const cooldownMs = (() => {
      const cooldowns = aiMembers.map(aiId => {
        const p = getEffectivePersona(aiId, userId);
        return p?.responseConfig?.cooldownBetweenResponses ?? 2000;
      });
      return Math.max(...cooldowns);
    })();
    const delay = cooldownMs + Math.random() * 1500;
    await sleep(delay);
    
    if (context.cancel) break;
    
    const recentMessages = await getRecentMessages(groupId, 50);
    
    const lastAiMessage = [...recentMessages].reverse().find(m => m.sender_type === 'ai');
    if (!lastAiMessage) {
      console.log(`[AI对话] 没有找到AI消息，退出对话`);
      break;
    }
    
    let mentionedAIs = [];
    const mentionedByNames = {};
    if (lastAiMessage.content) {
      const mentionRegex = /@([a-zA-Z0-9_.\u4e00-\u9fff\s-]+)/g;
      let match;
      while ((match = mentionRegex.exec(lastAiMessage.content)) !== null) {
        const mentionText = match[1].trim();
        for (const [aiId, aliases] of Object.entries(AI_MENTION_ALIASES)) {
          if (aliases.some(alias => alias.toLowerCase() === mentionText.toLowerCase())) {
            if (aiMembers.includes(aiId) && !mentionedAIs.includes(aiId)) {
              mentionedAIs.push(aiId);
              const senderPersona = getEffectivePersona(lastAiMessage.sender_id, userId);
              mentionedByNames[aiId] = senderPersona?.name || lastAiMessage.sender_id;
            }
            break;
          }
        }
        
        if (!mentionedAIs.length) {
          for (const aiId of aiMembers) {
            const persona = getEffectivePersona(aiId, userId);
            if (persona && persona.name && mentionText.toLowerCase() === persona.name.toLowerCase()) {
              if (!mentionedAIs.includes(aiId)) {
                mentionedAIs.push(aiId);
                const senderPersona = getEffectivePersona(lastAiMessage.sender_id, userId);
                mentionedByNames[aiId] = senderPersona?.name || lastAiMessage.sender_id;
              }
              break;
            }
          }
        }
      }
    }
    
    let respondingAis = [...aiMembers];
    
    if (mentionedAIs.length > 0) {
      respondingAis.sort((a, b) => {
        const aMentioned = mentionedAIs.includes(a);
        const bMentioned = mentionedAIs.includes(b);
        if (aMentioned && !bMentioned) return -1;
        if (!aMentioned && bMentioned) return 1;
        return 0;
      });
    }
    
    console.log(`[AI对话] 准备让 ${respondingAis.join(', ')} 回应`);
    
    let validResponseCount = 0;
    
    for (const aiId of respondingAis) {
      if (context.cancel) break;
      
      const persona = getEffectivePersona(aiId, userId);
      if (!persona) continue;
      
      const isMentioned = mentionedAIs.includes(aiId);
      let interactionProb = persona.socialConfig?.interactionProbability ?? 0.9;
      if (isMentioned) {
        interactionProb = 1.0;
      }
      
      if (Math.random() > interactionProb) {
        console.log(`[AI对话] ${aiId} 决定不回应`);
        const refusalMsg = generateRefusalMessage(aiId, userId);
        const refusalMessageId = uuidv4();
        const refusalMessage = {
          id: refusalMessageId,
          group_id: groupId,
          sender_type: 'system',
          sender_id: aiId,
          content: refusalMsg,
          content_type: 'system',
          created_at: new Date().toISOString()
        };
        
        await withWriteLock(dbResult.userId, async () => {
          await dbResult.db.read();
          dbResult.db.data.messages.push(refusalMessage);
          updateGroupActivityById(dbResult.db, groupId, refusalMessage);
          await dbResult.db.write();
        });
        
        broadcastToGroup(groupId, {
          type: 'system_message',
          group_id: groupId,
          content: refusalMsg,
          sender_id: aiId,
          timestamp: new Date().toISOString()
        });
        
        continue;
      }
      
      const responseDelay = 500 + Math.random() * 1500;
      await sleep(responseDelay);
      
      if (context.cancel) break;
      
      console.log(`[AI对话] ${aiId} 开始生成回应${isMentioned ? ' (被@)' : ''}`);
      
      const mentionedByName = mentionedByNames[aiId] || null;
      const result = await generateAIResponse(aiId, groupId, null, recentMessages, aiMembers, context, isMentioned, userAgents, false, userProfile, mentionedByName, userId);
      
      if (context.cancel || !result) continue;
      
      const { aiId: resultAiId, content, suggestedReplyTo, messageId } = result;
      
      const { replyToId, replyToIds, cleanedContent, socialActions } = parseReplyReference(content, recentMessages);
      
      if (!cleanedContent || cleanedContent.trim().length === 0) {
        console.warn(`[AI对话] ${resultAiId} 的内容在清理后为空，跳过保存`);
        continue;
      }
      
      let finalContent = cleanedContent;
      let agentCallInfo = null;
      
      const agentCallRegex = /\[CALL_AGENT:([a-zA-Z0-9_-]+)\]/g;
      const agentCallMatches = [...finalContent.matchAll(agentCallRegex)];
      
      if (agentCallMatches.length > 0) {
        const convUserId = dbResult.userId;
        for (const match of agentCallMatches) {
          const agentId = match[1];
          try {
            const agentResponse = await invokeAgentInGroup(convUserId, agentId, finalContent);
            const agentName = (userAgents || []).find(a => a.id === agentId)?.name || agentId;
            finalContent = finalContent.replace(match[0], agentResponse || '');
            agentCallInfo = { agentId, agentName };
          } catch (e) {
            console.warn(`[AI对话] 调用智能体 ${agentId} 失败:`, e.message);
            finalContent = finalContent.replace(match[0], `[智能体${agentId}调用失败]`);
          }
        }
      }
      
      const effectiveReplyTo = replyToId || suggestedReplyTo || lastAiMessage.id;
      const finalReplyToIds = replyToIds && replyToIds.length > 0 ? replyToIds : null;
      
      const finalMessageId = messageId || uuidv4();
      const message = {
        id: finalMessageId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: resultAiId,
        content: finalContent,
        content_type: 'text',
        reply_to: effectiveReplyTo,
        reply_to_ids: finalReplyToIds,
        metadata: agentCallInfo ? { agent_call: agentCallInfo } : undefined,
        created_at: new Date().toISOString()
      };
      
      await withWriteLock(dbResult.userId, async () => {
        await dbResult.db.read();
        dbResult.db.data.messages.push(message);
        updateGroupActivityById(dbResult.db, groupId, message);
        await dbResult.db.write();
      });
      
      broadcastStreamEnd(groupId, resultAiId, finalMessageId, finalContent, effectiveReplyTo, finalReplyToIds);
      
      console.log(`[AI对话] ${resultAiId} 发送了消息: ${cleanedContent.substring(0, 50)}...`);
      
      if (socialActions && socialActions.length > 0 && effectiveReplyTo) {
        await processSocialActions(groupId, effectiveReplyTo, resultAiId, socialActions);
      }
      
      context.lastSpeakerId = resultAiId;
      validResponseCount++;
      
      const updatedRecentMessages = await getRecentMessages(groupId, 50);
      const newLastMessage = [...updatedRecentMessages].reverse().find(m => m.sender_type === 'ai');
      if (newLastMessage && newLastMessage.id !== lastAiMessage.id) {
        recentMessages.length = 0;
        recentMessages.push(...updatedRecentMessages);
      }
    }
    
    console.log(`[AI对话] 第 ${context.conversationDepth} 轮完成，${validResponseCount} 个AI回应了`);
    
    if (validResponseCount === 0) {
      console.log(`[AI对话] 没有AI回应，结束对话`);
      context.conversationActive = false;
    }
    
    if (context.conversationDepth >= context.maxConversationDepth) {
      console.log(`[AI对话] 达到最大对话深度 ${context.maxConversationDepth}，结束对话`);
      context.conversationActive = false;
    }
  }
  
  console.log(`[AI对话] 群组 ${groupId} 对话结束，共 ${context.conversationDepth} 轮`);
}

export async function startAutonomousChat(groupId, topic = null) {
  const result = await findGroupInAnyUserDb(groupId);
  if (!result || !result.group || !result.group.ai_members || result.group.ai_members.length < 2) {
    return { success: false, error: '群组不存在或AI成员不足' };
  }
  
  const { db: userDb, group, userId: autonomousUserId } = result;

  await loadCustomPersonas(autonomousUserId);

  let autonomousUserAgents = [];
  try {
    const agentDb = await getUserDb(autonomousUserId);
    await agentDb.read();
    if (agentDb.data.agents && agentDb.data.agents.length > 0) {
      autonomousUserAgents = agentDb.data.agents.map(a => ({ id: a.id, name: a.name, description: a.description }));
    }
  } catch (e) {}
  
  const chatKey = `autonomous:${groupId}`;
  if (activeGroups.has(chatKey)) {
    return { success: false, error: '对话已在进行中' };
  }
  
  const context = { 
    cancel: false,
    conversationDepth: 0,
    maxConversationDepth: 8,
    lastSpeakerId: null,
    conversationActive: true,
    isAutonomous: true
  };
  activeGroups.set(chatKey, context);
  
  console.log(`[AI自主对话] 群组 ${groupId} 开始自主对话`);
  
  broadcastToGroup(groupId, {
    type: 'autonomous_chat_started',
    group_id: groupId,
    timestamp: new Date().toISOString()
  });
  
  try {
    const recentMessages = await getRecentMessages(groupId, 50);
    const chatTopic = topic || getRandomTopic();
    
    console.log(`[AI自主对话] 话题: ${chatTopic}`);
    
    const starterAi = group.ai_members[Math.floor(Math.random() * group.ai_members.length)];
    
    broadcastTypingStatus(groupId, starterAi, true);
    
    const persona = getEffectivePersona(starterAi, autonomousUserId);
    if (persona) {
      const { systemPrompt, userMessage: promptMessage } = buildWeChatStylePrompt(
        persona,
        chatTopic,
        recentMessages,
        group.ai_members
      );
      
      const rawContent = await callAI(starterAi, persona, promptMessage, recentMessages, 'free_chat', null, [], null, group.ai_members, false, [], autonomousUserId);
      let content = normalizeResponse(rawContent);
      
      if (content && content.trim().length > 0) {
        content = applyMessageLengthLimit(content, persona);
        
        const messageId = uuidv4();
        const message = {
          id: messageId,
          group_id: groupId,
          sender_type: 'ai',
          sender_id: starterAi,
          content,
          content_type: 'text',
          created_at: new Date().toISOString()
        };
        
        await withWriteLock(autonomousUserId, async () => {
          await userDb.read();
          userDb.data.messages.push(message);
          updateGroupActivityById(userDb, groupId, message);
          await userDb.write();
        });
        
        broadcastAIMessage(groupId, starterAi, content, null, messageId);
        context.lastSpeakerId = starterAi;
        
        console.log(`[AI自主对话] ${starterAi} 发起对话: ${content.substring(0, 50)}...`);
      }
      
      broadcastTypingStatus(groupId, starterAi, false);
    }
    
    await continueAIConversation(groupId, context, group.ai_members, autonomousUserAgents, null, autonomousUserId);
    
    activeGroups.delete(chatKey);
    
    broadcastToGroup(groupId, {
      type: 'autonomous_chat_stopped',
      group_id: groupId,
      timestamp: new Date().toISOString()
    });
    
    return { 
      success: true, 
      message: 'AI自主对话已完成',
      rounds: context.conversationDepth
    };
    
  } catch (error) {
    console.error(`[AI自主对话] 错误:`, error);
    
    activeGroups.delete(chatKey);
    
    broadcastToGroup(groupId, {
      type: 'autonomous_chat_error',
      group_id: groupId,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    return { success: false, error: error.message };
  }
}

export function stopAutonomousChat(groupId) {
  const chatKey = `autonomous:${groupId}`;
  const context = activeGroups.get(chatKey);
  
  if (context) {
    context.cancel = true;
    context.conversationActive = false;
    
    if (context.streamId) {
      cancelStream(context.streamId);
    }
    
    activeGroups.delete(chatKey);
    stopAutonomousChatTimer(groupId);
    
    broadcastToGroup(groupId, {
      type: 'autonomous_chat_stopped',
      group_id: groupId,
      timestamp: new Date().toISOString()
    });
    
    return { success: true, message: 'AI自主对话已停止' };
  }
  
  stopAutonomousChatTimer(groupId);
  
  return { success: false, message: '没有正在进行的AI自主对话' };
}

export function getAutonomousChatStatus(groupId) {
  const chatKey = `autonomous:${groupId}`;
  const context = activeGroups.get(chatKey);
  
  if (context) {
    return {
      isRunning: true,
      status: 'running',
      conversationDepth: context.conversationDepth,
      maxConversationDepth: context.maxConversationDepth
    };
  }
  
  return {
    isRunning: false,
    status: 'stopped'
  };
}

export async function handleUserReaction(groupId, messageId, reactionType, userId = 'user') {
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result || !result.group || !result.group.ai_members || result.group.ai_members.length === 0) {
    return;
  }
  
  const { db: userDb, group, messages } = result;
  
  await loadCustomPersonas(result.userId);

  const message = messages.find(m => m.id === messageId);
  if (!message) return;
  
  const recentMessages = await getRecentMessages(groupId, 50);
  
  const reactionPromises = group.ai_members.map(async aiId => {
    const persona = getEffectivePersona(aiId, result.userId);
    if (!persona) return null;
    
    const socialConfig = persona.socialConfig || {};
    if (!socialConfig.enableSocialFeedback) return null;
    
    const reactionProb = reactionType === 'dislike'
      ? (socialConfig.dislikeProbability ?? 0.05)
      : (socialConfig.likeProbability ?? 0.2);
    if (Math.random() > reactionProb) return null;
    
    const delay = 500 + Math.random() * 2000;
    await sleep(delay);
    
    broadcastTypingStatus(groupId, aiId, true);
    
    try {
      const { systemPrompt, userMessage: promptMessage } = buildWeChatStylePrompt(
        persona,
        `有人给群里的消息点了${reactionType === 'like' ? '赞' : '踩'}`,
        recentMessages,
        group.ai_members
      );
      
      const rawContent = await callAI(aiId, persona, promptMessage, recentMessages, 'reaction', null, [], null, group.ai_members, false, [], result.userId);
      let content = normalizeResponse(rawContent);
      
      if (!content || content.trim().length === 0) {
        broadcastTypingStatus(groupId, aiId, false);
        return null;
      }
      
      content = applyMessageLengthLimit(content, persona);
      broadcastTypingStatus(groupId, aiId, false);
      
      const { replyToId, cleanedContent } = parseReplyReference(content, recentMessages);
      
      // 检查清理后的内容是否为空
      if (!cleanedContent || cleanedContent.trim().length === 0) {
        console.warn(`[AI反应] ${aiId} 的内容在清理后为空，跳过保存`);
        return null;
      }
      
      const newMessageId = uuidv4();
      const newMessage = {
        id: newMessageId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: aiId,
        content: cleanedContent,
        content_type: 'text',
        reply_to: replyToId,
        created_at: new Date().toISOString()
      };
      
      await withWriteLock(result.userId, async () => {
        await userDb.read();
        userDb.data.messages.push(newMessage);
        updateGroupActivityById(userDb, groupId, newMessage);
        await userDb.write();
      });
      
      broadcastAIMessage(groupId, aiId, cleanedContent, replyToId, newMessageId);
      
      return { aiId, content: cleanedContent };
      
    } catch (error) {
      broadcastTypingStatus(groupId, aiId, false);
      return null;
    }
  });
  
  await Promise.allSettled(reactionPromises);
}

export async function handleUserComment(groupId, messageId, comment, commentId) {
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result || !result.group || !result.group.ai_members || result.group.ai_members.length === 0) {
    return;
  }
  
  const { db: userDb, group, messages } = result;
  
  await loadCustomPersonas(result.userId);

  const message = messages.find(m => m.id === messageId);
  if (!message) return;
  
  const recentMessages = await getRecentMessages(groupId, 50);
  
  const commentSenderName = comment.sender_type === 'user'
    ? '用户'
    : (AI_NAMES[comment.sender_id] || comment.sender_id || '某人');
  
  const messageSenderName = message.sender_type === 'user'
    ? '用户'
    : (AI_NAMES[message.sender_id] || message.sender_id || '某人');

  const commentPromises = group.ai_members.map(async aiId => {
    const persona = getEffectivePersona(aiId, result.userId);
    if (!persona) return null;
    
    const socialConfig = persona.socialConfig || {};
    if (!socialConfig.enableSocialFeedback) return null;
    
    const commentProb = socialConfig.commentProbability ?? 0.12;
    if (Math.random() > commentProb) return null;
    
    const delay = 1000 + Math.random() * 3000;
    await sleep(delay);
    
    broadcastTypingStatus(groupId, aiId, true);
    
    try {
      const { systemPrompt, userMessage: promptMessage } = buildWeChatStylePrompt(
        persona,
        `${commentSenderName}评论了${messageSenderName}的消息：${comment.content}`,
        recentMessages,
        group.ai_members
      );
      
      const rawContent = await callAI(aiId, persona, promptMessage, recentMessages, 'comment', null, [], null, group.ai_members, false, [], result.userId);
      let content = normalizeResponse(rawContent);
      
      if (!content || content.trim().length === 0) {
        broadcastTypingStatus(groupId, aiId, false);
        return null;
      }
      
      content = applyMessageLengthLimit(content, persona);
      broadcastTypingStatus(groupId, aiId, false);
      
      const { cleanedContent } = parseReplyReference(content, recentMessages);
      
      if (!cleanedContent || cleanedContent.trim().length === 0) {
        console.warn(`[AI评论] ${aiId} 的内容在清理后为空，跳过`);
        return null;
      }
      
      const aiCommentId = `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const aiComment = {
        id: aiCommentId,
        message_id: messageId,
        sender_type: 'ai',
        sender_id: aiId,
        content: cleanedContent,
        created_at: new Date().toISOString()
      };
      
      await withWriteLock(result.userId, async () => {
        await userDb.read();
        const targetMsg = userDb.data.messages.find(m => m.id === messageId);
        if (targetMsg) {
          if (!targetMsg.comments) targetMsg.comments = [];
          targetMsg.comments.push(aiComment);
        }
        await userDb.write();
      });
      
      broadcastToGroup(groupId, {
        type: 'new_comment',
        group_id: groupId,
        message_id: messageId,
        comment: {
          id: aiCommentId,
          message_id: messageId,
          sender_type: 'ai',
          sender_id: aiId,
          content: cleanedContent,
          created_at: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      });
      
      return { aiId, content: cleanedContent };
      
    } catch (error) {
      broadcastTypingStatus(groupId, aiId, false);
      return null;
    }
  });
  
  await Promise.allSettled(commentPromises);
}

const LIFE_TOPICS = [
  '今天吃了吗',
  '最近在追什么剧',
  '周末有啥安排',
  '有啥好吃的推荐',
  '最近怎么样',
  '在干嘛呢',
  '有啥烦心事',
  '想旅游了吗'
];

function getRandomTopic() {
  return LIFE_TOPICS[Math.floor(Math.random() * LIFE_TOPICS.length)];
}

async function generateSingleMessage(groupId, aiId, prompt, recentMessages, otherMembers, userId = null) {
  const persona = getEffectivePersona(aiId, userId);
  if (!persona) {
    throw new Error('无法获取AI人设');
  }
  
  const { systemPrompt, userMessage } = buildWeChatStylePrompt(persona, prompt, recentMessages, otherMembers);
  
  const rawContent = await callAI(aiId, persona, userMessage, recentMessages, 'free_chat', null, [], null, otherMembers, true, [], userId);
  let content = normalizeResponse(rawContent);
  
  if (!content || content.trim().length === 0) {
    throw new Error('AI生成内容为空');
  }
  
  content = applyMessageLengthLimit(content, persona);
  
  return { content, persona };
}

export async function startAIPrivateChat(groupId, topic = null) {
  const result = await findGroupInAnyUserDb(groupId);
  if (!result || !result.group) {
    return { groupId, status: 'error', error: 'AI私聊不存在' };
  }
  
  const { db: userDb, group: privateChat, userId: privateChatUserId } = result;

  await loadCustomPersonas(privateChatUserId);

  if (!privateChat.ai_members || privateChat.ai_members.length < 2) {
    return { groupId, status: 'error', error: 'AI成员不足' };
  }
  
  const aiMembers = privateChat.ai_members;
  
  const chatKey = `ai_private:${groupId}`;
  
  if (activeGroups.has(chatKey)) {
    const existingContext = activeGroups.get(chatKey);
    if (existingContext.isRunning) {
      return { groupId, status: 'already_active' };
    }
  }
  
  const context = { 
    cancel: false, 
    isRunning: true, 
    messageCount: 0,
    maxMessages: 50,
    topic: topic || getRandomTopic()
  };
  activeGroups.set(chatKey, context);
  
  broadcastToGroup(groupId, {
    type: 'chat_status',
    group_id: groupId,
    status: 'running',
    timestamp: new Date().toISOString()
  });
  
  try {
    while (!context.cancel && context.messageCount < context.maxMessages) {
      const recentMessages = await getRecentMessages(groupId, 50);
      
      const shuffledMembers = [...aiMembers].sort(() => Math.random() - 0.5);
      
      for (const aiId of shuffledMembers) {
        if (context.cancel) break;
        
        const result = await generateAIResponse(aiId, groupId, context.topic, recentMessages, aiMembers, context, false, null, false, null, null, privateChatUserId);
        
        if (context.cancel || !result) continue;
        
        const { content, suggestedReplyTo, messageId: streamMessageId } = result;
        
        const { replyToId, replyToIds, cleanedContent, socialActions } = parseReplyReference(content, recentMessages);
        
        if (!cleanedContent || cleanedContent.trim().length === 0) continue;
        
        const effectiveReplyTo = replyToId || suggestedReplyTo || null;
        const finalReplyToIds = replyToIds && replyToIds.length > 0 ? replyToIds : null;
        
        const finalMessageId = streamMessageId || uuidv4();
        const message = {
          id: finalMessageId,
          group_id: groupId,
          sender_type: 'ai',
          sender_id: aiId,
          content: cleanedContent,
          content_type: 'text',
          reply_to: effectiveReplyTo,
          reply_to_ids: finalReplyToIds,
          metadata: { type: 'ai_private_chat' },
          created_at: new Date().toISOString()
        };
        
        await withWriteLock(privateChatUserId, async () => {
          await userDb.read();
          userDb.data.messages.push(message);
          updateGroupActivityById(userDb, groupId, message);
          await userDb.write();
        });
        
        broadcastStreamEnd(groupId, aiId, finalMessageId, cleanedContent, effectiveReplyTo, finalReplyToIds);
        
        if (socialActions && socialActions.length > 0 && effectiveReplyTo) {
          await processSocialActions(groupId, effectiveReplyTo, aiId, socialActions);
        }
        
        context.messageCount++;
        
        const updatedRecent = await getRecentMessages(groupId, 50);
        recentMessages.length = 0;
        recentMessages.push(...updatedRecent);
        
        await sleep(500 + Math.random() * 1500);
      }
      
      if (context.messageCount >= context.maxMessages || context.cancel) break;
      
      await sleep(2000 + Math.random() * 3000);
    }
    
    activeGroups.delete(chatKey);
    broadcastToGroup(groupId, {
      type: 'chat_status',
      group_id: groupId,
      status: 'stopped',
      timestamp: new Date().toISOString()
    });
    
    return { 
      groupId, 
      status: 'success', 
      message: 'AI私聊已完成',
      totalMessages: context.messageCount
    };
    
  } catch (error) {
    console.error(`AI私聊错误:`, error);
    
    activeGroups.delete(chatKey);
    broadcastToGroup(groupId, {
      type: 'chat_status',
      group_id: groupId,
      status: 'stopped',
      timestamp: new Date().toISOString()
    });
    
    return { groupId, status: 'error', error: error.message };
  }
}

export function getChatStatus(groupId) {
  const chatKey = `ai_private:${groupId}`;
  const context = activeGroups.get(chatKey);
  
  if (context) {
    return {
      isRunning: context.isRunning || false,
      status: 'running',
      messageCount: context.messageCount || 0
    };
  }
  
  return {
    isRunning: false,
    status: 'stopped',
    messageCount: 0
  };
}

export function stopAIPrivateChat(groupId) {
  const chatKey = `ai_private:${groupId}`;
  const context = activeGroups.get(chatKey);
  
  if (context) {
    context.cancel = true;
    context.isRunning = false;
    
    broadcastToGroup(groupId, {
      type: 'chat_status',
      group_id: groupId,
      status: 'stopped',
      timestamp: new Date().toISOString()
    });
    
    activeGroups.delete(chatKey);
    
    return { success: true, message: 'AI私聊已停止', stoppedMessages: context.messageCount };
  }
  
  return { success: false, message: '没有正在进行的AI私聊' };
}

export async function continueAIPrivateChat(groupId) {
  return startAIPrivateChat(groupId, null);
}

export async function parseAndSaveMessage(groupId, aiId, aiContent, userMessage, recentMessages, replyToId = null, saveOnly = false, messageId = null) {
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result) throw new Error(`找不到群组 ${groupId}`);
  
  const { db: userDb } = result;
  
  const parsed = parseReplyReference(aiContent, recentMessages);
  const finalReplyToId = replyToId || parsed.replyToId;
  const finalReplyToIds = parsed.replyToIds;
  
  const message = {
    id: messageId || uuidv4(),
    group_id: groupId,
    sender_type: 'ai',
    sender_id: aiId,
    content: parsed.cleanedContent,
    content_type: 'text',
    reply_to: finalReplyToId,
    reply_to_ids: finalReplyToIds && finalReplyToIds.length > 0 ? finalReplyToIds : undefined,
    created_at: new Date().toISOString()
  };
  
  await withWriteLock(result.userId, async () => {
    await userDb.read();
    userDb.data.messages.push(message);
    updateGroupActivityById(userDb, groupId, message);
    await userDb.write();
  });
  
  if (!saveOnly && parsed.socialActions.length > 0) {
    for (const action of parsed.socialActions) {
      if (action.type === 'like' || action.type === 'dislike') {
        await processSocialActions(groupId, finalReplyToId || message.id, aiId, [action]);
      }
      if (action.type === 'comment') {
        await processSocialActions(groupId, finalReplyToId || message.id, aiId, [action]);
      }
    }
  }
  
  return message;
}
