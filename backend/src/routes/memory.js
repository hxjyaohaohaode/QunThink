/**
 * 长期记忆API路由
 * 处理记忆存储、检索、引用等功能
 */

import express from 'express';
import memoryService from '../services/memory/index.js';
import { validateBody, storeMemorySchema, retrieveMemorySchema } from '../validators/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

const ALLOWED_TIME_RANGES = {
  '1h': 1,
  '24h': 24,
  '7d': 168,
  '30d': 720
};

/**
 * 记忆回顾摘要
 * GET /api/memory/digest?limit=12
 * 按重要度×新鲜度加权返回Top记忆，供前端「TA记得什么」回顾卡展示
 */
router.get('/memory/digest', asyncHandler(async (req, res) => {
  const limitRaw = parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 30) : 12;
  const result = memoryService.getDigest(req.userId, limit);
  res.json(result);
}));

/**
 * 存储记忆
 * POST /api/memory/store
 * 存储单个记忆
 */
router.post('/memory/store', validateBody(storeMemorySchema), asyncHandler(async (req, res) => {
  const { content, category, metadata } = req.body;

  if (!content) {
    return res.status(400).json({ error: '记忆内容不能为空' });
  }

  const sender_id = req.userId;
  if (!sender_id) return res.status(401).json({ error: '未认证' });
  const sender_type = 'user';

  const memoryData = {
    content,
    sender_id,
    sender_type,
    category,
    metadata: metadata || {}
  };

  const result = memoryService.storeMemory(memoryData, req.userId);

  res.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 批量存储消息为记忆
 * POST /api/memory/store-messages
 * 将多条消息存储为记忆
 */
router.post('/memory/store-messages', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  const { messageIds, groupId, categories } = req.body;

  if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: '消息ID列表不能为空' });
  }

  const uniqueMessageIds = [...new Set(messageIds)];
  if (uniqueMessageIds.length > 100) {
    return res.status(400).json({ error: '消息ID列表不能超过100条' });
  }

  const messages = db.data.messages.filter(m =>
    uniqueMessageIds.includes(m.id) && (!groupId || m.group_id === groupId)
  );

  if (messages.length === 0) {
    return res.status(404).json({ error: '未找到指定的消息' });
  }

  const result = memoryService.storeMessagesBatch(messages, { categories }, req.userId);

  res.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 检索记忆
 * POST /api/memory/retrieve
 * 根据查询检索相关记忆
 */
router.post('/memory/retrieve', validateBody(retrieveMemorySchema), asyncHandler(async (req, res) => {
  const { query, category, senderId, dateRange, limit } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: '查询内容不能为空' });
  }

  const options = {};
  if (category) options.category = category;
  if (senderId) options.senderId = senderId;
  if (dateRange) {
    options.dateRange = {
      startDate: dateRange.start,
      endDate: dateRange.end
    };
  }
  if (limit) options.limit = parseInt(limit, 10);

  const result = memoryService.retrieveMemories(query, options, req.userId);

  res.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 检索对话相关记忆
 * POST /api/memory/retrieve-for-conversation
 * 根据对话历史检索相关记忆
 */
router.post('/memory/retrieve-for-conversation', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  const { groupId, limit = 5 } = req.body;

  if (!groupId) {
    return res.status(400).json({ error: '群组ID不能为空' });
  }

  // 获取群组的最新消息（最多50条）
  const groupMessages = db.data.messages
    .filter(m => m.group_id === groupId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50)
    .reverse();

  const result = memoryService.retrieveForConversation(groupMessages, limit, req.userId);

  res.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 引用记忆
 * POST /api/memory/reference
 * 在特定上下文中引用记忆
 */
router.post('/memory/reference', asyncHandler(async (req, res) => {
  const { memoryId, context, referenceType = 'direct' } = req.body;

  if (!memoryId) {
    return res.status(400).json({ error: '记忆ID不能为空' });
  }

  if (!context || !context.content) {
    return res.status(400).json({ error: '引用上下文不能为空' });
  }

  const result = memoryService.referenceMemory(memoryId, context, referenceType, req.userId);

  res.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 获取记忆统计
 * GET /api/memory/stats
 * 获取长期记忆系统的统计信息
 */
router.get('/memory/stats', asyncHandler(async (req, res) => {
  const result = memoryService.getStats(req.userId);

  res.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 获取性能检查结果
 * GET /api/memory/performance
 * 检查长期记忆系统是否满足性能要求
 */
router.get('/memory/performance', asyncHandler(async (req, res) => {
  const performanceCheck = memoryService.checkPerformance(req.userId);

  res.json({
    success: true,
    performance: performanceCheck,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 清空所有记忆
 * POST /api/memory/clear
 * 清空所有存储的记忆（仅用于测试）
 */
router.post('/memory/clear', requireAdmin, asyncHandler(async (req, res) => {
  const { confirm } = req.body;

  if (confirm !== 'CLEAR_ALL_MEMORIES') {
    return res.status(400).json({
      error: '需要确认操作，请提供正确的确认代码'
    });
  }

  const result = memoryService.clearAll(req.userId);

  res.json({
    success: true,
    ...result,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 获取记忆配置
 * GET /api/memory/config
 * 获取长期记忆系统的当前配置
 */
router.get('/memory/config', asyncHandler(async (req, res) => {
  const config = memoryService.getConfig(req.userId);

  res.json({
    success: true,
    config,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 更新记忆配置
 * PUT /api/memory/config
 * 更新长期记忆系统的配置
 */
router.put('/memory/config', asyncHandler(async (req, res) => {
  const { config } = req.body;

  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: '配置参数不能为空' });
  }

  // 验证配置参数
  const validConfig = {};

  if (config.maxRetrievalTime !== undefined) {
    if (typeof config.maxRetrievalTime !== 'number' || config.maxRetrievalTime < 100 || config.maxRetrievalTime > 5000) {
      return res.status(400).json({ error: '最大检索时间必须在100-5000ms之间' });
    }
    validConfig.maxRetrievalTime = config.maxRetrievalTime;
  }

  if (config.minAccuracy !== undefined) {
    if (typeof config.minAccuracy !== 'number' || config.minAccuracy < 0 || config.minAccuracy > 1) {
      return res.status(400).json({ error: '最小准确率必须在0-1之间' });
    }
    validConfig.minAccuracy = config.minAccuracy;
  }

  if (config.minReferenceAccuracy !== undefined) {
    if (typeof config.minReferenceAccuracy !== 'number' || config.minReferenceAccuracy < 0 || config.minReferenceAccuracy > 1) {
      return res.status(400).json({ error: '最小引用准确率必须在0-1之间' });
    }
    validConfig.minReferenceAccuracy = config.minReferenceAccuracy;
  }

  if (config.maxMemories !== undefined) {
    if (typeof config.maxMemories !== 'number' || config.maxMemories < 100 || config.maxMemories > 100000) {
      return res.status(400).json({ error: '最大记忆数量必须在100-100000之间' });
    }
    validConfig.maxMemories = config.maxMemories;
  }

  if (config.vectorSearchThreshold !== undefined) {
    if (typeof config.vectorSearchThreshold !== 'number' || config.vectorSearchThreshold < 0 || config.vectorSearchThreshold > 1) {
      return res.status(400).json({ error: '向量搜索阈值必须在0-1之间' });
    }
    validConfig.vectorSearchThreshold = config.vectorSearchThreshold;
  }

  // 更新配置
  const updateResult = memoryService.updateConfig(validConfig, req.userId);

  res.json({
    success: true,
    message: '配置更新成功',
    ...updateResult,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 自动存储重要消息为记忆
 * POST /api/memory/auto-store-important
 * 自动检测并存储重要的消息为记忆
 */
router.post('/memory/auto-store-important', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  const { groupId, timeRange, threshold } = req.body;

  if (!groupId) {
    return res.status(400).json({ error: '群组ID不能为空' });
  }

  const safeThreshold = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
    ? threshold
    : 0.9;
  const safeTimeRange = Object.prototype.hasOwnProperty.call(ALLOWED_TIME_RANGES, timeRange)
    ? timeRange
    : '24h';
  const cutoffTime = new Date(Date.now() - ALLOWED_TIME_RANGES[safeTimeRange] * 60 * 60 * 1000);

  const groupMessages = db.data.messages.filter(m =>
    m.group_id === groupId && new Date(m.created_at) > cutoffTime
  );

  if (groupMessages.length === 0) {
    return res.json({
      success: true,
      message: '没有找到符合条件的消息',
      storedCount: 0,
      totalMessages: 0,
      timestamp: new Date().toISOString()
    });
  }

  // 使用智能点赞引擎评估消息重要性
  // 注意：这里简化实现，实际应该使用更复杂的评估逻辑
  const importantMessages = [];

  for (const message of groupMessages) {
    // 简单的重要性判断：长消息、有附件、高点赞数等
    let importanceScore = 0;

    if (message.content && message.content.length > 100) importanceScore += 0.3;
    if (message.attachments && message.attachments.length > 0) importanceScore += 0.3;
    if (message.likes && message.likes > 0) importanceScore += 0.2;
    if (message.comments && message.comments.length > 0) importanceScore += 0.2;

    if (importanceScore >= safeThreshold) {
      importantMessages.push(message);
    }
  }

  // 存储重要消息为记忆
  let storeResult = null;
  if (importantMessages.length > 0) {
    storeResult = memoryService.storeMessagesBatch(importantMessages, {
      categories: ['factual', 'emotional', 'relational']
    }, req.userId);
  }

  res.json({
    success: true,
    totalMessages: groupMessages.length,
    importantMessages: importantMessages.length,
    storeResult,
    timestamp: new Date().toISOString()
  });
}));

export default router;
