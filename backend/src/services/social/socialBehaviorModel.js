/**
 * AI社交行为规范模型
 * 确保互动符合自然对话逻辑、社交礼仪及上下文相关性
 * 目标：无意义互动率≤5%，话题偏离度≤15%
 */

import { calculateSimilarity, analyzeSentiment } from './smartLike.js';

// AI社交行为规范模型
class SocialBehaviorModel {
  constructor() {
    this.config = {
      // 行为规范阈值
      meaninglessThreshold: 0.05,     // 无意义互动率阈值 (5%)
      topicDeviationThreshold: 0.15,  // 话题偏离度阈值 (15%)
      relevanceThreshold: 0.7,        // 相关性阈值
      sentimentThreshold: 0.6,        // 情感适当性阈值
      
      // 互动质量权重
      relevanceWeight: 0.4,
      coherenceWeight: 0.3,
      appropriatenessWeight: 0.2,
      timingWeight: 0.1,
      
      // 行为模式检测
      maxRepetitionPenalty: 0.3,      // 重复内容惩罚
      minResponseDelay: 500,          // 最小响应延迟(ms)
      maxResponseDelay: 10000,        // 最大响应延迟(ms)
      optimalResponseTime: 2000       // 最佳响应时间(ms)
    };
    
    this.interactionHistory = [];
    this.maxInteractionHistory = 500;
    this.behaviorMetrics = {
      totalInteractions: 0,
      meaninglessInteractions: 0,
      highDeviationInteractions: 0,
      inappropriateInteractions: 0,
      recentTopicCoherence: []
    };
  }
  
  /**
   * 评估AI社交行为
   * @param {Object} interaction - 互动对象
   * @param {Object} context - 上下文信息
   * @returns {Object} 评估结果
   */
  evaluateSocialBehavior(interaction, context = {}) {
    const evaluation = {
      interactionId: interaction.id || `interaction_${Date.now()}`,
      timestamp: new Date().toISOString(),
      senderType: interaction.sender_type,
      senderId: interaction.sender_id,
      metrics: {},
      scores: {},
      overallScore: 0,
      violations: [],
      recommendations: [],
      isAppropriate: true
    };
    
    // 1. 内容相关性评估
    const relevanceScore = this.evaluateRelevance(interaction, context);
    evaluation.scores.relevanceScore = relevanceScore;
    evaluation.metrics.relevance = relevanceScore >= this.config.relevanceThreshold;
    
    if (relevanceScore < this.config.relevanceThreshold) {
      evaluation.violations.push({
        type: 'low_relevance',
        score: relevanceScore,
        threshold: this.config.relevanceThreshold,
        message: '内容与上下文相关性不足'
      });
    }
    
    // 2. 话题连贯性评估
    const coherenceScore = this.evaluateCoherence(interaction, context);
    evaluation.scores.coherenceScore = coherenceScore;
    evaluation.metrics.topicDeviation = 1 - coherenceScore;
    
    if (evaluation.metrics.topicDeviation > this.config.topicDeviationThreshold) {
      evaluation.violations.push({
        type: 'high_topic_deviation',
        deviation: evaluation.metrics.topicDeviation,
        threshold: this.config.topicDeviationThreshold,
        message: '话题偏离度过高'
      });
    }
    
    // 3. 社交适当性评估
    const appropriatenessScore = this.evaluateAppropriateness(interaction, context);
    evaluation.scores.appropriatenessScore = appropriatenessScore;
    evaluation.metrics.appropriate = appropriatenessScore >= this.config.sentimentThreshold;
    
    if (appropriatenessScore < this.config.sentimentThreshold) {
      evaluation.violations.push({
        type: 'inappropriate_content',
        score: appropriatenessScore,
        threshold: this.config.sentimentThreshold,
        message: '内容可能不适合当前社交语境'
      });
    }
    
    // 4. 时机适当性评估
    const timingScore = this.evaluateTiming(interaction, context);
    evaluation.scores.timingScore = timingScore;
    evaluation.metrics.timingAppropriate = timingScore >= 0.5;
    
    // 5. 无意义互动检测
    const isMeaningless = this.detectMeaninglessInteraction(interaction, context);
    evaluation.metrics.meaningless = isMeaningless;
    
    if (isMeaningless) {
      evaluation.violations.push({
        type: 'meaningless_interaction',
        message: '互动可能缺乏实质性内容'
      });
    }
    
    // 6. 计算综合评分
    evaluation.overallScore = this.calculateOverallScore(
      relevanceScore,
      coherenceScore,
      appropriatenessScore,
      timingScore,
      isMeaningless
    );
    
    // 7. 确定是否适当
    evaluation.isAppropriate = evaluation.overallScore >= 0.7 && 
                              evaluation.violations.length === 0 &&
                              !isMeaningless;
    
    // 8. 生成建议
    if (!evaluation.isAppropriate) {
      evaluation.recommendations = this.generateRecommendations(evaluation, context);
    }
    
    // 9. 更新行为指标
    this.updateBehaviorMetrics(evaluation);
    
    // 10. 计算当前统计
    evaluation.currentStats = this.getCurrentStats();
    
    return evaluation;
  }
  
  /**
   * 评估内容相关性
   */
  evaluateRelevance(interaction, context) {
    const { content } = interaction;
    const { previousMessage, conversationHistory = [] } = context;
    
    if (!content || !previousMessage) {
      return 0.5; // 默认值
    }
    
    // 计算与上一条消息的直接相关性
    let directRelevance = 0;
    if (previousMessage && previousMessage.content) {
      directRelevance = calculateSimilarity(content, previousMessage.content);
    }
    
    // 计算与对话历史的平均相关性
    let historicalRelevance = 0;
    if (conversationHistory.length > 0) {
      let totalSimilarity = 0;
      let count = 0;
      
      // 考虑最近5条消息
      const recentHistory = conversationHistory.slice(-5);
      recentHistory.forEach(msg => {
        if (msg && msg.content) {
          totalSimilarity += calculateSimilarity(content, msg.content);
          count++;
        }
      });
      
      historicalRelevance = count > 0 ? totalSimilarity / count : 0;
    }
    
    // 检查是否包含上下文引用
    const hasContextReference = this.checkContextReference(content, context);
    const referenceBonus = hasContextReference ? 0.1 : 0;
    
    // 综合相关性评分
    const relevanceScore = directRelevance * 0.7 + historicalRelevance * 0.3 + referenceBonus;
    
    return Math.min(1, relevanceScore);
  }
  
  /**
   * 检查上下文引用
   */
  checkContextReference(content, context) {
    if (!content || typeof content !== 'string') return false;
    
    const referencePatterns = [
      // 中文引用模式
      '之前提到', '上面说', '刚才说到', '正如...所说', '关于这个问题',
      '针对这一点', '在这个话题上', '回到...问题', '继续讨论',
      // 英文引用模式
      'as mentioned', 'as discussed', 'regarding', 'about this', 'on this topic',
      'following up', 'to continue', 'back to', 'in response to'
    ];
    
    const contentLower = content.toLowerCase();
    return referencePatterns.some(pattern => contentLower.includes(pattern));
  }
  
  /**
   * 评估话题连贯性
   */
  evaluateCoherence(interaction, context) {
    const { content } = interaction;
    const { conversationHistory = [], currentTopic } = context;
    
    if (!content || conversationHistory.length === 0) {
      return 0.5; // 默认值
    }
    
    // 提取当前话题关键词
    const topicKeywords = this.extractTopicKeywords(conversationHistory, currentTopic);
    
    if (topicKeywords.length === 0) {
      return 0.5;
    }
    
    // 计算内容与话题关键词的匹配度
    const contentWords = this.extractWords(content);
    let matchedKeywords = 0;
    
    topicKeywords.forEach(keyword => {
      if (contentWords.includes(keyword)) {
        matchedKeywords++;
      }
    });
    
    const keywordMatchScore = matchedKeywords / topicKeywords.length;
    
    // 计算与最近消息的相似度
    let recentSimilarity = 0;
    const recentMessages = conversationHistory.slice(-3);
    if (recentMessages.length > 0) {
      let totalSimilarity = 0;
      let count = 0;
      
      recentMessages.forEach(msg => {
        if (msg && msg.content) {
          totalSimilarity += calculateSimilarity(content, msg.content);
          count++;
        }
      });
      
      recentSimilarity = count > 0 ? totalSimilarity / count : 0;
    }
    
    // 综合连贯性评分
    const coherenceScore = keywordMatchScore * 0.6 + recentSimilarity * 0.4;
    
    return coherenceScore;
  }
  
  /**
   * 提取话题关键词
   */
  extractTopicKeywords(conversationHistory, currentTopic = '') {
    const allContent = conversationHistory
      .filter(msg => msg && msg.content)
      .map(msg => msg.content)
      .join(' ');
    
    if (!allContent && !currentTopic) {
      return [];
    }
    
    // 简单的关键词提取
    const stopWords = ['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'];
    
    const words = (allContent + ' ' + currentTopic)
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
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
    
    // 返回频率最高的10个词作为话题关键词
    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }
  
  /**
   * 提取单词
   */
  extractWords(text) {
    if (!text || typeof text !== 'string') return [];
    
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 0);
  }
  
  /**
   * 评估社交适当性
   */
  evaluateAppropriateness(interaction, context) {
    const { content, sender_type } = interaction;
    const { conversationTone = 'neutral', participants = [] } = context;
    
    if (!content) return 0.5;
    
    // 情感分析
    const sentiment = analyzeSentiment(content);
    const sentimentScore = (sentiment.score + 1) / 2; // 归一化到0-1
    
    // 检查是否包含不当内容
    const hasInappropriateContent = this.checkInappropriateContent(content);
    const appropriatenessPenalty = hasInappropriateContent ? 0.3 : 0;
    
    // 检查语气是否与对话基调匹配
    const toneMatchScore = this.evaluateToneMatch(content, conversationTone);
    
    // 检查是否尊重参与者
    const respectScore = this.evaluateRespectfulness(content, participants);
    
    // 综合适当性评分
    const appropriatenessScore = 
      sentimentScore * 0.4 + 
      toneMatchScore * 0.3 + 
      respectScore * 0.3 - 
      appropriatenessPenalty;
    
    return Math.max(0, Math.min(1, appropriatenessScore));
  }
  
  /**
   * 检查不当内容
   */
  checkInappropriateContent(content) {
    if (!content || typeof content !== 'string') return false;
    
    const inappropriatePatterns = [
      // 攻击性语言模式（简化版）
      '笨蛋', '蠢货', '白痴', '废物', '去死',
      // 不当用语
      '他妈的', '妈的', '操', 'shit', 'fuck',
      // 歧视性语言
      '垃圾', '废物', '没用'
    ];
    
    const contentLower = content.toLowerCase();
    return inappropriatePatterns.some(pattern => contentLower.includes(pattern));
  }
  
  /**
   * 评估语气匹配
   */
  evaluateToneMatch(content, conversationTone) {
    // 简化版的语气分析
    const toneKeywords = {
      formal: ['尊敬的', '您好', '谨此', '特此', '敬礼'],
      casual: ['哈哈', '嘿嘿', '呵呵', '嗯嗯', '好的呀'],
      professional: ['根据', '分析', '数据', '报告', '建议'],
      friendly: ['朋友', '兄弟', '姐妹', '亲爱的', '开心']
    };
    
    if (!conversationTone || conversationTone === 'neutral') {
      return 0.7; // 中性基调匹配度中等
    }
    
    const contentLower = content.toLowerCase();
    const keywords = toneKeywords[conversationTone] || [];
    
    if (keywords.length === 0) return 0.5;
    
    let matchedKeywords = 0;
    keywords.forEach(keyword => {
      if (contentLower.includes(keyword.toLowerCase())) {
        matchedKeywords++;
      }
    });
    
    return matchedKeywords / keywords.length;
  }
  
  /**
   * 评估尊重程度
   */
  evaluateRespectfulness(content, participants) {
    if (!content || !Array.isArray(participants)) return 0.7;
    
    const contentLower = content.toLowerCase();
    
    // 检查是否包含参与者名称的正面提及
    let positiveMentions = 0;
    participants.forEach(participant => {
      if (participant.name && contentLower.includes(participant.name.toLowerCase())) {
        // 检查提及是否正面
        const positiveWords = ['感谢', '赞同', '同意', '支持', '欣赏', '尊重'];
        const hasPositiveWord = positiveWords.some(word => 
          contentLower.includes(word)
        );
        
        if (hasPositiveWord) {
          positiveMentions++;
        }
      }
    });
    
    const respectScore = participants.length > 0 ? 
      positiveMentions / participants.length : 0.7;
    
    return respectScore;
  }
  
  /**
   * 评估时机适当性
   */
  evaluateTiming(interaction, context) {
    const { timestamp, sender_type } = interaction;
    const { lastInteractionTime, conversationPace } = context;
    
    if (!timestamp || !lastInteractionTime) {
      return 0.7; // 默认值
    }
    
    const currentTime = new Date(timestamp).getTime();
    const lastTime = new Date(lastInteractionTime).getTime();
    const responseDelay = currentTime - lastTime;
    
    // 评估响应延迟
    let timingScore = 0.7;
    
    if (responseDelay < this.config.minResponseDelay) {
      // 响应太快，可能显得匆忙
      timingScore = 0.3;
    } else if (responseDelay > this.config.maxResponseDelay) {
      // 响应太慢，可能显得不专注
      timingScore = 0.4;
    } else if (Math.abs(responseDelay - this.config.optimalResponseTime) < 1000) {
      // 接近最佳响应时间
      timingScore = 0.9;
    } else {
      // 在可接受范围内
      timingScore = 0.7;
    }
    
    // 考虑对话节奏
    if (conversationPace === 'fast' && responseDelay > 5000) {
      timingScore *= 0.8; // 在快速对话中响应较慢
    } else if (conversationPace === 'slow' && responseDelay < 1000) {
      timingScore *= 0.8; // 在慢速对话中响应太快
    }
    
    return timingScore;
  }
  
  /**
   * 检测无意义互动
   */
  detectMeaninglessInteraction(interaction, context) {
    const { content } = interaction;
    
    if (!content || typeof content !== 'string') {
      return true; // 空内容视为无意义
    }
    
    // 检查内容长度
    if (content.trim().length < 5) {
      return true; // 内容过短
    }
    
    // 检查是否只是标点或符号
    const meaningfulChars = content.replace(/[\s\.,!?;:，。！？；：]/g, '');
    if (meaningfulChars.length < 3) {
      return true;
    }
    
    // 检查是否与近期内容高度重复
    const isRepetitive = this.checkRepetitiveness(interaction, context);
    if (isRepetitive) {
      return true;
    }
    
    // 检查是否只是简单回应词
    const simpleResponses = ['嗯', '哦', '啊', '好', '是的', '对', 'OK', 'ok', '好的'];
    const isSimpleResponse = simpleResponses.some(response => 
      content.trim().toLowerCase() === response.toLowerCase()
    );
    
    if (isSimpleResponse && content.trim().length < 10) {
      return true;
    }
    
    return false;
  }
  
  /**
   * 检查重复性
   */
  checkRepetitiveness(interaction, context) {
    const { content, sender_id } = interaction;
    const { conversationHistory = [] } = context;
    
    if (!content || conversationHistory.length === 0) {
      return false;
    }
    
    // 获取同一发送者的最近互动
    const recentInteractions = this.interactionHistory
      .filter(i => i.senderId === sender_id)
      .slice(-5);
    
    // 检查与最近互动的内容相似度
    for (const prevInteraction of recentInteractions) {
      if (prevInteraction.content) {
        const similarity = calculateSimilarity(content, prevInteraction.content);
        if (similarity > 0.9) { // 高度相似
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * 计算综合评分
   */
  calculateOverallScore(relevance, coherence, appropriateness, timing, isMeaningless) {
    if (isMeaningless) {
      return 0.2; // 无意义互动得分很低
    }
    
    const score = 
      relevance * this.config.relevanceWeight +
      coherence * this.config.coherenceWeight +
      appropriateness * this.config.appropriatenessWeight +
      timing * this.config.timingWeight;
    
    return Math.min(1, score);
  }
  
  /**
   * 生成改进建议
   */
  generateRecommendations(evaluation, context) {
    const recommendations = [];
    
    if (evaluation.scores.relevanceScore < this.config.relevanceThreshold) {
      recommendations.push('尝试更直接地回应对话中的具体内容，引用之前的讨论点');
    }
    
    if (evaluation.metrics.topicDeviation > this.config.topicDeviationThreshold) {
      recommendations.push('保持话题聚焦，避免突然转换不相关的主题');
    }
    
    if (evaluation.scores.appropriatenessScore < this.config.sentimentThreshold) {
      recommendations.push('调整语气使其更符合当前对话的社交语境');
    }
    
    if (evaluation.metrics.meaningless) {
      recommendations.push('提供更有实质性的内容，避免简单回应或重复');
    }
    
    // 添加通用建议
    if (recommendations.length === 0 && evaluation.overallScore < 0.8) {
      recommendations.push('考虑更深入地参与讨论，提供更有价值的见解');
    }
    
    return recommendations;
  }
  
  /**
   * 更新行为指标
   */
  updateBehaviorMetrics(evaluation) {
    this.interactionHistory.push({
      id: evaluation.interactionId,
      senderId: evaluation.senderId,
      senderType: evaluation.senderType,
      content: '', // 不存储具体内容以保护隐私
      timestamp: evaluation.timestamp,
      scores: evaluation.scores,
      metrics: evaluation.metrics,
      overallScore: evaluation.overallScore,
      isAppropriate: evaluation.isAppropriate
    });
    
    // 更新统计
    this.behaviorMetrics.totalInteractions++;
    
    if (evaluation.metrics.meaningless) {
      this.behaviorMetrics.meaninglessInteractions++;
    }
    
    if (evaluation.metrics.topicDeviation > this.config.topicDeviationThreshold) {
      this.behaviorMetrics.highDeviationInteractions++;
    }
    
    if (!evaluation.metrics.appropriate) {
      this.behaviorMetrics.inappropriateInteractions++;
    }
    
    // 记录最近的话题连贯性分数
    this.behaviorMetrics.recentTopicCoherence.push(evaluation.scores.coherenceScore);
    if (this.behaviorMetrics.recentTopicCoherence.length > 100) {
      this.behaviorMetrics.recentTopicCoherence = this.behaviorMetrics.recentTopicCoherence.slice(-100);
    }
    
    if (this.interactionHistory.length > this.maxInteractionHistory) {
      this.interactionHistory = this.interactionHistory.slice(-this.maxInteractionHistory);
    }
    
    if (this.interactionHistory.length > 1000) {
      this.interactionHistory = this.interactionHistory.slice(-1000);
    }
  }
  
  /**
   * 获取当前统计
   */
  getCurrentStats() {
    const total = this.behaviorMetrics.totalInteractions || 1;
    
    const meaninglessRate = this.behaviorMetrics.meaninglessInteractions / total;
    const deviationRate = this.behaviorMetrics.highDeviationInteractions / total;
    const inappropriateRate = this.behaviorMetrics.inappropriateInteractions / total;
    
    // 计算平均话题连贯性
    const avgCoherence = this.behaviorMetrics.recentTopicCoherence.length > 0 ?
      this.behaviorMetrics.recentTopicCoherence.reduce((sum, score) => sum + score, 0) / 
      this.behaviorMetrics.recentTopicCoherence.length : 0;
    
    return {
      totalInteractions: total,
      meaninglessInteractionRate: meaninglessRate,
      highDeviationRate: deviationRate,
      inappropriateRate: inappropriateRate,
      avgTopicCoherence: avgCoherence,
      meetsStandards: meaninglessRate <= this.config.meaninglessThreshold &&
                     deviationRate <= this.config.topicDeviationThreshold,
      thresholds: {
        meaningless: this.config.meaninglessThreshold,
        topicDeviation: this.config.topicDeviationThreshold
      }
    };
  }
  
  /**
   * 重置模型
   */
  reset() {
    this.interactionHistory = [];
    this.behaviorMetrics = {
      totalInteractions: 0,
      meaninglessInteractions: 0,
      highDeviationInteractions: 0,
      inappropriateInteractions: 0,
      recentTopicCoherence: []
    };
  }
  
  /**
   * 获取模型配置
   */
  getConfig() {
    return { ...this.config };
  }
  
  /**
   * 更新模型配置
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    return this.config;
  }
}

// 创建单例实例
const socialBehaviorModel = new SocialBehaviorModel();

export default socialBehaviorModel;

// 导出功能
export {
  socialBehaviorModel,
  SocialBehaviorModel
};