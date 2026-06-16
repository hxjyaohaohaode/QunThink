import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { getUploadsDir, getUserDb, withWriteLock } from '../../models/db.js';
import { callAI, callAIStream, normalizeResponse } from '../ai/index.js';
import { parseFile } from '../fileParser/index.js';
import { annotateAndDescribe, generateMediaDescription } from '../fileAnnotation/index.js';
import { AI_PERSONAS } from '../../config/personas.js';
import { safeLog } from '../../utils/logger.js';
import path from 'path';

const AVAILABLE_MODELS = [
  { id: 'deepseek', name: 'deepseek-chat', strength: '逻辑推理、数据分析、编程技术' },
  { id: 'deepseek_reasoner', name: 'deepseek-reasoner', strength: '深度推理、复杂问题分析、思维链推理' },
  { id: 'mimo_flash', name: 'mimo-v2.5', strength: '快速响应、务实分析、效率优化' },
  { id: 'mimo_omni', name: 'mimo-v2-omni', strength: '多模态分析、跨模态推理、全局理解' },
  { id: 'glm_air', name: 'GLM-4.5-Air', strength: '人文历史、哲学思辨、文学艺术' },
  { id: 'glm_flash', name: 'glm-4-flash', strength: '快速分析、要点提炼、高效沟通' },
  { id: 'glm_flashx', name: 'glm-4-flashx', strength: '深度推理、扩展分析、增强理解' },
  { id: 'qwen_flash', name: 'Qwen3.5-Flash', strength: '观点总结、框架构建、信息整合' },
  { id: 'qwen_turbo', name: 'qwen-turbo', strength: '快速分析、高效处理、即时响应' }
];

function extractJSON(text) {
  if (!text) return null;

  const normalized = normalizeResponse(text);
  const jsonBlockMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch (e) { safeLog('warn', 'Agent配置解析失败', { error: e?.message }); }
  }

  const braceMatch = normalized.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch (e) { safeLog('warn', 'Agent消息历史加载失败', { error: e?.message }); }
  }

  const bracketMatch = normalized.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      return JSON.parse(bracketMatch[0]);
    } catch (e) { safeLog('warn', 'Agent文件描述加载失败', { error: e?.message }); }
  }

  try {
    return JSON.parse(normalized);
  } catch (e) {
    safeLog('warn', 'Agent配置加载失败', { error: e?.message });
    return null;
  }
}

export async function createAgent(userId, name, description, openingMessage, enableSuggestions, capabilities, avatarUrl = null) {
  if (!capabilities) capabilities = {};
  const capabilitiesDesc = [];
  if (capabilities.scheduled_tasks) capabilitiesDesc.push('定时任务（需要能按计划执行任务、设置提醒）');
  if (capabilities.web_search) capabilitiesDesc.push('网络搜索（需要能搜索互联网获取最新信息）');
  if (capabilities.multimodal) capabilitiesDesc.push('多模态（需要能处理图片、语音等多模态内容）');

  const modelList = AVAILABLE_MODELS.map(m => `- ${m.id} (${m.name}): 擅长${m.strength}`).join('\n');

  // ============================================
  // 第一阶段：deepseek-v4-pro 主导架构设计（总导演）
  // ============================================
  const architectSystemPrompt = `你是一个顶级AI架构师和智能体编排专家。你的职责是：作为"总导演"，根据用户需求，从可用模型库中挑选最合适的模型组合，并设计完整的系统提示词。你会调用其他AI来协助你完成不同维度的分析。请严格按照JSON格式返回结果。`;

  const architectPrompt = `请作为AI架构师（总导演），为用户描述的智能体需求设计一套完善的AI模型协作方案。

## 用户需求
- 智能体名称：${name}
- 功能定位：${description}
- 开场白：${openingMessage}
- 已选能力：${capabilitiesDesc.length > 0 ? capabilitiesDesc.join('、') : '基础对话'}

## 可用模型库（全部系统AI，必须从中选择）
${modelList}

## 设计要求（多AI协同筛选）
你需要模拟一个多AI协同的筛选过程：

1. **需求分析**：深度分析用户描述的功能定位，拆解出核心能力需求
2. **模型选型**：从可用模型库中挑选2-4个模型，每个模型负责不同角色：
   - 意图理解层：优先使用 deepseek_reasoner 等深度推理模型
   - 主回复层：根据智能体专业领域选择最匹配的模型（如编程→deepseek，人文→glm_air，创意→mimo_omni，快速→qwen_flash）
   - 特殊能力层：多模态需求→mimo_omni，搜索需求→glm_flashx
   - 快速响应层：简单任务→glm_flash / qwen_turbo
3. **角色分配**：明确每个模型的具体职责，避免冗余
4. **协作流程**：设计模型间的调用顺序和协作方式

## 返回JSON格式
{
  "model_roles": [
    {"modelId": "模型ID", "role": "角色名", "description": "具体职责说明"}
  ],
  "model_selection_reasoning": "为什么选择这些模型组合的简要说明（50字内）",
  "system_prompt": "完整的系统提示词（至少300字）"
}

## 注意事项
- model_roles至少分配2个模型，最多4个模型
- 必须从可用模型库中选择，不能使用不存在的模型ID
- system_prompt必须包括：角色定位、专业领域、行为准则、回复风格、核心功能、主动引导策略
- system_prompt中要求智能体在专业领域内主动提供深入帮助，灵活应对相关请求
- 必须包含"主动引导策略"：在回复末尾主动提供1-2个延伸话题`;

  let architectResponse;
  try {
    architectResponse = await callAIStream(
      'deepseek_reasoner',
      { id: 'deepseek_reasoner', name: 'deepseek-reasoner' },
      architectPrompt,
      [],
      'free_chat',
      null, [], null, null, false, [],
      architectSystemPrompt,
      [], null, null, userId
    );
  } catch (error) {
    console.error('[Agent创建] deepseek_reasoner架构师调用失败:', error.message);
    architectResponse = null;
  }

  const parsed = extractJSON(architectResponse);

  let modelRoles;
  let modelSelectionReasoning = '';
  let agentSystemPrompt;

  if (parsed && parsed.model_roles && Array.isArray(parsed.model_roles) && parsed.model_roles.length > 0) {
    modelRoles = parsed.model_roles.map(role => ({
      modelId: role.modelId || 'deepseek',
      role: role.role || '主对话',
      description: role.description || ''
    }));
    modelSelectionReasoning = parsed.model_selection_reasoning || '';
    agentSystemPrompt = parsed.system_prompt || `你是${name}。${description}。`;
  } else {
    // 回退：默认模型组合
    modelRoles = [
      { modelId: 'deepseek_reasoner', role: '意图理解', description: '深度分析用户意图，理解复杂需求' },
      { modelId: 'deepseek', role: '主回复', description: '生成高质量专业回复' }
    ];
    agentSystemPrompt = `你是${name}，一个专业的AI助手。${description}。

## 核心能力
你擅长${description}，在这个领域内你能提供深入、专业、有价值的帮助。

## 行为准则
1. 在专业领域内主动提供深入分析和建议
2. 回复准确、详细、有针对性，避免泛泛而谈
3. 如果用户请求与你的专业领域相关但略微偏离核心功能，灵活应对并提供有价值的信息
4. 只有完全无关的请求才礼貌引导回你的专业领域
5. 在回复末尾主动提供1-2个相关延伸话题，引导用户深入探索

## 回复风格
专业、友好、高效，用自然的方式与用户交流，让每次对话都有收获。`;
  }

  // ============================================
  // 第二阶段：多AI协同评审（各模型从自身角度评审方案）
  // ============================================
  // 用第二个AI（如 qwen_flash）从不同角度评审和优化 system_prompt
  const reviewSystemPrompt = '你是一个智能体系统提示词评审专家。你的任务是检查并优化智能体的系统提示词，确保其完整、专业、实用。请直接输出优化后的完整系统提示词，不要添加其他说明。';

  const reviewPrompt = `请评审并优化以下智能体的系统提示词：

## 智能体信息
- 名称：${name}
- 功能定位：${description}
- 开场白：${openingMessage}

## 当前系统提示词
${agentSystemPrompt}

## 评审要求
1. 检查角色定位是否清晰明确
2. 检查专业领域描述是否准确深入
3. 检查行为准则是否完整（是否包含主动引导策略）
4. 检查回复风格描述是否恰当
5. 如有缺失或不足，请补充优化
6. 保持原有优秀内容，只做增量改进

请直接输出优化后的完整系统提示词。`;

  try {
    const reviewResponse = await callAIStream(
      'qwen_flash',
      { id: 'qwen_flash', name: 'Qwen3.5-Flash' },
      reviewPrompt,
      [],
      'free_chat',
      null, [], null, null, false, [],
      reviewSystemPrompt,
      [], null, null, userId
    );

    if (reviewResponse && reviewResponse.trim().length > 100) {
      const cleaned = normalizeResponse(reviewResponse).trim();
      // 确保优化后的结果至少包含原有内容的长度
      if (cleaned.length >= agentSystemPrompt.length * 0.7) {
        agentSystemPrompt = cleaned;
        console.log('[Agent创建] 多AI协同评审完成，system_prompt已优化');
      }
    }
  } catch (error) {
    console.warn('[Agent创建] 评审AI调用失败，使用原始system_prompt:', error.message);
  }

  const agent = {
    id: uuidv4(),
    name,
    avatar_url: avatarUrl,
    description,
    opening_message: openingMessage,
    enable_suggestions: enableSuggestions !== undefined ? enableSuggestions : true,
    capabilities,
    model_roles: modelRoles,
    system_prompt: agentSystemPrompt,
    model_selection_reasoning: modelSelectionReasoning,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const db = await getUserDb(userId);
  await db.read();
  db.data.agents.push(agent);
  await withWriteLock(userId, async () => { await db.write(); });

  return agent;
}

export async function generateAgentQuestions(name, description, openingMessage) {
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

  const persona = { id: 'mimo_flash', name: 'mimo-v2.5' };

  let response;
  try {
    response = await callAIStream(
      'mimo_flash',
      persona,
      userPrompt,
      [],
      'free_chat',
      null, [], null, null, false, [],
      systemPrompt,
      [], null, null, null
    );
  } catch (error) {
    console.error('[Agent问题生成] mimo_flash调用失败:', error.message);
    response = null;
  }

  if (!response) {
    console.warn('[Agent问题生成] AI返回为空，使用默认问题');
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

  console.warn('[Agent问题生成] AI返回格式不正确，使用默认问题');
  return [
    { id: 'q1', question: `针对"${name}"的核心功能，你希望它在${description.substring(0, 30)}方面有什么特别的处理方式吗？` },
    { id: 'q2', question: '这个智能体主要服务哪类人群？你期望他们用怎样的场景和频率使用？' },
    { id: 'q3', question: '你希望它的回复风格是怎样的？比如专业严谨、轻松幽默、还是亲切友好？' }
  ];
}

export async function chatWithAgent(userId, agentId, userMessage, onChunk, attachments = []) {
  const db = await getUserDb(userId);
  await db.read();

  const agent = db.data.agents.find(a => a.id === agentId);
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
        console.error(`[Agent对话] 附件解析失败:`, error.message);
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

  await withWriteLock(userId, async () => {
    db.data.agent_messages.push(userMsg);
    await db.write();
  });

  await db.read();

  const recentAgentMessages = db.data.agent_messages
    .filter(m => m.agent_id === agentId)
    .slice(-30);

  const modelRoles = agent.model_roles || [];
  const intentModel = modelRoles.find(r => r.role === '意图理解') || modelRoles[0];
  const replyModel = modelRoles.find(r => r.role === '主回复') || modelRoles[0];

  const replyModelId = replyModel?.modelId || 'deepseek';
  const replyPersona = AI_PERSONAS[replyModelId] || { id: replyModelId, name: replyModelId };

  const formattedMessages = recentAgentMessages.map(m => ({
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
      console.warn('[Agent对话] 意图分析失败，跳过:', error.message);
    }
  }

  const finalMessage = intentContext ? `${messageContent}${intentContext}` : messageContent;

  const response = await callAIStream(
    replyModelId,
    replyPersona,
    finalMessage,
    formattedMessages,
    'free_chat',
    null, [], null, null, false, [],
    enhancedSystemPrompt,
    [], onChunk, null, userId
  );

  const agentMsg = {
    id: uuidv4(),
    agent_id: agentId,
    sender_type: 'agent',
    content: response,
    created_at: new Date().toISOString()
  };

  await withWriteLock(userId, async () => {
    db.data.agent_messages.push(agentMsg);
    await db.write();
  });

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
    const suggestions = await callSuggestionAPI(systemPrompt, userPrompt);
    if (suggestions && suggestions.length > 0) {
      return suggestions;
    }
  } catch (error) {
    console.error('[建议回复] API调用失败:', error.message);
  }

  return getDefaultSuggestions(agent, isInitial, userProfile);
}

async function callSuggestionAPI(systemPrompt, userPrompt) {
  const configs = [
    { key: process.env.GLM_API_KEY, endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
    { key: process.env.MIMO_API_KEY, endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5' },
    { key: process.env.QWEN_API_KEY, endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen3.5-flash' }
  ];

  const availableConfigs = configs.filter(c => c.key);
  if (availableConfigs.length === 0) return null;

  const callOne = async (config) => {
    const response = await axios.post(
      config.endpoint,
      {
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 300,
        stream: false
      },
      {
        headers: {
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json'
        },
        timeout: 6000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = extractJSON(content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const validSuggestions = parsed
        .filter(s => typeof s === 'string' && s.trim().length > 0 && s.length <= 80)
        .map(s => s.trim().replace(/^["'\d.\s)]+/, '').replace(/["']+$/, ''))
        .slice(0, 3);
      if (validSuggestions.length > 0) {
        return validSuggestions;
      }
    }
    return null;
  };

  const promises = availableConfigs.map(config =>
    callOne(config).catch(() => null)
  );

  try {
    const raceResult = await Promise.any(promises);
    if (raceResult && Array.isArray(raceResult) && raceResult.length > 0) {
      return raceResult;
    }
  } catch (e) { safeLog('warn', 'Agent结果处理失败', { error: e?.message }); }

  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && Array.isArray(r.value) && r.value.length > 0) {
      return r.value;
    }
  }

  return null;
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

export async function invokeAgentInGroup(userId, agentId, context) {
  const db = await getUserDb(userId);
  await db.read();

  const agent = db.data.agents.find(a => a.id === agentId);
  if (!agent) {
    throw new Error('智能体不存在');
  }

  const primaryModel = agent.model_roles[0];
  const modelId = primaryModel?.modelId || 'deepseek';
  const persona = AI_PERSONAS[modelId] || { id: modelId, name: modelId };

  const response = await callAIStream(
    modelId,
    persona,
    context,
    [],
    'free_chat',
    null, [], null, null, false, [],
    agent.system_prompt,
    [], null, null, userId
  );

  return response;
}
