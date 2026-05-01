import express from 'express';
import { getUploadsDir, withWriteLock, updateGroupActivity } from '../models/db.js';  
import { v4 as uuidv4 } from 'uuid';
import { broadcastToGroup } from '../websocket/index.js';
import { startAutonomousChatTimer, stopAutonomousChatTimer } from '../services/scheduler/index.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { requireGroupMembership } from '../middleware/userDb.js';
import { validateBody, createGroupSchema, updateDebateSchema, pinGroupSchema } from '../validators/index.js';
import { sanitizeObject, GROUP_SANITIZE_CONFIG } from '../utils/sanitize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

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

const aiShortNames = {
  deepseek: 'Deep',
  deepseek_reasoner: 'Rson',
  glm_air: 'GLM',
  glm_flash: 'GF',
  glm_flashx: 'GX',
  mimo_flash: 'Mimo',
  mimo_omni: 'Omni',
  mimo_tts: 'TTS',
  qwen_flash: 'Qwen',
  qwen_turbo: 'QT'
};

const uploadDir = path.join(getUploadsDir(), 'backgrounds');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const bgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `bg_${uuidv4()}${ext}`);
  }
});
const bgUpload = multer({
  storage: bgStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只支持图片文件'));
  }
});

router.post('/groups/:id/upload-background', bgUpload.single('background'), async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const { id } = req.params;
    const group = db.data.groups.find(g => g.id === id);
    if (!group) return res.status(404).json({ error: '群组不存在' });
    if (!req.file) return res.status(400).json({ error: '请上传背景图片' });
    
    const bgUrl = `/uploads/backgrounds/${req.file.filename}`;
    group.background_url = bgUrl;
    await withWriteLock(req.userId, async () => { await db.write(); });
    res.json({ success: true, background_url: bgUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: '上传背景失败' });
  }
});

router.get('/groups', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const { limit, offset } = req.query;
    let groups = db.data.groups;
    if (limit || offset) {
      const start = parseInt(offset) || 0;
      const end = limit ? start + parseInt(limit) : undefined;
      groups = groups.slice(start, end);
    }
    res.json(groups);
  } catch (error) {
    console.error('获取群组列表错误:', error);
    res.status(500).json({ error: '获取群组列表失败' });
  }
});

router.get('/groups/:id', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const { id } = req.params;
    const group = db.data.groups.find(g => g.id === id);
    
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    res.json(group);
  } catch (error) {
    console.error('获取群组详情错误:', error);
    res.status(500).json({ error: '获取群组详情失败' });
  }
});

router.post('/groups', validateBody(createGroupSchema), async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const sanitizedBody = sanitizeObject(req.body, GROUP_SANITIZE_CONFIG);
    const { name, description, is_private, ai_member, avatar_url, avatar_color } = sanitizedBody;
    const aiMembers = sanitizedBody.ai_members || [];
    const normalizedAiMembers = Array.isArray(aiMembers) ? [...new Set(aiMembers.filter(Boolean))] : [];
    
    if (is_private) {
      if (!ai_member) {
        return res.status(400).json({ error: '私聊需要指定AI成员' });
      }
    } else {
      if (normalizedAiMembers.length > 0 && normalizedAiMembers.length < 2) {
        return res.status(400).json({ error: '群聊至少需要2个AI成员' });
      }
    }
    
    const groupId = uuidv4();
    const newGroup = {
      id: groupId,
      name,
      description,
      type: is_private ? 'private' : 'custom',
      is_private: is_private || false,
      avatar_url: avatar_url || null,
      avatar_color: avatar_color || null,
      pinned: false,
      debate_mode: false,
      debate_level: 1,
      ai_members: is_private ? [ai_member] : (normalizedAiMembers.length > 0 ? normalizedAiMembers : ['deepseek', 'deepseek_reasoner', 'glm_air', 'mimo_flash', 'qwen_flash']),
      created_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      last_message_preview: null
    };
    
    db.data.groups.push(newGroup);
    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    // 禁用自动启动自发对话 - AI只在用户发言后才回复
    // if (!is_private && newGroup.ai_members.length >= 2) {
    //   startAutonomousChatTimer(groupId);
    // }
    
    res.status(201).json(newGroup);
  } catch (error) {
    console.error('创建群组错误:', error);
    res.status(500).json({ error: '创建群组失败' });
  }
});

router.put('/groups/:id/debate', validateBody(updateDebateSchema), async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const { id } = req.params;
    const { debate_mode, debate_level } = req.body;
    
    const groupIndex = db.data.groups.findIndex(g => g.id === id);
    if (groupIndex === -1) {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    db.data.groups[groupIndex] = {
      ...db.data.groups[groupIndex],
      debate_mode: debate_mode !== undefined ? debate_mode : db.data.groups[groupIndex].debate_mode,
      debate_level: debate_level !== undefined ? debate_level : db.data.groups[groupIndex].debate_level
    };
    
    await withWriteLock(req.userId, async () => {
      await db.write();
    });
    res.json(db.data.groups[groupIndex]);
  } catch (error) {
    console.error('更新辩论设置错误:', error);
    res.status(500).json({ error: '更新辩论设置失败' });
  }
});

// 置顶/取消置顶群组
router.put('/groups/:id/pin', validateBody(pinGroupSchema), async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { pinned } = req.body;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id);
  if (groupIndex === -1) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  db.data.groups[groupIndex].pinned = pinned !== undefined ? pinned : !db.data.groups[groupIndex].pinned;
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  res.json(db.data.groups[groupIndex]);
});

// 添加AI成员到群聊
router.post('/groups/:id/members', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { aiId } = req.body;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id);
  if (groupIndex === -1) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  const group = db.data.groups[groupIndex];
  
  // 不能添加到私聊
  if (group.is_private) {
    return res.status(400).json({ error: '不能向私聊添加成员' });
  }
  
  // 检查AI是否已在群聊中
  if (group.ai_members && group.ai_members.includes(aiId)) {
    return res.status(400).json({ error: '该AI已在群聊中' });
  }
  
  if (!group.ai_members) {
    group.ai_members = [];
  }
  group.ai_members.push(aiId);
  
  // 创建系统消息：AI加入群聊
  const messageId = uuidv4();
  const systemMessage = {
    id: messageId,
    group_id: id,
    sender_type: 'system',
    sender_id: 'system',
    content: `邀请了 ${aiNames[aiId] || aiId} 加入群聊`,
    content_type: 'text',
    metadata: { type: 'member_joined', newMember: aiId },
    created_at: new Date().toISOString()
  };
  
  db.data.messages.push(systemMessage);
  updateGroupActivity(group, systemMessage);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  // 广播系统消息
  broadcastToGroup(id, {
    type: 'system_message',
    group_id: id,
    content: systemMessage.content,
    timestamp: systemMessage.created_at,
    metadata: systemMessage.metadata
  });
  
  res.json({ 
    success: true, 
    group: group,
    systemMessage: systemMessage
  });
});

// 获取或创建私聊群组
router.post('/private-chat/:aiId', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { aiId } = req.params;
  
  // 查找是否已存在与该AI的私聊
  let privateChat = db.data.groups.find(g => 
    g.is_private === true && 
    g.ai_members && 
    g.ai_members.length === 1 && 
    g.ai_members[0] === aiId
  );
  
  if (privateChat) {
    return res.json(privateChat);
  }
  
  // 创建新的私聊群组
  const groupId = uuidv4();
  privateChat = {
    id: groupId,
    name: aiNames[aiId] || aiId,
    description: `与 ${aiNames[aiId] || aiId} 的私聊`,
    type: 'private',
    is_private: true,
    pinned: true, // 私聊默认置顶
    debate_mode: false,
    debate_level: 1,
    ai_members: [aiId],
    created_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    last_message_preview: null
  };
  
  db.data.groups.push(privateChat);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  res.status(201).json(privateChat);
});

router.delete('/groups/:id', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id);
  if (groupIndex === -1) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  const initialMessageCount = db.data.messages.length;
  db.data.messages = db.data.messages.filter(m => m.group_id !== id);
  const deletedMessageCount = initialMessageCount - db.data.messages.length;
  const filesToDelete = (db.data.files || []).filter(file => file.group_id === id);
  const uploadsRoot = path.resolve(getUploadsDir());
  for (const file of filesToDelete) {
    const ownerId = file.owner_user_id || file.uploader_id || req.userId;
    const storedFilename = path.basename(file.stored_filename || file.original_path || '');
    if (!ownerId || !storedFilename) continue;
    const safeFilePath = path.resolve(path.join(uploadsRoot, ownerId, storedFilename));
    if (safeFilePath.startsWith(uploadsRoot) && fs.existsSync(safeFilePath)) {
      fs.unlinkSync(safeFilePath);
    }
  }
  db.data.files = (db.data.files || []).filter(file => file.group_id !== id);
  
  db.data.groups.splice(groupIndex, 1);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  console.log(`删除群聊 ${id}: 删除了 ${deletedMessageCount} 条消息`);
  
  res.json({ 
    success: true, 
    deleted_messages: deletedMessageCount
  });
});

router.delete('/groups/:id/members/:aiId', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id, aiId } = req.params;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id);
  if (groupIndex === -1) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  const group = db.data.groups[groupIndex];
  
  if (group.is_private) {
    return res.status(400).json({ error: '不能从私聊中移除成员' });
  }
  
  if (!group.ai_members || !group.ai_members.includes(aiId)) {
    return res.status(400).json({ error: '该AI不在群聊中' });
  }
  
  if (group.ai_members.length <= 2) {
    return res.status(400).json({ error: '群聊至少需要保留2个AI成员' });
  }
  
  group.ai_members = group.ai_members.filter(member => member !== aiId);
  
  const messageId = uuidv4();
  const systemMessage = {
    id: messageId,
    group_id: id,
    sender_type: 'system',
    sender_id: 'system',
    content: `${aiNames[aiId] || aiId} 已被移出群聊`,
    content_type: 'text',
    metadata: { type: 'member_removed', removedMember: aiId },
    created_at: new Date().toISOString()
  };
  
  db.data.messages.push(systemMessage);
  updateGroupActivity(group, systemMessage);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  broadcastToGroup(id, {
    type: 'system_message',
    group_id: id,
    content: systemMessage.content,
    timestamp: systemMessage.created_at,
    metadata: systemMessage.metadata
  });
  
  broadcastToGroup(id, {
    type: 'member_removed',
    group_id: id,
    aiId: aiId,
    timestamp: new Date().toISOString()
  });
  
  res.json({ 
    success: true, 
    group: group,
    systemMessage: systemMessage
  });
});

router.post('/ai-private-chat', async (req, res) => {
  console.log('收到AI私聊创建请求:', req.body);
  const db = await req.getUserDb();
  await db.read();
  const { aiMembers, topic, customName } = req.body;
  
  console.log('aiMembers:', aiMembers, 'topic:', topic, 'customName:', customName);
  
  if (!aiMembers || !Array.isArray(aiMembers) || aiMembers.length < 2) {
    console.log('错误: AI成员不足');
    return res.status(400).json({ error: '至少需要选择2个AI成员' });
  }
  
  if (aiMembers.length > 5) {
    return res.status(400).json({ error: '最多支持5个AI成员' });
  }
  
  const validAIs = ['deepseek', 'deepseek_reasoner', 'mimo_flash', 'mimo_omni', 'mimo_tts', 'glm_air', 'glm_flash', 'glm_flashx', 'qwen_flash', 'qwen_turbo'];
  for (const aiId of aiMembers) {
    if (!validAIs.includes(aiId)) {
      return res.status(400).json({ error: `无效的AI成员: ${aiId}` });
    }
  }
  
  const uniqueMembers = [...new Set(aiMembers)];
  if (uniqueMembers.length !== aiMembers.length) {
    return res.status(400).json({ error: 'AI成员不能重复' });
  }
  
  const sortedIds = [...uniqueMembers].sort();
  const existingChat = db.data.groups.find(g => 
    g.type === 'ai_private' && 
    g.ai_members && 
    g.ai_members.length === sortedIds.length &&
    sortedIds.every(id => g.ai_members.includes(id))
  );
  
  if (existingChat) {
    return res.json(existingChat);
  }
  
  const groupId = uuidv4();
  
  let chatName;
  if (customName && customName.trim()) {
    chatName = customName.trim();
  } else {
    const shortNames = sortedIds.map(id => aiShortNames[id] || aiNames[id]);
    chatName = shortNames.join(' & ');
  }
  
  const newChat = {
    id: groupId,
    name: chatName,
    description: topic ? `话题: ${topic}` : 'AI私聊（只读）',
    type: 'ai_private',
    is_private: true,
    is_ai_private: true,
    pinned: true,
    debate_mode: false,
    debate_level: 1,
    ai_members: sortedIds,
    topic: topic || null,
    is_active: false,
    created_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    last_message_preview: null
  };
  
  db.data.groups.push(newChat);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  res.status(201).json(newChat);
});

router.get('/ai-private-chats', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  
  const aiPrivateChats = db.data.groups.filter(g => g.type === 'ai_private' || g.is_ai_private);
  
  res.json(aiPrivateChats);
});

router.delete('/ai-private-chats/:id', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
  if (groupIndex === -1) {
    return res.status(404).json({ error: 'AI私聊不存在' });
  }
  
  const initialMessageCount = db.data.messages.length;
  db.data.messages = db.data.messages.filter(m => m.group_id !== id);
  const deletedMessageCount = initialMessageCount - db.data.messages.length;
  
  db.data.groups.splice(groupIndex, 1);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  console.log(`删除AI私聊 ${id}: 删除了 ${deletedMessageCount} 条消息`);
  
  res.json({ 
    success: true, 
    deleted_messages: deletedMessageCount 
  });
});

router.post('/ai-private-chats/:id/start', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { topic } = req.body;
  
  const group = db.data.groups.find(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
  if (!group) {
    return res.status(404).json({ error: 'AI私聊不存在' });
  }
  
  if (topic) {
    group.topic = topic;
    await withWriteLock(req.userId, async () => {
      await db.write();
    });
  }

  try {
    const { startAIPrivateChat, getChatStatus } = await import('../services/scheduler/index.js');
    
    const currentStatus = getChatStatus(id);
    if (currentStatus.isRunning) {
      return res.json({ groupId: id, status: 'already_active' });
    }
    
    startAIPrivateChat(id, topic || null).catch(error => {
      console.error('AI私聊后台运行错误:', error);
    });
    
    res.json({ 
      groupId: id, 
      status: 'started',
      message: 'AI私聊已在后台启动'
    });
  } catch (error) {
    console.error('启动AI私聊错误:', error);
    res.status(500).json({ error: '启动AI私聊失败', details: error.message });
  }
});

router.get('/ai-private-chats/:id/status', async (req, res) => {
  const { id } = req.params;
  
  try {
    const { getChatStatus } = await import('../services/scheduler/index.js');
    const status = getChatStatus(id);
    res.json(status);
  } catch (error) {
    console.error('获取聊天状态错误:', error);
    res.status(500).json({ error: '获取聊天状态失败', details: error.message });
  }
});

router.post('/ai-private-chats/:id/continue', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  
  const group = db.data.groups.find(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
  if (!group) {
    return res.status(404).json({ error: 'AI私聊不存在' });
  }
  
  try {
    const { continueAIPrivateChat, getChatStatus } = await import('../services/scheduler/index.js');
    
    const currentStatus = getChatStatus(id);
    if (currentStatus.isRunning) {
      return res.json({ groupId: id, status: 'already_active' });
    }
    
    continueAIPrivateChat(id).catch(error => {
      console.error('AI私聊继续运行错误:', error);
    });
    
    res.json({ 
      groupId: id, 
      status: 'started',
      message: 'AI私聊已在后台继续'
    });
  } catch (error) {
    console.error('继续AI私聊错误:', error);
    res.status(500).json({ error: '继续AI私聊失败', details: error.message });
  }
});

router.post('/ai-private-chats/:id/stop', async (req, res) => {
  try {
    const { stopAIPrivateChat } = await import('../services/scheduler/index.js');
    const result = stopAIPrivateChat(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('停止AI私聊错误:', error);
    res.status(500).json({ error: '停止AI私聊失败', details: error.message });
  }
});

router.post('/groups/:id/formal-debate/start', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { topic, rolePreferences, debateLevel, selectedParticipants } = req.body;
  
  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    return res.status(400).json({ error: '辩题不能为空' });
  }
  
  const group = db.data.groups.find(g => g.id === id);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }
  
  if (!group.ai_members || group.ai_members.length < 2) {
    return res.status(400).json({ error: '至少需要2个AI成员才能进行正规辩论' });
  }
  
  if (selectedParticipants && Array.isArray(selectedParticipants)) {
    const invalidParticipants = selectedParticipants.filter(p => !group.ai_members.includes(p));
    if (invalidParticipants.length > 0) {
      return res.status(400).json({ error: `无效的参与者: ${invalidParticipants.join(', ')}` });
    }
    if (selectedParticipants.length < 2) {
      return res.status(400).json({ error: '至少需要选择2个AI参与辩论' });
    }
  }
  
  try {
    const { startFormalDebate, getDebateStatus } = await import('../services/debate/index.js');
    
    const currentStatus = getDebateStatus(id);
    if (currentStatus.isRunning) {
      return res.status(409).json({ error: '辩论已在进行中', status: currentStatus });
    }
    
    startFormalDebate(id, topic.trim(), rolePreferences || {}, debateLevel || 2, selectedParticipants || null).catch(error => {
      console.error('正规辩论后台运行错误:', error);
    });
    
    res.json({ 
      groupId: id, 
      status: 'started',
      message: '正规辩论已在后台启动',
      topic: topic.trim(),
      selectedParticipants: selectedParticipants || null
    });
  } catch (error) {
    console.error('启动正规辩论错误:', error);
    res.status(500).json({ error: '启动正规辩论失败', details: error.message });
  }
});

router.post('/groups/:id/formal-debate/stop', async (req, res) => {
  const { id } = req.params;
  
  try {
    const { stopFormalDebate } = await import('../services/debate/index.js');
    const result = stopFormalDebate(id);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    console.error('停止正规辩论错误:', error);
    res.status(500).json({ error: '停止正规辩论失败', details: error.message });
  }
});

router.get('/groups/:id/formal-debate/status', async (req, res) => {
  const { id } = req.params;
  
  try {
    const { getDebateStatus } = await import('../services/debate/index.js');
    const status = getDebateStatus(id);
    res.json(status);
  } catch (error) {
    console.error('获取辩论状态错误:', error);
    res.status(500).json({ error: '获取辩论状态失败', details: error.message });
  }
});

router.post('/groups/:id/formal-debate/allocate-roles', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { rolePreferences, selectedParticipants } = req.body;
  
  const group = db.data.groups.find(g => g.id === id);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }
  
  if (!group.ai_members || group.ai_members.length < 2) {
    return res.status(400).json({ error: '至少需要2个AI成员' });
  }
  
  if (selectedParticipants && Array.isArray(selectedParticipants)) {
    const invalidParticipants = selectedParticipants.filter(p => !group.ai_members.includes(p));
    if (invalidParticipants.length > 0) {
      return res.status(400).json({ error: `无效的参与者: ${invalidParticipants.join(', ')}` });
    }
    if (selectedParticipants.length < 2) {
      return res.status(400).json({ error: '至少需要选择2个AI参与辩论' });
    }
  }
  
  try {
    const { allocateDebateRoles } = await import('../services/debate/index.js');
    const roles = allocateDebateRoles(group.ai_members, rolePreferences || {}, selectedParticipants || null);
    
    const formattedRoles = {
      proponents: roles.proponents.map(id => ({ id, name: aiNames[id] || id })),
      opponents: roles.opponents.map(id => ({ id, name: aiNames[id] || id })),
      judge: roles.judge ? { id: roles.judge, name: aiNames[roles.judge] || roles.judge } : null,
      audience: roles.audience.map(id => ({ id, name: aiNames[id] || id })),
      hasJudge: roles.hasJudge,
      hasAudience: roles.hasAudience
    };
    
    res.json({
      success: true,
      roles: formattedRoles,
      totalMembers: group.ai_members.length,
      debateParticipants: selectedParticipants ? selectedParticipants.length : group.ai_members.length
    });
  } catch (error) {
    console.error('分配辩论角色错误:', error);
    res.status(500).json({ error: '分配辩论角色失败', details: error.message });
  }
});

router.post('/groups/:id/formal-debate/audience-comment', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { audienceMembers } = req.body;
  
  const group = db.data.groups.find(g => g.id === id);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }
  
  if (!audienceMembers || !Array.isArray(audienceMembers) || audienceMembers.length === 0) {
    return res.status(400).json({ error: '需要指定观众成员' });
  }
  
  try {
    const { triggerAudienceComment } = await import('../services/debate/index.js');
    const result = await triggerAudienceComment(id, audienceMembers);
    res.json(result);
  } catch (error) {
    console.error('触发观众评论错误:', error);
    res.status(500).json({ error: '触发观众评论失败', details: error.message });
  }
});

router.put('/groups/:id/settings', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const sanitizedBody = sanitizeObject(req.body, GROUP_SANITIZE_CONFIG);
  const { name, avatar_url, avatar_color, background_url, announcement, notifications_enabled, pinned, ...restSettings } = sanitizedBody;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id);
  if (groupIndex === -1) {
    return res.status(404).json({ error: '群组不存在' });
  }
  
  const group = db.data.groups[groupIndex];
  
  if (name !== undefined) {
    group.name = name;
  }
  if (avatar_url !== undefined) {
    group.avatar_url = avatar_url;
  }
  if (avatar_color !== undefined) {
    group.avatar_color = avatar_color;
  }
  if (background_url !== undefined) {
    group.background_url = background_url;
  }
  if (announcement !== undefined) {
    group.announcement = announcement;
  }
  if (notifications_enabled !== undefined) {
    group.notifications_enabled = notifications_enabled;
  }
  if (pinned !== undefined) {
    group.pinned = pinned;
  }
  
  const allowedSettings = ['name', 'description', 'avatar_url', 'avatar_color', 'background_url', 'announcement', 'notifications_enabled', 'debate_mode', 'debate_level', 'debate_config'];
  const filteredSettings = {};
  for (const key of allowedSettings) {
    if (restSettings[key] !== undefined) {
      filteredSettings[key] = restSettings[key];
    }
  }
  Object.assign(group, filteredSettings);

  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  res.json({ success: true, group });
});

router.get('/groups/:id/files', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const group = db.data.groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: '群组不存在' });
    const files = (db.data.files || [])
      .filter(f => f.group_id === req.params.id)
      .map(f => ({
        id: f.id,
        group_id: f.group_id,
        name: f.filename,
        url: `/api/files/${f.id}/download?group_id=${encodeURIComponent(f.group_id)}`,
        size: f.file_size,
        type: f.mime_type,
        uploaded_at: f.created_at
      }))
      .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    res.json({ success: true, files });
  } catch (error) {
    console.error('获取群文件错误:', error);
    res.status(500).json({ success: false, error: '获取群文件失败' });
  }
});

router.post('/groups/:id/files', async (req, res) => {
  try {
    res.status(400).json({ success: false, error: '请使用 /api/files/upload 上传群文件' });
  } catch (error) {
    console.error('上传群文件错误:', error);
    res.status(500).json({ success: false, error: '上传群文件失败' });
  }
});

router.delete('/groups/:id/files/:fileId', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const group = db.data.groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: '群组不存在' });
    const fileIndex = (db.data.files || []).findIndex(f => f.id === req.params.fileId && f.group_id === req.params.id);
    if (fileIndex === -1) return res.status(404).json({ error: '文件不存在' });
    const [fileRecord] = db.data.files.splice(fileIndex, 1);
    const ownerId = fileRecord?.owner_user_id || fileRecord?.uploader_id || req.userId;
    const storedFilename = path.basename(fileRecord?.stored_filename || fileRecord?.original_path || '');
    if (ownerId && storedFilename) {
      const uploadsRoot = path.resolve(getUploadsDir());
      const safeFilePath = path.resolve(path.join(uploadsRoot, ownerId, storedFilename));
      if (safeFilePath.startsWith(uploadsRoot) && fs.existsSync(safeFilePath)) {
        fs.unlinkSync(safeFilePath);
      }
    }
    await withWriteLock(req.userId, async () => { await db.write(); });
    res.json({ success: true });
  } catch (error) {
    console.error('删除群文件错误:', error);
    res.status(500).json({ success: false, error: '删除群文件失败' });
  }
});

export default router;
