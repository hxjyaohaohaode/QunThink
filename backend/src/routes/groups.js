import express from 'express';
import { getDb } from '../models/db.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcastToGroup } from '../websocket/index.js';

const router = express.Router();

router.get('/groups', async (req, res) => {
  const db = getDb();
  await db.read();
  res.json(db.data.groups);
});

router.get('/groups/:id', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;
  const group = db.data.groups.find(g => g.id === id);
  
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  res.json(group);
});

router.post('/groups', async (req, res) => {
  const db = getDb();
  await db.read();
  const { name, description, is_private, ai_member } = req.body;
  const aiMembers = req.body.ai_members || req.body.aiMembers;
  
  // 私聊群组只需要1个AI成员
  if (is_private) {
    if (!ai_member) {
      return res.status(400).json({ error: '私聊需要指定AI成员' });
    }
  } else {
    // 群聊至少需要2个AI成员
    if (aiMembers && aiMembers.length < 2) {
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
    pinned: false,
    debate_mode: false,
    debate_level: 1,
    ai_members: is_private ? [ai_member] : (aiMembers || ['deepseek', 'deepseek_reasoner', 'glm', 'mimo', 'qwen']),
    created_at: new Date().toISOString()
  };
  
  db.data.groups.push(newGroup);
  await db.write();
  
  res.status(201).json(newGroup);
});

router.put('/groups/:id/debate', async (req, res) => {
  const db = getDb();
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
  
  await db.write();
  res.json(db.data.groups[groupIndex]);
});

// 置顶/取消置顶群组
router.put('/groups/:id/pin', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;
  const { pinned } = req.body;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id);
  if (groupIndex === -1) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  db.data.groups[groupIndex].pinned = pinned !== undefined ? pinned : !db.data.groups[groupIndex].pinned;
  await db.write();
  
  res.json(db.data.groups[groupIndex]);
});

// 添加AI成员到群聊
router.post('/groups/:id/members', async (req, res) => {
  const db = getDb();
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
  
  // AI名称映射
  const aiNames = {
    deepseek: 'deepseek-chat',
    deepseek_reasoner: 'deepseek-reasoner',
    glm: 'GLM-4.5-Air',
    mimo: 'mimo-v2-flash',
    qwen: 'Qwen3.5-Flash'
  };
  
  // 添加AI成员
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
  await db.write();
  
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
  const db = getDb();
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
  const aiNames = {
    deepseek: 'deepseek-chat',
    deepseek_reasoner: 'deepseek-reasoner',
    glm: 'GLM-4.5-Air',
    mimo: 'mimo-v2-flash',
    qwen: 'Qwen3.5-Flash'
  };
  
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
    created_at: new Date().toISOString()
  };
  
  db.data.groups.push(privateChat);
  await db.write();
  
  res.status(201).json(privateChat);
});

router.delete('/groups/:id', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;
  
  const groupIndex = db.data.groups.findIndex(g => g.id === id);
  if (groupIndex === -1) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  // 删除该群聊的所有消息
  const initialMessageCount = db.data.messages.length;
  db.data.messages = db.data.messages.filter(m => m.group_id !== id);
  const deletedMessageCount = initialMessageCount - db.data.messages.length;
  
  // 删除该群聊的所有评论
  const initialCommentCount = db.data.comments?.length || 0;
  if (db.data.comments) {
    db.data.comments = db.data.comments.filter(c => {
      // 找到评论对应的消息，检查消息是否属于该群聊
      const message = db.data.messages.find(m => m.id === c.message_id);
      return message && message.group_id !== id;
    });
  }
  const deletedCommentCount = initialCommentCount - (db.data.comments?.length || 0);
  
  // 删除群聊
  db.data.groups.splice(groupIndex, 1);
  await db.write();
  
  console.log(`删除群聊 ${id}: 删除了 ${deletedMessageCount} 条消息, ${deletedCommentCount} 条评论`);
  
  res.json({ 
    success: true, 
    deleted_messages: deletedMessageCount,
    deleted_comments: deletedCommentCount 
  });
});

export default router;
