/**
 * AI模型负载均衡与故障转移机制
 * 支持多个AI模型（deepseek、deepseek_reasoner、glm、mimo、qwen）的负载均衡，故障自动切换
 * 目标：模型调用成功率≥99%，API响应时间≤1.5秒，模型输出内容相关性评分≥4.0/5
 */

import axios from 'axios';
import { aiHealthStatus } from './index.js';

// 模型配置（从环境变量读取）
const MODEL_CONFIGS = {
  deepseek: {
    name: 'DeepSeek',
    apiKey: process.env.DEEPSEEK_API_KEY || 'sk-d3a1fe234c19415c9d2ad7ac679a3c72',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    enabled: true,
    priority: 1
  },
  deepseek_reasoner: {
    name: 'DeepSeek Reasoner',
    apiKey: process.env.DEEPSEEK_API_KEY || 'sk-d3a1fe234c19415c9d2ad7ac679a3c72',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-reasoner',
    enabled: true,
    priority: 2
  },
  glm: {
    name: 'GLM',
    apiKey: process.env.GLM_API_KEY || '4d1ab3a3f2614cd5aa65b61a86c9ffe8.KKqxIjcMfMZ9TxqW',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'GLM-4.5-Air',
    enabled: true,
    priority: 3
  },
  mimo: {
    name: 'MiMo',
    apiKey: process.env.MIMO_API_KEY || 'sk-c5db8fo9m0duxxc21n0yve8fxm66qqu2nk63f052whwnk4il',
    endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2-flash',
    enabled: true,
    priority: 4
  },
  qwen: {
    name: 'Qwen',
    apiKey: process.env.QWEN_API_KEY || 'sk-4d623ee9fe964e4f972fea98da89006b',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3.5-flash',
    enabled: true,
    priority: 5
  }
};

// 性能指标要求
const PERFORMANCE_REQUIREMENTS = {
  minSuccessRate: 0.99,      // 成功率≥99%
  maxResponseTime: 1500,     // 响应时间≤1.5秒
  minRelevanceScore: 4.0     // 相关性评分≥4.0/5
};

class AILoadBalancer {
  constructor() {
    this.models = new Map();
    this.metrics = new Map();
    this.healthStatus = new Map();
    this.circuitBreakers = new Map();
    
    // 初始化模型
    this.initializeModels();
    
    // 延迟初始健康检查（等待 aiHealthStatus 初始化完成）
    setTimeout(() => this.performInitialHealthChecks(), 100);
    
    // 定期健康检查（每5分钟）
    setInterval(() => this.performHealthChecks(), 5 * 60 * 1000);
    
    // 定期清理旧指标（每小时）
    setInterval(() => this.cleanupOldMetrics(), 60 * 60 * 1000);
  }
  
  /**
   * 初始化模型
   */
  initializeModels() {
    Object.entries(MODEL_CONFIGS).forEach(([id, config]) => {
      if (config.enabled) {
        this.models.set(id, {
          id,
          ...config,
          metrics: {
            totalCalls: 0,
            successfulCalls: 0,
            failedCalls: 0,
            totalResponseTime: 0,
            relevanceScores: [],
            lastCallTime: null,
            lastSuccessTime: null,
            lastError: null
          }
        });
        
        // 初始化断路器
        this.circuitBreakers.set(id, {
          failureCount: 0,
          lastFailureTime: null,
          state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
          nextAttempt: null
        });
      }
    });
  }
  
  /**
   * 执行初始健康检查
   */
  async performInitialHealthChecks() {
    const promises = Array.from(this.models.keys()).map(async (modelId) => {
      try {
        await this.healthCheck(modelId);
        console.log(`✅ 模型 ${modelId} 初始健康检查通过`);
      } catch (error) {
        console.warn(`⚠️  模型 ${modelId} 初始健康检查失败:`, error.message);
      }
    });
    
    await Promise.allSettled(promises);
  }
  
  /**
   * 定期健康检查
   */
  async performHealthChecks() {
    console.log('🔄 执行AI模型定期健康检查（读取统一健康状态）...');
    
    for (const [modelId, model] of this.models.entries()) {
      const status = aiHealthStatus.get(modelId);
      if (status && status.status === 'healthy') {
        this.healthStatus.set(modelId, 'healthy');
        console.log(`✅ 模型 ${modelId} 健康检查通过 (响应时间: ${status.responseTime}ms)`);
      } else {
        this.healthStatus.set(modelId, 'unhealthy');
        const errorMsg = status?.error || '未知错误';
        console.warn(`❌ 模型 ${modelId} 健康检查失败:`, errorMsg);
      }
    }
  }
  
  /**
   * 健康检查
   */
  async healthCheck(modelId) {
    const model = this.models.get(modelId);
    if (!model) throw new Error(`模型 ${modelId} 不存在`);
    
    const status = aiHealthStatus.get(modelId);
    if (status && status.status === 'healthy') {
      return true;
    } else {
      throw new Error(status?.error || `模型 ${modelId} 不健康`);
    }
  }
  
  /**
   * 选择最佳模型
   * @param {string} preference - 优先选择的模型ID
   * @returns {string} 选择的模型ID
   */
  selectModel(preference = null) {
    // 1. 过滤可用的模型
    const availableModels = Array.from(this.models.entries())
      .filter(([modelId, model]) => {
        // 检查是否启用
        if (!model.enabled) return false;
        
        // 检查断路器状态
        const breaker = this.circuitBreakers.get(modelId);
        if (breaker.state === 'OPEN') {
          // 如果断路器打开，检查是否可以重试
          if (breaker.nextAttempt && Date.now() >= breaker.nextAttempt) {
            breaker.state = 'HALF_OPEN';
            breaker.nextAttempt = null;
          } else {
            return false;
          }
        }
        
        // 检查健康状态
        const health = this.healthStatus.get(modelId);
        return health !== 'unhealthy';
      });
    
    if (availableModels.length === 0) {
      throw new Error('没有可用的AI模型');
    }
    
    // 2. 如果有偏好且可用，优先选择
    if (preference && availableModels.some(([id]) => id === preference)) {
      return preference;
    }
    
    // 3. 基于优先级和性能指标选择
    const scoredModels = availableModels.map(([modelId, model]) => {
      const metrics = model.metrics;
      const breaker = this.circuitBreakers.get(modelId);
      
      // 计算性能得分
      let score = 0;
      
      // 成功率得分（权重40%）
      const successRate = metrics.totalCalls > 0 ? 
        metrics.successfulCalls / metrics.totalCalls : 1;
      score += successRate * 40;
      
      // 响应时间得分（权重30%）
      const avgResponseTime = metrics.successfulCalls > 0 ?
        metrics.totalResponseTime / metrics.successfulCalls : 0;
      const responseTimeScore = avgResponseTime > 0 ?
        Math.max(0, 1 - avgResponseTime / PERFORMANCE_REQUIREMENTS.maxResponseTime) : 1;
      score += responseTimeScore * 30;
      
      // 相关性得分（权重20%）
      const relevanceScore = metrics.relevanceScores.length > 0 ?
        metrics.relevanceScores.reduce((a, b) => a + b, 0) / metrics.relevanceScores.length : 5;
      const normalizedRelevance = relevanceScore / 5; // 归一化到0-1
      score += normalizedRelevance * 20;
      
      // 优先级得分（权重10%）
      const priorityScore = (5 - model.priority) * 2; // 优先级1得8分，优先级4得2分
      score += priorityScore;
      
      // 断路器惩罚
      if (breaker.state === 'HALF_OPEN') {
        score *= 0.5; // 半开状态减半
      }
      
      // 最近失败惩罚
      if (breaker.failureCount > 0) {
        score *= Math.max(0.1, 1 - (breaker.failureCount * 0.1));
      }
      
      return { modelId, score, metrics };
    });
    
    // 按得分排序
    scoredModels.sort((a, b) => b.score - a.score);
    
    // 返回得分最高的模型
    return scoredModels[0].modelId;
  }
  
  /**
   * 调用AI模型
   * @param {Object} params - 调用参数
   * @param {string} params.preference - 优先模型
   * @param {Array} params.messages - 消息列表
   * @param {Object} params.options - 其他选项
   * @returns {Promise<Object>} 调用结果
   */
  async callModel(params) {
    const { preference, messages, options = {} } = params;
    
    let selectedModelId = null;
    let lastError = null;
    let attempts = 0;
    const maxAttempts = this.models.size; // 最多尝试所有模型
    
    while (attempts < maxAttempts) {
      attempts++;
      
      try {
        // 选择模型
        selectedModelId = this.selectModel(attempts === 1 ? preference : null);
        const model = this.models.get(selectedModelId);
        
        if (!model) {
          throw new Error(`模型 ${selectedModelId} 不存在`);
        }
        
        // 记录开始时间
        const startTime = Date.now();
        
        // 准备请求参数
        const requestData = {
          model: model.model,
          messages,
          max_tokens: options.max_tokens || 1000,
          temperature: options.temperature || 0.8,
          ...options
        };
        
        // 设置超时
        const timeout = options.timeout || 15000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
          // 发送请求
          const response = await axios.post(model.endpoint, requestData, {
            headers: {
              'Authorization': `Bearer ${model.apiKey}`,
              'Content-Type': 'application/json'
            },
            signal: controller.signal,
            timeout: timeout
          });
          
          clearTimeout(timeoutId);
          
          // 计算响应时间
          const responseTime = Date.now() - startTime;
          
          // 记录成功指标
          this.recordSuccess(selectedModelId, responseTime);
          
          // 重置断路器
          this.resetCircuitBreaker(selectedModelId);
          
          return {
            success: true,
            modelId: selectedModelId,
            modelName: model.name,
            content: response.data.choices[0].message.content,
            responseTime,
            meetsRequirements: {
              responseTime: responseTime <= PERFORMANCE_REQUIREMENTS.maxResponseTime,
              // 相关性评分需要后续计算
            },
            rawResponse: response.data
          };
          
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
        
      } catch (error) {
        lastError = error;
        
        // 记录失败
        if (selectedModelId) {
          this.recordFailure(selectedModelId, error);
        }
        
        // 如果还有模型可尝试，继续
        if (attempts < maxAttempts) {
          console.warn(`模型 ${selectedModelId} 调用失败，尝试下一个模型:`, error.message);
          // 短暂延迟后重试
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
      }
    }
    
    // 所有尝试都失败
    throw new Error(`所有AI模型调用失败，最后错误: ${lastError?.message}`);
  }
  
  /**
   * 记录成功调用
   */
  recordSuccess(modelId, responseTime, relevanceScore = null) {
    const model = this.models.get(modelId);
    if (!model) return;
    
    const metrics = model.metrics;
    metrics.totalCalls++;
    metrics.successfulCalls++;
    metrics.totalResponseTime += responseTime;
    metrics.lastCallTime = Date.now();
    metrics.lastSuccessTime = Date.now();
    metrics.lastError = null;
    
    if (relevanceScore !== null) {
      metrics.relevanceScores.push(relevanceScore);
      // 保持最近100个评分
      if (metrics.relevanceScores.length > 100) {
        metrics.relevanceScores = metrics.relevanceScores.slice(-100);
      }
    }
    
    // 重置断路器
    const breaker = this.circuitBreakers.get(modelId);
    if (breaker) {
      breaker.failureCount = 0;
      breaker.state = 'CLOSED';
      breaker.lastFailureTime = null;
      breaker.nextAttempt = null;
    }
  }
  
  /**
   * 记录失败调用
   */
  recordFailure(modelId, error) {
    const model = this.models.get(modelId);
    if (!model) return;
    
    const metrics = model.metrics;
    metrics.totalCalls++;
    metrics.failedCalls++;
    metrics.lastCallTime = Date.now();
    metrics.lastError = error.message;
    
    // 更新断路器
    const breaker = this.circuitBreakers.get(modelId);
    if (breaker) {
      breaker.failureCount++;
      breaker.lastFailureTime = Date.now();
      
      // 如果连续失败超过阈值，打开断路器
      if (breaker.failureCount >= 5) {
        breaker.state = 'OPEN';
        // 30秒后进入半开状态
        breaker.nextAttempt = Date.now() + 30000;
        console.warn(`🚨 模型 ${modelId} 断路器打开，30秒后重试`);
      }
    }
  }
  
  /**
   * 重置断路器
   */
  resetCircuitBreaker(modelId) {
    const breaker = this.circuitBreakers.get(modelId);
    if (breaker) {
      breaker.failureCount = 0;
      breaker.state = 'CLOSED';
      breaker.lastFailureTime = null;
      breaker.nextAttempt = null;
    }
  }
  
  /**
   * 计算相关性评分（简化版）
   * 在实际应用中，这可能需要更复杂的算法
   */
  calculateRelevanceScore(originalPrompt, aiResponse) {
    // 简化的相关性评分
    // 1. 关键词匹配
    const promptWords = new Set(originalPrompt.toLowerCase().split(/\s+/));
    const responseWords = new Set(aiResponse.toLowerCase().split(/\s+/));
    
    const intersection = [...promptWords].filter(w => responseWords.has(w)).length;
    const union = new Set([...promptWords, ...responseWords]).size;
    
    const keywordScore = union > 0 ? intersection / union : 0;
    
    // 2. 响应长度适当性（100-500字为佳）
    const lengthPenalty = aiResponse.length < 50 ? 0.7 : 
                         aiResponse.length > 1000 ? 0.8 : 1.0;
    
    // 3. 综合评分（1-5分）
    const rawScore = keywordScore * 5;
    const finalScore = Math.min(5, Math.max(1, rawScore * lengthPenalty));
    
    return finalScore;
  }
  
  /**
   * 清理旧指标
   */
  cleanupOldMetrics() {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    
    // 清理超过24小时的指标（示例）
    // 在实际应用中，可能需要更复杂的指标保留策略
    console.log('🧹 清理旧的AI模型指标数据...');
  }
  
  /**
   * 获取模型统计信息
   */
  getModelStats() {
    const stats = {};
    
    for (const [modelId, model] of this.models.entries()) {
      const metrics = model.metrics;
      const breaker = this.circuitBreakers.get(modelId);
      const health = this.healthStatus.get(modelId);
      
      const successRate = metrics.totalCalls > 0 ? 
        metrics.successfulCalls / metrics.totalCalls : 1;
      
      const avgResponseTime = metrics.successfulCalls > 0 ?
        metrics.totalResponseTime / metrics.successfulCalls : 0;
      
      const avgRelevanceScore = metrics.relevanceScores.length > 0 ?
        metrics.relevanceScores.reduce((a, b) => a + b, 0) / metrics.relevanceScores.length : null;
      
      stats[modelId] = {
        name: model.name,
        enabled: model.enabled,
        health: health || 'unknown',
        circuitBreaker: breaker ? breaker.state : 'unknown',
        metrics: {
          totalCalls: metrics.totalCalls,
          successfulCalls: metrics.successfulCalls,
          failedCalls: metrics.failedCalls,
          successRate,
          avgResponseTime,
          avgRelevanceScore,
          meetsRequirements: {
            successRate: successRate >= PERFORMANCE_REQUIREMENTS.minSuccessRate,
            responseTime: avgResponseTime <= PERFORMANCE_REQUIREMENTS.maxResponseTime,
            relevanceScore: avgRelevanceScore ? avgRelevanceScore >= PERFORMANCE_REQUIREMENTS.minRelevanceScore : null
          },
          lastCallTime: metrics.lastCallTime,
          lastSuccessTime: metrics.lastSuccessTime,
          lastError: metrics.lastError
        }
      };
    }
    
    return stats;
  }
  
  /**
   * 获取整体性能报告
   */
  getPerformanceReport() {
    const stats = this.getModelStats();
    const allModels = Object.values(stats);
    
    const totalCalls = allModels.reduce((sum, m) => sum + m.metrics.totalCalls, 0);
    const successfulCalls = allModels.reduce((sum, m) => sum + m.metrics.successfulCalls, 0);
    const overallSuccessRate = totalCalls > 0 ? successfulCalls / totalCalls : 1;
    
    const avgResponseTime = allModels
      .filter(m => m.metrics.avgResponseTime > 0)
      .reduce((sum, m) => sum + m.metrics.avgResponseTime, 0) / 
      allModels.filter(m => m.metrics.avgResponseTime > 0).length || 0;
    
    const avgRelevanceScore = allModels
      .filter(m => m.metrics.avgRelevanceScore !== null)
      .reduce((sum, m) => sum + m.metrics.avgRelevanceScore, 0) / 
      allModels.filter(m => m.metrics.avgRelevanceScore !== null).length || 0;
    
    const availableModels = allModels.filter(m => 
      m.enabled && m.health !== 'unhealthy' && m.circuitBreaker !== 'OPEN'
    ).length;
    
    return {
      timestamp: new Date().toISOString(),
      overallMetrics: {
        totalCalls,
        successfulCalls,
        overallSuccessRate,
        meetsSuccessRateRequirement: overallSuccessRate >= PERFORMANCE_REQUIREMENTS.minSuccessRate,
        avgResponseTime,
        meetsResponseTimeRequirement: avgResponseTime <= PERFORMANCE_REQUIREMENTS.maxResponseTime,
        avgRelevanceScore,
        meetsRelevanceRequirement: avgRelevanceScore >= PERFORMANCE_REQUIREMENTS.minRelevanceScore,
        availableModels,
        totalModels: allModels.length
      },
      modelDetails: stats,
      requirements: PERFORMANCE_REQUIREMENTS
    };
  }
  
  /**
   * 更新模型配置
   */
  updateModelConfig(modelId, newConfig) {
    const model = this.models.get(modelId);
    if (!model) throw new Error(`模型 ${modelId} 不存在`);
    
    Object.keys(newConfig).forEach(key => {
      if (key !== 'id' && key !== 'metrics' && model.hasOwnProperty(key)) {
        model[key] = newConfig[key];
      }
    });
    
    return { success: true, modelId, updatedConfig: model };
  }
  
  /**
   * 启用/禁用模型
   */
  setModelEnabled(modelId, enabled) {
    const model = this.models.get(modelId);
    if (!model) throw new Error(`模型 ${modelId} 不存在`);
    
    model.enabled = enabled;
    
    if (!enabled) {
      // 禁用时重置断路器
      const breaker = this.circuitBreakers.get(modelId);
      if (breaker) {
        breaker.state = 'CLOSED';
        breaker.failureCount = 0;
        breaker.nextAttempt = null;
      }
    }
    
    return { success: true, modelId, enabled };
  }
}

// 创建单例实例
const aiLoadBalancer = new AILoadBalancer();

export default aiLoadBalancer;
export { AILoadBalancer, PERFORMANCE_REQUIREMENTS };