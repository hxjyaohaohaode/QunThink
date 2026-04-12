import express from 'express';
import { getDb } from '../models/db.js';
import { v4 as uuidv4 } from 'uuid';
import { queueAIMessages } from '../services/scheduler/index.js';
import socialService from '../services/social/index.js';
import encryptionUtils from '../utils/encryption.js';
import { broadcastToGroup } from '../websocket/index.js';

const router = express.Router();

router.get('/groups/:groupId/messages', async (req, res) => {
  const db = getDb();
  await db.read();
  const { groupId } = req.params;
  const { limit = 50, before } = req.query;

  let messages = db.data.messages.filter(m => m.group_id === groupId);

  if (before) {
    messages = messages.filter(m => m.created_at < before);
  }

  messages = messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const hasMore = messages.length > parseInt(limit);
  if (hasMore) messages = messages.slice(0, parseInt(limit));

  // 解密消息内容
  const decryptedMessages = messages.map(message => {
    try {
      // 检查消息是否需要解密
      const isEncrypted = message.metadata?.encryption?.encrypted;
      if (isEncrypted && message.content && typeof message.content === 'string') {
        // 解密内容
        const decryptedContent = encryptionUtils.decryptText(message.content);
        return {
          ...message,
          content: decryptedContent,
          metadata: {
            ...message.metadata,
            encryption: {
              ...message.metadata.encryption,
              decrypted: true,
              decryption_timestamp: new Date().toISOString()
            }
          }
        };
      }
      return message;
    } catch (error) {
      console.warn(`解密消息 ${message.id} 内容失败:`, error.message);
      return message; // 返回原始消息
    }
  });

  const reversed = decryptedMessages.reverse();

  res.json({
    messages: reversed,
    hasMore
  });
});

router.post('/groups/:groupId/messages', async (req, res) => {
  const db = getDb();
  await db.read();
  const { groupId } = req.params;
  const { content, sender_type = 'user', sender_id = 'user', content_type = 'text', reply_to, metadata } = req.body;

  const group = db.data.groups.find(g => g.id === groupId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const messageId = uuidv4();
  
  // 加密消息内容（如果支持加密）
  let encryptedContent = content;
  let encryptionInfo = null;
  
  try {
    if (content && content.trim().length > 0 && content_type === 'text') {
      encryptedContent = encryptionUtils.encryptText(content);
      encryptionInfo = {
        encrypted: true,
        encryption_version: 'aes-256-gcm-v1',
        encryption_timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.warn('消息内容加密失败，将使用明文存储:', error.message);
  }
  
  const message = {
    id: messageId,
    group_id: groupId,
    sender_type,
    sender_id,
    content: encryptedContent,
    content_type,
    reply_to,
    metadata: {
      ...metadata,
      encryption: encryptionInfo
    },
    created_at: new Date().toISOString()
  };

  db.data.messages.push(message);
  await db.write();

  broadcastToGroup(groupId, {
    type: 'new_message',
    group_id: groupId,
    id: messageId,
    sender_type,
    sender_id,
    content: content,
    content_type,
    reply_to,
    created_at: message.created_at
  });

  setTimeout(() => {
    queueAIMessages(groupId, content, reply_to);
  }, 500);

  // 返回解密后的消息给前端
  const responseMessage = {
    ...message,
    content: content, // 返回原始内容，而非加密内容
    metadata: {
      ...message.metadata,
      encryption: {
        ...encryptionInfo,
        decrypted_for_display: true
      }
    }
  };

  res.status(201).json(responseMessage);
});

router.delete('/messages/:id', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;

  const messageIndex = db.data.messages.findIndex(m => m.id === id);
  if (messageIndex === -1) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const deletedMessage = db.data.messages[messageIndex];
  db.data.messages.splice(messageIndex, 1);
  await db.write();

  if (deletedMessage.group_id) {
    broadcastToGroup(deletedMessage.group_id, {
      type: 'message_deleted',
      group_id: deletedMessage.group_id,
      message_id: id,
      timestamp: new Date().toISOString()
    });
  }

  res.json({ success: true });
});

router.post('/messages/:id/dislike', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;
  const { userId = 'user' } = req.body;

  const message = db.data.messages.find(m => m.id === id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  if (!message.disliked_by) {
    message.disliked_by = [];
  }

  if (!message.disliked_by.includes(userId)) {
    message.disliked_by.push(userId);
    message.dislikes = (message.dislikes || 0) + 1;
    await db.write();

    if (message.group_id) {
      broadcastToGroup(message.group_id, {
        type: 'message_disliked',
        group_id: message.group_id,
        message_id: id,
        disliked_by: userId,
        disliked_by_type: userId === 'user' ? 'user' : 'ai',
        timestamp: new Date().toISOString()
      });
    }
  }

  res.json({ success: true, dislikes: message.dislikes, disliked_by: message.disliked_by });
});

router.delete('/messages/:id/dislike', async (req, res) => {
  const db = getDb();
  await db.read();
  const { id } = req.params;
  const { userId = 'user' } = req.body;

  const message = db.data.messages.find(m => m.id === id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  if (message.disliked_by && message.disliked_by.includes(userId)) {
    message.disliked_by = message.disliked_by.filter(id => id !== userId);
    message.dislikes = Math.max(0, (message.dislikes || 0) - 1);
    await db.write();
  }

  res.json({ success: true, dislikes: message.dislikes || 0, disliked_by: message.disliked_by || [] });
});

router.post('/comments', async (req, res) => {
  const { message_id, content } = req.body;

  if (!message_id || !content) {
    return res.status(400).json({ error: 'message_id and content are required' });
  }

  const db = getDb();
  await db.read();

  const message = db.data.messages.find(m => m.id === message_id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const comment = {
    id: 'comment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    message_id,
    content,
    user_id: req.body.user_id || 'user',
    created_at: new Date().toISOString()
  };

  if (!message.comments) {
    message.comments = [];
  }

  message.comments.push(comment);
  await db.write();

  broadcastToGroup(message.group_id, {
    type: 'new_comment',
    comment,
    message_id
  });

  res.status(201).json(comment);
});

router.post('/messages/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;
    const db = getDb();
    await db.read();
    const message = db.data.messages.find(m => m.id === id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (!message.likes) message.likes = [];
    if (!message.likes.includes(user_id)) {
      message.likes.push(user_id);
      await db.write();
    }
    res.json({ likes: message.likes, likes_count: message.likes.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/messages/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    const db = getDb();
    await db.read();
    const message = db.data.messages.find(m => m.id === id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (!message.likes) message.likes = [];
    message.likes = message.likes.filter(uid => uid !== user_id);
    await db.write();
    res.json({ likes: message.likes, likes_count: message.likes.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
