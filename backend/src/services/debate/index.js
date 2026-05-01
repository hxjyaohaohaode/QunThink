import { v4 as uuidv4 } from 'uuid';
import { getUserDb, listUserDatabases, withWriteLock } from '../../models/db.js';
import { callAIDebate, normalizeResponse, applyMessageLengthLimit } from '../ai/index.js';
import { broadcastToGroup, broadcastTypingStatus } from '../../websocket/index.js';
import { AI_PERSONAS } from '../../config/personas.js';
import { getEffectivePersona as getSchedulerPersona, loadCustomPersonas } from '../scheduler/index.js';

const activeDebates = new Map();
const groupToUserMap = new Map();

if (process.env.NODE_ENV !== 'test') {
  const debateCleanupTimer = setInterval(() => {
    const maxDuration = 2 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [key, context] of activeDebates.entries()) {
      if (context.startTime && now - context.startTime > maxDuration) {
        console.warn(`🧹 清理超时辩论: ${key}`);
        context.cancel = true;
        activeDebates.delete(key);
      }
    }
  }, 30 * 60 * 1000);

  if (typeof debateCleanupTimer.unref === 'function') {
    debateCleanupTimer.unref();
  }
}

function populateGroupCache(userId, db) {
  if (db.data && db.data.groups) {
    for (const group of db.data.groups) {
      groupToUserMap.set(group.id, userId);
    }
  }
}

const DEBATE_PHASES = {
  OPENING: 'opening',
  REBUTTAL: 'rebuttal',
  FREE_DEBATE: 'free_debate',
  CLOSING: 'closing',
  JUDGMENT: 'judgment',
  FINISHED: 'finished',
  AUDIENCE_COMMENT: 'audience_comment'
};

const PHASE_NAMES = {
  [DEBATE_PHASES.OPENING]: '立论阶段',
  [DEBATE_PHASES.REBUTTAL]: '驳论阶段',
  [DEBATE_PHASES.FREE_DEBATE]: '自由辩论阶段',
  [DEBATE_PHASES.CLOSING]: '总结阶段',
  [DEBATE_PHASES.JUDGMENT]: '裁判评判阶段',
  [DEBATE_PHASES.FINISHED]: '辩论结束',
  [DEBATE_PHASES.AUDIENCE_COMMENT]: '观众评论阶段'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEffectivePersona(aiId, userId = null) {
  const persona = getSchedulerPersona(aiId, userId);
  if (persona) return persona;
  return AI_PERSONAS[aiId] || null;
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

function allocateDebateRoles(aiMembers, rolePreferences = {}, selectedParticipants = null) {
  let debateMembers = aiMembers;
  let audienceMembers = [];
  
  if (selectedParticipants && Array.isArray(selectedParticipants) && selectedParticipants.length >= 2) {
    debateMembers = selectedParticipants.filter(id => aiMembers.includes(id));
    audienceMembers = aiMembers.filter(id => !debateMembers.includes(id));
  }
  
  const totalMembers = debateMembers.length;
  
  if (totalMembers < 2) {
    throw new Error('至少需要2个AI参与辩论');
  }
  
  let proponentCount, opponentCount, judgeCount;
  
  if (totalMembers === 2) {
    proponentCount = 1;
    opponentCount = 1;
    judgeCount = 0;
  } else if (totalMembers === 3) {
    proponentCount = 1;
    opponentCount = 1;
    judgeCount = 1;
  } else if (totalMembers === 4) {
    proponentCount = 2;
    opponentCount = 2;
    judgeCount = 0;
  } else if (totalMembers === 5) {
    proponentCount = 2;
    opponentCount = 2;
    judgeCount = 1;
  } else {
    proponentCount = Math.ceil((totalMembers - 1) / 2);
    opponentCount = Math.floor((totalMembers - 1) / 2);
    judgeCount = 1;
  }
  
  const availableMembers = [...debateMembers];
  const roles = {
    proponents: [],
    opponents: [],
    judge: null,
    audience: audienceMembers
  };
  
  for (const [aiId, preferredRole] of Object.entries(rolePreferences)) {
    if (!availableMembers.includes(aiId)) continue;
    
    const memberIndex = availableMembers.indexOf(aiId);
    
    if (preferredRole === 'proponent' && roles.proponents.length < proponentCount) {
      roles.proponents.push(aiId);
      availableMembers.splice(memberIndex, 1);
    } else if (preferredRole === 'opponent' && roles.opponents.length < opponentCount) {
      roles.opponents.push(aiId);
      availableMembers.splice(memberIndex, 1);
    } else if (preferredRole === 'judge' && !roles.judge && judgeCount > 0) {
      roles.judge = aiId;
      availableMembers.splice(memberIndex, 1);
    }
  }
  
  while (roles.proponents.length < proponentCount && availableMembers.length > 0) {
    const randomIndex = Math.floor(Math.random() * availableMembers.length);
    roles.proponents.push(availableMembers.splice(randomIndex, 1)[0]);
  }
  
  while (roles.opponents.length < opponentCount && availableMembers.length > 0) {
    const randomIndex = Math.floor(Math.random() * availableMembers.length);
    roles.opponents.push(availableMembers.splice(randomIndex, 1)[0]);
  }
  
  if (judgeCount > 0 && !roles.judge && availableMembers.length > 0) {
    roles.judge = availableMembers[0];
  }
  
  return {
    ...roles,
    totalProponents: roles.proponents.length,
    totalOpponents: roles.opponents.length,
    hasJudge: !!roles.judge,
    hasAudience: roles.audience.length > 0
  };
}

function getDebatePhaseConfig(phase, roles) {
  const hasJudge = roles.hasJudge;
  
  switch (phase) {
    case DEBATE_PHASES.OPENING:
      return {
        name: PHASE_NAMES[phase],
        speakers: [...roles.proponents, ...roles.opponents],
        speakerRoles: {
          ...Object.fromEntries(roles.proponents.map(id => [id, 'proponent'])),
          ...Object.fromEntries(roles.opponents.map(id => [id, 'opponent']))
        },
        instructions: '立论阶段：请阐述你方的核心观点和主要论据。正方支持辩题，反方反对辩题。',
        turnsPerSpeaker: 1
      };
      
    case DEBATE_PHASES.REBUTTAL:
      return {
        name: PHASE_NAMES[phase],
        speakers: [...roles.proponents, ...roles.opponents],
        speakerRoles: {
          ...Object.fromEntries(roles.proponents.map(id => [id, 'proponent'])),
          ...Object.fromEntries(roles.opponents.map(id => [id, 'opponent']))
        },
        instructions: '驳论阶段：请针对对方的立论进行反驳，指出对方论点的漏洞和不足。',
        turnsPerSpeaker: 1
      };
      
    case DEBATE_PHASES.FREE_DEBATE:
      return {
        name: PHASE_NAMES[phase],
        speakers: [...roles.proponents, ...roles.opponents],
        speakerRoles: {
          ...Object.fromEntries(roles.proponents.map(id => [id, 'proponent'])),
          ...Object.fromEntries(roles.opponents.map(id => [id, 'opponent']))
        },
        instructions: '自由辩论阶段：双方可以自由发言，针对对方观点进行辩论，也可以补充己方论据。',
        turnsPerSpeaker: 2
      };
      
    case DEBATE_PHASES.CLOSING:
      return {
        name: PHASE_NAMES[phase],
        speakers: [...roles.proponents.slice(-1), ...roles.opponents.slice(-1)],
        speakerRoles: {
          ...Object.fromEntries(roles.proponents.slice(-1).map(id => [id, 'proponent'])),
          ...Object.fromEntries(roles.opponents.slice(-1).map(id => [id, 'opponent']))
        },
        instructions: '总结阶段：请总结你方的核心观点，强调最有力的论据。',
        turnsPerSpeaker: 1
      };
      
    case DEBATE_PHASES.JUDGMENT:
      if (!hasJudge) {
        return {
          name: PHASE_NAMES[DEBATE_PHASES.FINISHED],
          speakers: [],
          speakerRoles: {},
          instructions: '辩论结束',
          turnsPerSpeaker: 0
        };
      }
      return {
        name: PHASE_NAMES[phase],
        speakers: [roles.judge],
        speakerRoles: { [roles.judge]: 'judge' },
        instructions: '裁判评判阶段：请公正地评价双方的表现，指出双方的优缺点，并给出你的判断。',
        turnsPerSpeaker: 1
      };
      
    case DEBATE_PHASES.AUDIENCE_COMMENT:
      if (!roles.hasAudience || roles.audience.length === 0) {
        return {
          name: PHASE_NAMES[DEBATE_PHASES.FINISHED],
          speakers: [],
          speakerRoles: {},
          instructions: '辩论结束',
          turnsPerSpeaker: 0
        };
      }
      return {
        name: PHASE_NAMES[phase],
        speakers: roles.audience,
        speakerRoles: Object.fromEntries(roles.audience.map(id => [id, 'audience'])),
        instructions: '观众评论阶段：作为观众，请对刚才的辩论发表你的看法和评论。',
        turnsPerSpeaker: 1
      };
      
    case DEBATE_PHASES.FINISHED:
    default:
      return {
        name: PHASE_NAMES[DEBATE_PHASES.FINISHED],
        speakers: [],
        speakerRoles: {},
        instructions: '辩论已结束',
        turnsPerSpeaker: 0
      };
  }
}

function buildDebateRolePrompt(persona, role, topic, phase, phaseConfig, recentMessages, allRoles) {
  const aiNames = {
    deepseek: 'deepseek-chat',
    deepseek_reasoner: 'deepseek-reasoner',
    glm_air: 'GLM-4.5-Air',
    glm_flash: 'GLM-4.7-Flash',
    glm_flashx: 'GLM-4.7-FlashX',
    mimo_flash: 'mimo-v2.5',
    mimo_omni: 'mimo-v2-omni',
    mimo_tts: 'mimo-v2-tts',
    qwen_flash: 'Qwen3.5-Flash',
    qwen_turbo: 'qwen-turbo'
  };
  
  const roleNames = {
    proponent: '正方',
    opponent: '反方',
    judge: '裁判',
    audience: '观众'
  };
  
  const currentAiId = persona?.id;
  const roleName = roleNames[role] || '辩手';
  
  let teammates = [];
  let opponents = [];
  
  if (role === 'proponent') {
    teammates = allRoles.proponents.filter(id => id !== currentAiId);
    opponents = allRoles.opponents;
  } else if (role === 'opponent') {
    teammates = allRoles.opponents.filter(id => id !== currentAiId);
    opponents = allRoles.proponents;
  }
  
  const teammateNames = teammates.map(id => aiNames[id] || id).join('、');
  const opponentNames = opponents.map(id => aiNames[id] || id).join('、');
  
  let contextSection = '';
  if (recentMessages && recentMessages.length > 0) {
    const contextMessages = recentMessages.slice(-30);
    contextSection = `\n\n【辩论记录】\n` + contextMessages.map(m => {
      const senderRole = allRoles.proponents.includes(m.sender_id) ? '[正方]' :
                        allRoles.opponents.includes(m.sender_id) ? '[反方]' :
                        allRoles.judge === m.sender_id ? '[裁判]' : '';
      const senderName = m.sender_type === 'user' ? '用户' : (aiNames[m.sender_id] || m.sender_id);
      return `${senderRole}${senderName}: ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`;
    }).join('\n');
  }
  
  let roleSpecificInstructions = '';
  
  if (role === 'proponent') {
    roleSpecificInstructions = `
【正方立场】
- 你支持辩题："${topic}"
- 你的任务是论证这个观点是正确的、合理的
- 用事实、逻辑和论据来支持你的立场
- 反驳反方的观点，指出其漏洞${teammateNames ? `\n- 你的队友：${teammateNames}` : ''}${opponentNames ? `\n- 你的对手：${opponentNames}` : ''}`;
  } else if (role === 'opponent') {
    roleSpecificInstructions = `
【反方立场】
- 你反对辩题："${topic}"
- 你的任务是论证这个观点是错误的、不合理的
- 用事实、逻辑和论据来支持你的立场
- 反驳正方的观点，指出其漏洞${teammateNames ? `\n- 你的队友：${teammateNames}` : ''}${opponentNames ? `\n- 你的对手：${opponentNames}` : ''}`;
  } else if (role === 'judge') {
    roleSpecificInstructions = `
【裁判职责】
- 你是本场辩论的裁判
- 你需要公正、客观地评价双方的表现
- 指出双方论点的优点和不足
- 不要偏袒任何一方
- 最后给出你的评判和理由`;
  } else if (role === 'audience') {
    const proponentNames = allRoles.proponents.map(id => aiNames[id] || id).join('、');
    const opponentNames = allRoles.opponents.map(id => aiNames[id] || id).join('、');
    roleSpecificInstructions = `
【观众身份】
- 你是本场辩论的观众
- 你全程观看了这场辩论，现在可以发表你的看法
- 可以评论双方的表现、论点的优劣
- 可以表达你支持哪一方以及原因
- 保持客观和尊重，不要过于偏激${proponentNames ? `\n- 正方辩手：${proponentNames}` : ''}${opponentNames ? `\n- 反方辩手：${opponentNames}` : ''}`;
  }
  
  let phaseInstructions = '';
  switch (phase) {
    case DEBATE_PHASES.OPENING:
      phaseInstructions = `
【立论阶段要求】
- 清晰阐述你的核心观点
- 提出2-3个主要论据
- 论据要有逻辑性和说服力
- 不要回应对方（对方还没发言）`;
      break;
    case DEBATE_PHASES.REBUTTAL:
      phaseInstructions = `
【驳论阶段要求】
- 针对对方立论中的薄弱环节进行反驳
- 指出对方论据的逻辑漏洞
- 可以用@名称来直接回应特定辩友
- 保持攻击性但不要人身攻击`;
      break;
    case DEBATE_PHASES.FREE_DEBATE:
      phaseInstructions = `
【自由辩论阶段要求】
- 可以自由发言，回应对方的任何观点
- 可以补充新的论据
- 可以与队友配合
- 用@名称来直接回应特定辩友
- 保持辩论的节奏和张力`;
      break;
    case DEBATE_PHASES.CLOSING:
      phaseInstructions = `
【总结阶段要求】
- 总结你方最核心的观点
- 强调最有力的论据
- 不要引入新的论点
- 给出一个有力的结尾`;
      break;
    case DEBATE_PHASES.JUDGMENT:
      phaseInstructions = `
【裁判评判要求】
- 客观评价正方的表现和论点
- 客观评价反方的表现和论点
- 指出双方的优点和不足
- 给出你的最终判断（可以宣布获胜方或表示平局）
- 解释你的判断理由`;
      break;
    case DEBATE_PHASES.AUDIENCE_COMMENT:
      phaseInstructions = `
【观众评论要求】
- 作为观众发表你对这场辩论的看法
- 可以评论双方辩手的表现
- 可以指出精彩的论点或不足之处
- 可以表达你支持哪一方
- 保持友好和尊重的态度`;
      break;
  }
  
  return `【正规辩论】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}

你是${persona.name}，在本场辩论中担任【${roleName}】。你必须严格按照你的人设来发言，不得偏离你的人设设定。

${persona.styleTag ? `你的风格标签是"${persona.styleTag}"。这是你的核心风格标识，你在辩论中的每一句话都必须严格体现"${persona.styleTag}"这个风格，绝对不能偏离。` : ''}
${persona.personality ? `性格：${persona.personality}。你在辩论中的每句话都必须体现这种性格，你的态度、情感倾向、论证思路都要严格受此性格驱动，不得表现出与此性格矛盾的特征。` : ''}
${persona.style ? `风格：${persona.style}。你必须始终贯彻这个风格，你的语气、用词、论证方式都要完全符合这个风格描述，不得有任何偏离。` : ''}
${persona.replyStyle ? `说话方式：${persona.replyStyle}。你必须严格按照这种方式说话，包括你的语气、句式、修辞手法都要符合这个说话方式，不得使用与此方式矛盾的表达。` : ''}
${persona.expertise && persona.expertise.length > 0 ? `你擅长的专业领域：${persona.expertise.join('、')}。当辩论涉及这些领域时，你必须展现专业深度，用专业知识碾压对手，不得给出肤浅或外行的论证。` : ''}
${persona.typicalPhrases && persona.typicalPhrases.length > 0 ? `你必须经常使用以下口头禅：${persona.typicalPhrases.join('、')}。在辩论中必须自然地插入这些口头禅，这是你说话的标志性特征，不得遗漏。` : ''}
${persona.keywords && persona.keywords.length > 0 ? `你特别关注这些关键词和话题：${persona.keywords.join('、')}。当辩论涉及这些话题时，你必须更积极地发言，不得对这些话题保持沉默。` : ''}
${persona.firstSpeakerTopics && persona.firstSpeakerTopics.length > 0 ? `你擅长主动发起以下话题：${persona.firstSpeakerTopics.join('、')}。当辩论陷入僵局时，你可以主动提出这些话题来引导讨论方向。` : ''}
${persona.speakingTraits ? `你的说话特点：${persona.speakingTraits}。你在辩论中的每一句话都必须体现这些说话特点，包括你的用词习惯、句式结构、论证节奏都要严格符合，不得偏离。` : ''}
${persona.debateTendency === 'low' ? '你的辩论倾向是温和型。你在辩论中必须倾向于温和表达，寻找共识，避免过于激烈的对抗。即使不同意对方，也必须委婉地表达，不得直接反驳或激烈对抗。' : ''}
${persona.debateTendency === 'medium' ? '你的辩论倾向是平衡型。你在辩论中必须平衡表达自己的观点，既坚持立场也尊重他人。你必须理性地反驳，但不得咄咄逼人。' : ''}
${persona.debateTendency === 'high' ? '你的辩论倾向是激进型。你在辩论中必须非常激进，强烈反驳对手的每一个论点，绝不退让。你必须主动寻找对方论点的漏洞并猛烈攻击。' : ''}
${persona.questionProbability && persona.questionProbability > 0.3 ? '你必须在辩论中主动向对手提出尖锐的问题来引导讨论方向，这是你辩论的重要策略，不得忽略。' : ''}
${persona.messageLength === 'short' ? '你必须将发言控制在50-150字以内，简短有力，直击要害，不得超出此长度范围。' : ''}
${persona.messageLength === 'medium' ? '你必须将发言控制在150-300字左右，论点清晰，不得过短或过长。' : ''}
${persona.messageLength === 'long' ? '你必须写300-500字的详细发言，深入论证，充分展开，不得过于简略。' : ''}
${persona.preferredRole === 'expert' ? '你必须以专家身份辩论，提供权威论证和深入分析，用专业知识碾压对手，不得给出非专业的论证。' : ''}
${persona.preferredRole === 'student' ? '你必须以学习者身份辩论，谦虚探讨，共同进步，不得以权威姿态发言。' : ''}
${persona.preferredRole === 'critic' ? '你必须以评论家身份辩论，用批判性思维指出对方每一个逻辑漏洞，不得盲目认同。' : ''}
${persona.preferredRole === 'mediator' ? '你必须以调解者身份辩论，平衡各方论点，化解分歧，不得偏袒任何一方。' : ''}
${persona.preferredRole === 'supporter' ? '你必须以支持者身份辩论，为队友提供有力补充和证据支持，不得拆队友的台。' : ''}
${persona.preferredRole === 'innovator' ? '你必须以创新者身份辩论，提出新颖独特的论点和角度，不得因循守旧。' : ''}
${persona.preferredRole === 'challenger' ? '你必须以挑战者身份辩论，不断质疑对方观点，激发深层思考，不得轻易接受对方论点。' : ''}
${persona.preferredRole === 'teacher' ? '你必须以导师身份辩论，循循善诱，用启发式提问引导对方暴露弱点，不得直接攻击。' : ''}
${persona.preferredRole === 'storyteller' ? '你必须以故事家身份辩论，善用故事和比喻来论证，不得使用干巴巴的逻辑推演。' : ''}
${persona.preferredRole === 'pragmatist' ? '你必须以实用主义者身份辩论，用实际案例和数据说话，不得空谈理论。' : ''}
${persona.preferredRole === 'philosopher' ? '你必须以哲学家身份辩论，从本质和底层逻辑出发论证，不得停留在表面现象。' : ''}
${persona.preferredRole === 'humorist' ? '你必须以幽默家身份辩论，风趣幽默地反驳对手，不得严肃刻板。' : ''}
${persona.preferredRole === 'skeptic' ? '你必须以怀疑论者身份辩论，理性怀疑一切论点，追求真相，不得轻信任何说法。' : ''}
${persona.preferredRole === 'optimist' ? '你必须以乐观主义者身份辩论，积极向上地论证，充满希望，不得消极悲观。' : ''}
${persona.preferredRole === 'realist' ? '你必须以现实主义者身份辩论，客观冷静地分析，直面现实，不得回避或美化问题。' : ''}
${persona.preferredRole === 'custom' && persona.customRoleName ? `你的辩论角色定位：${persona.customRoleName}。你必须严格按照这个角色定位来辩论。` : ''}

【辩题】${topic}
【当前阶段】${phaseConfig.name}
${roleSpecificInstructions}
${phaseInstructions}

【辩论规则】
1. 你必须严格按照你的人设来发言，不得偏离
2. 必须有明确的立场和观点
3. 用论据和逻辑来支持你的观点
4. 提及其他辩友用@名称格式，如@deepseek-chat、@GLM-4.5-Air等
5. 【最重要规则】绝对禁止复制粘贴其他辩友的原话！
6. 不要用模板化表达，直接有力地说话
7. 保持辩论的专业性和逻辑性
${contextSection}`;
}

async function generateDebateResponse(aiId, groupId, topic, role, phase, phaseConfig, recentMessages, allRoles, context) {
  if (context.cancel) return null;
  
  await loadCustomPersonas(context.userId);
  const persona = getEffectivePersona(aiId, context.userId);
  if (!persona) return null;
  
  const delay = 1000 + Math.random() * 2000;
  await sleep(delay);
  
  if (context.cancel) return null;
  
  broadcastTypingStatus(groupId, aiId, true);
  
  try {
    const systemPrompt = buildDebateRolePrompt(
      persona, 
      role, 
      topic, 
      phase, 
      phaseConfig, 
      recentMessages, 
      allRoles
    );
    
    const debateRound = context.currentRound || 1;
    const totalRounds = context.totalRounds || 5;
    const debateLevel = context.debateLevel || 2;
    
    const rawContent = await callAIDebate(
      aiId, 
      persona, 
      topic, 
      recentMessages, 
      debateRound, 
      totalRounds, 
      debateLevel,
      context.groupMembers,
      context.userId
    );
    
    let content = normalizeResponse(rawContent);
    
    if (!content || content.trim().length === 0) {
      broadcastTypingStatus(groupId, aiId, false);
      return null;
    }
    
    content = applyMessageLengthLimit(content, { ...persona, socialConfig: { maxMessageLength: Math.max(persona?.socialConfig?.maxMessageLength || 800, 800) } });
    
    broadcastTypingStatus(groupId, aiId, false);
    
    return { aiId, content, persona, role };
    
  } catch (error) {
    console.error(`AI ${aiId} 辩论生成失败:`, error.message);
    broadcastTypingStatus(groupId, aiId, false);
    return null;
  }
}

function broadcastDebatePhaseChange(groupId, phase, phaseConfig, roles, userId = null) {
  const roleNames = {
    proponent: '正方',
    opponent: '反方',
    judge: '裁判',
    audience: '观众'
  };
  
  const speakers = phaseConfig.speakers.map(id => {
    const role = phaseConfig.speakerRoles[id];
    const persona = getEffectivePersona(id, userId);
    return `${roleNames[role] || '辩手'}: ${persona?.name || id}`;
  });
  
  broadcastToGroup(groupId, {
    type: 'debate_phase_change',
    group_id: groupId,
    phase,
    phase_name: phaseConfig.name,
    instructions: phaseConfig.instructions,
    speakers,
    timestamp: new Date().toISOString()
  });
}

function broadcastDebateMessage(groupId, aiId, content, role, messageId) {
  const roleNames = {
    proponent: '正方',
    opponent: '反方',
    judge: '裁判',
    audience: '观众'
  };
  
  broadcastToGroup(groupId, {
    type: 'new_message',
    group_id: groupId,
    id: messageId,
    sender_type: 'ai',
    sender_id: aiId,
    content,
    content_type: 'text',
    metadata: {
      debate_role: role,
      debate_role_name: roleNames[role]
    },
    created_at: new Date().toISOString()
  });
}

async function getRecentMessages(groupId, limit = 50) {
  const cachedUserId = groupToUserMap.get(groupId);
  if (cachedUserId) {
    const db = await getUserDb(cachedUserId);
    await db.read();
    const messages = db.data.messages
      .filter(m => m.group_id === groupId)
      .slice(-limit);
    if (messages.length > 0) return messages;
  }
  
  const userIds = await listUserDatabases();
  for (const userId of userIds) {
    const db = await getUserDb(userId);
    await db.read();
    populateGroupCache(userId, db);
    const messages = db.data.messages
      .filter(m => m.group_id === groupId)
      .slice(-limit);
    if (messages.length > 0) return messages;
  }
  return [];
}

async function saveMessage(groupId, aiId, content, role) {
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result) throw new Error(`找不到群组 ${groupId}`);
  
  const { db: userDb } = result;
  const messageId = uuidv4();
  const roleNames = {
    proponent: '正方',
    opponent: '反方',
    judge: '裁判',
    audience: '观众'
  };
  
  const message = {
    id: messageId,
    group_id: groupId,
    sender_type: 'ai',
    sender_id: aiId,
    content,
    content_type: 'text',
    metadata: {
      type: 'formal_debate',
      debate_role: role,
      debate_role_name: roleNames[role]
    },
    created_at: new Date().toISOString()
  };
  
  await withWriteLock(result.userId, async () => {
    await userDb.read();
    userDb.data.messages.push(message);
    await userDb.write();
  });
  
  return messageId;
}

export async function startFormalDebate(groupId, topic, rolePreferences = {}, debateLevel = 2, selectedParticipants = null) {
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result || !result.group || !result.group.ai_members || result.group.ai_members.length < 2) {
    return { groupId, status: 'error', error: '群组不存在或AI成员不足' };
  }
  
  const { db: userDb, group, userId } = result;
  
  await loadCustomPersonas(userId);
  
  const debateKey = `debate:${groupId}`;
  if (activeDebates.has(debateKey)) {
    return { groupId, status: 'error', error: '辩论已在进行中' };
  }
  
  const roles = allocateDebateRoles(group.ai_members, rolePreferences, selectedParticipants);
  
  let phases = roles.hasJudge 
    ? [DEBATE_PHASES.OPENING, DEBATE_PHASES.REBUTTAL, DEBATE_PHASES.FREE_DEBATE, DEBATE_PHASES.CLOSING, DEBATE_PHASES.JUDGMENT]
    : [DEBATE_PHASES.OPENING, DEBATE_PHASES.REBUTTAL, DEBATE_PHASES.FREE_DEBATE, DEBATE_PHASES.CLOSING];
  
  if (roles.hasAudience) {
    phases.push(DEBATE_PHASES.AUDIENCE_COMMENT);
  }
  
  const context = {
    cancel: false,
    topic,
    roles,
    phases,
    currentPhaseIndex: 0,
    currentRound: 1,
    totalRounds: phases.length,
    debateLevel,
    groupMembers: group.ai_members,
    rolePreferences,
    selectedParticipants,
    startTime: Date.now(),
    userId
  };
  
  activeDebates.set(debateKey, context);
  
  group.debate_mode = true;
  group.debate_level = debateLevel;
  group.debate_topic = topic;
  group.debate_roles = roles;
  await withWriteLock(userId, async () => {
    await userDb.write();
  });
  
  broadcastToGroup(groupId, {
    type: 'debate_started',
    group_id: groupId,
    topic,
    roles: {
      proponents: roles.proponents.map(id => ({ id, name: getEffectivePersona(id, userId)?.name || id })),
      opponents: roles.opponents.map(id => ({ id, name: getEffectivePersona(id, userId)?.name || id })),
      judge: roles.judge ? { id: roles.judge, name: getEffectivePersona(roles.judge, userId)?.name || roles.judge } : null,
      audience: roles.audience.map(id => ({ id, name: getEffectivePersona(id, userId)?.name || id }))
    },
    phases: phases.map(p => PHASE_NAMES[p]),
    timestamp: new Date().toISOString()
  });
  
  try {
    for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
      if (context.cancel) break;
      
      context.currentPhaseIndex = phaseIndex;
      const phase = phases[phaseIndex];
      const phaseConfig = getDebatePhaseConfig(phase, roles);
      
      broadcastDebatePhaseChange(groupId, phase, phaseConfig, roles, userId);
      
      await sleep(1500);
      
      const speakerOrder = phase === DEBATE_PHASES.OPENING 
        ? [...roles.proponents, ...roles.opponents]
        : phase === DEBATE_PHASES.CLOSING
        ? [...roles.opponents.slice(-1), ...roles.proponents.slice(-1)]
        : phase === DEBATE_PHASES.AUDIENCE_COMMENT
        ? [...phaseConfig.speakers]
        : [...phaseConfig.speakers].sort(() => Math.random() - 0.5);
      
      for (let turn = 0; turn < phaseConfig.turnsPerSpeaker; turn++) {
        for (const speakerId of speakerOrder) {
          if (context.cancel) break;
          
          const role = phaseConfig.speakerRoles[speakerId];
          const recentMessages = await getRecentMessages(groupId);
          
          const result = await generateDebateResponse(
            speakerId,
            groupId,
            topic,
            role,
            phase,
            phaseConfig,
            recentMessages,
            roles,
            context
          );
          
          if (result) {
            const messageId = await saveMessage(groupId, speakerId, result.content, role);
            broadcastDebateMessage(groupId, speakerId, result.content, role, messageId);
          }
          
          await sleep(500 + Math.random() * 1000);
        }
      }
      
      if (phaseIndex < phases.length - 1 && !context.cancel) {
        await sleep(2000);
      }
    }
    
    activeDebates.delete(debateKey);
    
    await withWriteLock(userId, async () => {
      await userDb.read();
      const group = userDb.data.groups.find(g => g.id === groupId);
      if (group) {
        group.debate_mode = false;
        await userDb.write();
      }
    });
    
    broadcastToGroup(groupId, {
      type: 'debate_finished',
      group_id: groupId,
      timestamp: new Date().toISOString()
    });
    
    return { groupId, status: 'success', message: '辩论已完成' };
    
  } catch (error) {
    console.error(`辩论错误:`, error);
    
    activeDebates.delete(debateKey);
    
    await withWriteLock(userId, async () => {
      await userDb.read();
      const group = userDb.data.groups.find(g => g.id === groupId);
      if (group) {
        group.debate_mode = false;
        await userDb.write();
      }
    });
    
    broadcastToGroup(groupId, {
      type: 'debate_error',
      group_id: groupId,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    return { groupId, status: 'error', error: error.message };
  }
}

export async function stopFormalDebate(groupId) {
  const debateKey = `debate:${groupId}`;
  const context = activeDebates.get(debateKey);
  
  if (context) {
    context.cancel = true;
    
    broadcastToGroup(groupId, {
      type: 'debate_stopped',
      group_id: groupId,
      timestamp: new Date().toISOString()
    });
    
    await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (!activeDebates.has(debateKey)) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        activeDebates.delete(debateKey);
        resolve();
      }, 5000);
    });
    
    return { success: true, message: '辩论已停止' };
  }
  
  return { success: false, message: '没有正在进行的辩论' };
}

export function getDebateStatus(groupId) {
  const debateKey = `debate:${groupId}`;
  const context = activeDebates.get(debateKey);
  
  if (context) {
    const currentPhase = context.phases[context.currentPhaseIndex];
    const phaseConfig = getDebatePhaseConfig(currentPhase, context.roles);
    
    return {
      isRunning: true,
      status: 'running',
      topic: context.topic,
      currentPhase,
      phaseName: phaseConfig.name,
      roles: context.roles,
      debateLevel: context.debateLevel,
      selectedParticipants: context.selectedParticipants,
      hasAudience: context.roles.hasAudience
    };
  }
  
  return {
    isRunning: false,
    status: 'stopped'
  };
}

export async function triggerAudienceComment(groupId, audienceMembers) {
  const result = await findGroupAndMessagesInAnyUserDb(groupId);
  if (!result) {
    return { success: false, error: '群组不存在' };
  }
  
  const { db: userDb, group, messages, userId } = result;
  const recentMessages = messages.slice(-50);
  const topic = group.debate_topic || '辩论';

  await loadCustomPersonas(userId);

  const roles = {
    proponents: [],
    opponents: [],
    judge: null,
    audience: audienceMembers,
    hasAudience: true
  };
  
  const phaseConfig = getDebatePhaseConfig(DEBATE_PHASES.AUDIENCE_COMMENT, roles);
  
  broadcastDebatePhaseChange(groupId, DEBATE_PHASES.AUDIENCE_COMMENT, phaseConfig, roles, userId);
  
  for (const audienceId of audienceMembers) {
    const persona = getEffectivePersona(audienceId, userId);
    if (!persona) continue;
    
    broadcastTypingStatus(groupId, audienceId, true);
    
    try {
      const systemPrompt = buildDebateRolePrompt(
        persona,
        'audience',
        topic,
        DEBATE_PHASES.AUDIENCE_COMMENT,
        phaseConfig,
        recentMessages,
        roles
      );
      
      const rawContent = await callAIDebate(
        audienceId,
        persona,
        topic,
        recentMessages,
        1,
        1,
        2,
        audienceMembers,
        userId
      );
      
      let content = normalizeResponse(rawContent);
      
      if (content && content.trim().length > 0) {
        content = applyMessageLengthLimit(content, { ...persona, socialConfig: { maxMessageLength: Math.max(persona?.socialConfig?.maxMessageLength || 600, 600) } });
        const messageId = await saveMessage(groupId, audienceId, content, 'audience');
        broadcastDebateMessage(groupId, audienceId, content, 'audience', messageId);
      }
    } catch (error) {
      console.error(`观众 ${audienceId} 评论生成失败:`, error.message);
    }
    
    broadcastTypingStatus(groupId, audienceId, false);
    await sleep(500 + Math.random() * 1000);
  }
  
  broadcastToGroup(groupId, {
    type: 'audience_comment_finished',
    group_id: groupId,
    timestamp: new Date().toISOString()
  });
  
  return { success: true, message: '观众评论已完成' };
}

export { allocateDebateRoles, DEBATE_PHASES, PHASE_NAMES };
