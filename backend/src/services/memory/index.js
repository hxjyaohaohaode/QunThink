/**
 * 长期记忆服务主模块
 * 集成长期记忆存储、检索、引用等功能
 */

import { LongTermMemoryManager } from './longTermMemory.js';

const MAX_MANAGERS = 20;
const memoryManagers = new Map();

function touchManager(key) {
  const manager = memoryManagers.get(key);
  if (manager) {
    memoryManagers.delete(key);
    memoryManagers.set(key, manager);
  }
}

function evictManagersIfOverLimit() {
  while (memoryManagers.size > MAX_MANAGERS) {
    const oldestKey = memoryManagers.keys().next().value;
    const oldestManager = memoryManagers.get(oldestKey);
    memoryManagers.delete(oldestKey);
    if (oldestManager && typeof oldestManager.dispose === 'function') {
      try {
        oldestManager.dispose();
      } catch (error) {
        console.error('淘汰记忆管理器时清理失败:', error.message);
      }
    }
  }
}

// 长期记忆服务包装器
class LongTermMemoryService {
  constructor() {
    this.managers = memoryManagers;
  }

  getManager(userId) {
    if (userId === undefined || userId === null || userId === '') {
      throw new Error('memory service requires an explicit userId');
    }

    if (!memoryManagers.has(userId)) {
      memoryManagers.set(userId, new LongTermMemoryManager());
      evictManagersIfOverLimit();
      return memoryManagers.get(userId);
    }

    touchManager(userId);
    return memoryManagers.get(userId);
  }

  /**
   * 存储记忆
   */
  storeMemory(memoryData, userId) {
    try {
      const result = this.getManager(userId).storeMemory(memoryData);
      return {
        success: true,
        ...result,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('存储记忆失败:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 检索记忆
   */
  retrieveMemories(query, options = {}, userId) {
    try {
      const result = this.getManager(userId).retrieveMemories(query, options);
      return result;
    } catch (error) {
      console.error('检索记忆失败:', error);
      return {
        success: false,
        error: error.message,
        performance: {
          retrievalTime: 0,
          meetsTimeRequirement: false
        },
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 引用记忆
   */
  referenceMemory(memoryId, context, referenceType = 'direct', userId) {
    try {
      const result = this.getManager(userId).referenceMemory(memoryId, context, referenceType);
      return result;
    } catch (error) {
      console.error('引用记忆失败:', error);
      return {
        success: false,
        error: error.message,
        accuracy: 0,
        meetsAccuracyRequirement: false,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 获取记忆统计
   */
  getMemoryStats(userId) {
    try {
      const stats = this.getManager(userId).getMemoryStats();
      return {
        success: true,
        ...stats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('获取记忆统计失败:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 记忆回顾摘要（重要度×新鲜度加权Top记忆）
   */
  getDigest(userId, limit = 12) {
    try {
      const result = this.getManager(userId).getDigestMemories(limit);
      return {
        success: true,
        ...result,
        generated_at: new Date().toISOString()
      };
    } catch (error) {
      console.error('生成记忆摘要失败:', error);
      return {
        success: false,
        error: error.message,
        total: 0,
        memories: [],
        generated_at: new Date().toISOString()
      };
    }
  }

  /**
   * 清空所有记忆
   */
  clearAllMemories(userId) {
    try {
      const result = this.getManager(userId).clearAllMemories();
      return {
        success: true,
        ...result,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('清空记忆失败:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 批量存储消息为记忆
   */
  storeMessagesAsMemories(messages, options = {}, userId) {
    try {
      const manager = this.getManager(userId);
      const results = [];
      const categories = options.categories || ['factual', 'emotional', 'relational'];
      
      messages.forEach((message, index) => {
        // 确定类别
        const categoryIndex = index % categories.length;
        const category = categories[categoryIndex];
        
        // 创建记忆数据
        const memoryData = {
          content: message.content || '',
          sender_id: message.sender_id || 'unknown',
          sender_type: message.sender_type || 'unknown',
          category: category,
          source_type: 'message',
          source_id: message.id || `msg_${index}`,
          metadata: {
            original_timestamp: message.created_at || new Date().toISOString(),
            message_type: message.type || 'text',
            has_attachments: message.attachments && message.attachments.length > 0
          }
        };
        
        const result = manager.storeMemory(memoryData);
        results.push(result);
      });
      
      const successCount = results.filter(r => r.success).length;
      const totalCount = results.length;
      
      return {
        success: true,
        batchSize: totalCount,
        storedCount: successCount,
        successRate: totalCount > 0 ? successCount / totalCount : 0,
        results: results,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('批量存储消息为记忆失败:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 根据对话历史检索相关记忆
   */
  retrieveRelevantMemoriesForConversation(conversationHistory, limit = 5, userId) {
    try {
      // 提取最近消息的关键内容
      const recentMessages = conversationHistory.slice(-5);
      const queryText = recentMessages
        .map(msg => msg.content || '')
        .filter(text => text.length > 0)
        .join(' ');
      
      if (!queryText || queryText.trim().length === 0) {
        return {
          success: true,
          query: '',
          results: [],
          count: 0,
          message: '没有足够的对话内容用于检索',
          timestamp: new Date().toISOString()
        };
      }
      
      // 检索相关记忆
      const result = this.getManager(userId).retrieveMemories(queryText, { limit });
      
      return {
        ...result,
        conversationContext: {
          messageCount: conversationHistory.length,
          recentMessageCount: recentMessages.length,
          queryText: queryText.substring(0, 100) + (queryText.length > 100 ? '...' : '')
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('检索对话相关记忆失败:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// 创建单例实例
const longTermMemoryService = new LongTermMemoryService();

// 导出功能
export {
  longTermMemoryService
};

export default {
  getManager: (userId) => longTermMemoryService.getManager(userId),
  service: longTermMemoryService,
  
  storeMemory: (memoryData, userId) => longTermMemoryService.storeMemory(memoryData, userId),
  retrieveMemories: (query, options, userId) => longTermMemoryService.retrieveMemories(query, options, userId),
  referenceMemory: (memoryId, context, referenceType, userId) => longTermMemoryService.referenceMemory(memoryId, context, referenceType, userId),
  getStats: (userId) => longTermMemoryService.getMemoryStats(userId),
  getDigest: (userId, limit) => longTermMemoryService.getDigest(userId, limit),
  clearAll: (userId) => longTermMemoryService.clearAllMemories(userId),
  storeMessagesBatch: (messages, options, userId) => longTermMemoryService.storeMessagesAsMemories(messages, options, userId),
  retrieveForConversation: (conversationHistory, limit, userId) => longTermMemoryService.retrieveRelevantMemoriesForConversation(conversationHistory, limit, userId),
  
  checkPerformance: (userId) => {
    const manager = longTermMemoryService.getManager(userId);
    const stats = manager.getMemoryStats();
    return {
      meetsRequirements: {
        retrievalTime: stats.performance.meetsTimeRequirement,
        accuracy: stats.performance.meetsAccuracyRequirement,
        referenceAccuracy: stats.performance.meetsReferenceAccuracyRequirement
      },
      currentValues: {
        avgRetrievalTime: stats.performance.avgRetrievalTime,
        retrievalAccuracy: stats.performance.retrievalAccuracy,
        referenceAccuracy: stats.performance.referenceAccuracy
      },
      requirements: {
        maxRetrievalTime: manager.config.maxRetrievalTime,
        minAccuracy: manager.config.minAccuracy,
        minReferenceAccuracy: manager.config.minReferenceAccuracy
      }
    };
  },
  
  // 配置管理
  getConfig: (userId) => ({ ...longTermMemoryService.getManager(userId).config }),
  updateConfig: (newConfig, userId) => {
    const manager = longTermMemoryService.getManager(userId);
    Object.keys(newConfig).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(manager.config, key)) {
        manager.config[key] = newConfig[key];
      }
    });
    return { success: true, config: manager.config };
  }
};
