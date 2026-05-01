/**
 * 智能点赞算法模块
 * 基于内容相关性算法和情感分析模型的自动点赞机制
 * 目标准确率：85%以上
 */

// 简单的文本预处理函数
function preprocessText(text) {
  if (!text || typeof text !== 'string') return '';
  
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  const tokens = [];
  const chineseRegex = /[\u4e00-\u9fff]+/g;
  let lastIndex = 0;
  let match;
  
  while ((match = chineseRegex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      const nonChinesePart = cleaned.slice(lastIndex, match.index).trim();
      if (nonChinesePart) {
        tokens.push(...nonChinesePart.split(/\s+/).filter(w => w.length > 0));
      }
    }
    
    const chineseText = match[0];
    if (chineseText.length >= 2) {
      for (let i = 0; i <= chineseText.length - 2; i++) {
        tokens.push(chineseText.slice(i, i + 2));
      }
    } else {
      tokens.push(chineseText);
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  if (lastIndex < cleaned.length) {
    const remaining = cleaned.slice(lastIndex).trim();
    if (remaining) {
      tokens.push(...remaining.split(/\s+/).filter(w => w.length > 0));
    }
  }
  
  return tokens.join(' ');
}

// 计算TF-IDF相似度（简化版）
function calculateSimilarity(text1, text2) {
  const words1 = preprocessText(text1).split(' ');
  const words2 = preprocessText(text2).split(' ');
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  // 计算词频
  const freq1 = {};
  const freq2 = {};
  
  words1.forEach(word => {
    if (word.length > 2) { // 忽略短词
      freq1[word] = (freq1[word] || 0) + 1;
    }
  });
  
  words2.forEach(word => {
    if (word.length > 2) {
      freq2[word] = (freq2[word] || 0) + 1;
    }
  });
  
  // 计算余弦相似度
  const allWords = new Set([...Object.keys(freq1), ...Object.keys(freq2)]);
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;
  
  for (const word of allWords) {
    const f1 = freq1[word] || 0;
    const f2 = freq2[word] || 0;
    dotProduct += f1 * f2;
    norm1 += f1 * f1;
    norm2 += f2 * f2;
  }
  
  if (norm1 === 0 || norm2 === 0) return 0;
  
  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

// 简单的情感分析函数
function analyzeSentiment(text) {
  if (!text || typeof text !== 'string') return { score: 0, positive: 0, negative: 0, magnitude: 0 };
  
  const positiveWords = [
    '好', '优秀', '很棒', '厉害', '精彩', '有趣', '有用', '帮助', '感谢',
    '谢谢', '支持', '同意', '正确', '准确', '清晰', '明白', '理解',
    '喜欢', '爱', '开心', '高兴', '愉快', '满意', '成功', '胜利', '赢'
  ];
  
  const negativeWords = [
    '不好', '糟糕', '差', '错误', '不对', '问题', '困难', '难',
    '麻烦', '复杂', '混乱', '不清楚', '不明白', '不理解',
    '讨厌', '恨', '生气', '愤怒', '失望', '失败', '输', '错'
  ];
  
  const textLower = text.toLowerCase();
  let positiveScore = 0;
  let negativeScore = 0;
  let totalScore = 0;
  
  positiveWords.forEach(word => {
    if (textLower.includes(word)) {
      positiveScore++;
    }
  });
  
  negativeWords.forEach(word => {
    if (textLower.includes(word)) {
      negativeScore++;
    }
  });
  
  // 计算情感得分 (-1 到 1)
  totalScore = (positiveScore - negativeScore) / Math.max(1, (positiveScore + negativeScore));
  
  return {
    score: totalScore,
    positive: positiveScore,
    negative: negativeScore,
    magnitude: positiveScore + negativeScore
  };
}

// AI社交行为规范检查
function checkSocialBehavior(message, contextMessages = []) {
  if (!message || typeof message !== 'object') return { valid: false, reason: '无效消息' };
  
  const checks = {
    hasContent: message.content && message.content.trim().length > 0,
    isRelevant: true,
    isAppropriate: true,
    isMeaningful: message.content && message.content.trim().length > 5
  };
  
  let topicDeviation = 0;
  if (contextMessages.length > 0) {
    const recentContext = contextMessages.slice(-5);
    let maxSimilarity = 0;
    recentContext.forEach(ctxMsg => {
      if (ctxMsg && ctxMsg.content) {
        const similarity = calculateSimilarity(message.content, ctxMsg.content);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
      }
    });
    topicDeviation = 1 - maxSimilarity;
  }
  
  const isMeaningless = !checks.isMeaningful || topicDeviation > 0.85;
  
  return {
    valid: checks.hasContent && checks.isMeaningful && topicDeviation <= 0.85,
    checks,
    topicDeviation,
    isMeaningless,
    details: {
      contentLength: message.content ? message.content.length : 0,
      hasMeaningfulContent: checks.isMeaningful,
      topicRelevance: 1 - topicDeviation
    }
  };
}

// 智能点赞决策引擎
class SmartLikeEngine {
  constructor() {
    this.history = [];
    this.config = {
      relevanceWeight: 0.4,
      sentimentWeight: 0.3,
      qualityWeight: 0.2,
      historyWeight: 0.1,
      threshold: 0.55,
      minContentLength: 8,
      maxContentLength: 5000
    };
  }
  
  /**
   * 评估消息是否应该获得自动点赞
   * @param {Object} message - 当前消息
   * @param {Array} contextMessages - 上下文消息数组
   * @param {Object} senderInfo - 发送者信息
   * @returns {Object} 评估结果
   */
  evaluateMessage(message, contextMessages = [], senderInfo = {}) {
    if (!message || !message.content) {
      return {
        shouldLike: false,
        score: 0,
        reasons: ['消息内容为空'],
        details: {}
      };
    }
    
    // 检查消息长度
    if (message.content.length < this.config.minContentLength) {
      return {
        shouldLike: false,
        score: 0,
        reasons: [`消息内容过短（${message.content.length} < ${this.config.minContentLength}）`],
        details: { contentLength: message.content.length }
      };
    }
    
    // 1. 内容相关性分析
    let relevanceScore = 0;
    if (contextMessages.length > 0) {
      const recentMessages = contextMessages.slice(-5);
      let totalSimilarity = 0;
      let count = 0;
      
      recentMessages.forEach(ctxMsg => {
        if (ctxMsg && ctxMsg.content) {
          const similarity = calculateSimilarity(message.content, ctxMsg.content);
          totalSimilarity += similarity;
          count++;
        }
      });
      
      relevanceScore = count > 0 ? totalSimilarity / count : 0.6;
    } else {
      relevanceScore = 0.6;
    }
    
    // 2. 情感分析
    const sentimentResult = analyzeSentiment(message.content);
    const sentimentScore = (sentimentResult.score + 1) / 2;
    
    // 3. 内容质量评分
    const qualityScore = this.calculateQualityScore(message);
    
    // 4. 历史互动模式
    const historyScore = this.calculateHistoryScore(message, senderInfo);
    
    // 5. 社交行为规范检查
    const behaviorCheck = checkSocialBehavior(message, contextMessages);
    
    // 6. 综合评分
    const totalScore = 
      relevanceScore * this.config.relevanceWeight +
      sentimentScore * this.config.sentimentWeight +
      qualityScore * this.config.qualityWeight +
      historyScore * this.config.historyWeight;
    
    // 6. 决策
    const shouldLike = totalScore >= this.config.threshold && behaviorCheck.valid;
    
    // 记录历史
    this.recordEvaluation(message, totalScore, shouldLike);
    
    return {
      shouldLike,
      score: totalScore,
      relevanceScore,
      sentimentScore: sentimentResult.score,
      sentimentDetails: sentimentResult,
      historyScore,
      behaviorCheck,
      thresholds: {
        required: this.config.threshold,
        current: totalScore
      },
      reasons: shouldLike ? [
        `内容相关性高（${relevanceScore.toFixed(2)}）`,
        `情感倾向积极（${sentimentResult.score.toFixed(2)}）`,
        `符合社交规范`
      ] : [
        `综合评分不足（${totalScore.toFixed(2)} < ${this.config.threshold}）`,
        ...(behaviorCheck.valid ? [] : [`社交行为检查未通过: ${behaviorCheck.reason || '话题偏离度过高'}`])
      ],
      details: {
        contentPreview: message.content.length > 50 ? 
          message.content.substring(0, 50) + '...' : message.content,
        sender: senderInfo,
        timestamp: new Date().toISOString()
      }
    };
  }
  
  /**
   * 计算内容质量分数
   */
  calculateQualityScore(message) {
    const content = message.content || '';
    let score = 0.5;
    
    // 内容长度评分
    const length = content.length;
    if (length >= 20 && length <= 500) {
      score += 0.15;
    } else if (length >= 10 && length <= 1000) {
      score += 0.1;
    }
    
    // 包含代码片段加分
    if (content.includes('```') || content.includes('`')) {
      score += 0.1;
    }
    
    // 包含列表加分
    if (content.includes('- ') || content.includes('* ') || /\d+\./.test(content)) {
      score += 0.05;
    }
    
    // 包含引用加分
    if (content.includes('> ')) {
      score += 0.05;
    }
    
    // 包含表情符号减分（可能过于随意）
    const emojiCount = (content.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu) || []).length;
    if (emojiCount > 3) {
      score -= 0.05;
    }
    
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 计算历史互动分数
   */
  calculateHistoryScore(message, senderInfo) {
    if (!senderInfo.id || this.history.length === 0) return 0.5;
    
    // 获取该发送者的历史互动记录
    const senderHistory = this.history.filter(
      item => item.senderId === senderInfo.id
    ).slice(-10); // 最近10次
    
    if (senderHistory.length === 0) return 0.5;
    
    // 计算历史平均得分
    const avgScore = senderHistory.reduce((sum, item) => sum + item.score, 0) / senderHistory.length;
    
    // 计算互动频率（最近10分钟内）
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const recentInteractions = senderHistory.filter(
      item => new Date(item.timestamp).getTime() > tenMinutesAgo
    ).length;
    
    // 互动频率越高，分数略减（避免过度互动）
    const frequencyPenalty = Math.min(recentInteractions * 0.05, 0.2);
    
    return Math.max(0, Math.min(1, avgScore - frequencyPenalty));
  }
  
  /**
   * 记录评估结果
   */
  recordEvaluation(message, score, liked) {
    this.history.push({
      messageId: message.id,
      senderId: message.sender_id,
      score,
      liked,
      timestamp: new Date().toISOString()
    });
    
    // 保持历史记录不超过1000条
    if (this.history.length > 1000) {
      this.history = this.history.slice(-1000);
    }
  }
  
  /**
   * 获取引擎统计信息
   */
  getStats() {
    const totalEvaluations = this.history.length;
    const likedCount = this.history.filter(item => item.liked).length;
    const avgScore = totalEvaluations > 0 ? 
      this.history.reduce((sum, item) => sum + item.score, 0) / totalEvaluations : 0;
    
    return {
      totalEvaluations,
      likedCount,
      likeRate: totalEvaluations > 0 ? likedCount / totalEvaluations : 0,
      avgScore,
      config: this.config,
      recentActivity: this.history.slice(-10)
    };
  }
  
  /**
   * 更新配置
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    return this.config;
  }
}

// 创建单例实例
const smartLikeEngine = new SmartLikeEngine();

// 导出功能
export {
  smartLikeEngine,
  calculateSimilarity,
  analyzeSentiment,
  checkSocialBehavior,
  preprocessText
};

export default smartLikeEngine;