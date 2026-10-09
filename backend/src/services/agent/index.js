import { v4 as uuidv4 } from 'uuid';
import { defaultModelId, readCatalog, resolveModel } from '../ai/catalog.js';
import { requestCompletion } from '../ai/transport.js';
import { getUploadsDir, getUserDb, withWriteLock, beginUserDbWriteBarrier, readCommittedUserDb } from '../../models/db.js';
import { callAI, callAIStream, normalizeResponse } from '../ai/index.js';
import { parseFile } from '../fileParser/index.js';
import { annotateAndDescribe, generateMediaDescription } from '../fileAnnotation/index.js';
import { AI_PERSONAS } from '../../config/personas.js';
import { safeLog } from '../../utils/logger.js';
import path from 'path';

function extractJSON(text) {
  if (!text) return null;

  const normalized = normalizeResponse(text);
  const jsonBlockMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch (e) { safeLog('warn', 'JSON 解析失败（代码块阶段）', { error: e?.message }); }
  }

  const braceMatch = normalized.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch (e) { safeLog('warn', 'JSON 解析失败（花括号块阶段）', { error: e?.message }); }
  }

  const bracketMatch = normalized.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      return JSON.parse(bracketMatch[0]);
    } catch (e) { safeLog('warn', 'JSON 解析失败（方括号块阶段）', { error: e?.message }); }
  }

  try {
    return JSON.parse(normalized);
  } catch (e) {
    safeLog('warn', 'JSON 解析失败（全文阶段）', { error: e?.message });
    return null;
  }
}

export function buildBaseAgentPrompt(name, description) {
  return '你是' + name + '。你的任务是：' + description + '。请提供准确、清晰、可执行的帮助，区分事实和推测。可以主动提出下一步建议，但不能声称已执行未接入的外部工具、联网搜索或定时任务。';
}

export async function createAgent(userId, name, description, openingMessage, enableSuggestions, capabilities, avatarUrl = null, selectedModelId = null) {
  const modelId = selectedModelId || await defaultModelId(userId);
  const config = await resolveModel(userId, modelId, 'chat');
  const basePrompt = buildBaseAgentPrompt(name, description);
  let systemPrompt = basePrompt;
  let source = '根据用户说明创建';
  try {
    const result = await requestCompletion(config, [
      { role: 'system', content: '为用户创建一个实用的 AI 助手系统提示词。只返回 JSON，字段 system_prompt。不宣称已接入网络搜索、外部工具、操作系统或自动执行能力。' },
      { role: 'user', content: JSON.stringify({ name, description, openingMessage, preferences: capabilities || {} }) }
    ], { maxTokens: 1800, timeout: 30000 });
    const parsed = extractJSON(result);
    if (typeof parsed?.system_prompt === 'string' && parsed.system_prompt.length >= 30 && parsed.system_prompt.length <= 12000) {
      systemPrompt = parsed.system_prompt; source = '由所选模型根据你的需求生成，可在设置中修改';
    }
  } catch (error) { safeLog('warn', '[Agent创建] 使用用户说明创建基础提示词', { error: error.message }); }
  const agent = {
    id: uuidv4(), name, avatar_url: avatarUrl, description, opening_message: openingMessage,
    enable_suggestions: enableSuggestions !== false,
    capabilities: { ...capabilities, web_search: false, scheduled_tasks: false },
    model_roles: [{ modelId, role: '主回复', description: '使用用户选择的模型' }],
    system_prompt: systemPrompt, model_selection_reasoning: source,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  const db = await getUserDb(userId);
  await withWriteLock(userId, async () => {
    await db.read(); db.data.agents ||= []; db.data.agents.push(agent); await db.write();
  });
  return agent;
}

export async function generateAgentQuestions(name, description, openingMessage, userId) {
  const systemPrompt = '你是一个贴心的智能体配置助手。你的任务是：根据用户第一步填写的智能体信息，深入分析用户真实需求，生成2-3个高度个性化的追问。每个问题必须从用户描述中提取关键信息点，针对性地追问细节。绝不能泛泛而问。';

  const userPrompt = `用户正在创建智能体，以下是他们第一步填写的信息：

- 智能体名称：${name}
- 功能描述：${description}
- 开场白：${openingMessage}

## 核心任务
请深入分析以上信息，提取关键特征，然后生成2-3个高度个性化的追问。

## 生成规则（严格遵守）
1. **必须基于用户描述的具体内容**：从用户已经描述的功能、领域、场景中提取关键信息，追问相关细节
2. **每个问题必须独特**：不能重复问同一个方向
3. **问题类型参考**（从以下选择2-3个最相关的）：
   - 专业深度：针对用户描述的专业领域，追问具体子领域偏好
   - 工作流程：追问用户期望的具体工作方式或流程
   - 输出格式：追问用户期望的回复格式（如报告、列表、对话等）
   - 目标用户画像：追问服务对象和使用场景的细节
   - 功能边界：追问哪些话题需要回避或特别处理
4. **对话式表达**：像朋友间的自然对话，简洁友好，每个问题不超过60字
5. **绝对禁止**：不要问"需要联网吗""需要多模态吗"等通用问题

## 返回格式
请以JSON数组格式返回：
[{"id": "q1", "question": "问题内容"}, {"id": "q2", "question": "问题内容"}]

只返回JSON数组，不要任何其他文字。`;

  const modelId = await defaultModelId(userId).catch(() => null);
  const persona = { id: modelId, name: '配置助手' };

  let response;
  try {
    response = await callAIStream(
      modelId,
      persona,
      userPrompt,
      [],
      'free_chat',
      null, [], null, null, false, [],
      systemPrompt,
      [], null, null, userId
    );
  } catch (error) {
    safeLog('error', '[Agent问题生成] mimo_flash调用失败', { error: error.message });
    response = null;
  }

  if (!response) {
    safeLog('warn', '[Agent问题生成] AI返回为空，使用默认问题');
    return [
      { id: 'q1', question: `针对"${name}"的核心功能，你希望它在${description.substring(0, 30)}方面有什么特别的处理方式吗？` },
      { id: 'q2', question: '这个智能体主要服务哪类人群？你期望他们用怎样的场景和频率使用？' },
      { id: 'q3', question: '你希望它的回复风格是怎样的？比如专业严谨、轻松幽默、还是亲切友好？' }
    ];
  }

  const parsed = extractJSON(response);

  if (Array.isArray(parsed) && parsed.length > 0) {
    const questions = parsed.map((q, index) => ({
      id: q.id || `q${index + 1}`,
      question: q.question || q.text || q.content || ''
    })).filter(q => q.question.length > 0 && q.question.length < 200);

    if (questions.length > 0) {
      return questions;
    }
  }

  safeLog('warn', '[Agent问题生成] AI返回格式不正确，使用默认问题');
  return [
    { id: 'q1', question: `针对"${name}"的核心功能，你希望它在${description.substring(0, 30)}方面有什么特别的处理方式吗？` },
    { id: 'q2', question: '这个智能体主要服务哪类人群？你期望他们用怎样的场景和频率使用？' },
    { id: 'q3', question: '你希望它的回复风格是怎样的？比如专业严谨、轻松幽默、还是亲切友好？' }
  ];
}

function trimAgentMessages(db, agentId, max = 200) {
  const messages = db.data.agent_messages;
  if (!Array.isArray(messages)) return;
  const indexes = [];
  messages.forEach((m, i) => {
    if (m.agent_id === agentId) indexes.push(i);
  });
  if (indexes.length <= max) return;
  const removeSet = new Set(indexes.slice(0, indexes.length - max));
  db.data.agent_messages = messages.filter((_, i) => !removeSet.has(i));
}

// Keep readers behind each chat write and discard an unacknowledged in-memory
// mutation. The write may have committed before failing, so invalidate the
// local cache and let the next read establish durable truth; never retry it.
async function appendAgentMessage(userId, db, message) {
  await withWriteLock(userId, async () => {
    await db.read({ force: true });
    const before = db.data.agent_messages;
    const releaseReaders = beginUserDbWriteBarrier(db);
    try {
      db.data.agent_messages = [...(before || []), message];
      trimAgentMessages(db, message.agent_id);
      await db.write();
    } catch (error) {
      db.data.agent_messages = before;
      db.invalidateReadCache?.();
      throw Object.assign(new Error('消息保存结果未确认，请刷新核对会话后再决定是否重新发送'), { cause: error });
    } finally { releaseReaders(); }
  });
}

export async function chatWithAgent(userId, agentId, userMessage, onChunk, attachments = []) {
  const db = await getUserDb(userId);
  const agent = await readCommittedUserDb(db, data => data.agents.find(a => a.id === agentId));
  if (!agent) {
    throw new Error('智能体不存在');
  }

  let messageContent = userMessage;
  const attachmentInfos = [];

  if (attachments && attachments.length > 0) {
    messageContent += '\n\n【用户上传的附件】\n';

    for (const attachment of attachments) {
      try {
        const filePath = attachment.file_path || path.resolve(getUploadsDir(), attachment.filename || attachment.name);
        const mimeType = attachment.mime_type || attachment.type || 'application/octet-stream';
        const fileName = attachment.filename || attachment.name || '未知文件';
        const fileSize = attachment.size || 0;

        if (attachment.owner_user_id !== undefined && attachment.owner_user_id !== userId) {
          safeLog('warn', '[Agent对话] 拒绝属主不匹配的附件', { fileName, owner_user_id: attachment.owner_user_id, userId });
          messageContent += `\n[附件被拒绝: ${fileName}（附件属主校验失败）]\n`;
          continue;
        }

        const userUploadDir = path.resolve(getUploadsDir(), String(userId));
        const resolvedFilePath = path.resolve(filePath);
        const relativeToUserDir = path.relative(userUploadDir, resolvedFilePath);
        if (!relativeToUserDir || relativeToUserDir.startsWith('..') || path.isAbsolute(relativeToUserDir)) {
          safeLog('warn', '[Agent对话] 拒绝越权路径的附件', { fileName, userId });
          messageContent += `\n[附件被拒绝: ${fileName}（附件路径属主校验失败）]\n`;
          continue;
        }

        const parsedContent = await parseFile(filePath, mimeType);
        const textContent = typeof parsedContent === 'string' ? parsedContent : '';

        const { annotation, description } = await annotateAndDescribe(
          filePath, mimeType, fileName, fileSize, textContent
        );

        const ext = path.extname(fileName).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
        const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext);
        const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext);
        const mediaType = isImage ? '图片' : isAudio ? '音频' : isVideo ? '视频' : '文件';

        messageContent += `\n【用户上传的${mediaType}: ${fileName}】\n`;
        const hasRealContent = textContent && textContent.length > 30
          && !textContent.startsWith('[') && !textContent.startsWith('【');

        if (hasRealContent) {
          if (description) {
            messageContent += `AI分析: ${description}\n`;
          }
          const contentLimit = 4000;
          messageContent += `\n文件原文:\n${textContent.substring(0, contentLimit)}\n`;
          if (textContent.length > contentLimit) {
            messageContent += `...(内容已截断，原文共${textContent.length}字)\n`;
          }
        } else if (description) {
          messageContent += `内容描述: ${description}\n`;
        } else {
          messageContent += `请根据上下文理解这个${mediaType}。\n`;
        }

        if (annotation) {
          messageContent += `标签: ${annotation.tags?.join(', ') || '无'}\n`;
        }

        attachmentInfos.push({
          filename: fileName,
          type: isImage ? 'image' : isAudio ? 'audio' : isVideo ? 'video' : 'file',
          description: description || '',
          content_preview: (description || textContent).substring(0, 100)
        });
      } catch (error) {
        safeLog('error', '[Agent对话] 附件解析失败', { error: error.message });
        messageContent += `\n[文件解析失败: ${attachment.filename || attachment.name || '未知文件'}]\n`;
      }
    }
  }

  const userMsg = {
    id: uuidv4(),
    agent_id: agentId,
    sender_type: 'user',
    content: userMessage,
    attachments: attachmentInfos.length > 0 ? attachmentInfos : undefined,
    created_at: new Date().toISOString()
  };

  await appendAgentMessage(userId, db, userMsg);

  const recentAgentMessages = await readCommittedUserDb(db, data =>
    data.agent_messages.filter(m => m.agent_id === agentId).slice(-30));

  const modelRoles = agent.model_roles || [];
  const intentModel = modelRoles.find(r => r.role === '意图理解') || modelRoles[0];
  const replyModel = modelRoles.find(r => r.role === '主回复') || modelRoles[0];

  const replyModelId = replyModel?.modelId || await defaultModelId(userId);
  const replyPersona = AI_PERSONAS[replyModelId] || { id: replyModelId, name: replyModelId };

  const formattedMessages = recentAgentMessages.filter(m => m.id !== userMsg.id).map(m => ({
    id: m.id,
    sender_type: m.sender_type === 'agent' ? 'ai' : 'user',
    sender_id: m.sender_type === 'agent' ? replyModelId : 'user',
    content: m.content
  }));

  const enhancedSystemPrompt = buildAgentSystemPrompt(agent);

  let intentContext = '';
  if (modelRoles.length >= 2 && intentModel.modelId !== replyModelId) {
    try {
      const intentModelId = intentModel.modelId;
      const intentPersona = AI_PERSONAS[intentModelId] || { id: intentModelId, name: intentModelId };
      const intentSystemPrompt = `你是一个意图分析专家。你的任务是：分析用户在对话中的真实意图，提取关键信息点，判断用户需求的优先级和情感倾向。请简洁地输出分析结果，不超过100字。`;

      const recentContext = recentAgentMessages.slice(-6).map(m =>
        m.sender_type === 'user' ? `用户: ${m.content.substring(0, 200)}` : `助手: ${m.content.substring(0, 200)}`
      ).join('\n');

      const intentResult = await callAIStream(
        intentModelId,
        intentPersona,
        `分析以下对话中用户的最新意图：\n\n${recentContext}\n\n用户最新消息：${messageContent.substring(0, 500)}`,
        [],
        'free_chat',
        null, [], null, null, false, [],
        intentSystemPrompt,
        [], null, null, userId
      );

      if (intentResult && intentResult.trim()) {
        intentContext = `\n\n【意图分析】${intentResult.trim()}`;
      }
    } catch (error) {
      safeLog('warn', '[Agent对话] 意图分析失败，跳过', { error: error.message });
    }
  }

  const finalMessage = intentContext ? `${messageContent}${intentContext}` : messageContent;

  let emittedContent = '';
  const emitChunk = chunk => {
    if (typeof chunk !== 'string') return;
    emittedContent += chunk;
    onChunk?.(chunk);
  };
  const response = await callAIStream(
    replyModelId,
    replyPersona,
    finalMessage,
    formattedMessages,
    'free_chat',
    null, [], null, null, false, [],
    enhancedSystemPrompt,
    [], emitChunk, null, userId
  );

  const agentMsg = {
    id: uuidv4(),
    agent_id: agentId,
    sender_type: 'agent',
    content: response,
    created_at: new Date().toISOString()
  };

  await appendAgentMessage(userId, db, agentMsg);

  // callAIStream can append a truthful interruption notice to its returned text.
  // Emit only the actual saved suffix, never repeat chunks or invent a result.
  if (typeof response === 'string' && response.startsWith(emittedContent)) {
    const savedTail = response.slice(emittedContent.length);
    if (savedTail) emitChunk(savedTail);
  }
  return { content: response };
}

function buildAgentSystemPrompt(agent) {
  const functionBoundary = `你是"${agent.name}"智能体，功能定位：${agent.description}。

## 行为准则
1. 在你的专业领域内提供深入、准确、有价值的帮助
2. 如果用户请求与你的功能定位完全无关，礼貌引导回你的专业领域，但不要过于生硬
3. 始终记住自己的身份和专业性，回复时体现专业深度
4. 主动提供有价值的延伸信息和建议，让对话更有深度
5. 用自然、专业、友好的方式与用户交流`;

  return `${functionBoundary}\n\n${agent.system_prompt}`;
}

export async function generateSuggestions(agent, agentResponse, userMessage, userId, chatHistory = [], userProfile = null) {
  const historyContext = chatHistory.length > 0
    ? chatHistory.slice(-6).map(m =>
      m.sender_type === 'user' ? `用户: ${m.content.substring(0, 200)}` : `智能体: ${m.content.substring(0, 200)}`
    ).join('\n')
    : '（暂无历史对话）';

  let userContext = '';
  if (userProfile) {
    const parts = [];
    if (userProfile.nickname) parts.push(`昵称: ${userProfile.nickname}`);
    if (userProfile.occupation) parts.push(`职业: ${userProfile.occupation}`);
    if (userProfile.hobbies && userProfile.hobbies.length > 0) parts.push(`爱好: ${userProfile.hobbies.join('、')}`);
    if (userProfile.goals) parts.push(`目标: ${userProfile.goals}`);
    if (userProfile.personality && userProfile.personality.length > 0) parts.push(`性格: ${userProfile.personality.join('、')}`);
    if (userProfile.education) parts.push(`学历: ${userProfile.education}`);
    if (userProfile.bio) parts.push(`简介: ${userProfile.bio.substring(0, 150)}`);
    if (parts.length > 0) userContext = `\n## 用户画像\n${parts.join('\n')}`;
  }

  const capabilitiesDesc = [];
  if (agent.capabilities) {
    if (agent.capabilities.scheduled_tasks) capabilitiesDesc.push('定时任务');
    if (agent.capabilities.web_search) capabilitiesDesc.push('网络搜索');
    if (agent.capabilities.multimodal) capabilitiesDesc.push('多模态理解');
  }

  const isInitial = !agentResponse || agentResponse === agent.opening_message;
  const agentFuncDomain = agent.description ? agent.description.substring(0, 120) : '通用助手';
  const capabilitiesStr = capabilitiesDesc.length > 0 ? `\n## 智能体能力\n${capabilitiesDesc.join('、')}` : '';

  const systemPrompt = `你是一名资深对话设计师，擅长根据上下文预测用户最可能的下一步提问。你需要生成3个能推动对话向纵深发展的追问建议。

## 核心原则
1. 建议必须是用户真实会说的话，口语化、自然、具体
2. 每个建议应开启新的信息探索路径，避免重复
3. 严格基于智能体功能范围和对话上下文生成
4. 返回纯JSON数组格式，不要任何额外文字`;

  const userPrompt = isInitial
    ? `## 智能体信息
名称：${agent.name}
功能定位：${agentFuncDomain}
开场白：${agent.opening_message ? agent.opening_message.substring(0, 150) : '无'}${capabilitiesStr}${userContext}

## 任务
用户刚进入与"${agent.name}"的对话，看到了开场白。请生成3条用户最可能说的话。

## 生成要求
1. 每条15-30字，像用户真实会说的话，口语化表达
2. 三条建议覆盖不同维度：
   - 第一条：探索智能体的核心功能（用户最想先试什么）
   - 第二条：提出一个具体的专业问题（基于功能定位）
   - 第三条：深入一个实际使用场景（结合用户画像${userContext ? '' : '或功能特色'})
3. ${userContext ? '必须结合用户画像中的职业、爱好等信息个性化建议' : '建议要体现智能体的独特价值'}
4. 不加引号、序号等修饰

## 输出格式
只返回JSON数组：["建议1","建议2","建议3"]`
    : `## 智能体信息
名称：${agent.name}
功能定位：${agentFuncDomain}${capabilitiesStr}${userContext}

## 对话上下文
${historyContext}

## 当前轮对话
用户说：${userMessage.substring(0, 400)}
智能体回复：${agentResponse.substring(0, 600)}

## 任务
根据以上对话上下文，生成3条用户可能继续说的话。

## 生成要求
1. 每条15-30字，像用户真实会说的话，口语化表达
2. 三条建议覆盖不同维度：
   - 第一条：追问智能体回复中的细节或关键信息
   - 第二条：换个角度或方向提出相关问题
   - 第三条：深入探讨或请求具体行动（如示例、方案、步骤等）
3. ${userContext ? '结合用户画像让建议更个性化' : '自然衔接当前对话话题'}
4. 不加引号、序号等修饰，不重复已有对话内容
5. 禁止复述智能体已明确回答的内容

## 输出格式
只返回JSON数组：["建议1","建议2","建议3"]`;

  try {
    const suggestions = await callSuggestionAPI(systemPrompt, userPrompt, userId);
    if (suggestions && suggestions.length > 0) {
      return suggestions;
    }
  } catch (error) {
    safeLog('error', '[建议回复] API调用失败', { error: error.message });
  }

  return getDefaultSuggestions(agent, isInitial, userProfile);
}

async function callSuggestionAPI(systemPrompt, userPrompt, userId) {
  const modelId = await defaultModelId(userId);
  const config = await resolveModel(userId, modelId, 'chat');
  const content = await requestCompletion(config, [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], { maxTokens: 300, timeout: 10000 });
  const parsed = extractJSON(content);
  return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string' && s.trim() && s.length <= 80).slice(0, 3) : null;
}

function getDefaultSuggestions(agent, isInitial = true, userProfile = null) {
  const desc = agent.description || '';
  const name = agent.name || '';

  const userHints = [];
  if (userProfile) {
    if (userProfile.occupation) userHints.push(userProfile.occupation);
    if (userProfile.hobbies && userProfile.hobbies.length > 0) userHints.push(...userProfile.hobbies.slice(0, 3));
  }

  if (isInitial) {
    if (desc.includes('编程') || desc.includes('代码') || desc.includes('开发')) {
      return [
        '帮我写一个实用的代码示例',
        '这个技术栈有哪些最佳实践？',
        '帮我分析一下常见的架构模式'
      ];
    }
    if (desc.includes('写作') || desc.includes('文案') || desc.includes('创作')) {
      return [
        '帮我写一篇关于这个主题的文章',
        '能换个风格再写一版吗？',
        '给我一些创意灵感和方向'
      ];
    }
    if (desc.includes('翻译') || desc.includes('语言')) {
      return [
        '帮我翻译这段内容',
        '解释一下这个词的用法和语境',
        '帮我纠正这段话的语法错误'
      ];
    }
    if (desc.includes('健身') || desc.includes('运动') || desc.includes('健康')) {
      return [
        '帮我制定一个适合我的训练计划',
        '有哪些适合初学者的动作？',
        '如何科学地避免运动损伤？'
      ];
    }
    if (desc.includes('学习') || desc.includes('教育') || desc.includes('考试')) {
      return [
        '帮我梳理一下这个领域的知识框架',
        '有哪些重点和难点需要掌握？',
        '给我出几道练习题检验一下'
      ];
    }
    if (userHints.length > 0) {
      return [
        `作为${userHints[0]}，你能帮我做什么？`,
        `${name}最擅长解决什么问题？`,
        '给我一个具体的使用场景示例'
      ];
    }
    return [
      `你能帮我做什么？介绍一下你的功能`,
      `${name}有什么独特的优势？`,
      '给我一个具体的使用场景'
    ];
  }

  if (desc.includes('编程') || desc.includes('代码') || desc.includes('开发')) {
    return [
      '能详细解释一下这个实现原理吗？',
      '有没有更优的解决方案？',
      '帮我写一个完整的代码示例'
    ];
  }
  if (desc.includes('写作') || desc.includes('文案') || desc.includes('创作')) {
    return [
      '能换个风格再写一版吗？',
      '帮我润色一下这段文字',
      '给我更多创意方向和灵感'
    ];
  }
  if (desc.includes('翻译') || desc.includes('语言')) {
    return [
      '翻译成另一种语言',
      '解释一下这个词的用法',
      '帮我纠正语法错误'
    ];
  }
  if (desc.includes('健身') || desc.includes('运动') || desc.includes('健康')) {
    return [
      '帮我制定一个训练计划',
      '有哪些适合初学者的动作？',
      '如何避免运动损伤？'
    ];
  }
  if (desc.includes('学习') || desc.includes('教育') || desc.includes('考试')) {
    return [
      '帮我梳理一下知识框架',
      '有哪些重点需要掌握？',
      '给我出几道练习题'
    ];
  }

  if (userHints.length > 0) {
    return [
      `作为${userHints[0]}，你能帮我什么？`,
      `${name}的核心功能是什么？`,
      '给我一个具体的使用场景'
    ];
  }

  return [
    '能详细解释一下吗？',
    '有其他方案吗？',
    '能举个例子吗？'
  ];
}

export async function invokeAgentInGroup(userId, agentId, context, beforeDispatch = null) {
  const db = await getUserDb(userId);
  await db.read();

  const agent = db.data.agents.find(a => a.id === agentId);
  if (!agent) {
    throw new Error('智能体不存在');
  }

  const primaryModel = agent.model_roles?.find(r => r.role === '主回复') || agent.model_roles?.[0];
  const modelId = primaryModel?.modelId || await defaultModelId(userId);
  const persona = AI_PERSONAS[modelId] || { id: modelId, name: modelId };

  const response = await callAIStream(
    modelId,
    persona,
    context,
    [],
    'free_chat',
    null, [], null, null, false, [],
    agent.system_prompt,
    [], null, null, userId, null, beforeDispatch
  );

  return response;
}
