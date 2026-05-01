import express from 'express';
import { withWriteLock, resetGroupActivity, updateGroupActivity } from '../models/db.js';
import { v4 as uuidv4 } from 'uuid';
import { queueAIMessages, handleUserReaction, handleUserComment, startAutonomousChat, stopAutonomousChat, getAutonomousChatStatus } from '../services/scheduler/index.js';
import socialService from '../services/social/index.js';
import { AI_PERSONAS } from '../config/personas.js';
import encryptionUtils from '../utils/encryption.js';
import { broadcastToGroup } from '../websocket/index.js';
import { validateBody, sendMessageSchema, editMessageSchema, batchDeleteSchema, commentSchema } from '../validators/index.js';
import { safeLog } from '../utils/logger.js';
import { sanitizeObject, MESSAGE_SANITIZE_CONFIG, COMMENT_SANITIZE_CONFIG } from '../utils/sanitize.js';

const router = express.Router();

const safeErrorResponse = (error) => {
  if (process.env.NODE_ENV === 'production') {
    return { error: '服务器内部错误' };
  }
  return { error: error.message };
};

function getMessagesForGroup(db, groupId, limit = 50, before = null, after = null) {
  const indexes = db.data._indexes;
  if (!indexes || !indexes.messagesByGroup) {
    db.data._indexes = { messagesByGroup: {} };
  }

  let groupIndex = db.data._indexes.messagesByGroup[groupId];
  const groupMsgCount = db.data.messages.filter(m => m.group_id === groupId).length;
  if (!groupIndex || groupIndex.length !== groupMsgCount) {
    const msgs = db.data.messages.filter(m => m.group_id === groupId);
    msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    groupIndex = msgs.map(m => m.id);
    db.data._indexes.messagesByGroup[groupId] = groupIndex;
  }

  const messageMap = new Map(db.data.messages.map(m => [m.id, m]));
  let messages = groupIndex.map(id => messageMap.get(id)).filter(Boolean);

  if (after) {
    const afterIndex = messages.findIndex(m => m.created_at > after);
    if (afterIndex >= 0) {
      messages = messages.slice(afterIndex);
    } else {
      messages = [];
    }
  }

  if (before) {
    const beforeIndex = messages.findIndex(m => m.created_at >= before);
    if (beforeIndex > 0) {
      messages = messages.slice(0, beforeIndex);
    } else if (beforeIndex === 0) {
      messages = [];
    }
  }

  const hasMore = messages.length > limit;
  if (hasMore) {
    messages = messages.slice(-limit);
  }

  return { messages, hasMore };
}

function addMessageToIndex(db, message) {
  const indexes = db.data._indexes;
  if (!indexes || !indexes.messagesByGroup) {
    db.data._indexes = { messagesByGroup: {} };
  }
  const groupId = message.group_id;
  if (!db.data._indexes.messagesByGroup[groupId]) {
    db.data._indexes.messagesByGroup[groupId] = [];
  }
  db.data._indexes.messagesByGroup[groupId].push(message.id);
}

function removeMessageFromIndex(db, messageId, groupId) {
  const indexes = db.data._indexes;
  if (indexes?.messagesByGroup?.[groupId]) {
    const idx = indexes.messagesByGroup[groupId].indexOf(messageId);
    if (idx > -1) {
      indexes.messagesByGroup[groupId].splice(idx, 1);
    }
  }
}

function normalizeLikeState(message) {
  if (!Array.isArray(message.likes)) {
    message.likes = Array.isArray(message.liked_by) ? [...message.liked_by] : [];
  }
  if (!Array.isArray(message.liked_by)) {
    message.liked_by = [...message.likes];
  }
  return message.likes;
}

function normalizeDislikeState(message) {
  if (!Array.isArray(message.disliked_by)) {
    message.disliked_by = [];
  }
  message.dislikes = message.disliked_by.length;
  return message.disliked_by;
}

router.get('/groups/:groupId/messages', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { groupId } = req.params;
  const { limit = 50, before, after } = req.query;

  const { messages, hasMore } = getMessagesForGroup(db, groupId, parseInt(limit), before, after);

  const decryptedMessages = messages.map(message => {
    try {
      const isEncrypted = message.metadata?.encryption?.encrypted;
      if (isEncrypted && message.content && typeof message.content === 'string') {
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
      return message;
    }
  });

  res.json({
    messages: decryptedMessages,
    hasMore
  });
});

router.post('/groups/:groupId/messages', validateBody(sendMessageSchema), async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { groupId } = req.params;
  const sanitizedBody = sanitizeObject(req.body, MESSAGE_SANITIZE_CONFIG);
  const content = sanitizedBody.content;
  const content_type = sanitizedBody.content_type || 'text';
  const reply_to = sanitizedBody.reply_to;
  const metadata = sanitizedBody.metadata;
  const attachments = sanitizedBody.attachments;
  const sender_type = 'user';
  const sender_id = req.userId;
  if (!sender_id) return res.status(401).json({ error: '未认证' });

  const group = db.data.groups.find(g => g.id === groupId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  let enrichedAttachments = attachments || [];
  if (enrichedAttachments.length > 0) {
    const filesIndex = {};
    for (const f of (db.data.files || [])) {
      filesIndex[f.id] = f;
    }
    enrichedAttachments = enrichedAttachments.map(att => {
      const fileId = att.id || att.url?.split('/').pop() || att.url?.split('/files/').pop()?.replace('/download', '');
      const fileRecord = fileId ? filesIndex[fileId] : null;
      if (fileRecord && fileRecord.media_description) {
        return { ...att, media_description: fileRecord.media_description };
      }
      return att;
    });
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
    attachments: enrichedAttachments,
    metadata: {
      ...metadata,
      encryption: encryptionInfo
    },
    created_at: new Date().toISOString()
  };

  db.data.messages.push(message);
  addMessageToIndex(db, message);
  updateGroupActivity(group, {
    id: message.id,
    group_id: message.group_id,
    sender_type: message.sender_type,
    sender_id: message.sender_id,
    content: content,
    content_type: message.content_type,
    created_at: message.created_at
  });
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  broadcastToGroup(groupId, {
    type: 'new_message',
    group_id: groupId,
    id: messageId,
    sender_type,
    sender_id,
    content: content,
    content_type,
    reply_to,
    attachments: enrichedAttachments,
    created_at: message.created_at
  });

  if (process.env.NODE_ENV !== 'test') {
    queueAIMessages(groupId, content, reply_to).catch((error) => {
      safeLog('error', 'AI消息队列执行失败', { groupId, error: error?.message });
    });
  }

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

router.put('/messages/:id', validateBody(editMessageSchema), async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content is required' });
  }

  const message = db.data.messages.find(m => m.id === id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  if (message.sender_type !== 'user') {
    return res.status(403).json({ error: 'Cannot edit AI messages' });
  }

  if (message.sender_id !== req.userId) {
    return res.status(403).json({ error: '只能编辑自己发送的消息' });
  }

  let encryptedContent = content;
  let encryptionInfo = message.metadata?.encryption || null;
  
  try {
    if (content && content.trim().length > 0 && message.content_type === 'text') {
      encryptedContent = encryptionUtils.encryptText(content);
      encryptionInfo = {
        ...encryptionInfo,
        encrypted: true,
        encryption_version: 'aes-256-gcm-v1',
        encryption_timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.warn('消息内容加密失败，将使用明文存储:', error.message);
  }

  message.content = encryptedContent;
  message.is_edited = true;
  message.edited_at = new Date().toISOString();
  message.metadata = {
    ...message.metadata,
    encryption: encryptionInfo
  };
  const group = db.data.groups.find(g => g.id === message.group_id);
  updateGroupActivity(group, {
    id: message.id,
    group_id: message.group_id,
    sender_type: message.sender_type,
    sender_id: message.sender_id,
    content: content,
    content_type: message.content_type,
    created_at: new Date().toISOString()
  });
  
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  broadcastToGroup(message.group_id, {
    type: 'message_updated',
    group_id: message.group_id,
    message_id: id,
    content: content,
    is_edited: true,
    edited_at: message.edited_at
  });

  const responseMessage = {
    ...message,
    content: content,
    metadata: {
      ...message.metadata,
      encryption: {
        ...encryptionInfo,
        decrypted_for_display: true
      }
    }
  };

  res.json(responseMessage);
});

router.delete('/messages/:id', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;

  const messageIndex = db.data.messages.findIndex(m => m.id === id);
  if (messageIndex === -1) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const deletedMessage = db.data.messages[messageIndex];
  if (deletedMessage.sender_type === 'user' && deletedMessage.sender_id !== req.userId) {
    return res.status(403).json({ error: '只能删除自己发送的消息' });
  }
  db.data.messages.splice(messageIndex, 1);
  removeMessageFromIndex(db, id, deletedMessage.group_id);
  resetGroupActivity(db, deletedMessage.group_id);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

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

router.post('/messages/batch-delete', validateBody(batchDeleteSchema), async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { message_ids, group_id } = req.body;

  if (!Array.isArray(message_ids) || message_ids.length === 0) {
    return res.status(400).json({ error: 'message_ids must be a non-empty array' });
  }

  if (!group_id) {
    return res.status(400).json({ error: 'group_id is required' });
  }

  const idSet = new Set(message_ids);
  const messagesToDelete = db.data.messages.filter(m => idSet.has(m.id) && m.group_id === group_id);

  if (messagesToDelete.length !== message_ids.length) {
    return res.status(404).json({ error: '部分消息不存在或不属于当前群组' });
  }

  const unauthorizedMessage = messagesToDelete.find(message =>
    message.sender_type === 'user' && message.sender_id !== req.userId
  );
  if (unauthorizedMessage) {
    return res.status(403).json({ error: '批量删除仅允许删除自己发送的用户消息' });
  }

  db.data.messages = db.data.messages.filter(m => !(idSet.has(m.id) && m.group_id === group_id));

  const deletedCount = messagesToDelete.length;
  const deletedIds = messagesToDelete.map(message => message.id);

  if (deletedCount > 0) {
    if (db.data._indexes?.messagesByGroup?.[group_id]) {
      db.data._indexes.messagesByGroup[group_id] = db.data._indexes.messagesByGroup[group_id].filter(
        id => !idSet.has(id)
      );
    }
    resetGroupActivity(db, group_id);
    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    broadcastToGroup(group_id, {
      type: 'messages_batch_deleted',
      group_id: group_id,
      message_ids: deletedIds,
      deleted_count: deletedCount,
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    success: true,
    deleted_count: deletedCount,
    deleted_ids: deletedIds
  });
});

// 清空群聊所有消息
router.delete('/groups/:groupId/messages', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { groupId } = req.params;

  const group = db.data.groups.find(g => g.id === groupId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const originalCount = db.data.messages.length;
  db.data.messages = db.data.messages.filter(m => m.group_id !== groupId);
  const deletedCount = originalCount - db.data.messages.length;

  if (db.data._indexes?.messagesByGroup) {
    db.data._indexes.messagesByGroup[groupId] = [];
  }
  resetGroupActivity(db, groupId);

  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  broadcastToGroup(groupId, {
    type: 'messages_all_deleted',
    group_id: groupId,
    deleted_count: deletedCount,
    timestamp: new Date().toISOString()
  });

  res.json({
    success: true,
    deleted_count: deletedCount,
    message: `已清空群聊中的所有消息，共删除 ${deletedCount} 条`
  });
});

router.post('/messages/:id/dislike', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: '未认证' });

  const message = db.data.messages.find(m => m.id === id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  normalizeDislikeState(message);

  if (!message.disliked_by.includes(userId)) {
    message.disliked_by.push(userId);
    message.dislikes = message.disliked_by.length;
    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    if (message.group_id) {
      broadcastToGroup(message.group_id, {
        type: 'message_disliked',
        group_id: message.group_id,
        message_id: id,
        disliked_by: userId,
        disliked_by_type: userId === 'user' ? 'user' : 'ai',
        timestamp: new Date().toISOString()
      });
      
      if (message.sender_type === 'ai') {
        setTimeout(() => {
          handleUserReaction(message.group_id, id, 'dislike', userId);
        }, 500);
      }
    }
  }

  res.json({ success: true, dislikes: message.dislikes, disliked_by: message.disliked_by });
});

router.delete('/messages/:id/dislike', async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: '未认证' });

  const message = db.data.messages.find(m => m.id === id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  normalizeDislikeState(message);
  if (message.disliked_by && message.disliked_by.includes(userId)) {
    message.disliked_by = message.disliked_by.filter(id => id !== userId);
    message.dislikes = message.disliked_by.length;
    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    if (message.group_id) {
      broadcastToGroup(message.group_id, {
        type: 'message_undisliked',
        group_id: message.group_id,
        message_id: id,
        undisliked_by: userId,
        undisliked_by_type: userId === 'user' ? 'user' : 'ai',
        timestamp: new Date().toISOString()
      });
    }
  }

  res.json({ success: true, dislikes: message.dislikes || 0, disliked_by: message.disliked_by || [] });
});

router.post('/comments', validateBody(commentSchema), async (req, res) => {
  const sanitizedBody = sanitizeObject(req.body, COMMENT_SANITIZE_CONFIG);
  const { message_id, content, parent_id, reply_to } = sanitizedBody;

  if (!message_id || !content) {
    return res.status(400).json({ error: 'message_id and content are required' });
  }

  const db = await req.getUserDb();
  await db.read();

  const message = db.data.messages.find(m => m.id === message_id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  const existingComments = message.comments || [];
  let parentComment = null;
  if (parent_id) {
    parentComment = existingComments.find(comment => comment.id === parent_id);
    if (!parentComment) {
      return res.status(400).json({ error: '父评论不存在' });
    }
  }
  if (reply_to) {
    const replyTarget = existingComments.find(comment => comment.id === reply_to);
    if (!replyTarget) {
      return res.status(400).json({ error: '回复目标不存在' });
    }
  }

  const sender_id = req.userId;
  if (!sender_id) return res.status(401).json({ error: '未认证' });
  const comment = {
    id: 'comment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    message_id,
    parent_id: parent_id || null,
    reply_to: reply_to || null,
    sender_type: 'user',
    sender_id,
    content,
    created_at: new Date().toISOString(),
    depth: parentComment ? (parentComment.depth || 0) + 1 : 0
  };

  if (comment.depth >= 5) {
    return res.status(400).json({ error: '评论层级不能超过5层' });
  }

  if (!message.comments) {
    message.comments = [];
  }

  message.comments.push(comment);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  broadcastToGroup(message.group_id, {
    type: 'new_comment',
    group_id: message.group_id,
    comment,
    message_id
  });
  
  if (message.sender_type === 'ai') {
    setTimeout(() => {
      handleUserComment(message.group_id, message_id, comment, comment.id);
    }, 500);
  }

  res.status(201).json({ comment });
});

router.post('/messages/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.userId;
    if (!user_id) return res.status(401).json({ error: '未认证' });
    const db = await req.getUserDb();
    await db.read();
    const message = db.data.messages.find(m => m.id === id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    normalizeLikeState(message);
    if (!message.likes.includes(user_id)) {
      message.likes.push(user_id);
      message.liked_by = [...message.likes];
      await withWriteLock(req.userId, async () => {
        await db.write();
      });

      broadcastToGroup(message.group_id, {
        type: 'message_liked',
        group_id: message.group_id,
        message_id: id,
        liked_by: user_id,
        liked_by_type: user_id === 'user' ? 'user' : 'ai',
        timestamp: new Date().toISOString()
      });
      
      if (message.group_id && message.sender_type === 'ai') {
        setTimeout(() => {
          handleUserReaction(message.group_id, id, 'like', user_id);
        }, 500);
      }
    }
    res.json({ likes: message.likes, liked_by: message.liked_by, likes_count: message.likes.length });
  } catch (error) {
    safeLog('error', '点赞操作失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.delete('/messages/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.userId;
    if (!user_id) return res.status(401).json({ error: '未认证' });
    const db = await req.getUserDb();
    await db.read();
    const message = db.data.messages.find(m => m.id === id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    normalizeLikeState(message);
    const wasLiked = message.likes.includes(user_id);
    message.likes = message.likes.filter(uid => uid !== user_id);
    message.liked_by = [...message.likes];
    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    if (wasLiked && message.group_id) {
      broadcastToGroup(message.group_id, {
        type: 'message_unliked',
        group_id: message.group_id,
        message_id: id,
        unliked_by: user_id,
        unliked_by_type: user_id === 'user' ? 'user' : 'ai',
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({ likes: message.likes, liked_by: message.liked_by, likes_count: message.likes.length });
  } catch (error) {
    safeLog('error', '取消点赞操作失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.post('/groups/:groupId/autonomous-chat/start', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { topic } = req.body;
    
    const result = await startAutonomousChat(groupId, topic);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    safeLog('error', '启动自发对话失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.post('/groups/:groupId/autonomous-chat/stop', async (req, res) => {
  try {
    const { groupId } = req.params;
    const result = stopAutonomousChat(groupId);
    res.json(result);
  } catch (error) {
    safeLog('error', '停止自发对话失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.get('/groups/:groupId/autonomous-chat/status', async (req, res) => {
  try {
    const { groupId } = req.params;
    const status = getAutonomousChatStatus(groupId);
    res.json(status);
  } catch (error) {
    safeLog('error', '获取自发对话状态失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.post('/groups/:groupId/private-chat/start', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { topic } = req.body;
    
    const { startAIPrivateChat } = await import('../services/scheduler/index.js');
    const result = await startAIPrivateChat(groupId, topic);
    
    if (result.status === 'success') {
      res.json(result);
    } else if (result.status === 'already_active') {
      res.status(409).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    safeLog('error', '启动私聊失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.post('/groups/:groupId/private-chat/stop', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { stopAIPrivateChat } = await import('../services/scheduler/index.js');
    const result = stopAIPrivateChat(groupId);
    res.json(result);
  } catch (error) {
    safeLog('error', '停止私聊失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.get('/groups/:groupId/private-chat/status', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { getChatStatus } = await import('../services/scheduler/index.js');
    const status = getChatStatus(groupId);
    res.json(status);
  } catch (error) {
    safeLog('error', '获取私聊状态失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.get('/search', async (req, res) => {
  try {
    const { q, type, groupId, limit = 20 } = req.query;
    const maxLimit = Math.min(parseInt(limit) || 20, 50);

    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: '搜索关键词不能为空' });
    }

    const db = await req.getUserDb();
    await db.read();

    const searchQuery = q.toLowerCase().trim();
    const searchTypes = type ? type.split(',') : ['groups', 'messages', 'files', 'agents', 'personas', 'comments'];
    const results = {
      groups: [],
      messages: [],
      files: [],
      agents: [],
      personas: [],
      comments: [],
      total: 0,
      query: q
    };

    if (searchTypes.includes('groups')) {
      const groups = db.data.groups || [];
      for (const group of groups) {
        if (results.groups.length >= maxLimit) break;
        const nameMatch = group.name?.toLowerCase().includes(searchQuery);
        const descMatch = group.description?.toLowerCase().includes(searchQuery);
        const announcementMatch = group.announcement?.toLowerCase().includes(searchQuery);
        const memberMatch = (group.ai_members || []).some(m => m.toLowerCase().includes(searchQuery));
        if (nameMatch || descMatch || announcementMatch || memberMatch) {
          results.groups.push({
            id: group.id,
            name: group.name,
            description: group.description || '',
            type: group.type,
            memberCount: group.ai_members?.length || 0,
            pinned: group.pinned,
            created_at: group.created_at,
            matchField: nameMatch ? 'name' : descMatch ? 'description' : announcementMatch ? 'announcement' : 'member'
          });
        }
      }
    }

    if (searchTypes.includes('messages')) {
      let messages = db.data.messages || [];
      if (groupId) {
        messages = messages.filter(m => m.group_id === groupId);
      }
      const filesIndex = {};
      for (const f of (db.data.files || [])) {
        filesIndex[f.id] = f;
      }

      for (const message of messages) {
        if (results.messages.length >= maxLimit) break;
        try {
          let content = message.content;
          if (message.metadata?.encryption?.encrypted && typeof content === 'string') {
            content = encryptionUtils.decryptText(content);
          }

          const ttsTranscript = typeof message.metadata?.tts?.transcript === 'string'
            ? message.metadata.tts.transcript
            : '';
          let contentMatch = content && content.toLowerCase().includes(searchQuery);
          const ttsMatch = !contentMatch && ttsTranscript.toLowerCase().includes(searchQuery);

          let attachmentMatch = false;
          let attachmentMatchInfo = null;
          if (!contentMatch && !ttsMatch && message.attachments && message.attachments.length > 0) {
            for (const att of message.attachments) {
              const fileId = att.id || att.url?.split('/').pop();
              const fileRecord = fileId ? filesIndex[fileId] : null;
              if (fileRecord) {
                const attNameMatch = fileRecord.filename?.toLowerCase().includes(searchQuery);
                const attDescMatch = fileRecord.search_description?.toLowerCase().includes(searchQuery);
                const attTagsMatch = (fileRecord.search_tags || []).some(t => t.toLowerCase().includes(searchQuery));
                const attContentMatch = typeof fileRecord.parsed_content === 'string' && fileRecord.parsed_content.toLowerCase().includes(searchQuery);
                if (attNameMatch || attDescMatch || attTagsMatch || attContentMatch) {
                  attachmentMatch = true;
                  attachmentMatchInfo = {
                    filename: fileRecord.filename,
                    match_type: attNameMatch ? 'filename' : attDescMatch ? 'description' : attTagsMatch ? 'tags' : 'content'
                  };
                  break;
                }
              }
              const attNameDirect = att.name?.toLowerCase().includes(searchQuery);
              if (attNameDirect) {
                attachmentMatch = true;
                attachmentMatchInfo = { filename: att.name, match_type: 'filename' };
                break;
              }
            }
          }

          if (contentMatch || ttsMatch || attachmentMatch) {
            const groupObj = (db.data.groups || []).find(g => g.id === message.group_id);
            const resultContent = contentMatch
              ? content
              : (ttsMatch ? ttsTranscript : content);
            results.messages.push({
              id: message.id,
              group_id: message.group_id,
              group_name: groupObj?.name || '未知群组',
              sender_type: message.sender_type,
              sender_id: message.sender_id,
              content: resultContent ? resultContent.substring(0, 200) : '',
              content_type: message.content_type,
              has_attachments: !!(message.attachments && message.attachments.length > 0),
              attachments: message.attachments || [],
              tts_audio: message.metadata?.tts || null,
              attachment_match: attachmentMatchInfo,
              match_type: contentMatch ? 'content' : (ttsMatch ? 'tts_transcript' : 'attachment'),
              created_at: message.created_at
            });
          }
        } catch (e) {
          // skip
        }
      }
      results.messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    if (searchTypes.includes('files')) {
      const files = db.data.files || [];
      for (const file of files) {
        if (results.files.length >= maxLimit) break;
        const nameMatch = file.filename?.toLowerCase().includes(searchQuery);
        const descMatch = file.search_description?.toLowerCase().includes(searchQuery);
        const tagsMatch = (file.search_tags || []).some(t => t.toLowerCase().includes(searchQuery));

        let contentMatch = false;
        let contentPreview = '';
        if (typeof file.parsed_content === 'string') {
          contentMatch = file.parsed_content.toLowerCase().includes(searchQuery);
          if (contentMatch) {
            const idx = file.parsed_content.toLowerCase().indexOf(searchQuery);
            const start = Math.max(0, idx - 30);
            const end = Math.min(file.parsed_content.length, idx + searchQuery.length + 50);
            contentPreview = (start > 0 ? '...' : '') + file.parsed_content.substring(start, end) + (end < file.parsed_content.length ? '...' : '');
          } else {
            contentPreview = file.parsed_content.substring(0, 80);
          }
        } else if (file.parsed_content && typeof file.parsed_content === 'object') {
          const objStr = file.parsed_content.description || JSON.stringify(file.parsed_content).substring(0, 200);
          contentMatch = objStr.toLowerCase().includes(searchQuery);
          contentPreview = objStr.substring(0, 80);
        }

        if (nameMatch || descMatch || tagsMatch || contentMatch) {
          const groupObj = (db.data.groups || []).find(g => g.id === file.group_id);
          let matchField = nameMatch ? 'filename' : descMatch ? 'description' : tagsMatch ? 'tags' : 'content';

          const linkedMessage = (db.data.messages || []).find(m =>
            m.attachments && m.attachments.some(a => a.id === file.id || a.url?.endsWith(`/${file.id}/download`))
          );

          results.files.push({
            id: file.id,
            group_id: file.group_id,
            group_name: groupObj?.name || '未知群组',
            filename: file.filename,
            mime_type: file.mime_type,
            file_size: file.file_size,
            search_description: file.search_description || '',
            search_tags: file.search_tags || [],
            content_preview: contentPreview,
            match_field: matchField,
            url: `/api/files/${file.id}/download?group_id=${encodeURIComponent(file.group_id)}`,
            linked_message_id: linkedMessage?.id || null,
            created_at: file.created_at
          });
        }
      }
    }

    if (searchTypes.includes('agents')) {
      const agents = db.data.agents || [];
      for (const agent of agents) {
        if (results.agents.length >= maxLimit) break;
        const nameMatch = agent.name?.toLowerCase().includes(searchQuery);
        const descMatch = agent.description?.toLowerCase().includes(searchQuery);
        const promptMatch = agent.system_prompt?.toLowerCase().includes(searchQuery);
        const openingMatch = agent.opening_message?.toLowerCase().includes(searchQuery);
        if (nameMatch || descMatch || promptMatch || openingMatch) {
          results.agents.push({
            id: agent.id,
            name: agent.name,
            description: agent.description || '',
            avatar_url: agent.avatar_url || null,
            opening_message: agent.opening_message || '',
            match_field: nameMatch ? 'name' : descMatch ? 'description' : promptMatch ? 'system_prompt' : 'opening_message',
            created_at: agent.created_at
          });
        }
      }
    }

    if (searchTypes.includes('personas')) {
      for (const [aiId, persona] of Object.entries(AI_PERSONAS)) {
        if (results.personas.length >= maxLimit) break;
        const nameMatch = persona.name?.toLowerCase().includes(searchQuery);
        const styleMatch = persona.style?.toLowerCase().includes(searchQuery);
        const personalityMatch = persona.personality?.toLowerCase().includes(searchQuery);
        const expertiseMatch = (persona.expertise || []).some(e => e.toLowerCase().includes(searchQuery));
        const keywordsMatch = (persona.keywords || []).some(k => k.toLowerCase().includes(searchQuery));
        const replyStyleMatch = persona.replyStyle?.toLowerCase().includes(searchQuery);
        if (nameMatch || styleMatch || personalityMatch || expertiseMatch || keywordsMatch || replyStyleMatch) {
          results.personas.push({
            id: aiId,
            name: persona.name,
            style: persona.style || '',
            personality: persona.personality || '',
            expertise: persona.expertise || [],
            keywords: persona.keywords || [],
            color: persona.color,
            match_field: nameMatch ? 'name' : styleMatch ? 'style' : personalityMatch ? 'personality' : expertiseMatch ? 'expertise' : keywordsMatch ? 'keywords' : 'replyStyle'
          });
        }
      }
    }

    if (searchTypes.includes('comments')) {
      let messages = db.data.messages || [];
      if (groupId) {
        messages = messages.filter(m => m.group_id === groupId);
      }
      for (const msg of messages) {
        if (results.comments.length >= maxLimit) break;
        if (!msg.comments || msg.comments.length === 0) continue;
        for (const comment of msg.comments) {
          if (results.comments.length >= maxLimit) break;
          const contentMatch = comment.content?.toLowerCase().includes(searchQuery);
          if (contentMatch) {
            const groupObj = (db.data.groups || []).find(g => g.id === msg.group_id);
            results.comments.push({
              id: comment.id,
              message_id: comment.message_id || msg.id,
              group_id: msg.group_id,
              group_name: groupObj?.name || '未知群组',
              sender_type: comment.sender_type,
              sender_id: comment.sender_id,
              content: comment.content.substring(0, 150),
              created_at: comment.created_at
            });
          }
        }
      }
    }

    results.total = results.groups.length + results.messages.length + results.files.length + results.agents.length + results.personas.length + results.comments.length;

    res.json(results);
  } catch (error) {
    safeLog('error', '统一搜索失败', { error: error.message });
    res.status(500).json(safeErrorResponse(error));
  }
});

router.post('/groups/:groupId/messages/:messageId/read', async (req, res) => {
  try {
    const { groupId, messageId } = req.params;
    const db = await req.getUserDb();
    await db.read();
    const message = db.data.messages.find(m => m.id === messageId && m.group_id === groupId);
    if (!message) {
      return res.status(404).json({ error: '消息不存在' });
    }
    if (!message.readBy) message.readBy = [];
    if (!message.readBy.includes('user')) {
      message.readBy.push('user');
    }
    await withWriteLock(req.userId, async () => {
      await db.write();
    });
    res.json({ success: true, messageId, read: true });
  } catch (error) {
    console.error('标记已读错误:', error);
    res.status(500).json({ success: false, error: '标记已读失败' });
  }
});

export default router;
