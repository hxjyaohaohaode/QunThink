/**
 * 互动行为记录与分析系统
 * 记录AI间所有互动行为（点赞、评论、回复等）及其上下文
 * 提供互动频率、话题参与度、情感倾向等多维度分析
 */

import { getUserDb, listUserDatabases, withWriteLock } from '../models/db.js';
import smartLikeEngine, { analyzeSentiment } from './social/smartLike.js';

class InteractionLogger {
  constructor() {
    this.cache = new Map();
    this.analyticsCache = {
      hourly: null,
      daily: null,
      weekly: null,
      lastUpdate: null
    };
  }

  async findInteractionLogsInAllUsersDb(filter = {}) {
    const userIds = await listUserDatabases();
    const allLogs = [];
    
    for (const userId of userIds) {
      const db = await getUserDb(userId);
      await db.read();
      const logs = db.data.interaction_logs || [];
      allLogs.push(...logs);
    }
    
    return allLogs;
  }

  /**
   * 记录互动事件
   */
  async logInteraction(event) {
    const userIds = await listUserDatabases();
    
    if (userIds.length === 0) {
      throw new Error('没有找到用户数据库');
    }
    
    const defaultUserId = userIds[0];
    const db = await getUserDb(defaultUserId);
    await db.read();
    
    const interactionId = `interaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const logEntry = {
      id: interactionId,
      timestamp: new Date().toISOString(),
      event_type: event.type, // 'like', 'comment', 'reply', 'message', 'topic_change', 'file_share'
      participant: {
        type: event.participantType, // 'ai', 'user', 'system'
        id: event.participantId,
        name: event.participantName
      },
      target: event.target || null, // { type: 'message', id: 'xxx' }
      content: event.content || null,
      metadata: {
        ...event.metadata,
        context: event.context || {},
        sentiment: event.sentiment || null,
        relevance: event.relevance || null
      },
      performance_metrics: {
        response_time: event.responseTime || null,
        processing_time: event.processingTime || null,
        meets_requirements: event.meetsRequirements || null
      },
      system_info: {
        session_id: event.sessionId || 'unknown',
        group_id: event.groupId || 'unknown',
        ai_model: event.aiModel || null
      }
    };

    // 分析情感倾向（如果内容存在且未提供）
    if (!logEntry.metadata.sentiment && logEntry.content && typeof logEntry.content === 'string') {
      try {
        const sentiment = analyzeSentiment(logEntry.content);
        logEntry.metadata.sentiment = sentiment;
      } catch (error) {
        console.warn('情感分析失败:', error);
      }
    }

    // 存储到数据库
    db.data.interaction_logs.push(logEntry);
    await withWriteLock(defaultUserId, async () => {
      await db.write();
    });
    
    // 清除缓存
    this.analyticsCache = {
      hourly: null,
      daily: null,
      weekly: null,
      lastUpdate: null
    };

    return { success: true, interactionId, timestamp: logEntry.timestamp };
  }

  /**
   * 记录点赞事件
   */
  async logLike(participantType, participantId, targetMessageId, context = {}) {
    return this.logInteraction({
      type: 'like',
      participantType,
      participantId,
      target: { type: 'message', id: targetMessageId },
      metadata: { context },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 记录评论事件
   */
  async logComment(participantType, participantId, commentId, targetMessageId, content, context = {}) {
    return this.logInteraction({
      type: 'comment',
      participantType,
      participantId,
      target: { type: 'message', id: targetMessageId },
      content,
      metadata: { 
        context,
        comment_id: commentId
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 记录回复事件
   */
  async logReply(participantType, participantId, replyId, parentCommentId, content, context = {}) {
    return this.logInteraction({
      type: 'reply',
      participantType,
      participantId,
      target: { type: 'comment', id: parentCommentId },
      content,
      metadata: { 
        context,
        reply_id: replyId,
        parent_comment_id: parentCommentId
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 记录消息事件
   */
  async logMessage(participantType, participantId, messageId, content, groupId, aiModel = null) {
    return this.logInteraction({
      type: 'message',
      participantType,
      participantId,
      target: { type: 'message', id: messageId },
      content,
      metadata: {
        message_id: messageId,
        group_id: groupId
      },
      system_info: {
        group_id: groupId,
        ai_model: aiModel
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 记录话题变化事件
   */
  async logTopicChange(groupId, oldTopic, newTopic, triggerMessageId) {
    return this.logInteraction({
      type: 'topic_change',
      participantType: 'system',
      participantId: 'system',
      target: { type: 'group', id: groupId },
      content: `话题从"${oldTopic}"变为"${newTopic}"`,
      metadata: {
        old_topic: oldTopic,
        new_topic: newTopic,
        trigger_message_id: triggerMessageId
      },
      system_info: {
        group_id: groupId
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 记录文件分享事件
   */
  async logFileShare(participantType, participantId, fileId, fileName, groupId) {
    return this.logInteraction({
      type: 'file_share',
      participantType,
      participantId,
      target: { type: 'file', id: fileId },
      content: `分享了文件: ${fileName}`,
      metadata: {
        file_id: fileId,
        file_name: fileName,
        group_id: groupId
      },
      system_info: {
        group_id: groupId
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 获取互动日志
   */
  async getLogs(filter = {}) {
    let logs = await this.findInteractionLogsInAllUsersDb(filter);
    
    // 应用过滤器
    if (filter.type) {
      logs = logs.filter(log => log.event_type === filter.type);
    }
    
    if (filter.participantType) {
      logs = logs.filter(log => log.participant.type === filter.participantType);
    }
    
    if (filter.participantId) {
      logs = logs.filter(log => log.participant.id === filter.participantId);
    }
    
    if (filter.groupId) {
      logs = logs.filter(log => log.system_info.group_id === filter.groupId);
    }
    
    if (filter.startDate) {
      const start = new Date(filter.startDate).getTime();
      logs = logs.filter(log => new Date(log.timestamp).getTime() >= start);
    }
    
    if (filter.endDate) {
      const end = new Date(filter.endDate).getTime();
      logs = logs.filter(log => new Date(log.timestamp).getTime() <= end);
    }
    
    if (filter.limit) {
      logs = logs.slice(-filter.limit);
    }
    
    // 排序（最新的在前）
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return {
      success: true,
      count: logs.length,
      logs,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取互动统计
   */
  async getInteractionStats(timeRange = '24h', groupId = null) {
    let logs = await this.findInteractionLogsInAllUsersDb();
    
    const now = Date.now();
    let hours = 24;
    
    if (timeRange === '1h') hours = 1;
    else if (timeRange === '6h') hours = 6;
    else if (timeRange === '24h') hours = 24;
    else if (timeRange === '7d') hours = 24 * 7;
    else if (timeRange === '30d') hours = 24 * 30;
    
    const cutoffTime = now - hours * 60 * 60 * 1000;
    
    logs = logs.filter(log => 
      new Date(log.timestamp).getTime() > cutoffTime
    );
    
    if (groupId) {
      logs = logs.filter(log => log.system_info.group_id === groupId);
    }
    
    // 按事件类型统计
    const typeCounts = {};
    const participantCounts = {};
    const hourlyCounts = {};
    const sentimentScores = [];
    let totalResponseTime = 0;
    let responseTimeCount = 0;
    
    logs.forEach(log => {
      // 事件类型统计
      typeCounts[log.event_type] = (typeCounts[log.event_type] || 0) + 1;
      
      // 参与者统计
      const participantKey = `${log.participant.type}:${log.participant.id}`;
      participantCounts[participantKey] = (participantCounts[participantKey] || 0) + 1;
      
      // 每小时统计
      const hour = new Date(log.timestamp).getHours();
      hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
      
      // 情感评分
      if (log.metadata.sentiment && typeof log.metadata.sentiment.score === 'number') {
        sentimentScores.push(log.metadata.sentiment.score);
      }
      
      // 响应时间
      if (log.performance_metrics.response_time) {
        totalResponseTime += log.performance_metrics.response_time;
        responseTimeCount++;
      }
    });
    
    // 计算情感倾向分类
    const sentimentCategories = {
      positive: 0,
      neutral: 0,
      negative: 0
    };
    
    sentimentScores.forEach(score => {
      if (score > 0.2) sentimentCategories.positive++;
      else if (score < -0.2) sentimentCategories.negative++;
      else sentimentCategories.neutral++;
    });
    
    // 计算参与度指标
    const totalInteractions = logs.length;
    const uniqueParticipants = Object.keys(participantCounts).length;
    const avgInteractionsPerParticipant = uniqueParticipants > 0 ? totalInteractions / uniqueParticipants : 0;
    const avgResponseTime = responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0;
    
    // 按类型计算占比
    const typePercentages = {};
    Object.keys(typeCounts).forEach(type => {
      typePercentages[type] = totalInteractions > 0 ? typeCounts[type] / totalInteractions : 0;
    });
    
    // 计算互动频率（每小时）
    const interactionsPerHour = hours > 0 ? totalInteractions / hours : 0;
    
    return {
      success: true,
      timeRange,
      groupId,
      timestamp: new Date().toISOString(),
      summary: {
        totalInteractions,
        uniqueParticipants,
        avgInteractionsPerParticipant,
        interactionsPerHour,
        avgResponseTime,
        dataCollectionPeriod: `${hours}小时`
      },
      breakdown: {
        byType: typeCounts,
        byTypePercentage: typePercentages,
        byParticipant: participantCounts,
        byHour: hourlyCounts,
        sentiment: {
          totalScores: sentimentScores.length,
          averageScore: sentimentScores.length > 0 ? 
            sentimentScores.reduce((a, b) => a + b, 0) / sentimentScores.length : 0,
          categories: sentimentCategories,
          positivePercentage: sentimentScores.length > 0 ? 
            sentimentCategories.positive / sentimentScores.length : 0,
          neutralPercentage: sentimentScores.length > 0 ? 
            sentimentCategories.neutral / sentimentScores.length : 0,
          negativePercentage: sentimentScores.length > 0 ? 
            sentimentCategories.negative / sentimentScores.length : 0
        }
      },
      performance: {
        meetsRequirements: {
          responseTime: avgResponseTime <= 1000, // ≤1秒
          interactionCompleteness: totalInteractions > 0 // 日志完整性
        },
        metrics: {
          avgResponseTime,
          responseTimeThreshold: 1000
        }
      }
    };
  }

  /**
   * 获取话题参与度分析
   */
  async getTopicParticipation(groupId, timeRange = '24h') {
    // 注意：此功能需要话题检测支持，简化实现
    const stats = await this.getInteractionStats(timeRange, groupId);
    
    const participation = {
      groupId,
      timeRange,
      timestamp: new Date().toISOString(),
      summary: {
        totalParticipants: stats.summary.uniqueParticipants,
        totalInteractions: stats.summary.totalInteractions,
        participationRate: stats.summary.uniqueParticipants > 0 ? 
          stats.summary.totalInteractions / stats.summary.uniqueParticipants : 0
      },
      participantBreakdown: {}
    };
    
    // 分析每个参与者的贡献
    const participantContributions = {};
    const logsResult = await this.getLogs({ groupId, limit: 1000 });
    
    logsResult.logs.forEach(log => {
      const participantKey = `${log.participant.type}:${log.participant.id}`;
      if (!participantContributions[participantKey]) {
        participantContributions[participantKey] = {
          participantType: log.participant.type,
          participantId: log.participant.id,
          totalInteractions: 0,
          interactionTypes: {},
          firstInteraction: log.timestamp,
          lastInteraction: log.timestamp
        };
      }
      
      participantContributions[participantKey].totalInteractions++;
      participantContributions[participantKey].interactionTypes[log.event_type] = 
        (participantContributions[participantKey].interactionTypes[log.event_type] || 0) + 1;
      
      if (log.timestamp < participantContributions[participantKey].firstInteraction) {
        participantContributions[participantKey].firstInteraction = log.timestamp;
      }
      if (log.timestamp > participantContributions[participantKey].lastInteraction) {
        participantContributions[participantKey].lastInteraction = log.timestamp;
      }
    });
    
    participation.participantBreakdown = participantContributions;
    
    // 计算参与度排名
    const rankedParticipants = Object.values(participantContributions)
      .sort((a, b) => b.totalInteractions - a.totalInteractions)
      .slice(0, 10);
    
    participation.topParticipants = rankedParticipants;
    
    return participation;
  }

  /**
   * 获取互动质量评估
   */
  async getInteractionQualityMetrics(timeRange = '24h') {
    const stats = await this.getInteractionStats(timeRange);
    
    const totalInteractions = stats.summary.totalInteractions;
    const successfulInteractions = stats.breakdown.byType.message || 0;
    const likes = stats.breakdown.byType.like || 0;
    const dislikes = stats.breakdown.byType.dislike || 0;
    
    const responseRate = totalInteractions > 0 ? successfulInteractions / totalInteractions : 0;
    const userSatisfaction = (likes + dislikes) > 0 ? likes / (likes + dislikes) : 0;
    const avgMessagesPerSession = stats.summary.avgInteractionsPerParticipant || 0;
    const engagementScore = Math.min(1, avgMessagesPerSession / 10);
    
    const qualityMetrics = {
      relevance: {
        score: responseRate,
        threshold: 0.7,
        meetsRequirement: responseRate >= 0.7,
        description: '互动相关性评分（基于成功消息率）'
      },
      appropriateness: {
        score: userSatisfaction,
        threshold: 0.8,
        meetsRequirement: userSatisfaction >= 0.8,
        description: '互动适当性评分（基于点赞/踩比例）'
      },
      naturalness: {
        score: engagementScore,
        threshold: 0.8,
        meetsRequirement: engagementScore >= 0.8,
        description: '互动自然度评分（基于平均消息参与度）'
      }
    };
    
    // 综合评分
    const overallScore = (
      qualityMetrics.relevance.score * 0.4 +
      qualityMetrics.appropriateness.score * 0.3 +
      qualityMetrics.naturalness.score * 0.3
    );
    
    return {
      success: true,
      timeRange,
      timestamp: new Date().toISOString(),
      qualityMetrics,
      overallScore,
      meetsOverallRequirement: overallScore >= 0.8,
      assessment: overallScore >= 0.8 ? '良好' : '需要改进',
      recommendations: overallScore >= 0.8 ? [] : [
        '增加互动的多样性',
        '提高话题相关性',
        '优化AI回应自然度'
      ]
    };
  }

  /**
   * 导出互动日志
   */
  async exportLogs(format = 'json', filter = {}) {
    const logsResult = await this.getLogs(filter);
    
    if (format === 'json') {
      return {
        success: true,
        format: 'json',
        timestamp: new Date().toISOString(),
        ...logsResult
      };
    } else if (format === 'csv') {
      // 简化的CSV转换（实际应使用专业库）
      const headers = ['id', 'timestamp', 'event_type', 'participant_type', 'participant_id', 'content'];
      const csvRows = logsResult.logs.map(log => [
        log.id,
        log.timestamp,
        log.event_type,
        log.participant.type,
        log.participant.id,
        `"${(log.content || '').replace(/"/g, '""')}"`
      ].join(','));
      
      const csvContent = [headers.join(','), ...csvRows].join('\n');
      
      return {
        success: true,
        format: 'csv',
        timestamp: new Date().toISOString(),
        count: logsResult.count,
        content: csvContent
      };
    } else {
      throw new Error(`不支持导出格式: ${format}`);
    }
  }

  /**
   * 清理旧日志（保留最近30天）
   */
  async cleanupOldLogs(daysToKeep = 30) {
    const userIds = await listUserDatabases();
    let totalRemoved = 0;
    
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    
    for (const userId of userIds) {
      const db = await getUserDb(userId);
      await db.read();
      
      const oldLogsCount = (db.data.interaction_logs || []).length;
      db.data.interaction_logs = (db.data.interaction_logs || []).filter(log => 
        new Date(log.timestamp).getTime() > cutoffTime
      );
      
      const removedCount = oldLogsCount - (db.data.interaction_logs || []).length;
      totalRemoved += removedCount;
      
      await withWriteLock(userId, async () => {
        await db.write();
      });
    }
    
    const remainingCount = await this.findInteractionLogsInAllUsersDb().then(logs => logs.length);
    
    this.analyticsCache = {
      hourly: null,
      daily: null,
      weekly: null,
      lastUpdate: null
    };
    
    return {
      success: true,
      removedCount: totalRemoved,
      remainingCount,
      daysKept: daysToKeep,
      timestamp: new Date().toISOString()
    };
  }

  async getSystemStatus() {
    const allLogs = await this.findInteractionLogsInAllUsersDb();
    
    const totalLogs = allLogs.length;
    const now = Date.now();
    const last24hLogs = allLogs.filter(log => 
      now - new Date(log.timestamp).getTime() <= 24 * 60 * 60 * 1000
    ).length;
    
    const lastHourLogs = allLogs.filter(log => 
      now - new Date(log.timestamp).getTime() <= 60 * 60 * 1000
    ).length;
    
    // 计算日志完整性（是否有缺失时间段）
    const logsByHour = {};
    allLogs.forEach(log => {
      const hour = new Date(log.timestamp).toISOString().slice(0, 13); // YYYY-MM-DDTHH
      logsByHour[hour] = (logsByHour[hour] || 0) + 1;
    });
    
    const uniqueHours = Object.keys(logsByHour).length;
    const expectedHours = Math.min(24 * 30, totalLogs > 0 ? 24 * 30 : 0); // 假设最多30天
    const completeness = expectedHours > 0 ? uniqueHours / expectedHours : 1;
    
    return {
      success: true,
      timestamp: new Date().toISOString(),
      metrics: {
        totalLogs,
        last24hLogs,
        lastHourLogs,
        logsPerHour: lastHourLogs,
        logsPerDay: last24hLogs,
        logCompleteness: completeness,
        meetsCompletenessRequirement: completeness >= 0.95
      },
      system: {
        databaseSize: totalLogs * 500, // 估算大小
        lastCleanup: null, // 可以记录清理时间
        autoCleanupEnabled: true,
        retentionDays: 30
      }
    };
  }
}

// 创建单例实例
const interactionLogger = new InteractionLogger();

export default interactionLogger;
