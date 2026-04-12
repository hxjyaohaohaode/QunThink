/**
 * 社交互动服务主模块
 * 集成智能点赞、评论分析、社交行为规范等功能
 */

import smartLikeEngine, { calculateSimilarity, analyzeSentiment } from './smartLike.js';
import contextAwareCommentAnalyzer from './contextAwareComments.js';
import socialBehaviorModel from './socialBehaviorModel.js';
import encryptionUtils from '../../utils/encryption.js';

// 社交互动分析器
class SocialInteractionAnalyzer {
  constructor() {
    this.interactions = [];
    this.stats = {
      totalLikes: 0,
      totalComments: 0,
      totalReplies: 0,
      aiInteractions: 0,
      userInteractions: 0
    };
  }
  
  /**
   * 解密消息内容（如果加密）
   */
  decryptMessageIfNeeded(message) {
    if (!message) return message;
    
    try {
      // 检查消息是否加密
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
  }
  
  /**
   * 解密上下文消息数组
   */
  decryptContextMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map(msg => this.decryptMessageIfNeeded(msg));
  }
  
  /**
   * 分析消息互动
   */
  analyzeMessageInteractions(message, context = {}) {
    // 解密消息和上下文（如果加密）
    const decryptedMessage = this.decryptMessageIfNeeded(message);
    const decryptedContext = {
      ...context,
      recentMessages: this.decryptContextMessages(context.recentMessages || [])
    };
    
    const analysis = {
      messageId: decryptedMessage.id,
      timestamp: new Date().toISOString(),
      senderType: decryptedMessage.sender_type,
      senderId: decryptedMessage.sender_id,
      contentLength: decryptedMessage.content ? decryptedMessage.content.length : 0,
      hasReply: !!decryptedMessage.reply_to,
      likeCount: decryptedMessage.likes || 0,
      commentCount: decryptedMessage.comments ? decryptedMessage.comments.length : 0,
      smartLikeEvaluation: null,
      socialMetrics: {}
    };
    
    // 智能点赞评估
    if (decryptedMessage.content && decryptedMessage.content.length > 10) {
      analysis.smartLikeEvaluation = smartLikeEngine.evaluateMessage(
        decryptedMessage,
        decryptedContext.recentMessages || [],
        { type: decryptedMessage.sender_type, id: decryptedMessage.sender_id }
      );
    }
    
    // 计算社交指标
    analysis.socialMetrics = this.calculateSocialMetrics(decryptedMessage, decryptedContext);
    
    // 记录分析结果
    this.recordAnalysis(analysis);
    
    return analysis;
  }
  
  /**
   * 计算社交指标
   */
  calculateSocialMetrics(message, context) {
    const metrics = {
      engagementScore: 0,
      relevanceScore: 0,
      sentimentScore: 0,
      timelinessScore: 0
    };
    
    // 参与度评分（基于点赞和评论）
    const engagement = (message.likes || 0) * 0.6 + (message.comments ? message.comments.length : 0) * 0.4;
    metrics.engagementScore = Math.min(engagement / 10, 1); // 归一化
    
    // 相关性评分（基于上下文）
    if (context.recentMessages && context.recentMessages.length > 0) {
      const lastMessage = context.recentMessages[context.recentMessages.length - 1];
      if (lastMessage && lastMessage.content) {
        const similarity = calculateSimilarity(
          message.content || '',
          lastMessage.content
        );
        metrics.relevanceScore = similarity;
      }
    }
    
    // 情感评分
    const sentiment = analyzeSentiment(message.content || '');
    metrics.sentimentScore = (sentiment.score + 1) / 2; // 归一化到0-1
    
    // 时效性评分（消息越新分数越高）
    if (message.created_at) {
      const messageTime = new Date(message.created_at).getTime();
      const now = Date.now();
      const hoursDiff = (now - messageTime) / (1000 * 60 * 60);
      metrics.timelinessScore = Math.max(0, 1 - hoursDiff / 24); // 24小时内衰减
    }
    
    // 综合评分
    metrics.overallScore = 
      metrics.engagementScore * 0.3 +
      metrics.relevanceScore * 0.3 +
      metrics.sentimentScore * 0.2 +
      metrics.timelinessScore * 0.2;
    
    return metrics;
  }
  
  /**
   * 记录分析结果
   */
  recordAnalysis(analysis) {
    this.interactions.push(analysis);
    
    // 更新统计
    if (analysis.senderType === 'ai') {
      this.stats.aiInteractions++;
    } else if (analysis.senderType === 'user') {
      this.stats.userInteractions++;
    }
    
    if (analysis.likeCount > 0) this.stats.totalLikes += analysis.likeCount;
    if (analysis.commentCount > 0) this.stats.totalComments += analysis.commentCount;
    if (analysis.hasReply) this.stats.totalReplies++;
    
    // 保持记录数量
    if (this.interactions.length > 10000) {
      this.interactions = this.interactions.slice(-10000);
    }
  }
  
  /**
   * 获取社交分析统计
   */
  getSocialStats(timeRange = 'all') {
    const now = Date.now();
    let filteredInteractions = this.interactions;
    
    // 按时间范围过滤
    if (timeRange !== 'all') {
      const hours = timeRange === '24h' ? 24 : timeRange === '7d' ? 168 : 1;
      const cutoffTime = now - hours * 60 * 60 * 1000;
      
      filteredInteractions = this.interactions.filter(
        item => new Date(item.timestamp).getTime() > cutoffTime
      );
    }
    
    // 计算各种指标
    const totalInteractions = filteredInteractions.length;
    const aiInteractions = filteredInteractions.filter(i => i.senderType === 'ai').length;
    const userInteractions = filteredInteractions.filter(i => i.senderType === 'user').length;
    
    // 计算平均得分
    let avgEngagement = 0;
    let avgRelevance = 0;
    let avgSentiment = 0;
    let avgOverall = 0;
    
    if (totalInteractions > 0) {
      filteredInteractions.forEach(item => {
        avgEngagement += item.socialMetrics.engagementScore || 0;
        avgRelevance += item.socialMetrics.relevanceScore || 0;
        avgSentiment += item.socialMetrics.sentimentScore || 0;
        avgOverall += item.socialMetrics.overallScore || 0;
      });
      
      avgEngagement /= totalInteractions;
      avgRelevance /= totalInteractions;
      avgSentiment /= totalInteractions;
      avgOverall /= totalInteractions;
    }
    
    // 智能点赞统计
    const smartLikeEvals = filteredInteractions
      .filter(i => i.smartLikeEvaluation)
      .map(i => i.smartLikeEvaluation);
    
    const totalSmartLikeEvals = smartLikeEvals.length;
    const likedBySmartLike = smartLikeEvals.filter(e => e.shouldLike).length;
    const smartLikeAccuracy = totalSmartLikeEvals > 0 ? likedBySmartLike / totalSmartLikeEvals : 0;
    
    return {
      timeRange,
      totalInteractions,
      aiInteractions,
      userInteractions,
      aiPercentage: totalInteractions > 0 ? aiInteractions / totalInteractions : 0,
      userPercentage: totalInteractions > 0 ? userInteractions / totalInteractions : 0,
      avgMetrics: {
        engagement: avgEngagement,
        relevance: avgRelevance,
        sentiment: avgSentiment,
        overall: avgOverall
      },
      smartLikeStats: {
        totalEvaluations: totalSmartLikeEvals,
        autoLikes: likedBySmartLike,
        accuracy: smartLikeAccuracy,
        threshold: smartLikeEngine.config.threshold
      },
      interactionTypes: {
        likes: this.stats.totalLikes,
        comments: this.stats.totalComments,
        replies: this.stats.totalReplies
      }
    };
  }
  
  /**
   * 获取热门消息（基于社交指标）
   */
  getTopMessages(limit = 10, metric = 'overallScore') {
    const scoredMessages = this.interactions
      .filter(item => item.socialMetrics[metric] !== undefined)
      .map(item => ({
        messageId: item.messageId,
        senderType: item.senderType,
        senderId: item.senderId,
        score: item.socialMetrics[metric],
        timestamp: item.timestamp,
        metrics: item.socialMetrics
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return scoredMessages;
  }
  
  /**
   * 获取活跃用户/AI
   */
  getActiveParticipants(limit = 10) {
    const participantStats = {};
    
    this.interactions.forEach(item => {
      const participantId = item.senderId || 'unknown';
      if (!participantStats[participantId]) {
        participantStats[participantId] = {
          id: participantId,
          type: item.senderType,
          interactionCount: 0,
          totalScore: 0,
          lastActivity: item.timestamp
        };
      }
      
      participantStats[participantId].interactionCount++;
      participantStats[participantId].totalScore += item.socialMetrics.overallScore || 0;
      if (item.timestamp > participantStats[participantId].lastActivity) {
        participantStats[participantId].lastActivity = item.timestamp;
      }
    });
    
    // 计算平均分并排序
    const participants = Object.values(participantStats)
      .map(p => ({
        ...p,
        avgScore: p.interactionCount > 0 ? p.totalScore / p.interactionCount : 0
      }))
      .sort((a, b) => b.interactionCount - a.interactionCount)
      .slice(0, limit);
    
    return participants;
  }
}

// 创建单例实例
const socialAnalyzer = new SocialInteractionAnalyzer();

// 导出功能
export {
  socialAnalyzer,
  smartLikeEngine,
  contextAwareCommentAnalyzer,
  socialBehaviorModel
};

export default {
  smartLike: smartLikeEngine,
  analyzer: socialAnalyzer,
  commentAnalyzer: contextAwareCommentAnalyzer,
  behaviorModel: socialBehaviorModel,
  
  // 便捷方法
  evaluateMessageForLike: (message, contextMessages, senderInfo) => {
    const decryptedMessage = socialAnalyzer.decryptMessageIfNeeded(message);
    const decryptedContextMessages = socialAnalyzer.decryptContextMessages(contextMessages || []);
    return smartLikeEngine.evaluateMessage(decryptedMessage, decryptedContextMessages, senderInfo);
  },
  
  analyzeMessage: (message, context) => {
    return socialAnalyzer.analyzeMessageInteractions(message, context);
  },
  
  analyzeComment: (comment, targetMessage, messageContext, commentThread) => {
    return contextAwareCommentAnalyzer.analyzeComment(comment, targetMessage, messageContext, commentThread);
  },
  
  generateCommentSuggestions: (targetMessage, commentThread, aiPersonality) => {
    return contextAwareCommentAnalyzer.generateCommentSuggestions(targetMessage, commentThread, aiPersonality);
  },
  
  buildCommentTree: (flatComments) => {
    return contextAwareCommentAnalyzer.buildCommentTree(flatComments);
  },
  
  validateCommentDepth: (parentId, commentTree) => {
    return contextAwareCommentAnalyzer.validateCommentDepth(parentId, commentTree);
  },
  
  getStats: (timeRange) => {
    return socialAnalyzer.getSocialStats(timeRange);
  },
  
  getTopMessages: (limit, metric) => {
    return socialAnalyzer.getTopMessages(limit, metric);
  },
  
  getActiveParticipants: (limit) => {
    return socialAnalyzer.getActiveParticipants(limit);
  },
  
  // 社交行为规范方法
  evaluateSocialBehavior: (interaction, context) => {
    return socialBehaviorModel.evaluateSocialBehavior(interaction, context);
  },
  
  getBehaviorStats: () => {
    return socialBehaviorModel.getCurrentStats();
  },
  
  getBehaviorConfig: () => {
    return socialBehaviorModel.getConfig();
  },
  
  updateBehaviorConfig: (newConfig) => {
    return socialBehaviorModel.updateConfig(newConfig);
  },
  
  resetBehaviorModel: () => {
    socialBehaviorModel.reset();
    return { success: true, message: '社交行为模型已重置' };
  }
};