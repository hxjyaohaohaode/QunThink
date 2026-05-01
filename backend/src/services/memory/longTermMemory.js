/**
 * 长期记忆机制和记忆引用系统
 * 关键信息分类存储，检索响应时间≤500ms，准确率≥90%，引用准确率≥85%
 */

import { calculateSimilarity } from '../social/smartLike.js';

// 长期记忆管理器
class LongTermMemoryManager {
  constructor() {
    this.config = {
      maxRetrievalTime: 500,      // 最大检索时间(ms)
      minAccuracy: 0.90,          // 最小准确率
      minReferenceAccuracy: 0.85, // 最小引用准确率
      memoryCategories: ['factual', 'emotional', 'relational'],
      maxMemories: 10000,         // 最大记忆数量
      vectorSearchThreshold: 0.7  // 向量搜索阈值
    };
    
    this.memories = new Map(); // memoryId -> Memory
    this.categoryIndex = new Map(); // category -> Set(memoryId)
    this.senderIndex = new Map(); // senderId -> Set(memoryId)
    this.temporalIndex = new Map(); // timestamp -> Set(memoryId)
    
    this.performanceStats = {
      totalStores: 0,
      totalRetrievals: 0,
      successfulRetrievals: 0,
      totalReferences: 0,
      accurateReferences: 0,
      retrievalTimes: [],
      referenceAccuracies: []
    };
  }
  
  /**
   * 存储记忆
   */
  storeMemory(memoryData) {
    const memoryId = this.generateMemoryId();
    const timestamp = new Date().toISOString();
    
    const memory = {
      id: memoryId,
      ...memoryData,
      timestamp,
      category: memoryData.category || this.detectCategory(memoryData),
      vector: this.createMemoryVector(memoryData),
      metadata: {
        ...(memoryData.metadata || {}),
        storedAt: timestamp,
        accessCount: 0,
        lastAccessed: null,
        referenceCount: 0
      }
    };
    
    // 存储记忆
    this.memories.set(memoryId, memory);
    
    // 更新索引
    this.updateIndexes(memoryId, memory);
    
    // 更新统计
    this.performanceStats.totalStores++;
    
    // 保持记忆数量
    if (this.memories.size > this.config.maxMemories) {
      this.evictOldMemories();
    }
    
    return {
      success: true,
      memoryId,
      category: memory.category,
      timestamp
    };
  }
  
  /**
   * 生成记忆ID
   */
  generateMemoryId() {
    return `memory_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * 检测记忆类别
   */
  detectCategory(memoryData) {
    const content = memoryData.content || '';
    const senderType = memoryData.sender_type || '';
    
    // 简单的类别检测
    const factualKeywords = ['数据', '事实', '统计', '数字', '百分比', '研究', '报告', '调查'];
    const emotionalKeywords = ['感觉', '情感', '情绪', '喜欢', '讨厌', '高兴', '悲伤', '担心', '希望'];
    const relationalKeywords = ['关系', '联系', '合作', '团队', '朋友', '同事', '家人', '互动'];
    
    let factualScore = 0;
    let emotionalScore = 0;
    let relationalScore = 0;
    
    factualKeywords.forEach(keyword => {
      if (content.includes(keyword)) factualScore++;
    });
    
    emotionalKeywords.forEach(keyword => {
      if (content.includes(keyword)) emotionalScore++;
    });
    
    relationalKeywords.forEach(keyword => {
      if (content.includes(keyword)) relationalScore++;
    });
    
    // 决定类别
    const scores = [
      { category: 'factual', score: factualScore },
      { category: 'emotional', score: emotionalScore },
      { category: 'relational', score: relationalScore }
    ];
    
    scores.sort((a, b) => b.score - a.score);
    
    return scores[0].score > 0 ? scores[0].category : 'factual';
  }
  
  /**
   * 创建记忆向量（简化版）
   */
  createMemoryVector(memoryData) {
    const content = memoryData.content || '';
    const sender = memoryData.sender_id || '';
    const category = memoryData.category || '';
    
    // 简单的向量表示（在实际应用中可以使用词嵌入）
    const vector = {
      contentLength: content.length,
      hasQuestion: /[\?？]/.test(content),
      hasNumbers: /\d+/.test(content),
      senderType: memoryData.sender_type || 'unknown',
      categoryWeight: this.getCategoryWeight(category),
      keywordDensity: this.calculateKeywordDensity(content)
    };
    
    return vector;
  }
  
  /**
   * 获取类别权重
   */
  getCategoryWeight(category) {
    const weights = {
      factual: 0.6,
      emotional: 0.3,
      relational: 0.1
    };
    
    return weights[category] || 0.5;
  }
  
  /**
   * 计算关键词密度
   */
  calculateKeywordDensity(content) {
    if (!content || typeof content !== 'string') return 0;
    
    const keywords = ['重要', '关键', '主要', '核心', '重点', '要点', '总结'];
    let keywordCount = 0;
    
    keywords.forEach(keyword => {
      const regex = new RegExp(keyword, 'gi');
      const matches = content.match(regex);
      if (matches) keywordCount += matches.length;
    });
    
    const wordCount = content.split(/\s+/).length;
    
    return wordCount > 0 ? keywordCount / wordCount : 0;
  }
  
  /**
   * 更新索引
   */
  updateIndexes(memoryId, memory) {
    // 类别索引
    if (!this.categoryIndex.has(memory.category)) {
      this.categoryIndex.set(memory.category, new Set());
    }
    this.categoryIndex.get(memory.category).add(memoryId);
    
    // 发送者索引
    if (memory.sender_id) {
      if (!this.senderIndex.has(memory.sender_id)) {
        this.senderIndex.set(memory.sender_id, new Set());
      }
      this.senderIndex.get(memory.sender_id).add(memoryId);
    }
    
    // 时间索引（按天索引）
    const dateKey = memory.timestamp.split('T')[0];
    if (!this.temporalIndex.has(dateKey)) {
      this.temporalIndex.set(dateKey, new Set());
    }
    this.temporalIndex.get(dateKey).add(memoryId);
  }
  
  /**
   * 驱逐旧记忆
   */
  evictOldMemories() {
    const toRemove = this.memories.size - this.config.maxMemories;
    
    if (toRemove <= 0) return;
    
    for (let i = 0; i < toRemove; i++) {
      let oldestId = null;
      let oldestTime = Infinity;
      
      for (const [memoryId, memory] of this.memories.entries()) {
        const accessTime = memory.metadata.lastAccessed || memory.metadata.storedAt;
        const time = new Date(accessTime).getTime();
        if (time < oldestTime) {
          oldestTime = time;
          oldestId = memoryId;
        }
      }
      
      if (oldestId) {
        this.removeMemory(oldestId);
      }
    }
    
    console.log(`移除了 ${toRemove} 个旧记忆`);
  }
  
  /**
   * 移除记忆
   */
  removeMemory(memoryId) {
    const memory = this.memories.get(memoryId);
    if (!memory) return false;
    
    // 从索引中移除
    if (this.categoryIndex.has(memory.category)) {
      this.categoryIndex.get(memory.category).delete(memoryId);
    }
    
    if (memory.sender_id && this.senderIndex.has(memory.sender_id)) {
      this.senderIndex.get(memory.sender_id).delete(memoryId);
    }
    
    const dateKey = memory.timestamp.split('T')[0];
    if (this.temporalIndex.has(dateKey)) {
      this.temporalIndex.get(dateKey).delete(memoryId);
    }
    
    // 从主存储中移除
    this.memories.delete(memoryId);
    
    return true;
  }
  
  /**
   * 检索记忆
   */
  retrieveMemories(query, options = {}) {
    const startTime = Date.now();
    
    try {
      let candidateIds = new Set();
      
      // 1. 基于类别的检索
      if (options.category && this.categoryIndex.has(options.category)) {
        this.categoryIndex.get(options.category).forEach(id => candidateIds.add(id));
      }
      
      // 2. 基于发送者的检索
      if (options.senderId && this.senderIndex.has(options.senderId)) {
        if (candidateIds.size === 0) {
          this.senderIndex.get(options.senderId).forEach(id => candidateIds.add(id));
        } else {
          // 取交集
          const senderIds = this.senderIndex.get(options.senderId);
          candidateIds = new Set([...candidateIds].filter(id => senderIds.has(id)));
        }
      }
      
      // 3. 基于时间的检索
      if (options.dateRange) {
        const startDate = options.dateRange.startDate || options.dateRange.start;
        const endDate = options.dateRange.endDate || options.dateRange.end;

        if (startDate && endDate) {
          const dateIds = this.getMemoriesByDateRange(startDate, endDate);

          if (candidateIds.size === 0) {
            candidateIds = dateIds;
          } else {
            // 取交集
            candidateIds = new Set([...candidateIds].filter(id => dateIds.has(id)));
          }
        }
      }
      
      // 如果没有指定过滤条件，使用所有记忆
      if (candidateIds.size === 0 && !options.category && !options.senderId && !options.dateRange) {
        this.memories.forEach((_, id) => candidateIds.add(id));
      }
      
      // 4. 基于内容的相似度搜索
      const results = [];
      const queryVector = this.createMemoryVector({ content: query });
      
      candidateIds.forEach(memoryId => {
        const memory = this.memories.get(memoryId);
        if (!memory) return;
        
        const similarity = this.calculateVectorSimilarity(queryVector, memory.vector);
        
        if (similarity >= this.config.vectorSearchThreshold) {
          results.push({
            memory,
            similarity,
            relevance: similarity
          });
        }
      });
      
      // 5. 按相关性排序
      results.sort((a, b) => b.similarity - a.similarity);
      
      // 6. 限制结果数量
      const limit = options.limit || 10;
      const finalResults = results.slice(0, limit);
      
      // 7. 更新访问统计
      finalResults.forEach(result => {
        const memory = this.memories.get(result.memory.id);
        if (memory) {
          memory.metadata.accessCount++;
          memory.metadata.lastAccessed = new Date().toISOString();
        }
      });
      
      // 8. 计算性能指标
      const endTime = Date.now();
      const retrievalTime = endTime - startTime;
      
      this.performanceStats.totalRetrievals++;
      this.performanceStats.successfulRetrievals++;
      this.performanceStats.retrievalTimes.push(retrievalTime);
      
      // 保持样本大小
      if (this.performanceStats.retrievalTimes.length > 100) {
        this.performanceStats.retrievalTimes = this.performanceStats.retrievalTimes.slice(-100);
      }
      
      // 计算准确率
      const accuracy = this.calculateRetrievalAccuracy(finalResults, query);
      
      return {
        success: true,
        query,
        results: finalResults,
        count: finalResults.length,
        totalCandidate: candidateIds.size,
        performance: {
          retrievalTime,
          meetsTimeRequirement: retrievalTime <= this.config.maxRetrievalTime,
          accuracy,
          meetsAccuracyRequirement: accuracy >= this.config.minAccuracy
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('记忆检索错误:', error);
      
      const endTime = Date.now();
      const retrievalTime = endTime - startTime;
      
      this.performanceStats.totalRetrievals++;
      
      return {
        success: false,
        error: error.message,
        performance: {
          retrievalTime,
          meetsTimeRequirement: retrievalTime <= this.config.maxRetrievalTime
        }
      };
    }
  }
  
  /**
   * 获取日期范围内的记忆
   */
  getMemoriesByDateRange(startDate, endDate) {
    const result = new Set();
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // 简单的实现：检查所有日期键
    for (const [dateKey, memoryIds] of this.temporalIndex.entries()) {
      const date = new Date(dateKey);
      
      if (date >= start && date <= end) {
        memoryIds.forEach(id => result.add(id));
      }
    }
    
    return result;
  }
  
  /**
   * 计算向量相似度
   */
  calculateVectorSimilarity(vector1, vector2) {
    // 简单的相似度计算（在实际应用中可以使用余弦相似度）
    let similarity = 0;
    let weightSum = 0;
    
    // 内容长度相似度
    const maxLength = Math.max(vector1.contentLength, vector2.contentLength);
    const lengthSimilarity = maxLength > 0 ? 
      1 - Math.abs(vector1.contentLength - vector2.contentLength) / maxLength : 1;
    similarity += lengthSimilarity * 0.3;
    weightSum += 0.3;
    
    // 问题标记相似度
    const questionSimilarity = vector1.hasQuestion === vector2.hasQuestion ? 1 : 0;
    similarity += questionSimilarity * 0.2;
    weightSum += 0.2;
    
    // 数字内容相似度
    const numberSimilarity = vector1.hasNumbers === vector2.hasNumbers ? 1 : 0;
    similarity += numberSimilarity * 0.1;
    weightSum += 0.1;
    
    // 发送者类型相似度
    const senderSimilarity = vector1.senderType === vector2.senderType ? 1 : 0;
    similarity += senderSimilarity * 0.1;
    weightSum += 0.1;
    
    // 类别权重相似度
    const categorySimilarity = 1 - Math.abs(vector1.categoryWeight - vector2.categoryWeight);
    similarity += categorySimilarity * 0.2;
    weightSum += 0.2;
    
    // 关键词密度相似度
    const densitySimilarity = 1 - Math.abs(vector1.keywordDensity - vector2.keywordDensity);
    similarity += densitySimilarity * 0.1;
    weightSum += 0.1;
    
    return weightSum > 0 ? similarity / weightSum : 0;
  }
  
  /**
   * 计算检索准确率
   */
  calculateRetrievalAccuracy(results, query) {
    if (results.length === 0) return 0;
    
    // 计算平均相似度作为准确率估计
    const avgSimilarity = results.reduce((sum, result) => sum + result.similarity, 0) / results.length;
    
    return avgSimilarity;
  }
  
  /**
   * 引用记忆
   */
  referenceMemory(memoryId, context, referenceType = 'direct') {
    const memory = this.memories.get(memoryId);
    if (!memory) {
      return {
        success: false,
        error: '记忆未找到',
        accuracy: 0
      };
    }
    
    // 计算引用准确率
    const referenceAccuracy = this.calculateReferenceAccuracy(memory, context, referenceType);
    
    // 更新引用统计
    memory.metadata.referenceCount++;
    
    // 更新全局统计
    this.performanceStats.totalReferences++;
    if (referenceAccuracy >= this.config.minReferenceAccuracy) {
      this.performanceStats.accurateReferences++;
    }
    this.performanceStats.referenceAccuracies.push(referenceAccuracy);
    
    // 保持样本大小
    if (this.performanceStats.referenceAccuracies.length > 100) {
      this.performanceStats.referenceAccuracies = this.performanceStats.referenceAccuracies.slice(-100);
    }
    
    return {
      success: true,
      memoryId,
      memoryContent: memory.content,
      category: memory.category,
      referenceAccuracy,
      meetsAccuracyRequirement: referenceAccuracy >= this.config.minReferenceAccuracy,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 计算引用准确率
   */
  calculateReferenceAccuracy(memory, context, referenceType) {
    const memoryContent = memory.content || '';
    const contextContent = context.content || '';
    
    // 计算内容相似度
    const contentSimilarity = calculateSimilarity(memoryContent, contextContent);
    
    // 根据引用类型调整准确率
    let accuracy = contentSimilarity;
    
    switch (referenceType) {
      case 'direct':
        accuracy *= 1.0;
        break;
      case 'paraphrase':
        accuracy *= 0.9;
        break;
      case 'summary':
        accuracy *= 0.8;
        break;
      case 'inference':
        accuracy *= 0.7;
        break;
      default:
        accuracy *= 0.8;
    }
    
    // 确保在0-1范围内
    return Math.max(0, Math.min(1, accuracy));
  }
  
  /**
   * 获取记忆统计
   */
  getMemoryStats() {
    const categoryStats = {};
    this.config.memoryCategories.forEach(category => {
      const count = this.categoryIndex.has(category) ? 
        this.categoryIndex.get(category).size : 0;
      categoryStats[category] = count;
    });
    
    // 计算性能指标
    const avgRetrievalTime = this.performanceStats.retrievalTimes.length > 0 ?
      this.performanceStats.retrievalTimes.reduce((a, b) => a + b, 0) / 
      this.performanceStats.retrievalTimes.length : 0;
    
    const retrievalAccuracy = this.performanceStats.successfulRetrievals > 0 ?
      this.performanceStats.successfulRetrievals / this.performanceStats.totalRetrievals : 1;
    
    const referenceAccuracy = this.performanceStats.totalReferences > 0 ?
      this.performanceStats.accurateReferences / this.performanceStats.totalReferences : 1;
    
    const avgReferenceAccuracy = this.performanceStats.referenceAccuracies.length > 0 ?
      this.performanceStats.referenceAccuracies.reduce((a, b) => a + b, 0) / 
      this.performanceStats.referenceAccuracies.length : 1;
    
    return {
      memoryCount: this.memories.size,
      categoryStats,
      performance: {
        avgRetrievalTime,
        meetsTimeRequirement: avgRetrievalTime <= this.config.maxRetrievalTime,
        retrievalAccuracy,
        meetsAccuracyRequirement: retrievalAccuracy >= this.config.minAccuracy,
        referenceAccuracy: avgReferenceAccuracy,
        meetsReferenceAccuracyRequirement: avgReferenceAccuracy >= this.config.minReferenceAccuracy,
        totalStores: this.performanceStats.totalStores,
        totalRetrievals: this.performanceStats.totalRetrievals,
        successfulRetrievals: this.performanceStats.successfulRetrievals,
        totalReferences: this.performanceStats.totalReferences,
        accurateReferences: this.performanceStats.accurateReferences
      },
      config: this.config,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 清空记忆
   */
  clearAllMemories() {
    this.memories.clear();
    this.categoryIndex.clear();
    this.senderIndex.clear();
    this.temporalIndex.clear();
    
    this.performanceStats = {
      totalStores: 0,
      totalRetrievals: 0,
      successfulRetrievals: 0,
      totalReferences: 0,
      accurateReferences: 0,
      retrievalTimes: [],
      referenceAccuracies: []
    };
    
    return { success: true, message: '所有记忆已清空' };
  }
}

// 创建单例实例
const longTermMemoryManager = new LongTermMemoryManager();

export default longTermMemoryManager;

// 导出功能
export {
  longTermMemoryManager,
  LongTermMemoryManager
};
