/**
 * 社交互动API路由
 * 处理智能点赞、社交分析等功能
 */

import express from 'express';
import { withWriteLock } from '../models/db.js';
import socialService from '../services/social/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody, smartLikeSchema, autoLikeSchema } from '../validators/index.js';
import { sanitizeObject, COMMENT_SANITIZE_CONFIG } from '../utils/sanitize.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { decryptText } from '../utils/encryption.js';

const router = express.Router();

function toPublicMessageDetail(message) {
  if (!message) return null;
  let content = message.content;
  if (message.metadata?.encryption?.encrypted && typeof content === 'string') {
    try {
      content = decryptText(content);
    } catch {
      content = message.content;
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

/**
 * 智能点赞评估
 * POST /api/social/evaluate-like
 * 评估消息是否应该获得自动点赞
 */
router.post('/social/evaluate-like', validateBody(smartLikeSchema), asyncHandler(async (req, res) => {
  const { message, contextMessages = [], senderInfo = {} } = req.body;

  if (!message || !message.content) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }

  const evaluation = socialService.evaluateMessageForLike(message, contextMessages, senderInfo);

  res.json({
    success: true,
    evaluation,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 执行自动点赞
 * POST /api/social/auto-like
 * 根据智能评估自动点赞消息
 */
router.post('/social/auto-like', validateBody(autoLikeSchema), asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  const { messageId, groupId } = req.body;

  if (!messageId || !groupId) {
    return res.status(400).json({ error: '消息ID和群组ID不能为空' });
  }

  // 查找消息
  const message = db.data.messages.find(m => m.id === messageId && m.group_id === groupId);
  if (!message) {
    return res.status(404).json({ error: '消息未找到' });
  }

  // 获取上下文消息（最近10条）
  const contextMessages = db.data.messages
    .filter(m => m.group_id === groupId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10)
    .reverse();

  // 评估消息
  const evaluation = socialService.evaluateMessageForLike(message, contextMessages, {
    type: message.sender_type,
    id: message.sender_id
  });

  let liked = false;
  if (!Array.isArray(message.likes)) {
    message.likes = Array.isArray(message.liked_by) ? [...message.liked_by] : [];
  }
  if (!Array.isArray(message.liked_by)) {
    message.liked_by = [...message.likes];
  }
  let likeCount = message.likes.length;

  // 如果评估建议点赞，则执行点赞
  if (evaluation.shouldLike) {
    if (!message.likes.includes('system_auto_like')) {
      message.likes.push('system_auto_like');
      message.liked_by = [...message.likes];
      likeCount = message.likes.length;
      liked = true;

      await withWriteLock(req.userId, async () => {
        await db.write();
      });

      socialService.analyzeMessage(message, { recentMessages: contextMessages });
    }
  }

  res.json({
    success: true,
    liked,
    likeCount,
    evaluation,
    message: liked ? '消息已获得自动点赞' : '消息未达到点赞阈值',
    timestamp: new Date().toISOString()
  });
}));

/**
 * 批量评估消息
 * POST /api/social/batch-evaluate
 * 批量评估多条消息
 */
router.post('/social/batch-evaluate', asyncHandler(async (req, res) => {
  const { messages, groupId } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '消息列表不能为空' });
  }

  const db = await req.getUserDb();
  await db.read();

  // 获取群组的上下文消息
  const groupMessages = db.data.messages
    .filter(m => m.group_id === groupId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const messageIdIndexMap = new Map(groupMessages.map((m, idx) => [m.id, idx]));

  const evaluations = [];
  const recommendations = [];

  for (const message of messages) {
    // 获取该消息之前的上下文（最多5条）
    const messageIndex = messageIdIndexMap.has(message.id) ? messageIdIndexMap.get(message.id) : -1;
    const contextStart = Math.max(0, messageIndex - 5);
    const contextMessages = groupMessages.slice(contextStart, messageIndex);

    const evaluation = socialService.evaluateMessageForLike(
      message,
      contextMessages,
      { type: message.sender_type, id: message.sender_id }
    );

    evaluations.push({
      messageId: message.id,
      evaluation
    });

    if (evaluation.shouldLike) {
      recommendations.push({
        messageId: message.id,
        score: evaluation.score,
        reasons: evaluation.reasons
      });
    }
  }

  res.json({
    success: true,
    totalMessages: messages.length,
    evaluations,
    recommendations: {
      count: recommendations.length,
      items: recommendations
    },
    summary: {
      avgScore: evaluations.reduce((sum, item) => sum + item.evaluation.score, 0) / evaluations.length,
      likeRecommendationRate: recommendations.length / messages.length
    }
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

  const stats = socialService.getStats(timeRange);

  res.json({
    success: true,
    timeRange,
    stats,
    timestamp: new Date().toISOString()
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

  const topMessages = socialService.getTopMessages(limitNum, metric);

  // 获取完整的消息详情
  const db = await req.getUserDb();
  await db.read();

  const messagesWithDetails = topMessages.map(item => {
    const message = db.data.messages.find(m => m.id === item.messageId);
    return {
      ...item,
      messageContent: toPublicMessageDetail(message)?.content ?? null,
      messageDetails: toPublicMessageDetail(message)
    };
  });

  res.json({
    success: true,
    metric,
    limit: limitNum,
    messages: messagesWithDetails,
    timestamp: new Date().toISOString()
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

  const activeParticipants = socialService.getActiveParticipants(limitNum);

  res.json({
    success: true,
    limit: limitNum,
    participants: activeParticipants,
    timestamp: new Date().toISOString()
  });
}));

/**
 * 获取智能点赞引擎配置
 * GET /api/social/smart-like-config
 * 获取当前智能点赞引擎的配置
 */
router.get('/social/smart-like-config', asyncHandler(async (req, res) => {
  const config = socialService.smartLike.config;
  const stats = socialService.smartLike.getStats();

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
  const { config } = req.body;

  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: '配置参数不能为空' });
  }

  // 验证配置参数
  const validConfig = {};
  const defaultConfig = socialService.smartLike.config;

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

  // 更新配置
  const updatedConfig = socialService.smartLike.updateConfig(validConfig);

  res.json({
    success: true,
    message: '配置更新成功',
    oldConfig: defaultConfig,
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
  const sanitizedBody = sanitizeObject(req.body, COMMENT_SANITIZE_CONFIG);
  const { comment, targetMessage, messageContext = [], commentThread = [] } = sanitizedBody;

  if (!comment || !targetMessage) {
    return res.status(400).json({ error: '评论和目标消息不能为空' });
  }

  const analysis = socialService.analyzeComment(
    comment,
    targetMessage,
    messageContext,
    commentThread
  );

  res.json({
    success: true,
    analysis,
    timestamp: new Date().toISOString()
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

  const db = await req.getUserDb();
  await db.read();

  const targetMessage = db.data.messages.find(m => m.id === messageId);
  if (!targetMessage) {
    return res.status(404).json({ error: '消息未找到' });
  }

  let commentThread = [];
  if (parentCommentId) {
    const messageComments = targetMessage.comments || [];
    const commentTree = socialService.buildCommentTree(messageComments);

    const findCommentPath = (comments, targetId, path = []) => {
      for (const comment of comments) {
        if (comment.id === targetId) {
          return [...path, comment];
        }

        if (comment.replies && comment.replies.length > 0) {
          const found = findCommentPath(comment.replies, targetId, [...path, comment]);
          if (found) return found;
        }
      }
      return null;
    };

    const path = findCommentPath(commentTree, parentCommentId);
    if (path) {
      commentThread = path;
    }
  }

  const suggestions = socialService.generateCommentSuggestions(
    targetMessage,
    commentThread,
    aiPersonality
  );

  res.json({
    success: true,
    messageId,
    parentCommentId: parentCommentId || null,
    suggestions,
    timestamp: new Date().toISOString()
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

  const db = await req.getUserDb();
  await db.read();

  const targetMessage = db.data.messages.find(m => m.id === messageId);
  if (!targetMessage) {
    return res.status(404).json({ error: '消息未找到' });
  }

  const messageComments = targetMessage.comments || [];
  const commentTree = socialService.buildCommentTree(messageComments);

  const depthValidation = commentTree.map(comment =>
    socialService.validateCommentDepth(comment.id, commentTree)
  );

  res.json({
    success: true,
    messageId,
    totalComments: messageComments.length,
    commentTree,
    depthValidation,
    maxDepth: socialService.commentAnalyzer.config.maxDepth,
    timestamp: new Date().toISOString()
  });
}));

export default router;
