/**
 * 上下文感知评论算法模块
 * 支持嵌套式回复系统（5层级），评论相关性评分≥0.7
 */

import { calculateSimilarity, analyzeSentiment } from './smartLike.js';

// 上下文感知评论分析器
class ContextAwareCommentAnalyzer {
  constructor() {
    this.config = {
      minRelevanceScore: 0.7,      // 最小相关性评分
      maxDepth: 5,                 // 最大嵌套深度
      contextWindowSize: 3,        // 上下文窗口大小（条消息）
      sentimentWeight: 0.3,
      relevanceWeight: 0.4,
      contextCoherenceWeight: 0.15,
      threadCoherenceWeight: 0.15
    };
  }
  
  /**
   * 分析评论的上下文相关性
   * @param {Object} comment - 评论对象
   * @param {Object} targetMessage - 目标消息
   * @param {Array} messageContext - 消息上下文（最近的消息）
   * @param {Array} commentThread - 评论线程（父评论链）
   * @returns {Object} 分析结果
   */
  analyzeComment(comment, targetMessage, messageContext = [], commentThread = []) {
    const analysis = {
      commentId: comment.id,
      targetMessageId: targetMessage.id,
      timestamp: new Date().toISOString(),
      relevanceScores: {},
      overallScore: 0,
      isValid: false,
      depth: commentThread.length,
      exceedsMaxDepth: false,
      recommendations: []
    };
    
    // 检查嵌套深度
    const currentDepth = commentThread.length;
    analysis.exceedsMaxDepth = currentDepth >= this.config.maxDepth;
    analysis.depth = currentDepth;
    
    if (analysis.exceedsMaxDepth) {
      analysis.isValid = false;
      analysis.recommendations.push(`评论嵌套深度超过限制（${currentDepth} > ${this.config.maxDepth}）`);
      return analysis;
    }
    
    // 1. 计算与目标消息的相关性
    const messageRelevance = this.calculateMessageRelevance(comment, targetMessage);
    analysis.relevanceScores.messageRelevance = messageRelevance;
    
    // 2. 计算与消息上下文的相关性
    const contextRelevance = this.calculateContextRelevance(comment, messageContext);
    analysis.relevanceScores.contextRelevance = contextRelevance;
    
    // 3. 计算与评论线程的连贯性
    const threadCoherence = this.calculateThreadCoherence(comment, commentThread);
    analysis.relevanceScores.threadCoherence = threadCoherence;
    
    // 4. 情感分析
    const sentiment = analyzeSentiment(comment.content);
    analysis.relevanceScores.sentimentScore = (sentiment.score + 1) / 2; // 归一化到0-1
    
    // 5. 计算综合评分
    analysis.overallScore = this.calculateOverallScore(
      messageRelevance,
      contextRelevance,
      threadCoherence,
      analysis.relevanceScores.sentimentScore
    );
    
    // 6. 有效性判断
    analysis.isValid = analysis.overallScore >= this.config.minRelevanceScore;
    
    // 7. 生成建议
    if (!analysis.isValid) {
      if (messageRelevance < 0.5) {
        analysis.recommendations.push('评论与原始消息相关性较低，建议更直接地回应消息内容');
      }
      if (threadCoherence < 0.5 && commentThread.length > 0) {
        analysis.recommendations.push('评论与评论线程的连贯性不足，建议更直接地回应之前的评论');
      }
      if (analysis.relevanceScores.sentimentScore < 0.3) {
        analysis.recommendations.push('评论情感倾向较为消极，建议调整语气');
      }
    } else {
      analysis.recommendations.push('评论符合上下文相关性要求');
    }
    
    // 8. 深度建议
    if (currentDepth > 0) {
      const parentComment = commentThread[commentThread.length - 1];
      const parentRelevance = calculateSimilarity(comment.content, parentComment.content || '');
      analysis.relevanceScores.parentRelevance = parentRelevance;
      
      if (parentRelevance < 0.6) {
        analysis.recommendations.push('与父评论的相关性较低，建议更直接地回应父评论');
      }
    }
    
    return analysis;
  }
  
  /**
   * 计算评论与目标消息的相关性
   */
  calculateMessageRelevance(comment, targetMessage) {
    if (!comment.content || !targetMessage.content) return 0;
    
    // 直接相关性
    const directRelevance = calculateSimilarity(comment.content, targetMessage.content);
    
    // 检查是否包含关键词引用（如"这个消息"、"上述内容"等）
    const referenceKeywords = ['这个消息', '上述', '上面', '之前提到', '你说', '您说', '这个观点'];
    const hasReference = referenceKeywords.some(keyword => 
      comment.content.includes(keyword)
    );
    
    const referenceBonus = hasReference ? 0.1 : 0;
    
    return Math.min(1, directRelevance + referenceBonus);
  }
  
  /**
   * 计算评论与消息上下文的相关性
   */
  calculateContextRelevance(comment, messageContext) {
    if (!comment.content || messageContext.length === 0) return 0.5; // 默认值
    
    let totalRelevance = 0;
    let count = 0;
    
    // 计算与最近几条消息的平均相关性
    const recentMessages = messageContext.slice(-this.config.contextWindowSize);
    
    recentMessages.forEach(msg => {
      if (msg && msg.content) {
        const relevance = calculateSimilarity(comment.content, msg.content);
        totalRelevance += relevance;
        count++;
      }
    });
    
    return count > 0 ? totalRelevance / count : 0.5;
  }
  
  /**
   * 计算评论与评论线程的连贯性
   */
  calculateThreadCoherence(comment, commentThread) {
    if (commentThread.length === 0) return 1.0; // 没有父评论时，连贯性为完美
    
    const parentComment = commentThread[commentThread.length - 1];
    if (!parentComment || !parentComment.content) return 0.5;
    
    // 计算与父评论的直接相似性
    const directCoherence = calculateSimilarity(comment.content, parentComment.content);
    
    // 检查是否明确回复（包含@或回复关键词）
    const replyKeywords = ['@', '回复', '回答', '回应', '针对', '关于你的'];
    const hasExplicitReply = replyKeywords.some(keyword => 
      comment.content.includes(keyword)
    );
    
    const replyBonus = hasExplicitReply ? 0.15 : 0;
    
    // 检查是否保持话题一致
    const topicKeywords = this.extractTopics(parentComment.content);
    const topicMatchScore = this.calculateTopicMatch(comment.content, topicKeywords);
    
    const coherenceScore = 
      directCoherence * 0.6 + 
      replyBonus * 0.2 + 
      topicMatchScore * 0.2;
    
    return Math.min(1, coherenceScore);
  }
  
  /**
   * 提取话题关键词
   */
  extractTopics(text) {
    if (!text || typeof text !== 'string') return [];
    
    // 简单的关键词提取（在实际应用中可以使用更复杂的NLP技术）
    const stopWords = ['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'];
    
    const words = text
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
    
    // 返回频率最高的5个词作为话题关键词
    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }
  
  /**
   * 计算话题匹配度
   */
  calculateTopicMatch(commentText, topicKeywords) {
    if (!commentText || topicKeywords.length === 0) return 0;
    
    const commentWords = commentText
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/);
    
    let matchedTopics = 0;
    topicKeywords.forEach(keyword => {
      if (commentWords.includes(keyword)) {
        matchedTopics++;
      }
    });
    
    return matchedTopics / topicKeywords.length;
  }
  
  /**
   * 计算综合评分
   */
  calculateOverallScore(messageRelevance, contextRelevance, threadCoherence, sentimentScore) {
    return (
      messageRelevance * this.config.relevanceWeight +
      contextRelevance * this.config.contextCoherenceWeight +
      threadCoherence * this.config.threadCoherenceWeight +
      sentimentScore * this.config.sentimentWeight
    );
  }
  
  /**
   * 生成AI评论建议
   * @param {Object} targetMessage - 目标消息
   * @param {Array} commentThread - 评论线程
   * @param {string} aiPersonality - AI个性（可选）
   * @returns {Array} 评论建议列表
   */
  generateCommentSuggestions(targetMessage, commentThread = [], aiPersonality = 'neutral') {
    const suggestions = [];
    const messageContent = targetMessage.content || '';
    
    if (commentThread.length === 0) {
      // 对原始消息的评论建议
      suggestions.push({
        content: `我对这个消息很感兴趣：${messageContent.substring(0, 50)}${messageContent.length > 50 ? '...' : ''}`,
        relevance: 0.8,
        type: 'general_response'
      });
      
      suggestions.push({
        content: `这个观点很有见地，我特别赞同关于${this.extractMainTopic(messageContent) || '这个话题'}的部分`,
        relevance: 0.85,
        type: 'agreement'
      });
      
      suggestions.push({
        content: `从另一个角度考虑这个问题的话，${this.generateAlternativeViewpoint(messageContent)}`,
        relevance: 0.75,
        type: 'alternative_view'
      });
    } else {
      // 对评论的回复建议
      const parentComment = commentThread[commentThread.length - 1];
      const parentContent = parentComment.content || '';
      
      suggestions.push({
        content: `@${parentComment.sender_id || '用户'} 我理解你的观点，${this.generateAgreementExtension(parentContent)}`,
        relevance: 0.9,
        type: 'reply_agreement'
      });
      
      suggestions.push({
        content: `@${parentComment.sender_id || '用户'} 关于你说的"${parentContent.substring(0, 30)}..."，我有一个问题：${this.generateQuestion(parentContent)}`,
        relevance: 0.8,
        type: 'reply_question'
      });
      
      suggestions.push({
        content: `@${parentComment.sender_id || '用户'} 我补充一点：${this.generateAddition(parentContent)}`,
        relevance: 0.85,
        type: 'reply_addition'
      });
    }
    
    // 根据AI个性调整建议
    if (aiPersonality === 'logical') {
      suggestions.forEach(s => {
        s.content = s.content.replace('我', '从逻辑角度分析，');
        s.relevance *= 1.1;
      });
    } else if (aiPersonality === 'friendly') {
      suggestions.forEach(s => {
        s.content = s.content.replace('我', '我觉得');
        if (!s.content.includes('！')) s.content += '！';
      });
    }
    
    return suggestions;
  }
  
  /**
   * 提取主要话题
   */
  extractMainTopic(text) {
    if (!text) return '';
    
    const topics = this.extractTopics(text);
    return topics.length > 0 ? topics[0] : '';
  }
  
  /**
   * 生成替代观点
   */
  generateAlternativeViewpoint(text) {
    const alternatives = [
      '可能还有其他的解决方案。',
      '也许我们可以从不同的角度来看待这个问题。',
      '这个问题的另一面也值得考虑。',
      '我想到一个不同的思路。'
    ];
    
    return alternatives[Math.floor(Math.random() * alternatives.length)];
  }
  
  /**
   * 生成同意延伸
   */
  generateAgreementExtension(text) {
    const extensions = [
      '并且我还想补充一点。',
      '这个观点让我联想到相关的话题。',
      '我完全同意，特别是因为。',
      '你说的对，这让我想到了另一个相关的问题。'
    ];
    
    return extensions[Math.floor(Math.random() * extensions.length)];
  }
  
  /**
   * 生成问题
   */
  generateQuestion(text) {
    const questions = [
      '你能详细解释一下吗？',
      '这个观点的依据是什么？',
      '如果遇到相反的情况会怎样？',
      '这个解决方案的可行性如何？'
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }
  
  /**
   * 生成补充内容
   */
  generateAddition(text) {
    const additions = [
      '相关的资料显示...',
      '根据我的了解...',
      '从实践经验来看...',
      '历史上的类似案例表明...'
    ];
    
    return additions[Math.floor(Math.random() * additions.length)];
  }
  
  /**
   * 构建嵌套评论树
   * @param {Array} flatComments - 扁平评论列表
   * @returns {Array} 嵌套评论树
   */
  buildCommentTree(flatComments) {
    if (!Array.isArray(flatComments) || flatComments.length === 0) {
      return [];
    }
    
    const commentMap = {};
    const rootComments = [];
    
    // 创建映射并初始化replies数组
    flatComments.forEach(comment => {
      commentMap[comment.id] = { ...comment, replies: [] };
    });
    
    // 构建树结构
    flatComments.forEach(comment => {
      const node = commentMap[comment.id];
      
      if (comment.parent_id && commentMap[comment.parent_id]) {
        // 有父评论，添加到父评论的replies中
        commentMap[comment.parent_id].replies.push(node);
        // 计算深度
        node.depth = (commentMap[comment.parent_id].depth || 0) + 1;
      } else {
        // 根评论
        node.depth = 0;
        rootComments.push(node);
      }
    });
    
    // 对每个节点的replies按时间排序
    Object.values(commentMap).forEach(node => {
      if (node.replies.length > 0) {
        node.replies.sort((a, b) => 
          new Date(a.created_at) - new Date(b.created_at)
        );
      }
    });
    
    // 对根评论按时间排序
    rootComments.sort((a, b) => 
      new Date(a.created_at) - new Date(b.created_at)
    );
    
    return rootComments;
  }
  
  /**
   * 验证评论深度
   * @param {string} parentId - 父评论ID
   * @param {Array} commentTree - 评论树
   * @returns {Object} 验证结果
   */
  validateCommentDepth(parentId, commentTree) {
    if (!parentId) {
      return { valid: true, depth: 0, maxDepth: this.config.maxDepth };
    }
    
    // 查找父评论并计算深度
    const findCommentDepth = (comments, targetId, currentDepth = 0) => {
      for (const comment of comments) {
        if (comment.id === targetId) {
          return currentDepth + 1;
        }
        
        if (comment.replies && comment.replies.length > 0) {
          const depth = findCommentDepth(comment.replies, targetId, currentDepth + 1);
          if (depth !== -1) return depth;
        }
      }
      return -1;
    };
    
    const depth = findCommentDepth(commentTree, parentId, 0);
    
    if (depth === -1) {
      return { valid: false, depth: 0, maxDepth: this.config.maxDepth, error: '父评论未找到' };
    }
    
    const valid = depth < this.config.maxDepth;
    
    return {
      valid,
      depth,
      maxDepth: this.config.maxDepth,
      error: valid ? null : `评论嵌套深度超过限制（${depth} >= ${this.config.maxDepth}）`
    };
  }
}

// 创建单例实例
const contextAwareCommentAnalyzer = new ContextAwareCommentAnalyzer();

export default contextAwareCommentAnalyzer;

// 导出功能
export {
  contextAwareCommentAnalyzer,
  ContextAwareCommentAnalyzer
};