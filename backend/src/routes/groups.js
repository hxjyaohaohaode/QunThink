import express from 'express';
import { getUploadsDir, withWriteLock, updateGroupActivity, sanitizeGroupForClient, sanitizeGroupsForClient } from '../models/db.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcastToGroup } from '../websocket/index.js';
import { startAutonomousChatTimer, stopAutonomousChatTimer, stopAutomaticGroupConversation } from '../services/scheduler/index.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireGroupMembership } from '../middleware/userDb.js';
import { validateBody, createGroupSchema, updateDebateSchema, pinGroupSchema } from '../validators/index.js';
import { sanitizeObject, GROUP_SANITIZE_CONFIG } from '../utils/sanitize.js';
import { safeLog } from '../utils/logger.js';
import { readCatalog } from '../services/ai/catalog.js';
import { revokeTtsForMessages, drainTtsPendingDeletes } from '../services/ttsDeletion.js';
import { revokeMessageMemories, markGroupDeleted, markFileDeleted,
  sourceMutationUncertain, readableSourceGroups, readableSourceMessages,
  readableSourceFiles } from '../services/memory/persistentMemory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const router = express.Router();
// Covers group-specific reads and mutations that still look up raw groups.
// A restored old user JSON must not make a durably deleted group addressable.
router.param('id', asyncHandler(async (req, res, next) => {
  const db = await req.getUserDb();
  await db.read();
  if (!(await readableSourceGroups(req.userId, db, [{ id: req.params.id }])).length) {
    return res.status(404).json({ error: 'Group not found' });
  }
  return next();
}));
router.use(asyncHandler(async (req, res, next) => {
  if (!/^\/(groups|private-chat|ai-private-chat)(\/|$|s)/.test(req.path)) return next();
  res.locals.modelCatalog = await readCatalog(req.userId);
  res.locals.modelNames = Object.fromEntries(res.locals.modelCatalog.models.map(m => [m.id, m.name]));
  res.locals.validModelIds = new Set(res.locals.modelCatalog.models.filter(m => m.enabled && m.capabilities.includes('chat')).map(m => m.id));
  next();
}));

const aiNames = {
  // 向后兼容旧模型ID
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'mimo-v2.5': 'mimo-v2.5-pro',
  'mimo-v2-flash': 'mimo-v2.5-pro',
  'mimo-v2-omni': 'mimo-v2.5',
  'mimo-v2-tts': 'mimo-v2.5-tts',
  // 新模型ID
  deepseek: 'deepseek-v4-flash',
  deepseek_reasoner: 'deepseek-v4-pro',
  glm_air: 'GLM-4.5-Air',
  glm_flash: 'GLM-4.7-Flash',
  glm_flashx: 'GLM-4.7-FlashX',
  mimo_flash: 'mimo-v2.5-pro',
  mimo_omni: 'mimo-v2.5',
  mimo_tts: 'mimo-v2.5-tts',
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
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err) {
  safeLog('warn', '背景图目录创建失败（将在首次使用时重试）', { error: err.message });
}

const bgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `bg_${uuidv4()}${ext}`);
  }
});
const BACKGROUND_TYPES = new Map([
  ['image/jpeg', { extensions: new Set(['.jpg', '.jpeg']), signature: [0xFF, 0xD8, 0xFF] }],
  ['image/png', { extensions: new Set(['.png']), signature: [0x89, 0x50, 0x4E, 0x47] }],
  ['image/gif', { extensions: new Set(['.gif']), signature: [0x47, 0x49, 0x46] }],
  ['image/webp', { extensions: new Set(['.webp']), signature: [0x52, 0x49, 0x46, 0x46] }]
]);
const bgUpload = multer({
  storage: bgStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const rule = BACKGROUND_TYPES.get(file.mimetype);
    const ext = path.extname(file.originalname).toLowerCase();
    if (rule?.extensions.has(ext)) cb(null, true);
    else cb(new Error('背景图仅支持 JPG、PNG、GIF 或 WebP'));
  }
});

async function validateBackgroundFile(file) {
  const rule = BACKGROUND_TYPES.get(file?.mimetype);
  if (!rule || !file?.path) return false;
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const header = Buffer.alloc(rule.signature.length);
    await handle.read(header, 0, header.length, 0);
    return rule.signature.every((byte, index) => header[index] === byte);
  } finally {
    await handle.close();
  }
}

router.post('/groups/:id/upload-background', bgUpload.single('background'), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const group = db.data.groups.find(g => g.id === id);
  if (!group) {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => { });
    return res.status(404).json({ error: '群组不存在' });
  }
  if (!req.file) return res.status(400).json({ error: '请上传背景图片' });
  if (!await validateBackgroundFile(req.file)) {
    await fs.promises.unlink(req.file.path).catch(() => { });
    return res.status(400).json({ error: '背景图内容与声明类型不匹配' });
  }

  let previousKey = null;
  const bgUrl = `/api/groups/${encodeURIComponent(id)}/background`;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const lockedGroup = db.data.groups.find(g => g.id === id);
    if (!lockedGroup) {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => { });
      const notFound = new Error('群组不存在');
      notFound.status = 404;
      throw notFound;
    }
    previousKey = lockedGroup.background_storage_key;
    lockedGroup.background_url = bgUrl;
    lockedGroup.background_storage_key = req.file.filename;
    await db.write();
  });
  if (previousKey && previousKey !== req.file.filename) {
    const previousPath = path.resolve(uploadDir, path.basename(previousKey));
    if (previousPath.startsWith(path.resolve(uploadDir) + path.sep)) {
      await fs.promises.unlink(previousPath).catch(() => { });
    }
  }
  res.json({ success: true, background_url: bgUrl });
}));

router.get('/groups/:id/background', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const group = db.data.groups.find(item => item.id === req.params.id);
  if (!group) return res.status(404).json({ error: '群组不存在' });

  let storageKey = group.background_storage_key;
  if (!storageKey && typeof group.background_url === 'string' && group.background_url.startsWith('/uploads/backgrounds/')) {
    storageKey = path.basename(group.background_url);
  }
  if (!storageKey || path.basename(storageKey) !== storageKey) {
    return res.status(404).json({ error: '背景图不存在' });
  }

  const filePath = path.resolve(uploadDir, storageKey);
  const uploadRoot = path.resolve(uploadDir);
  if (!filePath.startsWith(uploadRoot + path.sep) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: '背景图不存在' });
  }

  const mimeByExtension = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
  const mimeType = mimeByExtension[path.extname(storageKey).toLowerCase()];
  if (!mimeType) return res.status(415).json({ error: '背景图类型不受支持' });
  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.sendFile(filePath);
}));

router.get('/groups', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await db.read();
    const { limit, offset } = req.query;
    let groups = await readableSourceGroups(req.userId, db);
  if (limit || offset) {
    const start = parseInt(offset, 10) || 0;
    const parsedLimit = parseInt(limit, 10);
    const end = Number.isFinite(parsedLimit) && parsedLimit > 0 ? start + parsedLimit : undefined;
    groups = groups.slice(start, end);
  }
    return res.json(sanitizeGroupsForClient(groups));
  });
}));

router.get('/groups/:id', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await db.read();
    const group = (await readableSourceGroups(req.userId, db))
      .find(item => item.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    return res.json(sanitizeGroupForClient(group));
  });
}));

router.post('/groups', validateBody(createGroupSchema), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const sanitizedBody = sanitizeObject(req.body, GROUP_SANITIZE_CONFIG);
  const { name, description, is_private, ai_member, avatar_url, avatar_color } = sanitizedBody;
  const aiMembers = sanitizedBody.ai_members || [];
  const normalizedAiMembers = Array.isArray(aiMembers) ? [...new Set(aiMembers.filter(Boolean))] : [];

  if (is_private) {
    if (!ai_member || !res.locals.validModelIds.has(ai_member)) {
      return res.status(400).json({ error: '私聊需要指定有效的AI成员' });
    }
  } else {
    if (normalizedAiMembers.some(id => !res.locals.validModelIds.has(id))) {
      return res.status(400).json({ error: 'ai_members 包含无效的AI标识' });
    }

  }

  const groupId = uuidv4();
  const newGroup = {
    id: groupId,
    name,
    description,
    type: is_private ? 'private' : 'custom',
    space_category: sanitizedBody.space_category || 'social',
    is_private: is_private || false,
    avatar_url: avatar_url || null,
    avatar_color: avatar_color || null,
    pinned: false,
    debate_mode: false,
    debate_level: 1,
    ai_members: is_private ? [ai_member] : normalizedAiMembers,
    created_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    last_message_preview: null
  };

  await withWriteLock(req.userId, async () => {
    await db.read();
    db.data.groups.push(newGroup);
    await db.write();
  });

  res.status(201).json(newGroup);
}));

router.put('/groups/:id/debate', validateBody(updateDebateSchema), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;
  const { debate_mode, debate_level } = req.body;

  let updatedGroup = null;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const group = db.data.groups.find(g => g.id === id);
    if (!group) {
      const notFound = new Error('Group not found');
      notFound.status = 404;
      throw notFound;
    }
    if (debate_mode !== undefined) group.debate_mode = debate_mode;
    if (debate_level !== undefined) group.debate_level = debate_level;
    updatedGroup = { ...group };
    await db.write();
  });

  broadcastToGroup(id, {
    type: 'group_update',
    group_id: id,
    group: sanitizeGroupForClient(updatedGroup),
    timestamp: new Date().toISOString()
  });

  res.json(updatedGroup);
}));

// 置顶/取消置顶群组
router.put('/groups/:id/pin', validateBody(pinGroupSchema), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;
  const { pinned } = req.body;

  let updatedGroup = null;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const group = db.data.groups.find(g => g.id === id);
    if (!group) {
      const notFound = new Error('Group not found');
      notFound.status = 404;
      throw notFound;
    }
    group.pinned = pinned !== undefined ? pinned : !group.pinned;
    updatedGroup = { ...group };
    await db.write();
  });

  res.json(updatedGroup);
}));

// 添加AI成员到群聊
router.post('/groups/:id/members', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;
  const { aiId } = req.body || {};

  if (!aiId || typeof aiId !== 'string' || !res.locals.validModelIds.has(aiId)) {
    return res.status(400).json({ error: 'aiId 无效或不在允许的AI列表中' });
  }

  let result = null;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const group = db.data.groups.find(g => g.id === id);
    if (!group) {
      const notFound = new Error('Group not found');
      notFound.status = 404;
      throw notFound;
    }
    if (group.is_private) {
      const bad = new Error('不能向私聊添加成员');
      bad.status = 400;
      throw bad;
    }
    if (group.ai_members && group.ai_members.includes(aiId)) {
      const dup = new Error('该AI已在群聊中');
      dup.status = 400;
      throw dup;
    }
    if (!group.ai_members) {
      group.ai_members = [];
    }
    group.ai_members.push(aiId);

    const messageId = uuidv4();
    const systemMessage = {
      id: messageId,
      group_id: id,
      sender_type: 'system',
      sender_id: 'system',
      content: `邀请了 ${res.locals.modelNames[aiId] || aiId} 加入群聊`,
      content_type: 'text',
      metadata: { type: 'member_joined', newMember: aiId },
      created_at: new Date().toISOString()
    };

    db.data.messages.push(systemMessage);
    updateGroupActivity(group, systemMessage);
    await db.write();
    result = { group: sanitizeGroupForClient(group), systemMessage };
  });

  broadcastToGroup(id, {
    type: 'system_message',
    group_id: id,
    content: result.systemMessage.content,
    timestamp: result.systemMessage.created_at,
    metadata: result.systemMessage.metadata
  });

  res.json({
    success: true,
    group: result.group,
    systemMessage: result.systemMessage
  });
}));

// 获取或创建私聊群组
router.post('/private-chat/:aiId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { aiId } = req.params;

  if (!res.locals.validModelIds.has(aiId)) {
    return res.status(400).json({ error: 'aiId 无效或不在允许的AI列表中' });
  }

  let privateChat = null;
  let created = false;
  await withWriteLock(req.userId, async () => {
    await db.read();
    privateChat = db.data.groups.find(g =>
      g.is_private === true &&
      g.ai_members &&
      g.ai_members.length === 1 &&
      g.ai_members[0] === aiId
    );

    if (!privateChat) {
      const groupId = uuidv4();
      privateChat = {
        id: groupId,
        name: res.locals.modelNames[aiId] || aiId,
        description: `与 ${res.locals.modelNames[aiId] || aiId} 的私聊`,
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
      await db.write();
      created = true;
    }
  });

  if (!privateChat) {
    return res.status(500).json({ error: '私聊创建失败' });
  }

  res.status(created ? 201 : 200).json(sanitizeGroupForClient(privateChat));
}));

router.delete('/groups/:id', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;

  // 删除前先停掉该群所有后台引擎，防止僵尸定时器继续向已删群写消息
  try {
    const { stopAutonomousChatTimer, cancelGroupGeneration, stopAIPrivateChat } = await import('../services/scheduler/index.js');
    const { stopFormalDebate } = await import('../services/debate/index.js');
    stopAutonomousChatTimer(id);
    cancelGroupGeneration(id);
    try { stopAIPrivateChat(id); } catch {}
    try { stopFormalDebate(id); } catch {}
  } catch (err) {
    safeLog('warn', '停止群组后台任务失败（继续删除）', { groupId: id, error: err?.message });
  }

  let deletedMessageCount = 0;
  let filesToDelete = [];

  await withWriteLock(req.userId, async () => {
    await db.read();
    const groupIndex = db.data.groups.findIndex(g => g.id === id);
    if (groupIndex === -1) {
      const notFound = new Error('Group not found');
      notFound.status = 404;
      throw notFound;
    }

    const previous = {
      messages: db.data.messages, files: db.data.files, groups: [...db.data.groups],
      ttsAudioFiles: db.data.ttsAudioFiles, ttsPendingDeletes: db.data.ttsPendingDeletes,
      memoryRecords: db.data.memoryRecords
    };
    const initialMessageCount = db.data.messages.length;
    const deletedMessageIds = db.data.messages.filter(m => m.group_id === id).map(m => m.id);
    await markGroupDeleted(req.userId, db, id);
    revokeTtsForMessages(db.data, deletedMessageIds);
    db.data.messages = db.data.messages.filter(m => m.group_id !== id);
    revokeMessageMemories(db.data, id);
    deletedMessageCount = initialMessageCount - db.data.messages.length;
    filesToDelete = (db.data.files || []).filter(file => file.group_id === id);
    db.data.files = (db.data.files || []).filter(file => file.group_id !== id);

    db.data.groups.splice(groupIndex, 1);
    try { await db.write(); }
    catch (error) { Object.assign(db.data, previous); throw sourceMutationUncertain(req.userId, error); }
  });

  const audioDeletionPending = await drainTtsPendingDeletes(req.userId).catch(error => {
    safeLog('warn', '删除群组音频待恢复', { userId: req.userId, error: error?.message });
    return 1;
  });

  // 磁盘清理放在锁外异步执行，失败不影响删除结果
  const uploadsRoot = path.resolve(getUploadsDir());
  for (const file of filesToDelete) {
    const ownerId = file.owner_user_id || file.uploader_id || req.userId;
    const storedFilename = path.basename(file.stored_filename || file.original_path || '');
    if (!ownerId || !storedFilename) continue;
    const safeFilePath = path.resolve(path.join(uploadsRoot, ownerId, storedFilename));
    const withSep = uploadsRoot.endsWith(path.sep) ? uploadsRoot : uploadsRoot + path.sep;
    if (safeFilePath.startsWith(withSep)) {
      fsPromises.unlink(safeFilePath).catch(() => {});
    }
  }

  safeLog('info', '删除群聊', { groupId: id, deletedMessageCount });

  res.json({
    success: true,
    audioDeletionPending: audioDeletionPending > 0,
    deleted_messages: deletedMessageCount
  });
}));

router.delete('/groups/:id/members/:aiId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id, aiId } = req.params;

  let result = null;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const group = db.data.groups.find(g => g.id === id);
    if (!group) {
      const notFound = new Error('Group not found');
      notFound.status = 404;
      throw notFound;
    }
    if (group.is_private) {
      const bad = new Error('不能从私聊中移除成员');
      bad.status = 400;
      throw bad;
    }
    if (!group.ai_members || !group.ai_members.includes(aiId)) {
      const bad = new Error('该AI不在群聊中');
      bad.status = 400;
      throw bad;
    }
    if (group.ai_members.length <= 2) {
      const bad = new Error('群聊至少需要保留2个AI成员');
      bad.status = 400;
      throw bad;
    }

    group.ai_members = group.ai_members.filter(member => member !== aiId);

    const messageId = uuidv4();
    const systemMessage = {
      id: messageId,
      group_id: id,
      sender_type: 'system',
      sender_id: 'system',
      content: `${res.locals.modelNames[aiId] || aiId} 已被移出群聊`,
      content_type: 'text',
      metadata: { type: 'member_removed', removedMember: aiId },
      created_at: new Date().toISOString()
    };

    db.data.messages.push(systemMessage);
    updateGroupActivity(group, systemMessage);
    await db.write();
    result = { group: sanitizeGroupForClient(group), systemMessage };
  });

  broadcastToGroup(id, {
    type: 'system_message',
    group_id: id,
    content: result.systemMessage.content,
    timestamp: result.systemMessage.created_at,
    metadata: result.systemMessage.metadata
  });

  broadcastToGroup(id, {
    type: 'member_removed',
    group_id: id,
    aiId: aiId,
    timestamp: new Date().toISOString()
  });

  res.json({
    success: true,
    group: result.group,
    systemMessage: result.systemMessage
  });
}));

router.post('/ai-private-chat', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { aiMembers, topic, customName } = req.body || {};

  if (!aiMembers || !Array.isArray(aiMembers) || aiMembers.length < 2) {
    return res.status(400).json({ error: '至少需要选择2个AI成员' });
  }

  if (aiMembers.length > 5) {
    return res.status(400).json({ error: '最多支持5个AI成员' });
  }

  for (const aiId of aiMembers) {
    if (!res.locals.validModelIds.has(aiId)) {
      return res.status(400).json({ error: `无效的AI成员: ${String(aiId).slice(0, 64)}` });
    }
  }

  if (topic !== undefined && (typeof topic !== 'string' || topic.trim().length > 200)) {
    return res.status(400).json({ error: 'topic 必须是不超过200字符的字符串' });
  }
  if (customName !== undefined && (typeof customName !== 'string' || customName.trim().length > 50)) {
    return res.status(400).json({ error: 'customName 必须是不超过50字符的字符串' });
  }

  const uniqueMembers = [...new Set(aiMembers)];
  if (uniqueMembers.length !== aiMembers.length) {
    return res.status(400).json({ error: 'AI成员不能重复' });
  }

  let resultChat = null;
  let created = false;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const sortedIds = [...uniqueMembers].sort();
    const existingChat = db.data.groups.find(g =>
      g.type === 'ai_private' &&
      g.ai_members &&
      g.ai_members.length === sortedIds.length &&
      sortedIds.every(id => g.ai_members.includes(id))
    );

    if (existingChat) {
      resultChat = existingChat;
      return;
    }

    const groupId = uuidv4();

    let chatName;
    if (customName && customName.trim()) {
      chatName = customName.trim().slice(0, 50);
    } else {
      const shortNames = sortedIds.map(id => res.locals.modelNames[id] || id);
      chatName = shortNames.join(' & ');
    }

    const newChat = {
      id: groupId,
      name: chatName,
      description: topic ? `话题: ${topic.trim().slice(0, 200)}` : 'AI私聊（只读）',
      type: 'ai_private',
      is_private: true,
      is_ai_private: true,
      pinned: true,
      debate_mode: false,
      debate_level: 1,
      ai_members: sortedIds,
      topic: topic ? topic.trim().slice(0, 200) : null,
      is_active: false,
      created_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      last_message_preview: null
    };

    db.data.groups.push(newChat);
    await db.write();
    resultChat = newChat;
    created = true;
  });

  res.status(created ? 201 : 200).json(sanitizeGroupForClient(resultChat));
}));

router.get('/ai-private-chats', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await db.read();
    const aiPrivateChats = (await readableSourceGroups(req.userId, db))
      .filter(g => g.type === 'ai_private' || g.is_ai_private);
    return res.json(sanitizeGroupsForClient(aiPrivateChats));
  });
}));

router.delete('/ai-private-chats/:id', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;

  // 删除前停止该群的后台引擎
  try {
    const { stopAutonomousChatTimer, cancelGroupGeneration, stopAIPrivateChat } = await import('../services/scheduler/index.js');
    stopAutonomousChatTimer(id);
    cancelGroupGeneration(id);
    try { stopAIPrivateChat(id); } catch {}
  } catch (err) {
    safeLog('warn', '停止AI私聊后台任务失败（继续删除）', { groupId: id, error: err?.message });
  }

  let deletedMessageCount = 0;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const groupIndex = db.data.groups.findIndex(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
    if (groupIndex === -1) {
      const notFound = new Error('AI私聊不存在');
      notFound.status = 404;
      throw notFound;
    }

    const previous = {
      messages: db.data.messages, groups: [...db.data.groups],
      ttsAudioFiles: db.data.ttsAudioFiles, ttsPendingDeletes: db.data.ttsPendingDeletes,
      memoryRecords: db.data.memoryRecords
    };
    const initialMessageCount = db.data.messages.length;
    const deletedMessageIds = db.data.messages.filter(m => m.group_id === id).map(m => m.id);
    await markGroupDeleted(req.userId, db, id);
    revokeTtsForMessages(db.data, deletedMessageIds);
    db.data.messages = db.data.messages.filter(m => m.group_id !== id);
    revokeMessageMemories(db.data, id);
    deletedMessageCount = initialMessageCount - db.data.messages.length;

    db.data.groups.splice(groupIndex, 1);
    try { await db.write(); }
    catch (error) { Object.assign(db.data, previous); throw sourceMutationUncertain(req.userId, error); }
  });

  const audioDeletionPending = await drainTtsPendingDeletes(req.userId).catch(error => {
    safeLog('warn', '删除AI私聊音频待恢复', { userId: req.userId, error: error?.message });
    return 1;
  });

  safeLog('info', '删除AI私聊', { groupId: id, deletedMessageCount });

  res.json({
    success: true,
    audioDeletionPending: audioDeletionPending > 0,
    deleted_messages: deletedMessageCount
  });
}));

router.post('/ai-private-chats/:id/start', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const topic = req.body?.topic;

  const group = db.data.groups.find(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
  if (!group) {
    return res.status(404).json({ error: 'AI私聊不存在' });
  }

  if (topic !== undefined && (typeof topic !== 'string' || topic.trim().length === 0 || topic.trim().length > 200)) {
    return res.status(400).json({ error: 'topic 必须是1-200字符的字符串' });
  }

  if (topic) {
    group.topic = topic.trim().slice(0, 200);
    await withWriteLock(req.userId, async () => {
      await db.write();
    });
  }

  const { startAIPrivateChat, getChatStatus } = await import('../services/scheduler/index.js');

  const currentStatus = getChatStatus(id);
  if (currentStatus.isRunning) {
    return res.json({ groupId: id, status: 'already_active' });
  }

  startAIPrivateChat(id, (topic ? topic.trim().slice(0, 200) : null)).catch(error => {
    safeLog('error', 'AI私聊后台运行错误', { error: error?.message || error });
  });

  res.json({
    groupId: id,
    status: 'started',
    message: 'AI私聊已在后台启动'
  });
}));

router.get('/ai-private-chats/:id/status', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;

  // 归属校验：只有该群的拥有者才能查询其引擎状态
  const group = db.data.groups.find(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
  if (!group) {
    return res.status(404).json({ error: 'AI私聊不存在' });
  }

  const { getChatStatus } = await import('../services/scheduler/index.js');
  const status = getChatStatus(id);
  res.json(status);
}));

router.post('/ai-private-chats/:id/continue', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;

  const group = db.data.groups.find(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
  if (!group) {
    return res.status(404).json({ error: 'AI私聊不存在' });
  }

  const { continueAIPrivateChat, getChatStatus } = await import('../services/scheduler/index.js');

  const currentStatus = getChatStatus(id);
  if (currentStatus.isRunning) {
    return res.json({ groupId: id, status: 'already_active' });
  }

  continueAIPrivateChat(id).catch(error => {
    safeLog('error', 'AI私聊继续运行错误', { error: error?.message || error });
  });

  res.json({
    groupId: id,
    status: 'started',
    message: 'AI私聊已在后台继续'
  });
}));

router.post('/ai-private-chats/:id/stop', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;

  // 归属校验
  const group = db.data.groups.find(g => g.id === id && (g.type === 'ai_private' || g.is_ai_private));
  if (!group) {
    return res.status(404).json({ error: 'AI私聊不存在' });
  }

  const { stopAIPrivateChat } = await import('../services/scheduler/index.js');
  const result = stopAIPrivateChat(id);
  res.json(result);
}));

router.post('/groups/:id/formal-debate/start', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { topic, rolePreferences, debateLevel, selectedParticipants } = req.body || {};

  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    return res.status(400).json({ error: '辩题不能为空' });
  }
  if (topic.trim().length > 500) {
    return res.status(400).json({ error: '辩题长度不能超过500字符' });
  }
  if (rolePreferences !== undefined && (typeof rolePreferences !== 'object' || rolePreferences === null || Array.isArray(rolePreferences))) {
    return res.status(400).json({ error: 'rolePreferences 必须是对象' });
  }
  if (debateLevel !== undefined && (!Number.isInteger(debateLevel) || debateLevel < 1 || debateLevel > 3)) {
    return res.status(400).json({ error: 'debateLevel 必须是 1-3 的整数' });
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
      return res.status(400).json({ error: `无效的参与者: ${invalidParticipants.map(String).join(', ').slice(0, 200)}` });
    }
    if (selectedParticipants.length < 2) {
      return res.status(400).json({ error: '至少需要选择2个AI参与辩论' });
    }
  }

  const { startFormalDebate, getDebateStatus } = await import('../services/debate/index.js');

  const currentStatus = getDebateStatus(id);
  if (currentStatus.isRunning) {
    return res.status(409).json({ error: '辩论已在进行中', status: currentStatus });
  }

  startFormalDebate(id, topic.trim().slice(0, 500), rolePreferences || {}, debateLevel || 2, selectedParticipants || null).catch(error => {
    safeLog('error', '正规辩论后台运行错误', { error: error?.message || error });
  });

  res.json({
    groupId: id,
    status: 'started',
    message: '正规辩论已在后台启动',
    topic: topic.trim().slice(0, 500),
    selectedParticipants: selectedParticipants || null
  });
}));

router.post('/groups/:id/formal-debate/stop', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;

  // 归属校验
  const group = db.data.groups.find(g => g.id === id);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }

  const { stopFormalDebate } = await import('../services/debate/index.js');
  const result = stopFormalDebate(id);

  if (result.success) {
    res.json(result);
  } else {
    res.status(404).json(result);
  }
}));

router.get('/groups/:id/formal-debate/status', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;

  // 归属校验
  const group = db.data.groups.find(g => g.id === id);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }

  const { getDebateStatus } = await import('../services/debate/index.js');
  const status = getDebateStatus(id);
  res.json(status);
}));

router.post('/groups/:id/formal-debate/allocate-roles', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { rolePreferences, selectedParticipants } = req.body || {};

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
      return res.status(400).json({ error: `无效的参与者: ${invalidParticipants.map(String).join(', ').slice(0, 200)}` });
    }
    if (selectedParticipants.length < 2) {
      return res.status(400).json({ error: '至少需要选择2个AI参与辩论' });
    }
  }

  const { allocateDebateRoles } = await import('../services/debate/index.js');
  const roles = allocateDebateRoles(group.ai_members, rolePreferences || {}, selectedParticipants || null);

  const formattedRoles = {
    proponents: roles.proponents.map(id => ({ id, name: res.locals.modelNames[id] || id })),
    opponents: roles.opponents.map(id => ({ id, name: res.locals.modelNames[id] || id })),
    judge: roles.judge ? { id: roles.judge, name: aiNames[roles.judge] || roles.judge } : null,
    audience: roles.audience.map(id => ({ id, name: res.locals.modelNames[id] || id })),
    hasJudge: roles.hasJudge,
    hasAudience: roles.hasAudience
  };

  res.json({
    success: true,
    roles: formattedRoles,
    totalMembers: group.ai_members.length,
    debateParticipants: selectedParticipants ? selectedParticipants.length : group.ai_members.length
  });
}));

router.post('/groups/:id/formal-debate/audience-comment', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const { id } = req.params;
  const { audienceMembers } = req.body || {};

  const group = db.data.groups.find(g => g.id === id);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }

  if (!audienceMembers || !Array.isArray(audienceMembers) || audienceMembers.length === 0) {
    return res.status(400).json({ error: '需要指定观众成员' });
  }

  const invalidAudience = audienceMembers.filter(p => !group.ai_members.includes(p));
  if (invalidAudience.length > 0) {
    return res.status(400).json({ error: `无效的观众成员: ${invalidAudience.map(String).join(', ').slice(0, 200)}` });
  }

  const { triggerAudienceComment } = await import('../services/debate/index.js');
  const result = await triggerAudienceComment(id, audienceMembers);
  res.json(result);
}));

router.put('/groups/:id/settings', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const { id } = req.params;
  const sanitizedBody = sanitizeObject(req.body, GROUP_SANITIZE_CONFIG);
  const { name, avatar_url, avatar_color, background_url, announcement, notifications_enabled, autonomous_chat_enabled, pinned, ...restSettings } = sanitizedBody;

  let updatedGroup = null;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const group = db.data.groups.find(g => g.id === id);
    if (!group) {
      const notFound = new Error('群组不存在');
      notFound.status = 404;
      throw notFound;
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
        const bad = new Error('群组名称必须是1-100字符');
        bad.status = 400;
        throw bad;
      }
      group.name = name.trim();
    }
    if (avatar_url !== undefined) {
      group.avatar_url = avatar_url;
    }
    if (avatar_color !== undefined) {
      group.avatar_color = avatar_color;
    }
    if (background_url !== undefined) {
      // 仅接受本站背景图 URL 形态，拒绝任意字符串注入
      if (background_url === null || background_url === '') {
        group.background_url = null;
        group.background_storage_key = null;
      } else if (typeof background_url === 'string' && new RegExp(`^/api/groups/${encodeURIComponent(id)}/background$`).test(background_url)) {
        group.background_url = background_url;
      } else {
        const bad = new Error('background_url 仅允许本站 /api/groups/:id/background 形态或置空');
        bad.status = 400;
        throw bad;
      }
    }
    if (announcement !== undefined) {
      if (typeof announcement !== 'string' || announcement.length > 2000) {
        const bad = new Error('公告必须是不超过2000字符的字符串');
        bad.status = 400;
        throw bad;
      }
      group.announcement = announcement;
    }
    if (notifications_enabled !== undefined) {
      group.notifications_enabled = Boolean(notifications_enabled);
    }
    if (autonomous_chat_enabled !== undefined) {
      if (typeof autonomous_chat_enabled !== 'boolean') {
        const bad = new Error('主动聊天开关必须是布尔值');
        bad.status = 400;
        throw bad;
      }
      group.autonomous_chat_enabled = autonomous_chat_enabled;
      if (!autonomous_chat_enabled) stopAutonomousChatTimer(id);
      else if (group.ai_members?.length > 1) startAutonomousChatTimer(id);
    }
    if (pinned !== undefined) {
      group.pinned = Boolean(pinned);
    }

    const allowedSettings = ['description', 'debate_mode', 'debate_level', 'debate_config'];
    for (const key of allowedSettings) {
      if (key in restSettings && restSettings[key] !== undefined) {
        if (key === 'debate_config' && typeof restSettings[key] === 'object' && restSettings[key] !== null) {
          const allowedNested = ['mode', 'topic', 'roles', 'max_rounds', 'time_limit'];
          group.debate_config = group.debate_config || {};
          for (const nk of allowedNested) {
            if (nk in restSettings[key]) {
              group.debate_config[nk] = restSettings[key][nk];
            }
          }
        } else if (key !== 'debate_config') {
          group[key] = restSettings[key];
        }
      }
    }

    updatedGroup = sanitizeGroupForClient(group);
    await db.write();
  });

  if (autonomous_chat_enabled === false) stopAutomaticGroupConversation(id);

  broadcastToGroup(id, {
    type: 'group_update',
    group_id: id,
    group: updatedGroup,
    timestamp: new Date().toISOString()
  });

  res.json({ success: true, group: updatedGroup });
}));

router.get('/groups/:id/files', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
  await db.read();
  const group = (await readableSourceGroups(req.userId, db)).find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: '群组不存在' });
  const files = (await readableSourceFiles(req.userId, db))
    .filter(f => f.group_id === req.params.id &&
      (!f.owner_user_id || f.owner_user_id === req.userId) &&
      (!f.uploader_id || f.uploader_id === req.userId))
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
  res.set('Cache-Control', 'no-store').json({ success: true, files });
  });
}));

router.post('/groups/:id/files', asyncHandler(async (req, res) => {
  res.status(400).json({ success: false, error: '请使用 /api/files/upload 上传群文件' });
}));

router.delete('/groups/:id/files/:fileId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();

  let fileRecord = null;
  await withWriteLock(req.userId, async () => {
    await db.read();
    const group = (await readableSourceGroups(req.userId, db)).find(g => g.id === req.params.id);
    if (!group) {
      const notFound = new Error('群组不存在');
      notFound.status = 404;
      throw notFound;
    }
    const fileIndex = (db.data.files || []).findIndex(f => f.id === req.params.fileId && f.group_id === req.params.id);
    if (fileIndex === -1) {
      const notFound = new Error('文件不存在');
      notFound.status = 404;
      throw notFound;
    }
    fileRecord = db.data.files[fileIndex];
    if ((fileRecord.owner_user_id && fileRecord.owner_user_id !== req.userId) ||
        (fileRecord.uploader_id && fileRecord.uploader_id !== req.userId)) {
      return res.status(403).json({ error: '禁止删除其他账号的文件' });
    }
    if (!(await readableSourceFiles(req.userId, db, [fileRecord])).length) {
      return res.status(404).json({ error: '文件不存在' });
    }
    await markFileDeleted(req.userId, db, req.params.id, req.params.fileId);
    const previousFiles = db.data.files;
    db.data.files = previousFiles.filter((_, index) => index !== fileIndex);
    try { await db.write(); }
    catch (error) { db.data.files = previousFiles; throw sourceMutationUncertain(req.userId, error); }
  });

  if (res.headersSent) return;

  // 磁盘清理在锁外异步执行
  const ownerId = fileRecord?.owner_user_id || fileRecord?.uploader_id || req.userId;
  const storedFilename = path.basename(fileRecord?.stored_filename || fileRecord?.original_path || '');
  if (ownerId && storedFilename) {
    const uploadsRoot = path.resolve(getUploadsDir());
    const safeFilePath = path.resolve(path.join(uploadsRoot, ownerId, storedFilename));
    const withSep = uploadsRoot.endsWith(path.sep) ? uploadsRoot : uploadsRoot + path.sep;
    if (safeFilePath.startsWith(withSep)) {
      fsPromises.unlink(safeFilePath).catch(() => {});
    }
  }
  res.json({ success: true });
}));

/**
 * 群聊洞察中心：聚合发言分布、活跃度、社交互动、情感趋势
 * GET /api/groups/:id/insights?days=7
 * 每次从当前可读来源计算，避免删除后短时缓存回显旧聚合。
 */
router.get('/groups/:id/insights', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
  await db.read();
  const { id } = req.params;
  const group = (await readableSourceGroups(req.userId, db)).find(g => g.id === id);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }

  const daysRaw = parseInt(String(req.query.days ?? ''), 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 30) : 7;

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const groupMessages = (await readableSourceMessages(req.userId, db)).filter(m =>
    m.group_id === id && new Date(m.created_at).getTime() >= sinceMs
  );
  const visibleMessageIds = new Set(groupMessages.map(message => message.id));

  const perAi = new Map();
  let userCount = 0;
  let systemCount = 0;
  let likesTotal = 0;
  let dislikesTotal = 0;
  let commentsTotal = 0;
  const dailyBuckets = new Map();

  for (const msg of groupMessages) {
    if (msg.sender_type === 'ai') {
      const entry = perAi.get(msg.sender_id) || { ai_id: msg.sender_id, name: res.locals.modelNames[msg.sender_id] || msg.sender_id, count: 0, last_active: null };
      entry.count += 1;
      if (!entry.last_active || msg.created_at > entry.last_active) entry.last_active = msg.created_at;
      perAi.set(msg.sender_id, entry);
    } else if (msg.sender_type === 'user') {
      userCount += 1;
    } else {
      systemCount += 1;
    }

    likesTotal += Array.isArray(msg.liked_by) ? msg.liked_by.length : 0;
    dislikesTotal += Array.isArray(msg.disliked_by) ? msg.disliked_by.length : 0;
    commentsTotal += Array.isArray(msg.comments) ? msg.comments.length : 0;

    const day = String(msg.created_at).slice(0, 10);
    dailyBuckets.set(day, (dailyBuckets.get(day) || 0) + 1);
  }

  const activityDaily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    activityDaily.push({ date: d, count: dailyBuckets.get(d) || 0 });
  }

  // 情感趋势（来自互动日志的情感分析，按日聚合均值）
  let sentimentTrend = [];
  try {
    const logs = db.data.interaction_logs || [];
    const sentimentByDay = new Map();
    for (const log of logs) {
      const score = log?.metadata?.sentiment?.score;
      if (typeof score !== 'number') continue;
      if (log.system_info?.group_id !== id) continue;
      const sourceId = log?.metadata?.message_id ||
        (log?.target?.type === 'message' ? log.target.id : null);
      if (!sourceId || !visibleMessageIds.has(sourceId)) continue;
      const ts = new Date(log.timestamp).getTime();
      if (ts < sinceMs) continue;
      const day = String(log.timestamp).slice(0, 10);
      const bucket = sentimentByDay.get(day) || { sum: 0, n: 0 };
      bucket.sum += score;
      bucket.n += 1;
      sentimentByDay.set(day, bucket);
    }
    sentimentTrend = [...sentimentByDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, b]) => ({ date, avg_score: Number((b.sum / b.n).toFixed(3)), samples: b.n }));
  } catch (err) {
    safeLog('warn', '洞察情感趋势聚合失败（返回空趋势）', { groupId: id, error: err?.message });
  }

  const totalAi = [...perAi.values()].reduce((s, e) => s + e.count, 0);
  const perAiRanked = [...perAi.values()].sort((a, b) => b.count - a.count);

  const payload = {
    success: true,
    group_id: id,
    window_days: days,
    generated_at: new Date().toISOString(),
    totals: {
      messages: groupMessages.length,
      ai_messages: totalAi,
      user_messages: userCount,
      system_messages: systemCount,
      likes: likesTotal,
      dislikes: dislikesTotal,
      comments: commentsTotal,
      active_ais: perAi.size
    },
    per_ai: perAiRanked,
    activity_daily: activityDaily,
    sentiment_trend: sentimentTrend,
    participation_ratio: totalAi + userCount > 0
      ? Number((totalAi / (totalAi + userCount)).toFixed(3))
      : 0
  };

  return res.json(payload);
  });
}));

export default router;
