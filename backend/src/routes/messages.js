import express from 'express';
import { withWriteLock, resetGroupActivity, updateGroupActivity } from '../models/db.js';
import { invalidateInsightsCache } from '../services/insightsCache.js';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { queueAIMessages, handleUserReaction, handleUserComment, startAutonomousChat, stopAutonomousChat, getAutonomousChatStatus } from '../services/scheduler/index.js';
import socialService from '../services/social/index.js';
import { AI_PERSONAS } from '../config/personas.js';
import { buildMergedPersonas } from './personas.js';
import { getCatalogData } from '../services/ai/catalog.js';
import encryptionUtils from '../utils/encryption.js';
import { broadcastToGroup } from '../websocket/index.js';
import { validateBody, sendMessageSchema, editMessageSchema, batchDeleteSchema, commentSchema } from '../validators/index.js';
import { safeLog } from '../utils/logger.js';
import { sanitizeObject, MESSAGE_SANITIZE_CONFIG, COMMENT_SANITIZE_CONFIG } from '../utils/sanitize.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { revokeTtsForMessages, drainTtsPendingDeletes } from '../services/ttsDeletion.js';
import { revokeMessageMemories, markMessageRevisionRevoked,
  markMessageDeleted, sourceMutationUncertain, readableSourceMessages,
  readableSourceGroups, readableSourceFiles, isSourceIdentityRevoked } from '../services/memory/persistentMemory.js';

const router = express.Router();

const MESSAGE_INDEX_CACHE = new Map();
const messageCacheKey = (userId, groupId) => JSON.stringify([userId, groupId]);
const MAX_MESSAGE_INDEX_ENTRIES = 1000;
const sendWithClientIdSchema = sendMessageSchema.extend({
  clientMessageId: z.string().trim().min(1).max(128).optional()
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function messageRequestHash(groupId, body) {
  return createHash('sha256').update(canonicalJson({
    groupId,
    content: body.content,
    content_type: body.content_type || 'text',
    reply_to: body.reply_to || null,
    metadata: body.metadata || {},
    attachments: body.attachments || []
  })).digest('hex');
}

function displayMessage(message) {
  const encryptionInfo = message.metadata?.encryption || null;
  return {
    ...message,
    content: encryptionInfo?.encrypted ? encryptionUtils.decryptText(message.content) : message.content,
    metadata: {
      ...message.metadata,
      encryption: { ...encryptionInfo, decrypted_for_display: true }
    }
  };
}
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

function discardLegacyPersistedIndexes(db) {
  if (db.data && Object.prototype.hasOwnProperty.call(db.data, '_indexes')) {
    delete db.data._indexes;
  }
}

async function readUserData(db) {
  await db.read();
  discardLegacyPersistedIndexes(db);
  return db;
}

function parseMessageLimit(rawLimit) {
  const parsed = parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MESSAGE_LIMIT;
  }
  return Math.min(Math.max(parsed, 1), MAX_MESSAGE_LIMIT);
}

function groupIndexSignature(messages) {
  return createHash('sha256').update(JSON.stringify(messages.map(message => [message.id, message.created_at]))).digest('hex');
}

function rebuildGroupMessageIndex(userId, groupId, groupMessages, signature) {
  groupMessages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const groupIndex = groupMessages.map(m => m.id);
  const key = messageCacheKey(userId, groupId);
  MESSAGE_INDEX_CACHE.delete(key);
  MESSAGE_INDEX_CACHE.set(key, { signature, ids: groupIndex });
  if (MESSAGE_INDEX_CACHE.size > MAX_MESSAGE_INDEX_ENTRIES) {
    MESSAGE_INDEX_CACHE.delete(MESSAGE_INDEX_CACHE.keys().next().value);
  }
  return groupIndex;
}

function getGroupMessageIndex(messages, userId, groupId) {
  const groupMessages = messages.filter(m => m.group_id === groupId);
  // A changed ID or sort timestamp invalidates the cache even when the number
  // of messages stays the same (e.g. another writer replaced a revision).
  const signature = groupIndexSignature(groupMessages);
  const key = messageCacheKey(userId, groupId);
  const cached = MESSAGE_INDEX_CACHE.get(key);
  if (cached?.signature === signature) return cached.ids;
  return rebuildGroupMessageIndex(userId, groupId, groupMessages, signature);
}

function getMessagesForGroup(allMessages, userId, groupId, limit = 50, before = null, after = null) {
  const groupIndex = getGroupMessageIndex(allMessages, userId, groupId);

  const messageMap = new Map(allMessages.map(m => [m.id, m]));
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

function invalidateMessageIndex(userId, groupId) {
  MESSAGE_INDEX_CACHE.delete(messageCacheKey(userId, groupId));
}

function stripAttachmentFullContent(attachments) {
  return (attachments || []).map(att => {
    if (att && typeof att === 'object' && Object.prototype.hasOwnProperty.call(att, 'parsed_content')) {
      const { parsed_content: _strippedContent, ...rest } = att;
      return rest;
    }
    return att;
  });
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

router.get('/groups/:groupId/messages', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { groupId } = req.params;
  const { limit, before, after } = req.query;
  return withWriteLock(req.userId, async () => {
    await readUserData(db);
    const group = (await readableSourceGroups(req.userId, db))
      .find(item => item.id === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const readable = await readableSourceMessages(req.userId, db);

    const { messages, hasMore } = getMessagesForGroup(readable, req.userId, groupId, parseMessageLimit(limit), before, after);

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
      safeLog('warn', '解密消息内容失败', { messageId: message.id, error: error.message });
      return message;
    }
  });

  res.json({
    messages: decryptedMessages,
    hasMore
  });
  });
}));

router.post('/groups/:groupId/messages', validateBody(sendWithClientIdSchema), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { groupId } = req.params;
  const sanitizedBody = sanitizeObject(req.body, MESSAGE_SANITIZE_CONFIG);
  const content = sanitizedBody.content;
  const content_type = sanitizedBody.content_type || 'text';
  const reply_to = sanitizedBody.reply_to;
  const metadata = { ...(sanitizedBody.metadata || {}) };
  // Only the TTS service may attach audio ownership to a message.
  delete metadata.tts;
  sanitizedBody.metadata = metadata;
  const attachments = sanitizedBody.attachments;
  const sender_type = 'user';
  const sender_id = req.userId;
  if (!sender_id) return res.status(401).json({ error: '未认证' });
  const headerKey = req.get('Idempotency-Key');
  if (headerKey && (headerKey.length > 128 || !headerKey.trim())) {
    return res.status(400).json({ error: 'Idempotency-Key 无效' });
  }
  if (headerKey && req.body.clientMessageId && headerKey !== req.body.clientMessageId) {
    return res.status(400).json({ error: 'Idempotency-Key 与 clientMessageId 不一致' });
  }
  const clientMessageId = req.body.clientMessageId || headerKey || null;
  const requestHash = clientMessageId ? messageRequestHash(groupId, sanitizedBody) : null;

  const outcome = await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const group = (await readableSourceGroups(req.userId, db))
      .find(item => item.id === groupId);
    if (!group) return { status: 404, error: 'Group not found' };

    const prior = clientMessageId && (db.data.messageIdempotency || []).find(
      entry => entry.client_message_id === clientMessageId
    );
    if (prior) {
      if (prior.request_hash !== requestHash) return { status: 409, error: 'clientMessageId 已用于不同消息' };
      const existing = (await readableSourceMessages(req.userId, db))
        .find(message => message.id === prior.message_id && message.group_id === groupId);
      if (!existing) return { status: 410, error: '原消息已删除，不能重复发送' };
      return { status: 200, message: displayMessage(existing), created: false };
    }

    const filesIndex = new Map((await readableSourceFiles(req.userId, db))
      .filter(file => (!file.owner_user_id || file.owner_user_id === req.userId) &&
        (!file.uploader_id || file.uploader_id === req.userId))
      .map(file => [file.id, file]));
    if ((attachments || []).some(att => filesIndex.get(att.id)?.group_id !== groupId)) {
      return { status: 404, error: '附件不存在或已撤销' };
    }
    const enrichedAttachments = (attachments || []).map(att => {
      const fileRecord = filesIndex.get(att.id);
      return fileRecord && fileRecord.group_id === groupId ? {
        ...att,
        media_description: fileRecord.media_description || att.media_description || '',
        parsed_content: fileRecord.parsed_content || ''
      } : att;
    });

    const encryptedContent = content_type === 'text' ? encryptionUtils.encryptText(content) : content;
    const encryptionInfo = content_type === 'text' ? {
      encrypted: true,
      encryption_version: 'aes-256-gcm-v1',
      encryption_timestamp: new Date().toISOString()
    } : null;
    const message = {
      id: uuidv4(), group_id: groupId, sender_type, sender_id,
      content: encryptedContent, content_type, reply_to,
      attachments: enrichedAttachments,
      client_message_id: clientMessageId,
      metadata: { ...metadata, encryption: encryptionInfo },
      created_at: new Date().toISOString()
    };
    const previousMessages = db.data.messages;
    const previousLedger = db.data.messageIdempotency;
    const previousActivity = { last_message_at: group.last_message_at, last_message_preview: group.last_message_preview };
    db.data.messages = [...previousMessages, message];
    if (clientMessageId) db.data.messageIdempotency = [...(previousLedger || []), {
      client_message_id: clientMessageId, request_hash: requestHash,
      message_id: message.id, group_id: groupId, created_at: message.created_at
    }];
    updateGroupActivity(group, { ...message, content });
    try {
      await db.write();
    } catch (error) {
      db.data.messages = previousMessages;
      if (previousLedger === undefined) delete db.data.messageIdempotency;
      else db.data.messageIdempotency = previousLedger;
      Object.assign(group, previousActivity);
      throw error;
    }
    invalidateMessageIndex(req.userId, groupId);
    return { status: 201, message: displayMessage(message), created: true };
  });

  if (!outcome.message) return res.status(outcome.status).json({ error: outcome.error });
  if (!outcome.created) return res.status(200).json(outcome.message);
  const message = outcome.message;
  const messageId = message.id;
  const enrichedAttachments = message.attachments;

  invalidateInsightsCache(req.userId, groupId);

  broadcastToGroup(groupId, {
    type: 'new_message',
    group_id: groupId,
    id: messageId,
    client_message_id: message.client_message_id,
    sender_type,
    sender_id,
    content: content,
    content_type,
    reply_to,
    attachments: stripAttachmentFullContent(enrichedAttachments),
    created_at: message.created_at
  });

  if (process.env.NODE_ENV !== 'test') {
    queueAIMessages(groupId, content, reply_to, req.userId, messageId).catch((error) => {
      safeLog('error', 'AI消息队列执行失败', { groupId, error: error?.message });
    });
  }

  res.status(201).json(message);
}));

router.put('/messages/:id', validateBody(editMessageSchema), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;
  const { content } = req.body;

  if (!content.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }

  const outcome = await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const message = db.data.messages.find(m => m.id === id);
    if (message && await isSourceIdentityRevoked(req.userId, db, message)) {
      return { status: 404, error: 'Message not found' };
    }
    if (!message) return { status: 404, error: 'Message not found' };
    if (message.sender_type !== 'user') return { status: 403, error: 'Cannot edit AI messages' };
    if (message.sender_id !== req.userId) return { status: 403, error: '只能编辑自己发送的消息' };

    const previousMessage = { ...message };
    const previousAudio = db.data.ttsAudioFiles;
    const previousPendingAudio = db.data.ttsPendingDeletes;
    const previousMemoryRecords = db.data.memoryRecords;
    const sourceChanged = displayMessage(message).content !== content;
    const audioRevoked = sourceChanged && Boolean(message.metadata?.tts);
    const group = db.data.groups.find(g => g.id === message.group_id);
    const previousActivity = group && { last_message_at: group.last_message_at, last_message_preview: group.last_message_preview };
    const encryptedContent = message.content_type === 'text' ? encryptionUtils.encryptText(content) : content;
    const encryptionInfo = message.content_type === 'text' ? {
      ...message.metadata?.encryption,
      encrypted: true,
      encryption_version: 'aes-256-gcm-v1',
      encryption_timestamp: new Date().toISOString()
    } : message.metadata?.encryption || null;
    await markMessageRevisionRevoked(req.userId, db, message);
    if (audioRevoked) {
      revokeTtsForMessages(db.data, [id]);
      message.metadata = { ...message.metadata };
      delete message.metadata.tts;
    }
    Object.assign(message, {
      content: encryptedContent, is_edited: true, edited_at: new Date().toISOString(),
      metadata: { ...message.metadata, encryption: encryptionInfo }
    });
    revokeMessageMemories(db.data, message.group_id, [id]);
    updateGroupActivity(group, { ...message, content, created_at: new Date().toISOString() });

    try {
      await db.write();
    } catch (error) {
      Object.keys(message).forEach(key => delete message[key]);
      Object.assign(message, previousMessage);
      db.data.ttsAudioFiles = previousAudio;
      db.data.ttsPendingDeletes = previousPendingAudio;
      db.data.memoryRecords = previousMemoryRecords;
      if (group) Object.assign(group, previousActivity);
      throw sourceMutationUncertain(req.userId, error);
    }
    invalidateMessageIndex(req.userId, message.group_id);
    return { status: 200, message: displayMessage(message), groupId: message.group_id, audioRevoked };
  });
  if (!outcome.message) return res.status(outcome.status).json({ error: outcome.error });
  if (outcome.audioRevoked) {
    await drainTtsPendingDeletes(req.userId).catch(error => {
      safeLog('warn', '编辑消息后的音频删除待恢复', { userId: req.userId, error: error?.message });
    });
  }

  broadcastToGroup(outcome.groupId, {
    type: 'message_updated',
    group_id: outcome.groupId,
    message_id: id,
    content: content,
    is_edited: true,
    audio_revoked: outcome.audioRevoked,
    edited_at: outcome.message.edited_at
  });

  res.json(outcome.message);
}));

router.delete('/messages/:id', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;
  const outcome = await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const deletedMessage = db.data.messages.find(m => m.id === id);
    if (!deletedMessage) return { status: 404, error: 'Message not found' };
    if (deletedMessage.sender_type === 'user' && deletedMessage.sender_id !== req.userId) {
      return { status: 403, error: '只能删除自己发送的消息' };
    }
    const previousMessages = db.data.messages;
    const previousAudio = db.data.ttsAudioFiles;
    const previousPendingAudio = db.data.ttsPendingDeletes;
    const previousMemoryRecords = db.data.memoryRecords;
    const group = db.data.groups.find(g => g.id === deletedMessage.group_id);
    const previousActivity = group && { last_message_at: group.last_message_at, last_message_preview: group.last_message_preview };
    await markMessageDeleted(req.userId, db, deletedMessage.group_id, [id]);
    revokeTtsForMessages(db.data, [id]);
    db.data.messages = previousMessages.filter(message => message.id !== id);
    revokeMessageMemories(db.data, deletedMessage.group_id, [id]);
    resetGroupActivity(db, deletedMessage.group_id);
    try {
      await db.write();
    } catch (error) {
      db.data.messages = previousMessages;
      db.data.ttsAudioFiles = previousAudio;
      db.data.ttsPendingDeletes = previousPendingAudio;
      db.data.memoryRecords = previousMemoryRecords;
      if (group) Object.assign(group, previousActivity);
      throw sourceMutationUncertain(req.userId, error);
    }
    invalidateMessageIndex(req.userId, deletedMessage.group_id);
    return { deletedMessage };
  });
  if (!outcome.deletedMessage) return res.status(outcome.status).json({ error: outcome.error });
  const audioDeletionPending = await drainTtsPendingDeletes(req.userId).catch(error => {
    safeLog('warn', '消息音频删除待恢复', { userId: req.userId, error: error?.message });
    return 1;
  });

  if (outcome.deletedMessage.group_id) {
    broadcastToGroup(outcome.deletedMessage.group_id, {
      type: 'message_deleted',
      group_id: outcome.deletedMessage.group_id,
      message_id: id,
      timestamp: new Date().toISOString()
    });
  }

  res.json({ success: true, audioDeletionPending: audioDeletionPending > 0 });
}));

router.post('/messages/batch-delete', validateBody(batchDeleteSchema), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { message_ids, group_id } = req.body;

  if (!Array.isArray(message_ids) || message_ids.length === 0) {
    return res.status(400).json({ error: 'message_ids must be a non-empty array' });
  }

  if (!group_id) {
    return res.status(400).json({ error: 'group_id is required' });
  }

  const outcome = await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const idSet = new Set(message_ids);
    const messagesToDelete = db.data.messages.filter(m => idSet.has(m.id) && m.group_id === group_id);
    if (messagesToDelete.length !== message_ids.length) {
      return { status: 404, error: '部分消息不存在或不属于当前群组' };
    }
    if (messagesToDelete.some(message => message.sender_type === 'user' && message.sender_id !== req.userId)) {
      return { status: 403, error: '批量删除仅允许删除自己发送的用户消息' };
    }
    const previousMessages = db.data.messages;
    const previousAudio = db.data.ttsAudioFiles;
    const previousPendingAudio = db.data.ttsPendingDeletes;
    const previousMemoryRecords = db.data.memoryRecords;
    const group = db.data.groups.find(g => g.id === group_id);
    const previousActivity = group && { last_message_at: group.last_message_at, last_message_preview: group.last_message_preview };
    await markMessageDeleted(req.userId, db, group_id, message_ids);
    revokeTtsForMessages(db.data, message_ids);
    db.data.messages = previousMessages.filter(m => !(idSet.has(m.id) && m.group_id === group_id));
    revokeMessageMemories(db.data, group_id, message_ids);
    resetGroupActivity(db, group_id);
    try {
      await db.write();
    } catch (error) {
      db.data.messages = previousMessages;
      db.data.ttsAudioFiles = previousAudio;
      db.data.ttsPendingDeletes = previousPendingAudio;
      db.data.memoryRecords = previousMemoryRecords;
      if (group) Object.assign(group, previousActivity);
      throw sourceMutationUncertain(req.userId, error);
    }
    invalidateMessageIndex(req.userId, group_id);
    return { deletedIds: messagesToDelete.map(message => message.id) };
  });
  if (!outcome.deletedIds) return res.status(outcome.status).json({ error: outcome.error });
  const audioDeletionPending = await drainTtsPendingDeletes(req.userId).catch(error => {
    safeLog('warn', '批量消息音频删除待恢复', { userId: req.userId, error: error?.message });
    return 1;
  });
  const deletedIds = outcome.deletedIds;
  const deletedCount = deletedIds.length;
  if (deletedCount > 0) {
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
    audioDeletionPending: audioDeletionPending > 0,
    deleted_count: deletedCount,
    deleted_ids: deletedIds
  });
}));

// 清空群聊所有消息
router.delete('/groups/:groupId/messages', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { groupId } = req.params;
  const outcome = await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const group = db.data.groups.find(g => g.id === groupId);
    if (!group) return { status: 404, error: 'Group not found' };
    const previousMessages = db.data.messages;
    const previousAudio = db.data.ttsAudioFiles;
    const previousPendingAudio = db.data.ttsPendingDeletes;
    const previousMemoryRecords = db.data.memoryRecords;
    const previousActivity = { last_message_at: group.last_message_at, last_message_preview: group.last_message_preview };
    const deletedIds = previousMessages.filter(m => m.group_id === groupId).map(m => m.id);
    await markMessageDeleted(req.userId, db, groupId, deletedIds);
    revokeTtsForMessages(db.data, deletedIds);
    db.data.messages = previousMessages.filter(m => m.group_id !== groupId);
    revokeMessageMemories(db.data, groupId);
    const deletedCount = previousMessages.length - db.data.messages.length;
    resetGroupActivity(db, groupId);
    try {
      await db.write();
    } catch (error) {
      db.data.messages = previousMessages;
      db.data.ttsAudioFiles = previousAudio;
      db.data.ttsPendingDeletes = previousPendingAudio;
      db.data.memoryRecords = previousMemoryRecords;
      Object.assign(group, previousActivity);
      throw sourceMutationUncertain(req.userId, error);
    }
    invalidateMessageIndex(req.userId, groupId);
    return { deletedCount };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  const audioDeletionPending = await drainTtsPendingDeletes(req.userId).catch(error => {
    safeLog('warn', '清空会话音频删除待恢复', { userId: req.userId, error: error?.message });
    return 1;
  });
  const { deletedCount } = outcome;

  broadcastToGroup(groupId, {
    type: 'messages_all_deleted',
    group_id: groupId,
    deleted_count: deletedCount,
    timestamp: new Date().toISOString()
  });

  res.json({
    success: true,
    deleted_count: deletedCount,
    audioDeletionPending: audioDeletionPending > 0,
    message: `已清空群聊中的所有消息，共删除 ${deletedCount} 条`
  });
}));

router.post('/messages/:id/dislike', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: '未认证' });
  const db = await req.getUserDb();

  await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const message = (await readableSourceMessages(req.userId, db)).find(m => m.id === id);
    if (!message) {
      const err = new Error('Message not found');
      err.status = 404;
      throw err;
    }
    normalizeDislikeState(message);

    if (!message.disliked_by.includes(userId)) {
      message.disliked_by.push(userId);
      message.dislikes = message.disliked_by.length;
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

        if (message.sender_type === 'ai') {
          setTimeout(() => {
            handleUserReaction(message.group_id, id, 'dislike', userId, req.userId);
          }, 500);
        }
      }
    }

    res.json({ success: true, dislikes: message.dislikes, disliked_by: message.disliked_by });
  });
}));

router.delete('/messages/:id/dislike', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: '未认证' });
  const db = await req.getUserDb();

  await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const message = (await readableSourceMessages(req.userId, db)).find(m => m.id === id);
    if (!message) {
      const err = new Error('Message not found');
      err.status = 404;
      throw err;
    }
    normalizeDislikeState(message);

    if (message.disliked_by.includes(userId)) {
      message.disliked_by = message.disliked_by.filter(uid => uid !== userId);
      message.dislikes = message.disliked_by.length;
      await db.write();

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
}));

router.post('/comments', validateBody(commentSchema), asyncHandler(async (req, res) => {
  const sanitizedBody = sanitizeObject(req.body, COMMENT_SANITIZE_CONFIG);
  const { message_id, content, parent_id, reply_to } = sanitizedBody;

  if (!message_id || !content) {
    return res.status(400).json({ error: 'message_id and content are required' });
  }

  const sender_id = req.userId;
  if (!sender_id) return res.status(401).json({ error: '未认证' });
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await readUserData(db);
    const message = (await readableSourceMessages(req.userId, db))
      .find(item => item.id === message_id);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const existingComments = message.comments || [];
    const parentComment = parent_id
      ? existingComments.find(comment => comment.id === parent_id) : null;
    if (parent_id && !parentComment) return res.status(400).json({ error: '父评论不存在' });
    if (reply_to && !existingComments.some(comment => comment.id === reply_to)) {
      return res.status(400).json({ error: '回复目标不存在' });
    }
    const comment = {
      id: uuidv4(), message_id, parent_id: parent_id || null,
      reply_to: reply_to || null, sender_type: 'user', sender_id, content,
      created_at: new Date().toISOString(),
      depth: parentComment ? (parentComment.depth || 0) + 1 : 0
    };
    if (comment.depth >= 5) return res.status(400).json({ error: '评论层级不能超过5层' });
    message.comments = [...existingComments, comment];
    await db.write();

    broadcastToGroup(message.group_id, {
      type: 'new_comment', group_id: message.group_id, comment, message_id
    });
    if (message.sender_type === 'ai') {
      setTimeout(() => {
        handleUserComment(message.group_id, message_id, comment, comment.id, req.userId);
      }, 500);
    }
    return res.status(201).json({ comment });
  });
}));

router.post('/messages/:id/like', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user_id = req.userId;
  if (!user_id) return res.status(401).json({ error: '未认证' });
  const db = await req.getUserDb();

  await withWriteLock(req.userId, async () => {
    await readUserData(db);
    const message = (await readableSourceMessages(req.userId, db)).find(m => m.id === id);
    if (!message) {
      const err = new Error('Message not found');
      err.status = 404;
      throw err;
    }
    normalizeLikeState(message);
    if (!message.likes.includes(user_id)) {
      message.likes.push(user_id);
      message.liked_by = [...message.likes];
    }
    await db.write();

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
        handleUserReaction(message.group_id, id, 'like', user_id, req.userId);
      }, 500);
    }

    res.json({ likes: message.likes, liked_by: message.liked_by, likes_count: message.likes.length });
  });
}));

router.delete('/messages/:id/like', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user_id = req.userId;
  if (!user_id) return res.status(401).json({ error: '未认证' });
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await readUserData(db);
    const message = (await readableSourceMessages(req.userId, db)).find(m => m.id === id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    normalizeLikeState(message);
    const wasLiked = message.likes.includes(user_id);
    if (wasLiked) {
      message.likes = message.likes.filter(uid => uid !== user_id);
      message.liked_by = [...message.likes];
      await db.write();
    }

    if (wasLiked && message.group_id) broadcastToGroup(message.group_id, {
      type: 'message_unliked',
      group_id: message.group_id,
      message_id: id,
      unliked_by: user_id,
      unliked_by_type: user_id === 'user' ? 'user' : 'ai',
      timestamp: new Date().toISOString()
    });
    return res.json({ likes: message.likes, liked_by: message.liked_by, likes_count: message.likes.length });
  });
}));

router.post('/groups/:groupId/autonomous-chat/start', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { topic } = req.body;

  const result = await startAutonomousChat(groupId, topic);

  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
}));

router.post('/groups/:groupId/autonomous-chat/stop', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const result = stopAutonomousChat(groupId);
  res.json(result);
}));

router.get('/groups/:groupId/autonomous-chat/status', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const status = getAutonomousChatStatus(groupId);
  res.json(status);
}));

router.post('/groups/:groupId/private-chat/start', asyncHandler(async (req, res) => {
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
}));

router.post('/groups/:groupId/private-chat/stop', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { stopAIPrivateChat } = await import('../services/scheduler/index.js');
  const result = stopAIPrivateChat(groupId);
  res.json(result);
}));

router.get('/groups/:groupId/private-chat/status', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { getChatStatus } = await import('../services/scheduler/index.js');
  const status = getChatStatus(groupId);
  res.json(status);
}));

router.get('/search', asyncHandler(async (req, res) => {
  const { q, type, groupId, limit = 20, quickFilter, dateFrom, dateTo } = req.query;
  const maxLimit = Math.min(parseInt(limit) || 20, 50);

  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: '搜索关键词不能为空' });
  }

  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
  await readUserData(db);
  const readableMessages = await readableSourceMessages(req.userId, db);
  const readableGroups = await readableSourceGroups(req.userId, db);
  const readableFiles = (await readableSourceFiles(req.userId, db)).filter(file =>
    (!file.owner_user_id || file.owner_user_id === req.userId) &&
    (!file.uploader_id || file.uploader_id === req.userId));
  const readableGroupIds = new Set(readableGroups.map(group => group.id));

  const accountPersonas = buildMergedPersonas(db.data.customPersonas || {}, getCatalogData(db.data));
  const searchQuery = q.toLowerCase().trim();
  const searchTypes = type ? type.split(',') : ['groups', 'messages', 'files', 'agents', 'personas', 'comments', 'members', 'media'];

  // 解析日期范围
  const fromDate = dateFrom ? new Date(dateFrom) : null;
  const toDate = dateTo ? new Date(dateTo + 'T23:59:59.999Z') : null;

  // 快速筛选：根据 quickFilter 限定消息搜索类型
  const quickFilterImages = quickFilter === 'images';
  const quickFilterFiles = quickFilter === 'files';
  const quickFilterLinks = quickFilter === 'links';
  const quickFilterMedia = quickFilter === 'media';
  const results = {
    groups: [],
    messages: [],
    files: [],
    agents: [],
    personas: [],
    comments: [],
    members: [],
    media: [],
    total: 0,
    query: q
  };

  if (searchTypes.includes('groups')) {
    const groups = readableGroups;
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
    let messages = readableMessages;
    if (groupId) {
      messages = messages.filter(m => m.group_id === groupId);
    }

    // 按日期范围筛选
    if (fromDate || toDate) {
      messages = messages.filter(m => {
        const msgDate = new Date(m.created_at);
        if (fromDate && msgDate < fromDate) return false;
        if (toDate && msgDate > toDate) return false;
        return true;
      });
    }

    // 按 quickFilter 预筛选消息附件类型
    if (quickFilterImages || quickFilterFiles || quickFilterLinks) {
      messages = messages.filter(m => {
        if (!m.attachments || m.attachments.length === 0) return false;
        return m.attachments.some(att => {
          const mimeType = (att.type || att.mime_type || '').toLowerCase();
          const fileName = (att.name || att.filename || '').toLowerCase();
          if (quickFilterImages) return mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(fileName);
          if (quickFilterFiles) return !mimeType.startsWith('image/') && !/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(fileName) && !/^https?:\/\//i.test(att.url || '');
          if (quickFilterLinks) return /^https?:\/\//i.test(att.url || '') || /^https?:\/\//i.test(att.name || '') || m.content_type === 'link' || /https?:\/\/[^\s]+/.test(m.content || '');
          return false;
        });
      });
    }

    const filesIndex = {};
    for (const f of readableFiles) {
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
            const attMediaDescMatch = att.media_description && att.media_description.toLowerCase().includes(searchQuery);
            if (attMediaDescMatch) {
              attachmentMatch = true;
              attachmentMatchInfo = { filename: att.name || '附件', match_type: 'media_description' };
              break;
            }
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
          let resultContent = content || '';
          let attachmentMatchPreview = null;

          if (attachmentMatch && !contentMatch && !ttsMatch) {
            if (attachmentMatchInfo?.filename) {
              resultContent = `[附件: ${attachmentMatchInfo.filename}] ${resultContent}`.trim();
            }
            const fileId = message.attachments?.[0]?.id || message.attachments?.[0]?.url?.match(/\/files\/([^/]+)/)?.[1];
            if (fileId) {
              const fileRecord = filesIndex[fileId];
              if (fileRecord) {
                if (fileRecord.media_description) {
                  attachmentMatchPreview = `AI识别: ${fileRecord.media_description.substring(0, 150)}`;
                }
                if (fileRecord.search_description) {
                  attachmentMatchPreview = (attachmentMatchPreview ? attachmentMatchPreview + '\n' : '') + `摘要: ${fileRecord.search_description.substring(0, 150)}`;
                }
                if (typeof fileRecord.parsed_content === 'string' && fileRecord.parsed_content.length > 0) {
                  const idx = fileRecord.parsed_content.toLowerCase().indexOf(searchQuery);
                  if (idx !== -1) {
                    const start = Math.max(0, idx - 30);
                    const end = Math.min(fileRecord.parsed_content.length, idx + searchQuery.length + 50);
                    const preview = (start > 0 ? '...' : '') + fileRecord.parsed_content.substring(start, end) + (end < fileRecord.parsed_content.length ? '...' : '');
                    attachmentMatchPreview = (attachmentMatchPreview ? attachmentMatchPreview + '\n' : '') + `内容: ${preview}`;
                  }
                }
              }
            }
          }

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
            attachment_match_preview: attachmentMatchPreview,
            match_type: contentMatch ? 'content' : (ttsMatch ? 'tts_transcript' : 'attachment'),
            created_at: message.created_at
          });
        }
      } catch (e) {
        safeLog('debug', '搜索解密失败跳过', { messageId: message.id, error: e.message });
      }
    }
    results.messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  if (searchTypes.includes('files')) {
    const files = readableFiles;

    const messagesByAttachmentKey = new Map();
    const registerAttachmentLink = (key, msg) => {
      if (key && !messagesByAttachmentKey.has(key)) {
        messagesByAttachmentKey.set(key, msg);
      }
    };
    for (const msg of readableMessages) {
      for (const att of (msg.attachments || [])) {
        registerAttachmentLink(att.id, msg);
        if (typeof att.url === 'string' && att.url.includes('/files/')) {
          registerAttachmentLink(att.url.split('/files/')[1]?.split(/[/?#]/)[0], msg);
        }
        registerAttachmentLink(att.name, msg);
        if (att.name) {
          registerAttachmentLink(encodeURIComponent(att.name), msg);
        }
      }
    }

    for (const file of files) {
      if (results.files.length >= maxLimit) break;
      if (file.group_id && !readableGroupIds.has(file.group_id)) continue;
      const nameMatch = file.filename?.toLowerCase().includes(searchQuery);
      const descMatch = file.search_description?.toLowerCase().includes(searchQuery);
      const tagsMatch = (file.search_tags || []).some(t => t.toLowerCase().includes(searchQuery));
      const mediaDescMatch = file.media_description && file.media_description.toLowerCase().includes(searchQuery);

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

      if (nameMatch || descMatch || tagsMatch || contentMatch || mediaDescMatch) {
        const groupObj = readableGroups.find(g => g.id === file.group_id);
        let matchField = nameMatch ? 'filename' : descMatch ? 'description' : tagsMatch ? 'tags' : mediaDescMatch ? 'media_description' : 'content';

        const linkedMessage = messagesByAttachmentKey.get(file.id)
          || (file.filename ? (
            messagesByAttachmentKey.get(file.filename)
            || messagesByAttachmentKey.get(encodeURIComponent(file.filename))
          ) : null)
          || null;

        results.files.push({
          id: file.id,
          group_id: file.group_id,
          group_name: groupObj?.name || '未知群组',
          filename: file.filename,
          mime_type: file.mime_type,
          file_size: file.file_size,
          search_description: file.search_description || '',
          search_tags: file.search_tags || [],
          media_description: file.media_description || '',
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
    for (const [aiId, persona] of Object.entries(accountPersonas)) {
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
    let messages = readableMessages;
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

  if (searchTypes.includes('members')) {
    const groups = db.data.groups || [];
    const filteredGroups = groupId ? groups.filter(g => g.id === groupId) : groups;
    const seenMemberIds = new Set();
    for (const group of filteredGroups) {
      // 搜索 AI 成员
      const aiMembers = group.ai_members || [];
      for (const aiId of aiMembers) {
        if (results.members.length >= maxLimit) break;
        const memberKey = `ai_${aiId}`;
        if (seenMemberIds.has(memberKey)) continue;
        const persona = accountPersonas[aiId] || AI_PERSONAS[aiId];
        const aiName = persona?.name || aiId;
        const nameMatch = aiName.toLowerCase().includes(searchQuery);
        const personalityMatch = persona?.personality?.toLowerCase().includes(searchQuery);
        const styleMatch = persona?.style?.toLowerCase().includes(searchQuery);
        const expertiseMatch = (persona?.expertise || []).some(e => e.toLowerCase().includes(searchQuery));
        const keywordsMatch = (persona?.keywords || []).some(k => k.toLowerCase().includes(searchQuery));
        if (nameMatch || personalityMatch || styleMatch || expertiseMatch || keywordsMatch) {
          seenMemberIds.add(memberKey);
          results.members.push({
            id: aiId,
            name: aiName,
            type: 'ai',
            group_id: group.id,
            group_name: group.name,
            personality: persona?.personality || '',
            style: persona?.style || '',
            expertise: persona?.expertise || [],
            color: persona?.color || null,
            match_field: nameMatch ? 'name' : personalityMatch ? 'personality' : styleMatch ? 'style' : expertiseMatch ? 'expertise' : 'keywords'
          });
        }
      }
      // 搜索自定义智能体成员
      const agents = db.data.agents || [];
      for (const agent of agents) {
        if (results.members.length >= maxLimit) break;
        if (!aiMembers.includes(agent.id)) continue;
        const memberKey = `agent_${agent.id}`;
        if (seenMemberIds.has(memberKey)) continue;
        const nameMatch = agent.name?.toLowerCase().includes(searchQuery);
        const descMatch = agent.description?.toLowerCase().includes(searchQuery);
        if (nameMatch || descMatch) {
          seenMemberIds.add(memberKey);
          results.members.push({
            id: agent.id,
            name: agent.name,
            type: 'ai',
            group_id: group.id,
            group_name: group.name,
            personality: agent.description || '',
            avatar_url: agent.avatar_url || null,
            match_field: nameMatch ? 'name' : 'description'
          });
        }
      }
      // 搜索用户成员
      const userMembers = group.user_members || [];
      for (const userId of userMembers) {
        if (results.members.length >= maxLimit) break;
        const memberKey = `user_${userId}`;
        if (seenMemberIds.has(memberKey)) break;
        const idMatch = userId.toLowerCase().includes(searchQuery);
        if (idMatch) {
          seenMemberIds.add(memberKey);
          results.members.push({
            id: userId,
            name: userId,
            type: 'user',
            group_id: group.id,
            group_name: group.name,
            match_field: 'name'
          });
        }
      }
    }
  }

  if (searchTypes.includes('media')) {
    const files = readableFiles;
    const mediaMimeTypes = ['image/', 'audio/', 'video/'];
    const mediaExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'];
    for (const file of files) {
      if (results.media.length >= maxLimit) break;
      if (groupId && file.group_id !== groupId) continue;
      if (file.group_id && !readableGroupIds.has(file.group_id)) continue;

      const ext = (file.filename || '').split('.').pop()?.toLowerCase() || '';
      const isMedia = mediaMimeTypes.some(t => (file.mime_type || '').startsWith(t)) || mediaExtensions.includes(`.${ext}`);
      if (!isMedia) continue;

      const nameMatch = file.filename?.toLowerCase().includes(searchQuery);
      const mediaDescMatch = file.media_description && file.media_description.toLowerCase().includes(searchQuery);
      const searchDescMatch = file.search_description?.toLowerCase().includes(searchQuery);
      const tagsMatch = (file.search_tags || []).some(t => t.toLowerCase().includes(searchQuery));
      const parsedContentMatch = typeof file.parsed_content === 'string' && file.parsed_content.toLowerCase().includes(searchQuery);

      if (nameMatch || mediaDescMatch || searchDescMatch || tagsMatch || parsedContentMatch) {
        const groupObj = readableGroups.find(g => g.id === file.group_id);
        let matchField = nameMatch ? 'filename' : mediaDescMatch ? 'media_description' : searchDescMatch ? 'description' : tagsMatch ? 'tags' : 'content';

        let contentPreview = '';
        if (mediaDescMatch && file.media_description) {
          contentPreview = file.media_description.substring(0, 150);
        } else if (searchDescMatch && file.search_description) {
          contentPreview = file.search_description.substring(0, 150);
        } else if (parsedContentMatch && typeof file.parsed_content === 'string') {
          const idx = file.parsed_content.toLowerCase().indexOf(searchQuery);
          const start = Math.max(0, idx - 30);
          const end = Math.min(file.parsed_content.length, idx + searchQuery.length + 50);
          contentPreview = (start > 0 ? '...' : '') + file.parsed_content.substring(start, end) + (end < file.parsed_content.length ? '...' : '');
        }

        const mediaType = (file.mime_type || '').startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(`.${ext}`) ? 'image'
          : (file.mime_type || '').startsWith('audio/') || ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'].includes(`.${ext}`) ? 'audio'
            : 'video';

        results.media.push({
          id: file.id,
          group_id: file.group_id,
          group_name: groupObj?.name || '未知群组',
          filename: file.filename,
          mime_type: file.mime_type,
          media_type: mediaType,
          file_size: file.file_size,
          media_description: file.media_description || '',
          search_description: file.search_description || '',
          search_tags: file.search_tags || [],
          content_preview: contentPreview,
          match_field: matchField,
          url: `/api/files/${file.id}/download?group_id=${encodeURIComponent(file.group_id)}`,
          created_at: file.created_at
        });
      }
    }
  }

  results.total = results.groups.length + results.messages.length + results.files.length + results.agents.length + results.personas.length + results.comments.length + results.members.length + results.media.length;

  res.json(results);
  });
}));

router.post('/groups/:groupId/messages/:messageId/read', asyncHandler(async (req, res) => {
  const { groupId, messageId } = req.params;
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await readUserData(db);
    if (!(await readableSourceGroups(req.userId, db)).some(group => group.id === groupId)) {
      return res.status(404).json({ error: '群组不存在' });
    }
    const visible = (await readableSourceMessages(req.userId, db))
      .some(message => message.id === messageId && message.group_id === groupId);
    if (!visible) return res.status(404).json({ error: '消息不存在' });
    const message = db.data.messages.find(m => m.id === messageId && m.group_id === groupId);
    message.readBy ||= [];
    if (!message.readBy.includes(req.userId)) {
      message.readBy.push(req.userId);
      await db.write();
    }
    return res.json({ success: true, messageId, read: true });
  });
}));

// 批量已读回执：前端进入历史较多的群时会一次性标记大量可见消息，
// 单独的批量端点避免逐条请求打满限流桶
router.post('/groups/:groupId/messages/read-batch', asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const rawIds = req.body?.messageIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return res.status(400).json({ error: 'messageIds 不能为空' });
  }
  const messageIds = [...new Set(rawIds.filter(id => typeof id === 'string'))].slice(0, 200);
  if (messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds 不含有效 ID' });
  }

  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await readUserData(db);
    if (!(await readableSourceGroups(req.userId, db)).some(group => group.id === groupId)) {
      return res.status(404).json({ error: '群组不存在' });
    }
    const idSet = new Set(messageIds);
    const visibleIds = new Set((await readableSourceMessages(req.userId, db))
      .filter(message => message.group_id === groupId && idSet.has(message.id))
      .map(message => message.id));
    let updated = 0;
    for (const message of db.data.messages) {
      if (message.group_id !== groupId || !visibleIds.has(message.id)) continue;
      message.readBy ||= [];
      if (!message.readBy.includes(req.userId)) {
        message.readBy.push(req.userId);
        updated += 1;
      }
    }
    if (updated > 0) await db.write();
    return res.json({ success: true, requested: messageIds.length, updated });
  });
}));

export default router;
