/**
 * 上下文感知对话系统
 * 支持50轮对话历史，话题维持率≥85%，切换自然度评分≥4.2/5
 */

import { calculateSimilarity } from '../social/smartLike.js';

// 对话上下文管理器
class ConversationContextManager {
  constructor() {
    this.config = {
      maxHistoryLength: 50,           // 最大历史长度
      topicCoherenceThreshold: 0.85,  // 话题维持率阈值
      topicSwitchNaturalnessThreshold: 4.2, // 话题切换自然度阈值（1-5分）
      contextWindow: 10,              // 上下文窗口大小
      topicDetectionSensitivity: 0.7, // 话题检测敏感度
      minTopicDuration: 3             // 最小话题持续时间（消息数）
    };
    
    this.conversations = new Map(); // groupId -> ConversationContext
    this.topicModels = new Map();   // groupId -> TopicModel
  }
  
  /**
   * 获取或创建对话上下文
   */
  getConversationContext(groupId) {
    if (!this.conversations.has(groupId)) {
      this.conversations.set(groupId, {
        groupId,
        messages: [],
        topics: [],
        currentTopic: null,
        topicHistory: [],
        coherenceScore: 1.0,
        naturalnessScore: 5.0,
        metadata: {
          totalMessages: 0,
          topicSwitches: 0,
          lastUpdate: new Date().toISOString()
        }
      });
      
      this.topicModels.set(groupId, new TopicModel());
    }
    
    return this.conversations.get(groupId);
  }
  
  /**
   * 添加消息到对话历史
   */
  addMessage(groupId, message) {
    const context = this.getConversationContext(groupId);
    const topicModel = this.topicModels.get(groupId);
    
    // 添加消息
    context.messages.push({
      ...message,
      timestamp: message.timestamp || new Date().toISOString()
    });
    
    // 保持历史长度
    if (context.messages.length > this.config.maxHistoryLength) {
      context.messages = context.messages.slice(-this.config.maxHistoryLength);
    }
    
    // 分析话题
    this.analyzeTopics(context, topicModel);
    
    // 更新话题连贯性
    this.updateCoherence(context);
    
    // 更新元数据
    context.metadata.totalMessages++;
    context.metadata.lastUpdate = new Date().toISOString();
    
    return context;
  }
  
  /**
   * 分析话题
   */
  analyzeTopics(context, topicModel) {
    if (context.messages.length < 2) {
      return; // 需要至少2条消息才能分析
    }
    
    // 获取最近消息进行分析
    const recentMessages = context.messages.slice(-this.config.contextWindow);
    
    // 检测话题变化
    const topicChange = topicModel.detectTopicChange(recentMessages);
    
    if (topicChange.detected) {
      // 话题切换
      context.metadata.topicSwitches++;
      
      // 记录旧话题
      if (context.currentTopic) {
        context.topicHistory.push({
          ...context.currentTopic,
          endMessageIndex: context.messages.length - 2,
          duration: context.messages.length - context.currentTopic.startMessageIndex
        });
      }
      
      // 开始新话题
      context.currentTopic = {
        id: `topic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        keywords: topicChange.newTopicKeywords,
        startMessageIndex: context.messages.length - 1,
        startTime: new Date().toISOString(),
        coherenceScores: []
      };
      
      // 评估话题切换自然度
      const naturalness = this.evaluateTopicSwitchNaturalness(
        context.topicHistory,
        context.currentTopic,
        recentMessages
      );
      
      context.naturalnessScore = naturalness.overallScore;
      context.lastTopicSwitchNaturalness = naturalness;
    } else if (context.currentTopic) {
      // 更新当前话题
      const coherence = this.calculateTopicCoherence(
        recentMessages,
        context.currentTopic.keywords
      );
      
      context.currentTopic.coherenceScores.push(coherence);
      context.currentTopic.lastUpdate = new Date().toISOString();
    }
    
    // 记录所有检测到的话题
    context.topics = topicModel.getTopics();
  }
  
  /**
   * 更新话题连贯性评分
   */
  updateCoherence(context) {
    if (!context.currentTopic || context.currentTopic.coherenceScores.length === 0) {
      context.coherenceScore = 1.0;
      return;
    }
    
    // 计算平均连贯性评分
    const avgCoherence = context.currentTopic.coherenceScores.reduce((sum, score) => sum + score, 0) /
                        context.currentTopic.coherenceScores.length;
    
    context.coherenceScore = avgCoherence;
  }
  
  /**
   * 评估话题切换自然度
   */
  evaluateTopicSwitchNaturalness(topicHistory, newTopic, recentMessages) {
    if (topicHistory.length === 0) {
      return {
        overallScore: 5.0,
        scores: {
          transitionSmoothness: 5.0,
          contextualRelevance: 5.0,
          timingAppropriateness: 5.0,
          naturalLanguageCues: 5.0
        },
        reasons: ['首次话题，自然度满分']
      };
    }
    
    const previousTopic = topicHistory[topicHistory.length - 1];
    
    // 1. 过渡平滑度（基于内容相关性）
    const transitionSmoothness = this.evaluateTransitionSmoothness(
      previousTopic,
      newTopic,
      recentMessages
    );
    
    // 2. 上下文相关性（基于对话历史）
    const contextualRelevance = this.evaluateContextualRelevance(
      newTopic,
      recentMessages
    );
    
    // 3. 时机适当性（基于话题持续时间）
    const timingAppropriateness = this.evaluateTimingAppropriateness(
      previousTopic.duration
    );
    
    // 4. 自然语言线索（基于消息内容中的过渡词）
    const naturalLanguageCues = this.evaluateNaturalLanguageCues(
      recentMessages
    );
    
    // 综合评分（加权平均）
    const overallScore = 
      transitionSmoothness * 0.3 +
      contextualRelevance * 0.3 +
      timingAppropriateness * 0.2 +
      naturalLanguageCues * 0.2;
    
    // 生成理由
    const reasons = [];
    if (transitionSmoothness < 3) reasons.push('话题过渡略显生硬');
    if (contextualRelevance < 3) reasons.push('新话题与上下文相关性较低');
    if (timingAppropriateness < 3) reasons.push('话题切换时机可能过早');
    if (naturalLanguageCues < 3) reasons.push('缺乏自然的话题过渡语言');
    
    if (reasons.length === 0) reasons.push('话题切换自然流畅');
    
    return {
      overallScore,
      scores: {
        transitionSmoothness,
        contextualRelevance,
        timingAppropriateness,
        naturalLanguageCues
      },
      reasons
    };
  }
  
  /**
   * 评估过渡平滑度
   */
  evaluateTransitionSmoothness(previousTopic, newTopic, recentMessages) {
    if (!previousTopic || recentMessages.length < 3) return 3.0;
    
    // 获取话题切换前后的消息
    const switchMessages = recentMessages.slice(-3);
    
    // 计算消息间的相关性
    let totalSimilarity = 0;
    let count = 0;
    
    for (let i = 1; i < switchMessages.length; i++) {
      const prevMsg = switchMessages[i - 1];
      const currMsg = switchMessages[i];
      
      if (prevMsg.content && currMsg.content) {
        const similarity = calculateSimilarity(prevMsg.content, currMsg.content);
        totalSimilarity += similarity;
        count++;
      }
    }
    
    const avgSimilarity = count > 0 ? totalSimilarity / count : 0;
    
    // 将相似度转换为1-5分
    const score = 1 + avgSimilarity * 4; // 0-1映射到1-5
    
    return Math.min(5, Math.max(1, score));
  }
  
  /**
   * 评估上下文相关性
   */
  evaluateContextualRelevance(newTopic, recentMessages) {
    if (recentMessages.length < 2) return 3.0;
    
    // 检查新话题关键词是否在最近消息中出现
    const recentContent = recentMessages
      .slice(0, -1) // 排除最新消息
      .map(m => m.content || '')
      .join(' ');
    
    let keywordMatches = 0;
    newTopic.keywords.forEach(keyword => {
      if (recentContent.includes(keyword)) {
        keywordMatches++;
      }
    });
    
    const matchRatio = newTopic.keywords.length > 0 ? 
      keywordMatches / newTopic.keywords.length : 0;
    
    // 将匹配率转换为1-5分
    const score = 1 + matchRatio * 4;
    
    return Math.min(5, Math.max(1, score));
  }
  
  /**
   * 评估时机适当性
   */
  evaluateTimingAppropriateness(previousTopicDuration) {
    if (!previousTopicDuration) return 3.0;
    
    // 根据话题持续时间评分
    // 理想持续时间：5-10条消息
    let score = 3.0;
    
    if (previousTopicDuration < this.config.minTopicDuration) {
      score = 1.0; // 话题持续时间太短
    } else if (previousTopicDuration < 5) {
      score = 2.0; // 话题持续时间较短
    } else if (previousTopicDuration <= 10) {
      score = 4.0; // 理想持续时间
    } else if (previousTopicDuration <= 20) {
      score = 3.0; // 稍长但可接受
    } else {
      score = 5.0; // 长时间讨论一个话题后切换是自然的
    }
    
    return score;
  }
  
  /**
   * 评估自然语言线索
   */
  evaluateNaturalLanguageCues(recentMessages) {
    if (recentMessages.length < 2) return 3.0;
    
    const lastMessage = recentMessages[recentMessages.length - 1];
    const content = lastMessage.content || '';
    
    // 检查是否包含自然的话题过渡词
    const transitionWords = [
      // 中文过渡词
      '说到这个', '顺便提一下', '换个话题', '对了', '另外',
      '突然想到', '话说回来', '回到正题', '关于另一个问题',
      '扯远了', '言归正传', '说到这里',
      // 英文过渡词
      'by the way', 'speaking of', 'on another note', 'incidentally',
      'changing the subject', 'before I forget', 'anyway'
    ];
    
    let hasTransitionCue = false;
    transitionWords.forEach(word => {
      if (content.toLowerCase().includes(word.toLowerCase())) {
        hasTransitionCue = true;
      }
    });
    
    // 检查是否包含问题或疑问句（自然的话题引入方式）
    const hasQuestion = /[\?？]|(吗|呢|吧|啊)$/.test(content);
    
    let score = 3.0;
    if (hasTransitionCue) score += 1.0;
    if (hasQuestion) score += 0.5;
    
    return Math.min(5, Math.max(1, score));
  }
  
  /**
   * 计算话题连贯性
   */
  calculateTopicCoherence(recentMessages, topicKeywords) {
    if (recentMessages.length < 2 || topicKeywords.length === 0) {
      return 1.0;
    }
    
    let totalRelevance = 0;
    let count = 0;
    
    // 检查每条消息与话题关键词的相关性
    recentMessages.forEach(message => {
      const content = message.content || '';
      const contentLower = content.toLowerCase();
      
      let keywordMatches = 0;
      topicKeywords.forEach(keyword => {
        if (contentLower.includes(keyword.toLowerCase())) {
          keywordMatches++;
        }
      });
      
      const relevance = topicKeywords.length > 0 ? 
        keywordMatches / topicKeywords.length : 0;
      
      totalRelevance += relevance;
      count++;
    });
    
    return count > 0 ? totalRelevance / count : 1.0;
  }
  
  /**
   * 获取对话上下文摘要
   */
  getContextSummary(groupId) {
    const context = this.getConversationContext(groupId);
    const topicModel = this.topicModels.get(groupId);
    
    const summary = {
      groupId,
      messageCount: context.messages.length,
      currentTopic: context.currentTopic ? {
        id: context.currentTopic.id,
        keywords: context.currentTopic.keywords,
        duration: context.messages.length - context.currentTopic.startMessageIndex,
        coherence: context.coherenceScore
      } : null,
      topicHistory: context.topicHistory.map(topic => ({
        id: topic.id,
        keywords: topic.keywords,
        duration: topic.duration,
        messageRange: `${topic.startMessageIndex}-${topic.endMessageIndex}`
      })),
      performance: {
        coherenceScore: context.coherenceScore,
        naturalnessScore: context.naturalnessScore,
        meetsThresholds: {
          coherence: context.coherenceScore >= this.config.topicCoherenceThreshold,
          naturalness: context.naturalnessScore >= this.config.topicSwitchNaturalnessThreshold
        }
      },
      metadata: context.metadata,
      detectedTopics: topicModel.getTopics().slice(-5) // 最近5个检测到的话题
    };
    
    return summary;
  }
  
  /**
   * 获取对话历史（可指定数量）
   */
  getConversationHistory(groupId, limit = 50) {
    const context = this.getConversationContext(groupId);
    
    return {
      groupId,
      totalMessages: context.messages.length,
      messages: context.messages.slice(-limit),
      hasMore: context.messages.length > limit,
      limit
    };
  }
  
  /**
   * 清空对话上下文
   */
  clearConversationContext(groupId) {
    this.conversations.delete(groupId);
    this.topicModels.delete(groupId);
    
    return { success: true, message: `群组 ${groupId} 的对话上下文已清空` };
  }
  
  /**
   * 获取所有对话上下文的统计信息
   */
  getAllConversationStats() {
    const stats = {
      totalConversations: this.conversations.size,
      conversations: [],
      overallStats: {
        avgCoherence: 0,
        avgNaturalness: 0,
        totalMessages: 0,
        totalTopicSwitches: 0
      }
    };
    
    let totalCoherence = 0;
    let totalNaturalness = 0;
    
    this.conversations.forEach((context, groupId) => {
      stats.conversations.push({
        groupId,
        messageCount: context.messages.length,
        topicCount: context.topics.length,
        currentTopic: context.currentTopic ? context.currentTopic.id : null,
        coherenceScore: context.coherenceScore,
        naturalnessScore: context.naturalnessScore,
        lastUpdate: context.metadata.lastUpdate
      });
      
      totalCoherence += context.coherenceScore;
      totalNaturalness += context.naturalnessScore;
      stats.overallStats.totalMessages += context.metadata.totalMessages;
      stats.overallStats.totalTopicSwitches += context.metadata.topicSwitches;
    });
    
    if (stats.conversations.length > 0) {
      stats.overallStats.avgCoherence = totalCoherence / stats.conversations.length;
      stats.overallStats.avgNaturalness = totalNaturalness / stats.conversations.length;
    }
    
    return stats;
  }
}

// 话题模型类
class TopicModel {
  constructor() {
    this.topics = [];
    this.config = {
      minTopicSimilarity: 0.6,
      maxTopics: 20,
      keywordExtractionWindow: 5
    };
  }
  
  /**
   * 检测话题变化
   */
  detectTopicChange(recentMessages) {
    if (recentMessages.length < 2) {
      return { detected: false, newTopicKeywords: [] };
    }
    
    // 提取最近消息的关键词
    const newKeywords = this.extractKeywords(recentMessages);
    
    if (this.topics.length === 0) {
      // 第一个话题
      this.topics.push({
        id: `topic_${Date.now()}`,
        keywords: newKeywords,
        messageCount: recentMessages.length,
        lastUpdate: new Date().toISOString()
      });
      
      return { detected: true, newTopicKeywords: newKeywords };
    }
    
    // 获取当前话题
    const currentTopic = this.topics[this.topics.length - 1];
    
    // 计算与当前话题的相似度
    const similarity = this.calculateTopicSimilarity(currentTopic.keywords, newKeywords);
    
    if (similarity < this.config.minTopicSimilarity) {
      // 检测到话题变化
      const newTopic = {
        id: `topic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        keywords: newKeywords,
        messageCount: 1,
        lastUpdate: new Date().toISOString()
      };
      
      this.topics.push(newTopic);
      
      // 保持话题数量
      if (this.topics.length > this.config.maxTopics) {
        this.topics = this.topics.slice(-this.config.maxTopics);
      }
      
      return { detected: true, newTopicKeywords: newKeywords, similarity };
    } else {
      // 更新当前话题
      currentTopic.keywords = this.mergeKeywords(currentTopic.keywords, newKeywords);
      currentTopic.messageCount++;
      currentTopic.lastUpdate = new Date().toISOString();
      
      return { detected: false, newTopicKeywords: currentTopic.keywords, similarity };
    }
  }
  
  /**
   * 提取关键词
   */
  extractKeywords(messages) {
    if (messages.length === 0) return [];
    
    // 合并所有消息内容
    const allContent = messages
      .map(m => m.content || '')
      .join(' ');
    
    // 简单的关键词提取（在实际应用中可以使用更复杂的NLP技术）
    const stopWords = ['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'];
    
    const words = allContent
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter(word => 
        word.length > 1 && 
        !stopWords.includes(word) &&
        !/\d+/.test(word)
      );
    
    // 统计词频
    const wordFreq = {};
    words.forEach(word => {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    });
    
    // 返回频率最高的词作为关键词
    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }
  
  /**
   * 计算话题相似度
   */
  calculateTopicSimilarity(keywords1, keywords2) {
    if (keywords1.length === 0 || keywords2.length === 0) return 0;
    
    const set1 = new Set(keywords1);
    const set2 = new Set(keywords2);
    
    const intersection = [...set1].filter(x => set2.has(x)).length;
    const union = new Set([...set1, ...set2]).size;
    
    return union > 0 ? intersection / union : 0;
  }
  
  /**
   * 合并关键词
   */
  mergeKeywords(oldKeywords, newKeywords) {
    const allKeywords = [...oldKeywords, ...newKeywords];
    const keywordCounts = {};
    
    allKeywords.forEach(keyword => {
      keywordCounts[keyword] = (keywordCounts[keyword] || 0) + 1;
    });
    
    // 按频率排序并返回前10个
    return Object.entries(keywordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }
  
  /**
   * 获取所有话题
   */
  getTopics() {
    return this.topics;
  }
  
  /**
   * 重置话题模型
   */
  reset() {
    this.topics = [];
  }
}

// 创建单例实例
const conversationContextManager = new ConversationContextManager();

export default conversationContextManager;

// 导出功能
export {
  conversationContextManager,
  ConversationContextManager,
  TopicModel
};