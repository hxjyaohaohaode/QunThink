/**
 * 长期记忆服务主模块
 * 集成长期记忆存储、检索、引用等功能
 */

import { longTermMemoryManager } from './longTermMemory.js';

// 长期记忆服务包装器
class LongTermMemoryService {
  constructor() {
    this.manager = longTermMemoryManager;
  }

  /**
   * 存储记忆
   */
  storeMemory(memoryData) {
    try {
      const result = this.manager.storeMemory(memoryData);
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
  retrieveMemories(query, options = {}) {
    try {
      const result = this.manager.retrieveMemories(query, options);
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
  referenceMemory(memoryId, context, referenceType = 'direct') {
    try {
      const result = this.manager.referenceMemory(memoryId, context, referenceType);
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
  getMemoryStats() {
    try {
      const stats = this.manager.getMemoryStats();
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
   * 清空所有记忆
   */
  clearAllMemories() {
    try {
      const result = this.manager.clearAllMemories();
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
  storeMessagesAsMemories(messages, options = {}) {
    try {
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
        
        const result = this.manager.storeMemory(memoryData);
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
  retrieveRelevantMemoriesForConversation(conversationHistory, limit = 5) {
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
      const result = this.manager.retrieveMemories(queryText, { limit });
      
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
  longTermMemoryService,
  longTermMemoryManager
};

export default {
  manager: longTermMemoryManager,
  service: longTermMemoryService,
  
  // 便捷方法
  storeMemory: (memoryData) => longTermMemoryService.storeMemory(memoryData),
  retrieveMemories: (query, options) => longTermMemoryService.retrieveMemories(query, options),
  referenceMemory: (memoryId, context, referenceType) => longTermMemoryService.referenceMemory(memoryId, context, referenceType),
  getStats: () => longTermMemoryService.getMemoryStats(),
  clearAll: () => longTermMemoryService.clearAllMemories(),
  storeMessagesBatch: (messages, options) => longTermMemoryService.storeMessagesAsMemories(messages, options),
  retrieveForConversation: (conversationHistory, limit) => longTermMemoryService.retrieveRelevantMemoriesForConversation(conversationHistory, limit),
  
  // 性能检查
  checkPerformance: () => {
    const stats = longTermMemoryManager.getMemoryStats();
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
        maxRetrievalTime: longTermMemoryManager.config.maxRetrievalTime,
        minAccuracy: longTermMemoryManager.config.minAccuracy,
        minReferenceAccuracy: longTermMemoryManager.config.minReferenceAccuracy
      }
    };
  },
  
  // 配置管理
  getConfig: () => ({ ...longTermMemoryManager.config }),
  updateConfig: (newConfig) => {
    Object.keys(newConfig).forEach(key => {
      if (longTermMemoryManager.config.hasOwnProperty(key)) {
        longTermMemoryManager.config[key] = newConfig[key];
      }
    });
    return { success: true, config: longTermMemoryManager.config };
  }
};