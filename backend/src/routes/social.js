/**
 * 社交互动API路由
 * 处理智能点赞、社交分析等功能
 */

import express from 'express';
import { withWriteLock, clearUserDbCache } from '../models/db.js';
import socialService from '../services/social/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody, smartLikeSchema, autoLikeSchema } from '../validators/index.js';
import { sanitizeObject, COMMENT_SANITIZE_CONFIG } from '../utils/sanitize.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { decryptText } from '../utils/encryption.js';
import { readableSourceMessages } from '../services/memory/persistentMemory.js';

const router = express.Router();
const DEFAULT_SMART_LIKE_CONFIG = Object.freeze({ ...socialService.smartLike.config });

function toPublicMessageDetail(message) {
  if (!message) return null;
  let content = message.content;
  if (message.metadata?.encryption?.encrypted && typeof content === 'string') {
    try {
      content = decryptText(content);
    } catch {
      throw createError('消息内容无法解密', 503, 'MESSAGE_DECRYPT_UNAVAILABLE');
    }
  }
  return {
    id: message.id,
    sender_type: message.sender_type,
    sender_id: message.sender_id,
    content,
    created_at: message.created_at
  };
}

// Keep the source ledger check, any subsequent content use, and mutation in
// one account critical section. A restored user JSON must not revive content
// after its independent deletion ledger has recorded a source revocation.
async function withReadableMessages(req, reader) {
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await db.read();
    const readable = await readableSourceMessages(req.userId, db);
    const groupIds = new Set((db.data.groups || []).map(group => group.id));
    return reader(db, readable.filter(message => groupIds.has(message.group_id)));
  });
}

function analyticsSnapshot(messages) {
  const ordered = [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const latestByGroup = new Map();
  return ordered.map(message => {
    const plain = toPublicMessageDetail(message);
    const recent = latestByGroup.get(message.group_id);
    const current = { ...message, content: plain.content,
      likes: Array.isArray(message.likes) ? message.likes.length :
        (Array.isArray(message.liked_by) ? message.liked_by.length : Number(message.likes) || 0) };
    const metrics = socialService.analyzer.calculateSocialMetrics(current,
      { recentMessages: recent ? [recent] : [] });
    latestByGroup.set(message.group_id, current);
    return { message, plain, metrics };
  });
}

function withinRange(message, timeRange) {
  if (timeRange === 'all') return true;
  const hours = { '1h': 1, '24h': 24, '7d': 168 }[timeRange];
  const created = new Date(message.created_at).getTime();
  return Number.isFinite(created) && created > Date.now() - hours * 3600000;
}

function smartLikeConfig(db) {
  return { ...DEFAULT_SMART_LIKE_CONFIG, ...(db.data.socialSmartLikeConfig || {}) };
}

function evaluateLike(db, message, contextMessages) {
  // The legacy engine keeps a process-wide evaluation history, including
  // sender IDs shared by preset AI accounts. Use a fresh evaluator and the
  // account's own config so another account cannot influence this decision.
  const engine = new socialService.smartLike.constructor();
  engine.config = smartLikeConfig(db);
  const plain = { ...message, content: toPublicMessageDetail(message).content };
  const context = contextMessages.map(item => ({ ...item,
    content: toPublicMessageDetail(item).content }));
  return engine.evaluateMessage(plain, context,
    { type: message.sender_type, id: message.sender_id });
}

function findCommentPath(comments, targetId, path = []) {
  for (const comment of comments) {
    if (comment.id === targetId) return [...path, comment];
    const found = findCommentPath(comment.replies || [], targetId, [...path, comment]);
    if (found) return found;
  }
  return null;
}

/**
 * 智能点赞评估
 * POST /api/social/evaluate-like
 * 评估消息是否应该获得自动点赞
 */
router.post('/social/evaluate-like', validateBody(smartLikeSchema), asyncHandler(async (req, res) => {
  const { message, contextMessages = [] } = req.body;

  if (!message || (!message.id && (typeof message.content !== 'string' || !message.content.trim()))) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }

  return withReadableMessages(req, (db, readable) => {
    let evaluation;
    if (!message.id) evaluation = evaluateLike(db, message, contextMessages);
    else {
    const authoritative = readable.find(item => item.id === message.id);
    if (!authoritative) return res.status(404).json({ error: '消息未找到' });
    const context = readable.filter(item => item.group_id === authoritative.group_id &&
      new Date(item.created_at) < new Date(authoritative.created_at))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(-5);
    evaluation = evaluateLike(db, authoritative, context);
    }
    return res.json({ success: true, evaluation, timestamp: new Date().toISOString() });
  });
}));

/**
 * 执行自动点赞
 * POST /api/social/auto-like
 * 根据智能评估自动点赞消息
 */
router.post('/social/auto-like', validateBody(autoLikeSchema), asyncHandler(async (req, res) => {
  const { messageId, groupId } = req.body;

  if (!messageId || !groupId) {
    return res.status(400).json({ error: '消息ID和群组ID不能为空' });
  }

  return withReadableMessages(req, async (db, readable) => {
    const message = readable.find(m => m.id === messageId && m.group_id === groupId);
    if (!message || !db.data.groups?.some(group => group.id === groupId))
      return res.status(404).json({ error: '消息未找到' });
    const contextMessages = readable.filter(m => m.group_id === groupId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10).reverse();
    const evaluation = evaluateLike(db, message, contextMessages);
    const previousLikes = message.likes;
    const previousLikedBy = message.liked_by;
    const likes = Array.isArray(message.likes) ? [...message.likes] :
      (Array.isArray(message.liked_by) ? [...message.liked_by] : []);
    const liked = Boolean(evaluation.shouldLike && !likes.includes('system_auto_like'));
    if (liked) likes.push('system_auto_like');
    if (liked) {
      message.likes = likes;
      message.liked_by = [...likes];
      try {
        await db.write();
      } catch {
        message.likes = previousLikes;
        message.liked_by = previousLikedBy;
        clearUserDbCache(req.userId);
        throw createError('自动点赞写入结果不确定，请刷新消息核验', 503, 'SOCIAL_WRITE_UNCERTAIN');
      }
    }
    return res.json({ success: true, liked, likeCount: likes.length, evaluation,
      message: liked ? '消息已获得自动点赞' : '消息未达到点赞阈值',
      timestamp: new Date().toISOString() });
  });
}));

/**
 * 批量评估消息
 * POST /api/social/batch-evaluate
 * 批量评估多条消息
 */
router.post('/social/batch-evaluate', asyncHandler(async (req, res) => {
  const { messages, groupId } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '消息列表不能为空' });
  }

  if (typeof groupId !== 'string' || !groupId || messages.length > 100 ||
      messages.some(item => typeof item?.id !== 'string') ||
      new Set(messages.map(item => item.id)).size !== messages.length) {
    return res.status(400).json({ error: '群组或消息列表无效' });
  }
  return withReadableMessages(req, (db, readable) => {
    if (!db.data.groups?.some(group => group.id === groupId))
      return res.status(404).json({ error: '群组未找到' });
    const groupMessages = readable.filter(m => m.group_id === groupId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const indexes = new Map(groupMessages.map((message, index) => [message.id, index]));
    if (messages.some(item => !indexes.has(item.id)))
      return res.status(404).json({ error: '部分消息不存在或无权访问' });
    const evaluations = [];
    const recommendations = [];
    for (const requested of messages) {
      const index = indexes.get(requested.id);
      const message = groupMessages[index];
      const contextMessages = groupMessages.slice(Math.max(0, index - 5), index);
      const evaluation = evaluateLike(db, message, contextMessages);
      evaluations.push({ messageId: message.id, evaluation });
      if (evaluation.shouldLike) {
        recommendations.push({ messageId: message.id, score: evaluation.score,
          reasons: evaluation.reasons });
      }
    }
    return res.json({
      success: true, totalMessages: messages.length, evaluations,
      recommendations: { count: recommendations.length, items: recommendations },
      summary: {
        avgScore: evaluations.reduce((sum, item) => sum + item.evaluation.score, 0) / evaluations.length,
        likeRecommendationRate: recommendations.length / messages.length
      }
    });
  });
}));

/**
 * 获取社交分析统计
 * GET /api/social/stats
 * 获取系统社交互动统计信息
 */
router.get('/social/stats', asyncHandler(async (req, res) => {
  const { timeRange = 'all' } = req.query;
  const validTimeRanges = ['all', '24h', '7d', '1h'];

  if (!validTimeRanges.includes(timeRange)) {
    return res.status(400).json({ error: '无效的时间范围' });
  }

  return withReadableMessages(req, (db, readable) => {
    const items = analyticsSnapshot(readable.filter(message => withinRange(message, timeRange)));
    const total = items.length;
    const average = key => total ? items.reduce((sum, item) => sum + (item.metrics[key] || 0), 0) / total : 0;
    const ai = items.filter(item => item.message.sender_type === 'ai').length;
    const user = items.filter(item => item.message.sender_type === 'user').length;
    const liked = items.filter(item => item.message.likes?.includes?.('system_auto_like')).length;
    const stats = {
      timeRange, dataBasis: 'current_readable_messages',
      totalInteractions: total, aiInteractions: ai, userInteractions: user,
      aiPercentage: total ? ai / total : 0, userPercentage: total ? user / total : 0,
      avgMetrics: { engagement: average('engagementScore'), relevance: average('relevanceScore'),
        sentiment: average('sentimentScore'), overall: average('overallScore') },
      smartLikeStats: { totalEvaluations: null, autoLikes: liked, accuracy: null,
        threshold: smartLikeConfig(db).threshold },
      interactionTypes: {
        likes: items.reduce((sum, item) => sum + (Array.isArray(item.message.likes) ? item.message.likes.length : 0), 0),
        comments: items.reduce((sum, item) => sum + (item.message.comments?.length || 0), 0),
        replies: items.filter(item => item.message.reply_to).length
      }
    };
    return res.json({ success: true, timeRange, stats, timestamp: new Date().toISOString() });
  });
}));

/**
 * 获取热门消息
 * GET /api/social/top-messages
 * 获取社交指标最高的消息
 */
router.get('/social/top-messages', asyncHandler(async (req, res) => {
  const { limit = 10, metric = 'overallScore' } = req.query;
  const validMetrics = ['overallScore', 'engagementScore', 'relevanceScore', 'sentimentScore'];

  if (!validMetrics.includes(metric)) {
    return res.status(400).json({ error: '无效的指标类型' });
  }

  const limitNum = parseInt(limit, 10);
  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    return res.status(400).json({ error: '限制参数必须在1-100之间' });
  }

  return withReadableMessages(req, (_db, readable) => {
    const messagesWithDetails = analyticsSnapshot(readable).map(({ message, plain, metrics }) => ({
      messageId: message.id, senderType: message.sender_type, senderId: message.sender_id,
      score: metrics[metric], timestamp: message.created_at, metrics,
      messageContent: plain.content, messageDetails: plain
    })).sort((a, b) => b.score - a.score).slice(0, limitNum);
    return res.json({ success: true, metric, limit: limitNum,
      messages: messagesWithDetails, timestamp: new Date().toISOString() });
  });
}));

/**
 * 获取活跃参与者
 * GET /api/social/active-participants
 * 获取最活跃的用户和AI
 */
router.get('/social/active-participants', asyncHandler(async (req, res) => {
  const { limit = 10 } = req.query;

  const limitNum = parseInt(limit, 10);
  if (isNaN(limitNum) || limitNum < 1 || limitNum > 50) {
    return res.status(400).json({ error: '限制参数必须在1-50之间' });
  }

  return withReadableMessages(req, (_db, readable) => {
    const participants = new Map();
    for (const item of analyticsSnapshot(readable)) {
      const id = item.message.sender_id || 'unknown';
      const key = JSON.stringify([item.message.sender_type, id]);
      const current = participants.get(key) || { id, type: item.message.sender_type,
        interactionCount: 0, totalScore: 0, lastActivity: item.message.created_at };
      current.interactionCount++;
      current.totalScore += item.metrics.overallScore || 0;
      if (item.message.created_at > current.lastActivity) current.lastActivity = item.message.created_at;
      participants.set(key, current);
    }
    const activeParticipants = [...participants.values()].map(item => ({ ...item,
      avgScore: item.interactionCount ? item.totalScore / item.interactionCount : 0 }))
      .sort((a, b) => b.interactionCount - a.interactionCount).slice(0, limitNum);
    return res.json({ success: true, limit: limitNum, participants: activeParticipants,
      timestamp: new Date().toISOString() });
  });
}));

/**
 * 获取智能点赞引擎配置
 * GET /api/social/smart-like-config
 * 获取当前智能点赞引擎的配置
 */
router.get('/social/smart-like-config', asyncHandler(async (req, res) => {
  const config = await withReadableMessages(req, db => smartLikeConfig(db));
  // The engine's process-wide history is not partitioned by account and may
  // contain another account's message IDs. No durable per-account evaluation
  // history exists yet, so report it as unavailable rather than leak it.
  const stats = { totalEvaluations: null, likedCount: null, likeRate: null,
    avgScore: null, config, recentActivity: [], available: false };

  res.json({
    success: true,
    config,
    engineStats: stats,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 更新智能点赞引擎配置
 * PUT /api/social/smart-like-config
 * 更新智能点赞引擎的配置参数
 */
router.put('/social/smart-like-config', asyncHandler(async (req, res) => {
  const { config } = req.body || {};

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: '配置参数不能为空' });
  }

  // 验证配置参数
  const validConfig = {};

  if (config.relevanceWeight !== undefined) {
    if (typeof config.relevanceWeight !== 'number' || config.relevanceWeight < 0 || config.relevanceWeight > 1) {
      return res.status(400).json({ error: '相关性权重必须在0-1之间' });
    }
    validConfig.relevanceWeight = config.relevanceWeight;
  }

  if (config.sentimentWeight !== undefined) {
    if (typeof config.sentimentWeight !== 'number' || config.sentimentWeight < 0 || config.sentimentWeight > 1) {
      return res.status(400).json({ error: '情感权重必须在0-1之间' });
    }
    validConfig.sentimentWeight = config.sentimentWeight;
  }

  if (config.threshold !== undefined) {
    if (typeof config.threshold !== 'number' || config.threshold < 0 || config.threshold > 1) {
      return res.status(400).json({ error: '阈值必须在0-1之间' });
    }
    validConfig.threshold = config.threshold;
  }

  const { oldConfig, updatedConfig } = await withReadableMessages(req, async db => {
    const oldConfig = smartLikeConfig(db);
    const previous = db.data.socialSmartLikeConfig;
    db.data.socialSmartLikeConfig = { ...(previous || {}), ...validConfig };
    try { await db.write(); }
    catch {
      db.data.socialSmartLikeConfig = previous;
      clearUserDbCache(req.userId);
      throw createError('点赞配置写入结果不确定，请重新读取核验', 503, 'SOCIAL_WRITE_UNCERTAIN');
    }
    return { oldConfig, updatedConfig: smartLikeConfig(db) };
  });

  res.json({
    success: true,
    message: '配置更新成功',
    oldConfig,
    newConfig: updatedConfig,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 重置社交分析数据
 * POST /api/social/reset
 * 重置社交分析数据（仅用于测试）
 */
router.post('/social/reset', requireAdmin, asyncHandler(async (req, res) => {
  const { confirm } = req.body;

  if (confirm !== 'RESET_SOCIAL_DATA') {
    return res.status(400).json({
      error: '需要确认操作，请提供正确的确认代码'
    });
  }

  res.status(501).json({
    success: false,
    implemented: false,
    message: '需重启进程生效',
    timestamp: new Date().toISOString()
  });
}));

/**
 * 分析评论上下文相关性
 * POST /api/social/comments/analyze
 * 分析评论的上下文相关性
 */
router.post('/social/comments/analyze', asyncHandler(async (req, res) => {
  const sanitizedBody = sanitizeObject(req.body || {}, COMMENT_SANITIZE_CONFIG);
  const { comment, targetMessage, commentThread = [] } = sanitizedBody;

  if (typeof comment?.content !== 'string' || !comment.content ||
      typeof targetMessage?.id !== 'string' || !Array.isArray(commentThread)) {
    return res.status(400).json({ error: '评论内容、目标消息ID或评论链无效' });
  }
  return withReadableMessages(req, (_db, readable) => {
    const target = readable.find(item => item.id === targetMessage.id);
    if (!target) return res.status(404).json({ error: '消息未找到' });
    const messageContext = readable.filter(item => item.group_id === target.group_id &&
      new Date(item.created_at) < new Date(target.created_at))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(-5)
      .map(item => ({ ...item, content: toPublicMessageDetail(item).content }));
    let thread = [];
    if (commentThread.length) {
      const lastId = commentThread.at(-1)?.id;
      thread = lastId && findCommentPath(socialService.buildCommentTree(target.comments || []), lastId);
      if (!thread || thread.length !== commentThread.length ||
          thread.some((item, index) => item.id !== commentThread[index]?.id)) {
        return res.status(404).json({ error: '评论链未找到' });
      }
    }
    const currentTarget = { ...target, content: toPublicMessageDetail(target).content };
    const analysis = socialService.analyzeComment(comment, currentTarget, messageContext, thread);
    return res.json({ success: true, analysis, timestamp: new Date().toISOString() });
  });
}));

/**
 * 获取评论建议
 * GET /api/social/comments/suggestions
 * 获取上下文感知的评论建议
 */
router.get('/social/comments/suggestions', asyncHandler(async (req, res) => {
  const { messageId, parentCommentId, aiPersonality = 'neutral' } = req.query;

  if (!messageId) {
    return res.status(400).json({ error: '消息ID不能为空' });
  }

  return withReadableMessages(req, (_db, readable) => {
    const targetMessage = readable.find(m => m.id === messageId);
    if (!targetMessage) return res.status(404).json({ error: '消息未找到' });
    let commentThread = [];
    if (parentCommentId) {
      const commentTree = socialService.buildCommentTree(targetMessage.comments || []);
      commentThread = findCommentPath(commentTree, parentCommentId);
      if (!commentThread) return res.status(404).json({ error: '父评论未找到' });
    }
    const plainTarget = { ...targetMessage, content: toPublicMessageDetail(targetMessage).content };
    const suggestions = socialService.generateCommentSuggestions(plainTarget, commentThread, aiPersonality);
    return res.json({ success: true, messageId, parentCommentId: parentCommentId || null,
      suggestions, timestamp: new Date().toISOString() });
  });
}));

/**
 * 获取评论树
 * GET /api/social/comments/tree
 * 获取消息的嵌套评论树
 */
router.get('/social/comments/tree', asyncHandler(async (req, res) => {
  const { messageId } = req.query;

  if (!messageId) {
    return res.status(400).json({ error: '消息ID不能为空' });
  }

  return withReadableMessages(req, (_db, readable) => {
    const target = readable.find(m => m.id === messageId);
    if (!target) return res.status(404).json({ error: '消息未找到' });
    const messageComments = target.comments || [];
    const commentTree = socialService.buildCommentTree(messageComments);
    const depthValidation = commentTree.map(comment =>
      socialService.validateCommentDepth(comment.id, commentTree));
    return res.json({ success: true, messageId, totalComments: messageComments.length,
      commentTree, depthValidation, maxDepth: socialService.commentAnalyzer.config.maxDepth,
      timestamp: new Date().toISOString() });
  });
}));

export default router;
