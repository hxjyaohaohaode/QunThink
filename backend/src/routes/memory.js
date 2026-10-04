import express from 'express';
import { validateBody, storeMemorySchema, retrieveMemorySchema } from '../validators/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  storeUserMemory, storeMessageMemories, listMemories, getMemory,
  retrieveMemories, retrieveForConversation, correctMemory, forgetMemory, forgetAllMemories
} from '../services/memory/persistentMemory.js';

const router = express.Router();
const fail = (code, statusCode, message) => {
  throw Object.assign(new Error(message), { code, statusCode, isOperational: true });
};
router.use((req, res, next) => {
  if (!req.userId || typeof req.getUserDb !== 'function') {
    return res.status(401).json({ success: false, error: '未登录' });
  }
  next();
});

// These legacy Map-backed features have no persisted source or valid metrics.
const unavailable = (_req, res) => res.status(501).json({
  success: false, code: 'MEMORY_FEATURE_NOT_PERSISTENT',
  error: '此项旧记忆能力尚未接入持久记忆与来源校验'
});
router.get('/memory/performance', unavailable);
router.get('/memory/config', unavailable);
router.put('/memory/config', unavailable);
router.post('/memory/auto-store-important', unavailable);

router.get('/memory/digest', asyncHandler(async (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Number.isSafeInteger(raw) && raw >= 1 ? Math.min(raw, 30) : 12;
  const groupId = req.query.groupId;
  if (groupId !== undefined && (typeof groupId !== 'string' || !groupId)) {
    fail('INVALID_GROUP', 400, '群组 ID 无效');
  }
  if (groupId) {
    const db = await req.getUserDb();
    await db.read();
    if (!db.data.groups?.some(group => group.id === groupId)) {
      fail('GROUP_NOT_FOUND', 404, '群组不存在或无权访问');
    }
  }
  const value = await listMemories(req.userId, { limit, includeContent: false, groupId });
  res.set('Cache-Control', 'no-store').json({
    success: true, total: value.total, memories: value.memories,
    generated_at: new Date().toISOString(), searchMode: 'persisted_visible_only'
  });
}));
router.get('/memory/stats', asyncHandler(async (req, res) => {
  const value = await listMemories(req.userId, { limit: 1 });
  res.set('Cache-Control', 'no-store').json({
    success: true, memoryCount: value.total, measured: false,
    storage: 'user_database', timestamp: new Date().toISOString()
  });
}));
router.post('/memory/store', validateBody(storeMemorySchema), asyncHandler(async (req, res) => {
  const key = req.get('Idempotency-Key');
  if (key !== undefined && (!key || key.length > 128)) {
    fail('INVALID_IDEMPOTENCY_KEY', 400, '请求号无效');
  }
  const result = await storeUserMemory(req.userId, { ...req.body, requestKey: key });
  // Preserve the established 200 response for existing Web clients.
  res.status(200).json({
    success: true, ...result, timestamp: new Date().toISOString()
  });
}));
router.post('/memory/store-messages', asyncHandler(async (req, res) => {
  const { messageIds, groupId } = req.body || {};
  if (typeof groupId !== 'string' || !groupId) {
    fail('INVALID_SOURCE', 400, '群组 ID 无效');
  }
  const result = await storeMessageMemories(req.userId, messageIds, groupId);
  res.status(201).json({ success: true, ...result, timestamp: new Date().toISOString() });
}));
router.post('/memory/retrieve', validateBody(retrieveMemorySchema), asyncHandler(async (req, res) => {
  const { query, category, senderId, dateRange, limit } = req.body;
  if (dateRange && (!/^\d{4}-\d{2}-\d{2}$/.test(dateRange.start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dateRange.end) ||
    dateRange.start > dateRange.end)) {
    fail('INVALID_DATE_RANGE', 400, '日期范围无效');
  }
  const result = await retrieveMemories(req.userId, query, { category, senderId, dateRange, limit });
  res.set('Cache-Control', 'no-store').json({
    success: true, ...result, timestamp: new Date().toISOString()
  });
}));
router.post('/memory/retrieve-for-conversation', asyncHandler(async (req, res) => {
  const { groupId, limit = 5 } = req.body || {};
  if (typeof groupId !== 'string' || !groupId ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    fail('INVALID_QUERY', 400, '群组或数量无效');
  }
  const result = await retrieveForConversation(req.userId, groupId, limit);
  res.set('Cache-Control', 'no-store').json({
    success: true, ...result, timestamp: new Date().toISOString()
  });
}));
router.post('/memory/reference', asyncHandler(async (req, res) => {
  const { memoryId, context } = req.body || {};
  if (typeof memoryId !== 'string' || !memoryId ||
    typeof context?.content !== 'string' || !context.content ||
    typeof context?.groupId !== 'string' || !context.groupId) {
    fail('INVALID_REFERENCE', 400, '记忆或上下文无效');
  }
  const db = await req.getUserDb();
  await db.read();
  if (!db.data.groups?.some(group => group.id === context.groupId)) {
    fail('GROUP_NOT_FOUND', 404, '群组不存在或无权访问');
  }
  const memory = await getMemory(req.userId, memoryId);
  if (memory.source?.groupId !== context.groupId) {
    fail('REFERENCE_SCOPE_DENIED', 403, '记忆未授权用于此群组');
  }
  res.set('Cache-Control', 'no-store').json({
    success: true, memoryId, memoryContent: memory.content,
    category: memory.category, evidence: memory.evidence,
    referenceAccuracy: null, measured: false
  });
}));
router.post('/memory/clear', requireAdmin, asyncHandler(async (req, res) => {
  if (req.body?.confirm !== 'CLEAR_ALL_MEMORIES') fail('CONFIRMATION_REQUIRED', 400, '需要确认操作');
  const result = await forgetAllMemories(req.userId);
  res.json({ success: true, ...result, timestamp: new Date().toISOString() });
}));
router.get('/memory', asyncHandler(async (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Number.isSafeInteger(raw) && raw >= 1 ? Math.min(raw, 100) : 30;
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    fail('INVALID_OFFSET', 400, '分页位置无效');
  }
  const result = await listMemories(req.userId, { limit, offset });
  res.set('Cache-Control', 'no-store').json({ success: true, ...result });
}));
router.get('/memory/:memoryId', asyncHandler(async (req, res) => {
  const memory = await getMemory(req.userId, req.params.memoryId);
  res.set('Cache-Control', 'no-store').json({ success: true, memory });
}));
router.post('/memory/:memoryId/correct', asyncHandler(async (req, res) => {
  const { content, expectedRevision } = req.body || {};
  const memory = await correctMemory(req.userId, req.params.memoryId, content, expectedRevision);
  res.json({ success: true, memory });
}));
router.post('/memory/:memoryId/forget', asyncHandler(async (req, res) => {
  const result = await forgetMemory(req.userId, req.params.memoryId);
  res.json({ success: true, ...result });
}));
export default router;
