/**
 * 互动行为记录与分析系统
 * 记录AI间所有互动行为（点赞、评论、回复等）及其上下文
 * 提供互动频率、话题参与度、情感倾向等多维度分析
 *
 * 安全模型：所有数据严格限定在调用者自己的用户数据库内，
 * 绝不聚合其他用户的数据（跨用户读取/写入均已移除）。
 */

import { getUserDb, withWriteLock } from '../models/db.js';
import smartLikeEngine, { analyzeSentiment } from './social/smartLike.js';

const AUTO_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

class InteractionLogger {
  constructor() {
    this.analyticsCache = {
      hourly: null,
      daily: null,
      weekly: null,
      lastUpdate: null
    };
    this._autoCleanupTimer = null;
  }

  async getUserLogs(userId) {
    const db = await getUserDb(userId);
    await db.read();
    return { db, logs: db.data.interaction_logs || [] };
  }

  /**
   * 记录互动事件（写入调用者自己的用户库，全程持锁）
   */
  async logInteraction(userId, event) {
    if (!userId) {
      throw new Error('记录互动事件需要用户身份');
    }
    const db = await getUserDb(userId);

    const interactionId = `interaction_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    const logEntry = {
      id: interactionId,
      timestamp: new Date().toISOString(),
      event_type: event.type,
      participant: {
        type: event.participantType,
        id: event.participantId,
        name: event.participantName
      },
      target: event.target || null,
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

    if (!logEntry.metadata.sentiment && logEntry.content && typeof logEntry.content === 'string') {
      try {
        const sentiment = analyzeSentiment(logEntry.content);
        logEntry.metadata.sentiment = sentiment;
      } catch (error) {
        console.warn('情感分析失败:', error);
      }
    }

    await withWriteLock(userId, async () => {
      await db.read();
      if (!Array.isArray(db.data.interaction_logs)) {
        db.data.interaction_logs = [];
      }
      db.data.interaction_logs.push(logEntry);
      await db.write();
    });

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
  async logLike(userId, participantType, participantId, targetMessageId, context = {}) {
    return this.logInteraction(userId, {
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
  async logComment(userId, participantType, participantId, commentId, targetMessageId, content, context = {}) {
    return this.logInteraction(userId, {
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
  async logReply(userId, participantType, participantId, replyId, parentCommentId, content, context = {}) {
    return this.logInteraction(userId, {
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
  async logMessage(userId, participantType, participantId, messageId, content, groupId, aiModel = null) {
    return this.logInteraction(userId, {
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
  async logTopicChange(userId, groupId, oldTopic, newTopic, triggerMessageId) {
    return this.logInteraction(userId, {
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
  async logFileShare(userId, participantType, participantId, fileId, fileName, groupId) {
    return this.logInteraction(userId, {
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
   * 获取互动日志（仅限调用者自己的数据；先排序后截取）
   */
  async getLogs(userId, filter = {}) {
    let logs = (await this.getUserLogs(userId)).logs;

    if (filter.type) {
      logs = logs.filter(log => log.event_type === filter.type);
    }

    if (filter.participantType) {
      logs = logs.filter(log => log.participant?.type === filter.participantType);
    }

    if (filter.participantId) {
      logs = logs.filter(log => log.participant?.id === filter.participantId);
    }

    if (filter.groupId) {
      logs = logs.filter(log => log.system_info?.group_id === filter.groupId);
    }

    if (filter.startDate) {
      const start = new Date(filter.startDate).getTime();
      logs = logs.filter(log => new Date(log.timestamp).getTime() >= start);
    }

    if (filter.endDate) {
      const end = new Date(filter.endDate).getTime();
      logs = logs.filter(log => new Date(log.timestamp).getTime() <= end);
    }

    // 先按时间倒序（最新在前），再应用 limit 截取
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (filter.limit && Number.isFinite(filter.limit) && filter.limit > 0) {
      logs = logs.slice(0, filter.limit);
    }

    return {
      success: true,
      count: logs.length,
      logs,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取互动统计（仅限调用者自己的数据）
   */
  async getInteractionStats(userId, timeRange = '24h', groupId = null) {
    let logs = (await this.getUserLogs(userId)).logs;

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
      logs = logs.filter(log => log.system_info?.group_id === groupId);
    }

    const typeCounts = {};
    const participantCounts = {};
    const hourlyCounts = {};
    const sentimentScores = [];
    let totalResponseTime = 0;
    let responseTimeCount = 0;

    logs.forEach(log => {
      typeCounts[log.event_type] = (typeCounts[log.event_type] || 0) + 1;

      const participantKey = `${log.participant?.type}:${log.participant?.id}`;
      participantCounts[participantKey] = (participantCounts[participantKey] || 0) + 1;

      const hour = new Date(log.timestamp).getHours();
      hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;

      if (log.metadata?.sentiment && typeof log.metadata.sentiment.score === 'number') {
        sentimentScores.push(log.metadata.sentiment.score);
      }

      if (log.performance_metrics?.response_time) {
        totalResponseTime += log.performance_metrics.response_time;
        responseTimeCount++;
      }
    });

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

    const totalInteractions = logs.length;
    const uniqueParticipants = Object.keys(participantCounts).length;
    const avgInteractionsPerParticipant = uniqueParticipants > 0 ? totalInteractions / uniqueParticipants : 0;
    const avgResponseTime = responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0;

    const typePercentages = {};
    Object.keys(typeCounts).forEach(type => {
      typePercentages[type] = totalInteractions > 0 ? typeCounts[type] / totalInteractions : 0;
    });

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
          responseTime: avgResponseTime <= 1000,
          interactionCompleteness: totalInteractions > 0
        },
        metrics: {
          avgResponseTime,
          responseTimeThreshold: 1000
        }
      }
    };
  }

  /**
   * 获取话题参与度分析（仅限调用者自己的数据）
   */
  async getTopicParticipation(userId, groupId, timeRange = '24h') {
    const stats = await this.getInteractionStats(userId, timeRange, groupId);

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

    const participantContributions = {};
    const logsResult = await this.getLogs(userId, { groupId, limit: 1000 });

    logsResult.logs.forEach(log => {
      const participantKey = `${log.participant?.type}:${log.participant?.id}`;
      if (!participantContributions[participantKey]) {
        participantContributions[participantKey] = {
          participantType: log.participant?.type,
          participantId: log.participant?.id,
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

    const rankedParticipants = Object.values(participantContributions)
      .sort((a, b) => b.totalInteractions - a.totalInteractions)
      .slice(0, 10);

    participation.topParticipants = rankedParticipants;

    return participation;
  }

  /**
   * 获取互动质量评估（仅限调用者自己的数据）
   */
  async getInteractionQualityMetrics(userId, timeRange = '24h') {
    const stats = await this.getInteractionStats(userId, timeRange);

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
   * 导出互动日志（仅限调用者自己的数据；CSV 含公式注入防护）
   */
  async exportLogs(userId, format = 'json', filter = {}) {
    const logsResult = await this.getLogs(userId, filter);

    if (format === 'json') {
      return {
        success: true,
        format: 'json',
        timestamp: new Date().toISOString(),
        ...logsResult
      };
    } else if (format === 'csv') {
      const headers = ['id', 'timestamp', 'event_type', 'participant_type', 'participant_id', 'content'];
      const sanitizeCsvCell = (value) => {
        let cell = String(value ?? '');
        if (/^[=+\-@\t\r]/.test(cell)) {
          cell = `'${cell}`;
        }
        return `"${cell.replace(/"/g, '""')}"`;
      };
      const csvRows = logsResult.logs.map(log => [
        sanitizeCsvCell(log.id),
        sanitizeCsvCell(log.timestamp),
        sanitizeCsvCell(log.event_type),
        sanitizeCsvCell(log.participant?.type),
        sanitizeCsvCell(log.participant?.id),
        sanitizeCsvCell(log.content || '')
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
   * 清理旧日志（仅限调用者自己的数据）
   */
  async cleanupOldLogs(userId, daysToKeep = DEFAULT_RETENTION_DAYS) {
    const db = await getUserDb(userId);
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    let removedCount = 0;

    await withWriteLock(userId, async () => {
      await db.read();
      const before = (db.data.interaction_logs || []).length;
      db.data.interaction_logs = (db.data.interaction_logs || []).filter(log =>
        new Date(log.timestamp).getTime() > cutoffTime
      );
      removedCount = before - db.data.interaction_logs.length;
      await db.write();
    });

    this.analyticsCache = {
      hourly: null,
      daily: null,
      weekly: null,
      lastUpdate: null
    };

    const remainingCount = ((await this.getUserLogs(userId)).logs).length;

    return {
      success: true,
      removedCount,
      remainingCount,
      daysKept: daysToKeep,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 系统级维护：定期清理所有用户的过期日志（服务端运维行为，非用户接口路径）
   */
  startAutoCleanup(daysToKeep = DEFAULT_RETENTION_DAYS) {
    if (this._autoCleanupTimer) return;
    this._autoCleanupTimer = setInterval(async () => {
      try {
        const { listUserDatabases } = await import('../models/db.js');
        const userIds = await listUserDatabases();
        for (const userId of userIds) {
          try {
            await this.cleanupOldLogs(userId, daysToKeep);
          } catch (err) {
            console.warn(`[InteractionLogger] 用户 ${userId} 日志清理失败:`, err.message);
          }
        }
      } catch (err) {
        console.warn('[InteractionLogger] 自动清理失败:', err.message);
      }
    }, AUTO_CLEANUP_INTERVAL_MS);
    if (typeof this._autoCleanupTimer.unref === 'function') this._autoCleanupTimer.unref();
  }

  stopAutoCleanup() {
    if (this._autoCleanupTimer) {
      clearInterval(this._autoCleanupTimer);
      this._autoCleanupTimer = null;
    }
  }

  async getSystemStatus(userId) {
    const allLogs = (await this.getUserLogs(userId)).logs;

    const totalLogs = allLogs.length;
    const now = Date.now();
    const last24hLogs = allLogs.filter(log =>
      now - new Date(log.timestamp).getTime() <= 24 * 60 * 60 * 1000
    ).length;

    const lastHourLogs = allLogs.filter(log =>
      now - new Date(log.timestamp).getTime() <= 60 * 60 * 1000
    ).length;

    const logsByHour = {};
    allLogs.forEach(log => {
      const hour = new Date(log.timestamp).toISOString().slice(0, 13);
      logsByHour[hour] = (logsByHour[hour] || 0) + 1;
    });

    const uniqueHours = Object.keys(logsByHour).length;
    const expectedHours = Math.min(24 * 30, totalLogs > 0 ? 24 * 30 : 0);
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
        databaseSize: totalLogs * 500,
        lastCleanup: null,
        autoCleanupEnabled: !!this._autoCleanupTimer,
        retentionDays: DEFAULT_RETENTION_DAYS
      }
    };
  }
}

// 创建单例实例
const interactionLogger = new InteractionLogger();

export default interactionLogger;
