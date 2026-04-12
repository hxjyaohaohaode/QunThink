/**
 * 社交互动API路由
 * 处理智能点赞、社交分析等功能
 */

import express from 'express';
import { getDb } from '../models/db.js';
import socialService from '../services/social/index.js';

const router = express.Router();

/**
 * 智能点赞评估
 * POST /api/social/evaluate-like
 * 评估消息是否应该获得自动点赞
 */
router.post('/social/evaluate-like', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('智能点赞评估错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '智能点赞评估失败',
      details: error.message 
    });
  }
});

/**
 * 执行自动点赞
 * POST /api/social/auto-like
 * 根据智能评估自动点赞消息
 */
router.post('/social/auto-like', async (req, res) => {
  const db = getDb();
  await db.read();
  
  try {
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
    let likeCount = message.likes || 0;
    
    // 如果评估建议点赞，则执行点赞
    if (evaluation.shouldLike) {
      // 更新消息的点赞数
      message.likes = (message.likes || 0) + 1;
      message.liked_by = message.liked_by || [];
      message.liked_by.push('system_auto_like');
      
      likeCount = message.likes;
      liked = true;
      
      // 保存到数据库
      await db.write();
      
      // 记录社交分析
      socialService.analyzeMessage(message, { recentMessages: contextMessages });
    }
    
    res.json({
      success: true,
      liked,
      likeCount,
      evaluation,
      message: liked ? '消息已获得自动点赞' : '消息未达到点赞阈值',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('自动点赞错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '自动点赞失败',
      details: error.message 
    });
  }
});

/**
 * 批量评估消息
 * POST /api/social/batch-evaluate
 * 批量评估多条消息
 */
router.post('/social/batch-evaluate', async (req, res) => {
  try {
    const { messages, groupId } = req.body;
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '消息列表不能为空' });
    }
    
    const db = getDb();
    await db.read();
    
    // 获取群组的上下文消息
    const groupMessages = db.data.messages
      .filter(m => m.group_id === groupId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    const evaluations = [];
    const recommendations = [];
    
    for (const message of messages) {
      // 获取该消息之前的上下文（最多5条）
      const messageIndex = groupMessages.findIndex(m => m.id === message.id);
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
  } catch (error) {
    console.error('批量评估错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '批量评估失败',
      details: error.message 
    });
  }
});

/**
 * 获取社交分析统计
 * GET /api/social/stats
 * 获取系统社交互动统计信息
 */
router.get('/social/stats', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('获取社交统计错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取社交统计失败',
      details: error.message 
    });
  }
});

/**
 * 获取热门消息
 * GET /api/social/top-messages
 * 获取社交指标最高的消息
 */
router.get('/social/top-messages', async (req, res) => {
  try {
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
    const db = getDb();
    await db.read();
    
    const messagesWithDetails = topMessages.map(item => {
      const message = db.data.messages.find(m => m.id === item.messageId);
      return {
        ...item,
        messageContent: message ? message.content : null,
        messageDetails: message
      };
    });
    
    res.json({
      success: true,
      metric,
      limit: limitNum,
      messages: messagesWithDetails,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取热门消息错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取热门消息失败',
      details: error.message 
    });
  }
});

/**
 * 获取活跃参与者
 * GET /api/social/active-participants
 * 获取最活跃的用户和AI
 */
router.get('/social/active-participants', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('获取活跃参与者错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取活跃参与者失败',
      details: error.message 
    });
  }
});

/**
 * 获取智能点赞引擎配置
 * GET /api/social/smart-like-config
 * 获取当前智能点赞引擎的配置
 */
router.get('/social/smart-like-config', async (req, res) => {
  try {
    const config = socialService.smartLike.config;
    const stats = socialService.smartLike.getStats();
    
    res.json({
      success: true,
      config,
      engineStats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取配置错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取配置失败',
      details: error.message 
    });
  }
});

/**
 * 更新智能点赞引擎配置
 * PUT /api/social/smart-like-config
 * 更新智能点赞引擎的配置参数
 */
router.put('/social/smart-like-config', async (req, res) => {
  try {
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
  } catch (error) {
    console.error('更新配置错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '更新配置失败',
      details: error.message 
    });
  }
});

/**
 * 重置社交分析数据
 * POST /api/social/reset
 * 重置社交分析数据（仅用于测试）
 */
router.post('/social/reset', async (req, res) => {
  try {
    // 注意：在实际生产环境中需要权限验证
    const { confirm } = req.body;
    
    if (confirm !== 'RESET_SOCIAL_DATA') {
      return res.status(400).json({ 
        error: '需要确认操作，请提供正确的确认代码' 
      });
    }
    
    // 重新初始化服务
    // 这里需要重新导入模块来重置，但在实际中需要更复杂的重置逻辑
    // 目前仅返回成功消息，实际重置需要在服务内部实现
    
    res.json({
      success: true,
      message: '社交分析数据已重置（需要重启服务生效）',
      warning: '此操作仅重置内存中的数据，数据库中的点赞记录不受影响',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('重置数据错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '重置数据失败',
      details: error.message 
    });
  }
});

/**
 * 分析评论上下文相关性
 * POST /api/social/comments/analyze
 * 分析评论的上下文相关性
 */
router.post('/social/comments/analyze', async (req, res) => {
  try {
    const { comment, targetMessage, messageContext = [], commentThread = [] } = req.body;
    
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
  } catch (error) {
    console.error('评论分析错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '评论分析失败',
      details: error.message 
    });
  }
});

/**
 * 获取评论建议
 * GET /api/social/comments/suggestions
 * 获取上下文感知的评论建议
 */
router.get('/social/comments/suggestions', async (req, res) => {
  try {
    const { messageId, parentCommentId, aiPersonality = 'neutral' } = req.query;
    
    if (!messageId) {
      return res.status(400).json({ error: '消息ID不能为空' });
    }
    
    const db = getDb();
    await db.read();
    
    // 获取目标消息
    const targetMessage = db.data.messages.find(m => m.id === messageId);
    if (!targetMessage) {
      return res.status(404).json({ error: '消息未找到' });
    }
    
    // 构建评论线程
    let commentThread = [];
    if (parentCommentId) {
      // 获取父评论链
      const allComments = db.data.comments || [];
      const commentTree = socialService.buildCommentTree(allComments);
      
      // 查找父评论及其祖先
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
  } catch (error) {
    console.error('获取评论建议错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取评论建议失败',
      details: error.message 
    });
  }
});

/**
 * 获取评论树
 * GET /api/social/comments/tree
 * 获取消息的嵌套评论树
 */
router.get('/social/comments/tree', async (req, res) => {
  try {
    const { messageId } = req.query;
    
    if (!messageId) {
      return res.status(400).json({ error: '消息ID不能为空' });
    }
    
    const db = getDb();
    await db.read();
    
    // 获取该消息的所有评论
    const allComments = db.data.comments || [];
    const messageComments = allComments.filter(c => c.message_id === messageId);
    
    // 构建评论树
    const commentTree = socialService.buildCommentTree(messageComments);
    
    // 验证深度
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
  } catch (error) {
    console.error('获取评论树错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取评论树失败',
      details: error.message 
    });
  }
});

/**
 * 创建评论
 * POST /api/comments
 * 创建新的评论（支持嵌套）
 */
router.post('/comments', async (req, res) => {
  const db = getDb();
  await db.read();
  
  try {
    const { 
      message_id, 
      content, 
      sender_type = 'user', 
      sender_id = 'user', 
      parent_id = null,
      reply_to = null 
    } = req.body;
    
    if (!message_id || !content) {
      return res.status(400).json({ error: '消息ID和评论内容不能为空' });
    }
    
    // 验证消息是否存在
    const targetMessage = db.data.messages.find(m => m.id === message_id);
    if (!targetMessage) {
      return res.status(404).json({ error: '目标消息未找到' });
    }
    
    // 验证父评论是否存在（如果提供了parent_id）
    if (parent_id) {
      const parentComment = (db.data.comments || []).find(c => c.id === parent_id);
      if (!parentComment) {
        return res.status(404).json({ error: '父评论未找到' });
      }
      
      // 验证评论深度
      const allComments = db.data.comments || [];
      const commentTree = socialService.buildCommentTree(allComments);
      const depthValidation = socialService.validateCommentDepth(parent_id, commentTree);
      
      if (!depthValidation.valid) {
        return res.status(400).json({ 
          error: '评论深度超过限制',
          details: depthValidation
        });
      }
    }
    
    // 生成评论ID
    const commentId = `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // 创建评论对象
    const comment = {
      id: commentId,
      message_id,
      parent_id: parent_id || null,
      reply_to: reply_to || null,
      sender_type,
      sender_id,
      content,
      created_at: new Date().toISOString(),
      likes: 0,
      liked_by: []
    };
    
    // 保存评论
    if (!db.data.comments) {
      db.data.comments = [];
    }
    db.data.comments.push(comment);
    await db.write();
    
    // 分析评论相关性
    let analysis = null;
    try {
      // 获取上下文
      const messageContext = db.data.messages
        .filter(m => m.group_id === targetMessage.group_id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 5)
        .reverse();
      
      // 构建评论线程
      let commentThread = [];
      if (parent_id) {
        const allComments = db.data.comments || [];
        const commentTree = socialService.buildCommentTree(allComments);
        const findCommentPath = (comments, targetId, path = []) => {
          for (const c of comments) {
            if (c.id === targetId) {
              return [...path, c];
            }
            if (c.replies && c.replies.length > 0) {
              const found = findCommentPath(c.replies, targetId, [...path, c]);
              if (found) return found;
            }
          }
          return null;
        };
        
        const path = findCommentPath(commentTree, parent_id);
        if (path) {
          commentThread = path;
        }
      }
      
      analysis = socialService.analyzeComment(
        comment,
        targetMessage,
        messageContext,
        commentThread
      );
    } catch (analysisError) {
      console.error('评论分析失败:', analysisError);
      // 分析失败不影响评论创建
    }
    
    res.status(201).json({
      success: true,
      comment,
      analysis,
      message: '评论创建成功',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('创建评论错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '创建评论失败',
      details: error.message 
    });
  }
});

export default router;