import { AI_PERSONAS, AI_LIST } from '../../config/personas.js';
import { getDb } from '../../models/db.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcastAIMessage, broadcastTypingStatusWithTimeout, broadcastSystemMessage, broadcastToGroup } from '../../websocket/index.js';
import { callAI, normalizeResponse, callAIDebate } from '../ai/index.js';
import encryptionUtils from '../../utils/encryption.js';

let activeGroups = new Map();

const AI_NAME_MAP = {};
AI_LIST.forEach(id => {
  const persona = AI_PERSONAS[id];
  if (persona) {
    AI_NAME_MAP[id.toLowerCase()] = id;
    AI_NAME_MAP[persona.name.toLowerCase()] = id;
  }
});

export async function queueAIMessages(groupId, userMessage, replyTo = null) {
  if (activeGroups.has(groupId)) {
    activeGroups.get(groupId).cancel = true;
  }

  const db = getDb();
  await db.read();
  const group = db.data.groups.find(g => g.id === groupId);

  if (!group) return;

  const aiMembers = group.ai_members || [];
  if (aiMembers.length === 0) return;

  const isDebateMode = group.debate_mode === true;

  if (isDebateMode) {
    await executeDebate(groupId, userMessage, aiMembers, group.debate_level || 2);
    return;
  }

  const mentionedAIs = extractMentions(userMessage);

  const context = {
    cancel: false,
    groupId,
    userMessage,
    mentionedAIs,
    aiMembers,
    respondingAIs: new Set()
  };

  activeGroups.set(groupId, context);

  const participatingAIs = selectParticipatingAIs(userMessage, aiMembers, mentionedAIs);

  const parallelPromises = participatingAIs.map((aiId, index) => {
    context.respondingAIs.add(aiId);
    const persona = AI_PERSONAS[aiId];
    if (!persona) return Promise.resolve();

    const delay = calculateInitialDelay(aiId, userMessage, mentionedAIs.includes(aiId));
    return generateAIResponse(groupId, aiId, persona, userMessage, delay, context);
  });

  await Promise.allSettled(parallelPromises);

  if (!context.cancel) {
    await triggerSpontaneousReactions(groupId, userMessage, context);
  }

  activeGroups.delete(groupId);
}

function selectParticipatingAIs(userMessage, aiMembers, mentionedAIs) {
  return aiMembers.filter(aiId => {
    const persona = AI_PERSONAS[aiId];
    if (!persona) return false;

    if (mentionedAIs.includes(aiId)) return true;

    const score = calculateParticipationScore(aiId, persona, userMessage);
    if (score > 55) return true;
    if (score >= 40) return Math.random() < 0.5;
    return false;
  });
}

function calculateParticipationScore(aiId, persona, userMessage) {
  let score = 50;

  score += persona.questionProbability * 30;

  const isExpertTopic = persona.firstSpeakerTopics.some(t => userMessage.toLowerCase().includes(t));
  if (isExpertTopic) {
    score += 25;
  } else {
    score -= 20;
  }

  if (checkControversial(userMessage)) {
    score += 20;
  }

  score += (Math.random() - 0.5) * 40;

  if (persona.silenceProbability && Math.random() < persona.silenceProbability) {
    score -= 30;
  }

  const db = getDb();
  if (db.data && db.data.messages) {
    const recentMessages = db.data.messages
      .filter(m => m.group_id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);
    if (recentMessages.some(m => m.sender_id === aiId)) {
      score -= 15;
    }
  }

  return score;
}

function calculateInitialDelay(aiId, userMessage, isMentioned) {
  if (isMentioned) {
    return 500 + Math.random() * 1500;
  }

  const persona = AI_PERSONAS[aiId];
  if (persona && persona.firstSpeakerTopics.some(t => userMessage.toLowerCase().includes(t))) {
    return 1000 + Math.random() * 2000;
  }

  return 2000 + Math.random() * 6000;
}

async function generateAIResponse(groupId, aiId, persona, userMessage, delay, context) {
  await sleep(delay);

  if (context.cancel) {
    broadcastTypingStatusWithTimeout(groupId, aiId, false);
    return;
  }

  broadcastTypingStatusWithTimeout(groupId, aiId, true, 90000);

  const recentMessages = await getRecentMessages(groupId);

  try {
    const db = getDb();
    await db.read();
    const group = db.data.groups.find(g => g.id === groupId);
    const groupMembers = group?.ai_members || [];
    const isPrivateChat = group?.is_private === true;
    const customPersona = db.data.customPersonas?.[aiId];
    const effectivePersona = customPersona ? { ...persona, ...customPersona } : persona;
    const userProfile = db.data.userProfile || null;
    const responseType = 'free_chat';
    const replyToMsg = [...recentMessages].reverse().find(m => m.sender_id !== aiId);
    const replyToMessages = replyToMsg ? [replyToMsg] : [];
    
    // 获取私聊历史（如果当前是群聊）
    let privateChatHistory = [];
    if (!isPrivateChat) {
      const privateChat = db.data.groups.find(g => 
        g.is_private === true && 
        g.ai_members && 
        g.ai_members.length === 1 && 
        g.ai_members[0] === aiId
      );
      if (privateChat) {
        privateChatHistory = db.data.messages.filter(m => m.group_id === privateChat.id).slice(-20);
      }
    }
    
    const rawContent = await callAI(aiId, effectivePersona, userMessage, recentMessages, responseType, userProfile, replyToMessages, null, groupMembers, isPrivateChat, privateChatHistory);
    const content = normalizeResponse(rawContent);

    if (!content || content.trim().length === 0) {
      broadcastTypingStatusWithTimeout(groupId, aiId, false);
      return;
    }

    broadcastTypingStatusWithTimeout(groupId, aiId, false);

    const messageId = uuidv4();
    const message = {
      id: messageId,
      group_id: groupId,
      sender_type: 'ai',
      sender_id: aiId,
      content,
      content_type: 'text',
      reply_to: replyToMsg ? replyToMsg.id : null,
      metadata: { type: responseType },
      created_at: new Date().toISOString()
    };

    await db.read();
    db.data.messages.push(message);
    await db.write();

    broadcastAIMessage(groupId, aiId, content, replyToMsg ? replyToMsg.id : null, messageId);

    if (!context.cancel) {
      await handlePostResponseInteractions(groupId, aiId, messageId, content, recentMessages, context);
    }

  } catch (error) {
    console.error(`AI ${aiId} response error:`, error);
    broadcastTypingStatusWithTimeout(groupId, aiId, false);
  }
}

async function handlePostResponseInteractions(groupId, aiId, messageId, content, recentMessages, context) {
  await performAIInteractions(groupId, aiId, messageId, recentMessages);

  const mentionedAIs = extractMentions(content);
  if (mentionedAIs.length > 0) {
    await triggerMentionedAIResponses(groupId, aiId, content, mentionedAIs, context);
  }

  if (!context.cancel && Math.random() < 0.6) {
    await triggerSpontaneousReply(groupId, aiId, content, context);
  }
}

async function triggerMentionedAIResponses(groupId, fromAiId, content, mentionedAIs, context) {
  const db = getDb();
  await db.read();
  const group = db.data.groups.find(g => g.id === groupId);
  if (!group) return;

  const aiMembers = group.ai_members || [];

  const targetAIs = mentionedAIs.filter(id => id !== fromAiId && aiMembers.includes(id));

  for (const targetAiId of targetAIs) {
    if (context.cancel) break;

    const persona = AI_PERSONAS[targetAiId];
    if (!persona) continue;

    const followUpKey = `${groupId}:followup:${targetAiId}`;
    if (activeGroups.has(followUpKey)) continue;

    const followUpContext = { cancel: false };
    activeGroups.set(followUpKey, followUpContext);

    broadcastTypingStatusWithTimeout(groupId, targetAiId, true, 90000);

    await sleep(1500 + Math.random() * 2000);

    if (context.cancel) {
      broadcastTypingStatusWithTimeout(groupId, targetAiId, false);
      activeGroups.delete(followUpKey);
      break;
    }

    const recentMessages = await getRecentMessages(groupId);

    try {
      await db.read();
      const groupMembers = group?.ai_members || [];
      const customPersona = db.data.customPersonas?.[targetAiId];
      const effectivePersona = customPersona ? { ...persona, ...customPersona } : persona;
      const userProfile = db.data.userProfile || null;
      const responseType = 'free_chat';
      const prompt = `${content}`;
      const replyToMsg = [...recentMessages].reverse().find(m => m.sender_id === fromAiId);
      const replyToMessages = replyToMsg ? [replyToMsg] : [];
      const rawContent = await callAI(targetAiId, effectivePersona, prompt, recentMessages, responseType, userProfile, replyToMessages, null, groupMembers);
      const aiContent = normalizeResponse(rawContent);

      if (!aiContent || aiContent.trim().length === 0) {
        broadcastTypingStatusWithTimeout(groupId, targetAiId, false);
        activeGroups.delete(followUpKey);
        continue;
      }

      broadcastTypingStatusWithTimeout(groupId, targetAiId, false);

      const msgId = uuidv4();
      const message = {
        id: msgId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: targetAiId,
        content: aiContent,
        content_type: 'text',
        reply_to: replyToMsg ? replyToMsg.id : null,
        metadata: { type: responseType, replyToAi: fromAiId },
        created_at: new Date().toISOString()
      };

      await db.read();
      db.data.messages.push(message);
      await db.write();

      broadcastAIMessage(groupId, targetAiId, aiContent, replyToMsg ? replyToMsg.id : null, msgId);

      await performAIInteractions(groupId, targetAiId, msgId, recentMessages);

      const subMentions = extractMentions(aiContent);
      if (subMentions.length > 0 && Math.random() < 0.5) {
        await triggerMentionedAIResponses(groupId, targetAiId, aiContent, subMentions, context);
      }

    } catch (error) {
      console.error(`AI ${targetAiId} follow-up response error:`, error);
      broadcastTypingStatusWithTimeout(groupId, targetAiId, false);
    }

    activeGroups.delete(followUpKey);
  }
}

async function triggerSpontaneousReply(groupId, fromAiId, fromContent, context) {
  const db = getDb();
  await db.read();
  const group = db.data.groups.find(g => g.id === groupId);
  if (!group) return;

  const aiMembers = (group.ai_members || []).filter(id => id !== fromAiId);
  if (aiMembers.length === 0) return;

  const replierCount = Math.random() < 0.3 ? 2 : 1;
  const shuffled = aiMembers.sort(() => Math.random() - 0.5);
  const repliers = shuffled.slice(0, replierCount);

  for (const replierId of repliers) {
    if (context.cancel) break;

    const persona = AI_PERSONAS[replierId];
    if (!persona) continue;

    const reactionKey = `${groupId}:reaction:${replierId}:${Date.now()}`;
    const reactionContext = { cancel: false };
    activeGroups.set(reactionKey, reactionContext);

    broadcastTypingStatusWithTimeout(groupId, replierId, true, 90000);

    await sleep(2000 + Math.random() * 3000);

    if (context.cancel) {
      broadcastTypingStatusWithTimeout(groupId, replierId, false);
      activeGroups.delete(reactionKey);
      break;
    }

    const recentMessages = await getRecentMessages(groupId);

    try {
      await db.read();
      const groupMembers = group?.ai_members || [];
      const customPersona = db.data.customPersonas?.[replierId];
      const effectivePersona = customPersona ? { ...persona, ...customPersona } : persona;
      const userProfile = db.data.userProfile || null;
      const responseType = 'free_chat';
      const prompt = fromContent;
      const replyToMsg = [...recentMessages].reverse().find(m => m.sender_id === fromAiId);
      const replyToMessages = replyToMsg ? [replyToMsg] : [];
      const rawContent = await callAI(replierId, effectivePersona, prompt, recentMessages, responseType, userProfile, replyToMessages, null, groupMembers);
      const aiContent = normalizeResponse(rawContent);

      if (!aiContent || aiContent.trim().length === 0) {
        broadcastTypingStatusWithTimeout(groupId, replierId, false);
        activeGroups.delete(reactionKey);
        continue;
      }

      broadcastTypingStatusWithTimeout(groupId, replierId, false);

      const msgId = uuidv4();
      const message = {
        id: msgId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: replierId,
        content: aiContent,
        content_type: 'text',
        reply_to: replyToMsg ? replyToMsg.id : null,
        metadata: { type: responseType, spontaneousReplyTo: fromAiId },
        created_at: new Date().toISOString()
      };

      await db.read();
      db.data.messages.push(message);
      await db.write();

      broadcastAIMessage(groupId, replierId, aiContent, replyToMsg ? replyToMsg.id : null, msgId);

      await performAIInteractions(groupId, replierId, msgId, recentMessages);

    } catch (error) {
      console.error(`AI ${replierId} spontaneous reply error:`, error);
      broadcastTypingStatusWithTimeout(groupId, replierId, false);
    }

    activeGroups.delete(reactionKey);
  }
}

async function triggerSpontaneousReactions(groupId, userMessage, context) {
  const db = getDb();
  await db.read();
  const group = db.data.groups.find(g => g.id === groupId);
  if (!group) return;

  const aiMembers = group.ai_members || [];
  const silentAIs = aiMembers.filter(id => !context.respondingAIs.has(id));

  if (silentAIs.length === 0) return;

  const reactionProbability = checkControversial(userMessage) ? 0.25 : 0.1;
  const reactingAIs = silentAIs.filter(() => Math.random() < reactionProbability);

  if (reactingAIs.length === 0) return;

  for (const aiId of reactingAIs) {
    if (context.cancel) break;

    const persona = AI_PERSONAS[aiId];
    if (!persona) continue;

    broadcastTypingStatusWithTimeout(groupId, aiId, true, 90000);

    await sleep(3000 + Math.random() * 4000);

    if (context.cancel) {
      broadcastTypingStatusWithTimeout(groupId, aiId, false);
      break;
    }

    const recentMessages = await getRecentMessages(groupId);

    try {
      await db.read();
      const customPersona = db.data.customPersonas?.[aiId];
      const effectivePersona = customPersona ? { ...persona, ...customPersona } : persona;
      const userProfile = db.data.userProfile || null;
      const responseType = 'free_chat';
      const groupMembers = group?.ai_members || [];
      const rawContent = await callAI(aiId, effectivePersona, userMessage, recentMessages, responseType, userProfile, [], null, groupMembers);
      const content = normalizeResponse(rawContent);

      if (!content || content.trim().length === 0) {
        broadcastTypingStatusWithTimeout(groupId, aiId, false);
        continue;
      }

      broadcastTypingStatusWithTimeout(groupId, aiId, false);

      const messageId = uuidv4();
      const message = {
        id: messageId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: aiId,
        content,
        content_type: 'text',
        reply_to: null,
        metadata: { type: responseType, spontaneous: true },
        created_at: new Date().toISOString()
      };

      await db.read();
      db.data.messages.push(message);
      await db.write();

      broadcastAIMessage(groupId, aiId, content, null, messageId);

      await performAIInteractions(groupId, aiId, messageId, recentMessages);

    } catch (error) {
      console.error(`AI ${aiId} spontaneous reaction error:`, error);
      broadcastTypingStatusWithTimeout(groupId, aiId, false);
    }
  }
}

async function performAIInteractions(groupId, aiId, newMessageId, recentMessages) {
  const db = getDb();
  const socialService = await import('../social/index.js');

  await sleep(1000 + Math.random() * 2000);

  const recentOtherMessages = recentMessages.slice(-8).filter(msg =>
    msg.id !== newMessageId && msg.sender_id !== aiId
  );

  for (const msg of recentOtherMessages) {
    try {
      const likeEvaluation = socialService.default.evaluateMessageForLike(
        msg,
        recentMessages.filter(m => m.created_at < msg.created_at).slice(-5),
        { type: 'ai', id: aiId }
      );

      if (likeEvaluation.shouldLike && Math.random() > 0.4) {
        await db.read();
        const messageToLike = db.data.messages.find(m => m.id === msg.id);
        if (messageToLike) {
          if (!messageToLike.liked_by) {
            messageToLike.liked_by = [];
          }
          const aiLikeKey = `ai_${aiId}`;
          if (!messageToLike.liked_by.includes(aiLikeKey)) {
            messageToLike.liked_by.push(aiLikeKey);
            messageToLike.likes = (messageToLike.likes || 0) + 1;
            await db.write();

            broadcastToGroup(groupId, {
              type: 'message_liked',
              group_id: groupId,
              message_id: msg.id,
              liked_by: aiId,
              liked_by_type: 'ai',
              timestamp: new Date().toISOString()
            });
          }
        }
      }

      if (Math.random() > 0.85 && msg.sender_type === 'ai') {
        const commentAnalysis = socialService.default.analyzeComment(
          { content: '这个观点很有意思' },
          msg,
          recentMessages.filter(m => m.created_at < msg.created_at).slice(-3),
          []
        );

        if (commentAnalysis.relevanceScore > 0.5) {
          let commentContent = null;
          try {
            const commentPersona = AI_PERSONAS[aiId];
            if (commentPersona) {
              const db = getDb();
              await db.read();
              const customPersona = db.data.customPersonas?.[aiId];
              const effectivePersona = customPersona ? { ...commentPersona, ...customPersona } : commentPersona;
              const userProfile = db.data.userProfile || null;

              const commentPrompt = `请对以下观点发表一个简短的评论（10-30字），用你${effectivePersona.name}的风格：\n"${msg.content.substring(0, 100)}"`;

              const rawComment = await callAI(aiId, effectivePersona, commentPrompt, [], 'free_chat', userProfile, [], null, [], false, []);
              commentContent = normalizeResponse(rawComment);

              if (commentContent && commentContent.length > 50) {
                commentContent = commentContent.substring(0, 50);
              }
            }
          } catch (commentError) {
            console.error(`AI ${aiId} 评论生成失败:`, commentError.message);
          }

          if (!commentContent) {
            const fallbackComments = [
              `关于"${msg.content.substring(0, 15)}..."这个观点值得思考`,
              `对"${msg.content.substring(0, 15)}..."有不同看法`,
              `"${msg.content.substring(0, 15)}..."说得好`,
              `补充一下"${msg.content.substring(0, 15)}..."`,
            ];
            commentContent = fallbackComments[Math.floor(Math.random() * fallbackComments.length)];
          }

          await db.read();
          const messageToComment = db.data.messages.find(m => m.id === msg.id);
          if (messageToComment) {
            if (!messageToComment.comments) {
              messageToComment.comments = [];
            }

            const comment = {
              id: uuidv4(),
              message_id: msg.id,
              sender_type: 'ai',
              sender_id: aiId,
              content: commentContent,
              created_at: new Date().toISOString()
            };

            messageToComment.comments.push(comment);
            await db.write();

            broadcastToGroup(groupId, {
              type: 'new_comment',
              group_id: groupId,
              message_id: msg.id,
              comment: comment,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch (error) {
      console.error(`AI互动错误 (${aiId} -> ${msg.id}):`, error.message);
    }
  }
}

function extractMentions(message) {
  const mentionRegex = /@([\w\u4e00-\u9fff]+)/g;
  const mentions = [];
  let match;

  while ((match = mentionRegex.exec(message)) !== null) {
    const name = match[1].toLowerCase();
    if (AI_NAME_MAP[name] && !mentions.includes(AI_NAME_MAP[name])) {
      mentions.push(AI_NAME_MAP[name]);
    } else if (AI_LIST.includes(name) && !mentions.includes(name)) {
      mentions.push(name);
    }
  }

  return mentions;
}

function checkControversial(message) {
  const controversialWords = ['是否', '应该', '对错', '好坏', '观点', '认为', '觉得', '辩论', '讨论', '争议'];
  return controversialWords.some(w => message.includes(w));
}

async function getRecentMessages(groupId) {
  const db = getDb();
  await db.read();
  const recentMessages = db.data.messages
    .filter(m => m.group_id === groupId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 1000)
    .reverse();

  return recentMessages.map(msg => {
    try {
      if (msg.content && typeof msg.content === 'string') {
        const decrypted = encryptionUtils.decryptText(msg.content);
        return { ...msg, content: decrypted };
      }
    } catch (e) {
    }
    return msg;
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeDebate(groupId, userMessage, aiMembers, debateLevel) {
  const debateKey = `debate:${groupId}`;
  if (activeGroups.has(debateKey)) {
    activeGroups.get(debateKey).cancel = true;
  }

  const debateContext = { cancel: false };
  activeGroups.set(debateKey, debateContext);

  const totalRounds = debateLevel === 1 ? 2 : debateLevel === 3 ? 4 : 3;

  broadcastSystemMessage(groupId, `辩论开始！主题：${userMessage}，共${totalRounds}轮，${aiMembers.length}位辩手参与`);

  await sleep(1000);

  const db = getDb();

  for (let round = 1; round <= totalRounds; round++) {
    if (debateContext.cancel) break;

    broadcastSystemMessage(groupId, `第${round}轮辩论开始${round === totalRounds ? '（总结轮）' : ''}`);

    await sleep(500);

    for (const aiId of aiMembers) {
      if (debateContext.cancel) break;

      const persona = AI_PERSONAS[aiId];
      if (!persona) continue;

      await db.read();
      const customPersona = db.data.customPersonas?.[aiId];
      const effectivePersona = customPersona ? { ...persona, ...customPersona } : persona;

      broadcastTypingStatusWithTimeout(groupId, aiId, true, 90000);

      const delay = 1000 + Math.random() * 2000;
      await sleep(delay);

      if (debateContext.cancel) {
        broadcastTypingStatusWithTimeout(groupId, aiId, false);
        break;
      }

      const recentMessages = await getRecentMessages(groupId);

      try {
        const content = await callAIDebate(
          aiId, effectivePersona, userMessage, recentMessages,
          round, totalRounds, debateLevel, aiMembers
        );

        broadcastTypingStatusWithTimeout(groupId, aiId, false);

        if (!content || content.trim().length === 0) {
          continue;
        }

        const replyToMsg = [...recentMessages].reverse().find(m => m.sender_type === 'ai' && m.sender_id !== aiId);

        const messageId = uuidv4();
        const message = {
          id: messageId,
          group_id: groupId,
          sender_type: 'ai',
          sender_id: aiId,
          content,
          content_type: 'text',
          reply_to: replyToMsg ? replyToMsg.id : null,
          metadata: { type: 'debate', round, totalRounds, debateLevel },
          created_at: new Date().toISOString()
        };

        await db.read();
        db.data.messages.push(message);
        await db.write();

        broadcastAIMessage(groupId, aiId, content, replyToMsg ? replyToMsg.id : null, messageId);

      } catch (error) {
        console.error(`辩论 AI ${aiId} 第${round}轮错误:`, error);
        broadcastTypingStatusWithTimeout(groupId, aiId, false);
      }

      if (round < totalRounds) {
        await sleep(800 + Math.random() * 1500);
      }
    }

    if (round < totalRounds && !debateContext.cancel) {
      await sleep(1500 + Math.random() * 2000);
    }
  }

  if (!debateContext.cancel) {
    await generateDebateConclusion(groupId, userMessage, aiMembers, debateLevel);
  }

  broadcastSystemMessage(groupId, '辩论结束！');

  activeGroups.delete(debateKey);
}

async function generateDebateConclusion(groupId, userMessage, aiMembers, debateLevel) {
  const db = getDb();
  await db.read();

  const recentMessages = await getRecentMessages(groupId);
  const debateMessages = recentMessages.filter(m => m.metadata?.type === 'debate');

  if (debateMessages.length === 0) return;

  const aiNames = {
    deepseek: 'deepseek-chat',
    deepseek_reasoner: 'deepseek-reasoner',
    glm: 'GLM-4.5-Air',
    mimo: 'mimo-v2-flash',
    qwen: 'Qwen3.5-Flash'
  };

  const debateSummary = debateMessages.map(m => {
    const sender = aiNames[m.sender_id] || m.sender_id;
    return `${sender}(第${m.metadata.round}轮): ${m.content.substring(0, 200)}`;
  }).join('\n');

  const conclusionPersona = AI_PERSONAS.qwen;
  if (!conclusionPersona) return;

  const customPersona = db.data.customPersonas?.['qwen'];
  const effectivePersona = customPersona ? { ...conclusionPersona, ...customPersona } : conclusionPersona;

  broadcastTypingStatusWithTimeout(groupId, 'qwen', true, 90000);

  await sleep(2000);

  try {
    const conclusionPrompt = `你是${effectivePersona.name}，作为这场辩论的总结者。

【辩论主题】${userMessage}
【辩论风格级别】${debateLevel}

【辩论记录摘要】
${debateSummary}

请基于以上辩论内容，给出一个全面、客观的总结：
1. 列出各方的主要观点和论据
2. 指出辩论中的共识点
3. 指出仍然存在的分歧
4. 给出你的综合建议或结论

要求：简洁有力，不要重复辩手的话，要有自己的分析和判断。`;

    const config = {
      name: 'Qwen3.5-Flash',
      apiKey: process.env.QWEN_API_KEY || 'sk-4d623ee9fe964e4f972fea98da89006b',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen3.5-flash',
      params: { temperature: 0.5, top_p: 0.8, max_tokens: 2000 }
    };

    const axios = (await import('axios')).default;
    const response = await axios.post(config.endpoint, {
      model: config.model,
      messages: [
        { role: 'system', content: conclusionPrompt },
        { role: 'user', content: '请给出辩论总结。' }
      ],
      max_tokens: 2000,
      temperature: 0.5,
      top_p: 0.8
    }, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    let conclusion = response.data.choices[0].message.content;
    if (!conclusion || conclusion.trim().length === 0) {
      if (response.data.choices[0].reasoning_content) {
        conclusion = response.data.choices[0].reasoning_content;
      }
    }

    conclusion = normalizeResponse(conclusion);

    broadcastTypingStatusWithTimeout(groupId, 'qwen', false);

    if (conclusion && conclusion.trim().length > 0) {
      const messageId = uuidv4();
      const message = {
        id: messageId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: 'qwen',
        content: `📋 **辩论总结**\n\n${conclusion}`,
        content_type: 'text',
        reply_to: null,
        metadata: { type: 'debate_conclusion', topic: userMessage },
        created_at: new Date().toISOString()
      };

      await db.read();
      db.data.messages.push(message);
      await db.write();

      broadcastAIMessage(groupId, 'qwen', message.content, null, messageId);
    }
  } catch (error) {
    console.error('生成辩论总结失败:', error);
    broadcastTypingStatusWithTimeout(groupId, 'qwen', false);
  }
}

export function cancelGroupGeneration(groupId) {
  const context = activeGroups.get(groupId);
  if (context) {
    context.cancel = true;
    if (context.respondingAIs) {
      for (const aiId of context.respondingAIs) {
        broadcastTypingStatusWithTimeout(groupId, aiId, false);
      }
    }
    activeGroups.delete(groupId);
  }

  const debateKey = `debate:${groupId}`;
  const debateContext = activeGroups.get(debateKey);
  if (debateContext) {
    debateContext.cancel = true;
    activeGroups.delete(debateKey);
  }

  for (const [key, value] of activeGroups.entries()) {
    if (key.startsWith(`${groupId}:`)) {
      value.cancel = true;
      activeGroups.delete(key);
    }
  }
}
