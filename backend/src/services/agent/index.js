import { v4 as uuidv4 } from 'uuid';
import { getUploadsDir, getUserDb, withWriteLock } from '../../models/db.js';
import { callAI, callAIStream, normalizeResponse } from '../ai/index.js';
import { AI_PERSONAS } from '../../config/personas.js';
import { parseFile } from '../fileParser/index.js';
import { generateMediaDescription } from '../fileAnnotation/index.js';
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
    } catch {}
  }

  const braceMatch = normalized.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {}
  }

  const bracketMatch = normalized.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      return JSON.parse(bracketMatch[0]);
    } catch {}
  }

  try {
    return JSON.parse(normalized);
  } catch {
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

  const systemPrompt = '你是一个顶级AI架构师和智能体编排专家。你的职责是：根据用户提供的智能体需求，设计最优的模型角色分配方案和系统提示词。注意：你不是智能体本身，你是智能体的"设计者"，你需要自主创建功能、调用合适的大模型来组建一个完整的智能体。请严格按照JSON格式返回结果。';

  const userPrompt = `请作为AI架构师，为用户描述的智能体需求设计一套完善的AI模型协作方案。

## 用户需求
- 智能体名称：${name}
- 功能定位：${description}
- 开场白：${openingMessage}
- 已选能力：${capabilitiesDesc.length > 0 ? capabilitiesDesc.join('、') : '基础对话'}

## 可用模型库
${modelList}

## 设计要求（你需要自主决定如何组建这个智能体）
1. **分析需求**：根据用户描述的功能，判断需要哪些核心能力
2. **模型选型**：从可用模型库中选择最合适的模型组合，每个模型负责不同角色
3. **角色分配**：
   - 意图理解层：优先使用 deepseek_reasoner 等深度推理模型理解用户复杂意图
   - 主回复层：根据智能体专业领域选择最擅长的大模型生成高质量回复
   - 特殊能力层：如有多模态、搜索等特殊需求，分配专门的模型
   - 快速响应层：简单任务可使用 glm_flashx 等极速模型保证响应速度
4. **能力编排**：设计模型间的协作流程，确保智能体功能完善、响应迅速

## 返回JSON格式
{
  "model_roles": [
    {"modelId": "模型ID", "role": "角色名", "description": "该模型在智能体中的具体职责说明"}
  ],
  "system_prompt": "这个智能体的完整系统提示词，必须包括：角色定位、专业领域、行为准则、能力边界、回复风格、核心功能"
}

## 注意事项
- model_roles至少分配2个模型，最多4个模型
- system_prompt必须非常详细，至少200字，完全基于用户需求定制
- **关键约束**：system_prompt 中必须明确定义智能体的功能边界，要求智能体**只做用户设定的功能范围内的事情**，如果用户请求超出功能范围，应该礼貌说明自己专注于设定的功能
- 确保模型分工明确、各尽其职、功能强大`;

  const persona = { id: 'deepseek_reasoner', name: 'deepseek-reasoner' };

  let response;
  try {
    response = await callAIStream(
      'deepseek_reasoner',
      persona,
      userPrompt,
      [],
      'free_chat',
      null, [], null, null, false, [],
      systemPrompt,
      [], null, null, userId
    );
  } catch (error) {
    console.error('[Agent创建] deepseek_reasoner调用失败:', error.message);
    response = null;
  }

  const parsed = extractJSON(response);

  let modelRoles;
  let agentSystemPrompt;

  if (parsed && parsed.model_roles && Array.isArray(parsed.model_roles) && parsed.model_roles.length > 0) {
    modelRoles = parsed.model_roles.map(role => ({
      modelId: role.modelId || 'deepseek',
      role: role.role || '主对话',
      description: role.description || ''
    }));
    agentSystemPrompt = parsed.system_prompt || `你是${name}。${description}。`;
  } else {
    modelRoles = [
      { modelId: 'deepseek_reasoner', role: '意图理解', description: '深度分析用户意图，理解复杂需求' },
      { modelId: 'deepseek', role: '主回复', description: '生成高质量专业回复' }
    ];
    agentSystemPrompt = `你是${name}，一个专业的AI助手。${description}。请用专业、友好、高效的方式与用户交流。你的回复应该准确、详细且有针对性。`;
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
  const systemPrompt = '你是一个贴心的智能体配置助手。你的任务是：根据用户第一步填写的智能体信息，生成2-3个有针对性的追问，帮助明确智能体的更多细节和功能需求。问题必须紧密关联用户描述的内容，不能泛泛而问。';

  const userPrompt = `用户正在创建智能体，以下是他们第一步填写的信息：

- 智能体名称：${name}
- 功能描述：${description}
- 开场白：${openingMessage}

请根据以上信息，生成2-3个有针对性的追问，用于明确智能体的更多细节。

## 生成问题的要求
1. **必须基于用户描述**：问题要从用户填写的功能描述和开场白出发，提取关键信息并针对性地追问
2. **关注细节**：追问应该帮助用户明确以下方向（选择最相关的2-3个）：
   - 专业领域深度：这个智能体在用户描述的专业领域中，具体擅长哪些方面？
   - 交互风格：用户期望的对话风格是怎样的？（正式/幽默/专业/亲切等）
   - 特殊能力：根据功能描述，是否需要某些特殊能力？（数据分析、创意生成、代码编写、文档处理等）
   - 目标用户：这个智能体主要服务哪类人群？他们的使用场景是什么？
   - 知识边界：智能体应该专注于哪些话题？避免哪些话题？
3. **对话式表达**：问题要像朋友间的对话，简洁友好，每个问题不超过50字
4. **避免泛泛而问**：不要问"需要联网吗"这类通用问题，要基于用户的具体需求来问

## 返回格式
请以JSON数组格式返回，每个问题要有id和question字段：
[{"id": "q1", "question": "问题内容"}]

只返回JSON数组，不要其他内容。`;

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
        
        const parsedContent = await parseFile(filePath, mimeType);
        
        if (typeof parsedContent === 'string') {
          messageContent += `\n${parsedContent}\n`;
          attachmentInfos.push({
            filename: attachment.filename || attachment.name || '未知文件',
            content_preview: parsedContent.substring(0, 100)
          });
        } else if (parsedContent && parsedContent.type === 'image') {
          let imageDescription = '';
          try {
            imageDescription = await generateMediaDescription(
              filePath,
              parsedContent.mime_type || mimeType,
              attachment.filename || attachment.name || '未知图片',
              0,
              parsedContent
            );
          } catch (e) {
            console.error('[Agent对话] 图片描述生成失败:', e.message);
          }
          messageContent += `\n【用户上传的图片: ${attachment.filename || attachment.name || '未知文件'}】\n`;
          if (imageDescription) {
            messageContent += `图片内容描述: ${imageDescription}\n`;
          } else {
            messageContent += `请根据上下文理解这张图片。\n`;
          }
          attachmentInfos.push({
            filename: attachment.filename || attachment.name || '未知文件',
            type: 'image',
            description: imageDescription,
            base64: parsedContent.base64,
            mime_type: parsedContent.mime_type
          });
        } else if (parsedContent && parsedContent.type === 'audio') {
          let audioDescription = '';
          try {
            audioDescription = await generateMediaDescription(
              filePath,
              parsedContent.mime_type || mimeType,
              attachment.filename || attachment.name || '未知音频',
              0,
              parsedContent
            );
          } catch (e) {
            console.error('[Agent对话] 音频描述生成失败:', e.message);
          }
          messageContent += `\n【用户上传的音频: ${attachment.filename || attachment.name || '未知文件'}】\n`;
          if (audioDescription) {
            messageContent += `音频内容描述: ${audioDescription}\n`;
          } else {
            messageContent += `请根据上下文理解这段音频。\n`;
          }
          attachmentInfos.push({
            filename: attachment.filename || attachment.name || '未知文件',
            type: 'audio',
            description: audioDescription,
            base64: parsedContent.base64,
            mime_type: parsedContent.mime_type
          });
        } else if (parsedContent && parsedContent.type === 'video') {
          let videoDescription = '';
          try {
            videoDescription = await generateMediaDescription(
              filePath,
              parsedContent.mime_type || mimeType,
              attachment.filename || attachment.name || '未知视频',
              0,
              parsedContent
            );
          } catch (e) {
            console.error('[Agent对话] 视频描述生成失败:', e.message);
          }
          messageContent += `\n【用户上传的视频: ${attachment.filename || attachment.name || '未知文件'}】\n`;
          if (videoDescription) {
            messageContent += `视频内容描述: ${videoDescription}\n`;
          } else {
            messageContent += `请根据上下文理解这个视频。\n`;
          }
          attachmentInfos.push({
            filename: attachment.filename || attachment.name || '未知文件',
            type: 'video',
            description: videoDescription,
            base64: parsedContent.base64,
            mime_type: parsedContent.mime_type
          });
        }
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

  const primaryModel = agent.model_roles[0];
  const modelId = primaryModel?.modelId || 'deepseek';
  const persona = AI_PERSONAS[modelId] || { id: modelId, name: modelId };

  const formattedMessages = recentAgentMessages.map(m => ({
    id: m.id,
    sender_type: m.sender_type === 'agent' ? 'ai' : 'user',
    sender_id: m.sender_type === 'agent' ? modelId : 'user',
    content: m.content
  }));

  const functionBoundary = `【重要功能约束】你是"${agent.name}"智能体，你的功能定位是：${agent.description}。你必须严格遵守以下规则：
1. **只做你功能范围内的事情**：你的能力严格限定在用户设定的功能描述中
2. **拒绝超出功能范围的请求**：如果用户请求超出你的功能，礼貌说明"抱歉，我专注于[功能描述]，这个需求超出了我的能力范围。你可以尝试[相关功能]。"
3. **不要冒充其他功能**：不要声称自己会做用户没有设定给你的功能
4. **始终记住自己的身份**：你是用户创建的专业智能体，不是通用的聊天助手
5. **回复时体现专业性**：在你的专业领域内提供深入、准确的帮助`;

  const enhancedSystemPrompt = `${functionBoundary}\n\n${agent.system_prompt}`;

  const response = await callAIStream(
    modelId,
    persona,
    messageContent,
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

  let suggestions = null;
  if (agent.enable_suggestions) {
    try {
      const chatHistory = db.data.agent_messages
        .filter(m => m.agent_id === agentId)
        .slice(-10);
      const userProfile = db.data.userProfile || null;
      suggestions = await generateSuggestions(agent, response, messageContent, userId, chatHistory, userProfile);
    } catch (error) {
      console.error('[Agent对话] 生成建议回复失败:', error.message);
    }
  }

  return { content: response, suggestions };
}

export async function generateSuggestions(agent, agentResponse, userMessage, userId, chatHistory = [], userProfile = null) {
  const historyContext = chatHistory.length > 0
    ? chatHistory.slice(-10).map(m =>
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
    if (userProfile.bio) parts.push(`简介: ${userProfile.bio.substring(0, 100)}`);
    if (parts.length > 0) userContext = `\n## 用户画像\n${parts.join('\n')}`;
  }

  const capabilitiesDesc = [];
  if (agent.capabilities) {
    if (agent.capabilities.scheduled_tasks) capabilitiesDesc.push('定时任务');
    if (agent.capabilities.web_search) capabilitiesDesc.push('网络搜索');
    if (agent.capabilities.multimodal) capabilitiesDesc.push('多模态理解');
  }

  const isInitial = !agentResponse || agentResponse === agent.opening_message;

  const suggestionPrompt = isInitial
    ? `你是一个对话建议生成器。根据智能体信息和用户画像，生成3条用户可能想对智能体说的话。

## 智能体信息
- 名称：${agent.name}
- 功能：${agent.description}
- 开场白：${agent.opening_message}
${capabilitiesDesc.length > 0 ? `- 能力：${capabilitiesDesc.join('、')}` : ''}${userContext}

## 要求
1. 每条建议应该简短自然，像用户真实会说的话，每条不超过25字
2. 建议必须与智能体的功能领域（${agent.description.substring(0, 50)}）紧密相关
3. 建议要有差异：一条探索功能、一条具体问题、一条深入场景
4. ${userContext ? '结合用户画像信息，让建议更贴合用户需求' : '让建议覆盖智能体的核心功能'}
5. 不要加引号或序号，不要重复开场白内容

## 返回格式
只返回JSON数组，不要其他内容：
["建议1", "建议2", "建议3"]`
    : `你是一个对话建议生成器。根据以下对话上下文，生成3条用户可能想继续说的话。

## 智能体信息
- 名称：${agent.name}
- 功能：${agent.description}
${capabilitiesDesc.length > 0 ? `- 能力：${capabilitiesDesc.join('、')}` : ''}${userContext}

## 历史对话
${historyContext}

## 最近对话
- 用户说：${userMessage.substring(0, 500)}
- 智能体回复：${agentResponse.substring(0, 800)}

## 要求
1. 每条建议应该简短自然，像用户真实会说的话，每条不超过25字
2. 建议应该有差异：一条追问细节、一条换个角度、一条深入探讨
3. 建议必须与智能体的功能领域（${agent.description.substring(0, 50)}）相关
4. ${userContext ? '结合用户画像信息，让建议更贴合用户需求' : '让建议自然衔接对话'}
5. 不要加引号或序号，不要重复已有对话内容

## 返回格式
只返回JSON数组，不要其他内容：
["建议1", "建议2", "建议3"]`;

  const persona = { id: 'glm_flash', name: 'glm-4-flash' };

  let response;
  try {
    response = await callAIStream(
      'glm_flash',
      persona,
      suggestionPrompt,
      [],
      'free_chat',
      null, [], null, null, false, [],
      '你是一个JSON生成器，只返回JSON数组，不要任何额外文字。',
      [], null, null, userId
    );
  } catch (error) {
    console.error('[建议回复] glm_flash调用失败:', error.message);
    return getDefaultSuggestions(agent, userProfile);
  }

  if (!response) {
    return getDefaultSuggestions(agent, userProfile);
  }

  const parsed = extractJSON(response);
  if (Array.isArray(parsed) && parsed.length > 0) {
    const validSuggestions = parsed
      .filter(s => typeof s === 'string' && s.trim().length > 0 && s.length <= 60)
      .map(s => s.trim())
      .slice(0, 3);
    if (validSuggestions.length > 0) {
      return validSuggestions;
    }
  }

  return getDefaultSuggestions(agent, userProfile);
}

function getDefaultSuggestions(agent, userProfile = null) {
  const desc = agent.description || '';
  const name = agent.name || '';

  const userHints = [];
  if (userProfile) {
    if (userProfile.occupation) userHints.push(userProfile.occupation);
    if (userProfile.hobbies && userProfile.hobbies.length > 0) userHints.push(...userProfile.hobbies.slice(0, 3));
  }

  if (desc.includes('编程') || desc.includes('代码') || desc.includes('开发')) {
    return [
      '帮我写一个实用的代码示例',
      '有哪些最佳实践和规范？',
      '帮我优化这段代码的性能'
    ];
  }
  if (desc.includes('写作') || desc.includes('文案') || desc.includes('创作')) {
    return [
      '能换个风格再写一版吗？',
      '帮我润色一下这段文字',
      '给我更多创意方向'
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
