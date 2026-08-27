/**
 * AI模型负载均衡与故障转移机制
 * 支持多个AI模型（deepseek、deepseek_reasoner、glm_air、mimo_flash、qwen_flash）的负载均衡，故障自动切换
 * 目标：模型调用成功率≥99%，API响应时间≤1.5秒，模型输出内容相关性评分≥4.0/5
 */

import axios from 'axios';
import { aiHealthStatus, getAIConfigs, normalizeBaseUrl } from './index.js';
import { getSafeExternalRequestOptions } from '../../utils/safeExternalUrl.js';

// 模型配置（从环境变量读取）
const MODEL_CONFIGS = {
  deepseek: {
    name: 'DeepSeek V4 Flash',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
    enabled: true,
    priority: 1
  },
  deepseek_reasoner: {
    name: 'DeepSeek V4 Pro',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-pro',
    enabled: true,
    priority: 2
  },
  glm_air: {
    name: 'GLM',
    apiKey: process.env.GLM_API_KEY || '',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'GLM-4.5-Air',
    enabled: true,
    priority: 3
  },
  mimo_flash: {
    name: 'MiMo Pro',
    apiKey: process.env.MIMO_API_KEY || '',
    endpoint: process.env.MIMO_BASE_URL
      ? `${normalizeBaseUrl(process.env.MIMO_BASE_URL)}/chat/completions`
      : 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.5-pro',
    enabled: true,
    priority: 4
  },
  qwen_flash: {
    name: 'Qwen',
    apiKey: process.env.QWEN_API_KEY || '',
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
    this.healthStatus = new Map();
    this.circuitBreakers = new Map();
    this._timers = [];

    this.initializeModels();

    if (process.env.NODE_ENV !== 'test') {
      const initialHealthCheckTimer = setTimeout(() => this.performInitialHealthChecks(), 5000);
      if (typeof initialHealthCheckTimer.unref === 'function') {
        initialHealthCheckTimer.unref();
      }

      // 延长健康检查间隔到5分钟，减少API调用压力
      const healthTimer = setInterval(() => this.performHealthChecks(), 5 * 60 * 1000);
      if (typeof healthTimer.unref === 'function') {
        healthTimer.unref();
      }
      this._timers.push(healthTimer);
    }
  }

  cleanupTimers() {
    for (const timer of this._timers) {
      clearInterval(timer);
    }
    this._timers = [];
    console.log('🧹 AI负载均衡器定时器已清理');
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
        const healthy = await this.probeHealth(modelId);
        if (healthy) {
          this.healthStatus.set(modelId, 'healthy');
          console.log(`✅ 模型 ${modelId} 初始健康检查通过`);
        } else {
          this.healthStatus.set(modelId, 'unhealthy');
          console.warn(`⚠️  模型 ${modelId} 初始健康检查失败`);
        }
      } catch (error) {
        this.healthStatus.set(modelId, 'unhealthy');
        console.warn(`⚠️  模型 ${modelId} 初始健康检查失败:`, error.message);
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * 定期健康检查
   */
  async performHealthChecks() {
    console.log('🔄 执行AI模型定期健康检查...');

    const promises = Array.from(this.models.keys()).map(async (modelId) => {
      try {
        const healthy = await this.probeHealth(modelId);
        if (healthy) {
          this.healthStatus.set(modelId, 'healthy');
          const status = aiHealthStatus.get(modelId);
          console.log(`✅ 模型 ${modelId} 健康检查通过 (响应时间: ${status?.responseTime || 0}ms)`);
        } else {
          this.healthStatus.set(modelId, 'unhealthy');
          const status = aiHealthStatus.get(modelId);
          console.warn(`❌ 模型 ${modelId} 健康检查失败:`, status?.error || '未知错误');
        }
      } catch (error) {
        this.healthStatus.set(modelId, 'unhealthy');
        console.warn(`❌ 模型 ${modelId} 健康检查异常:`, error.message);
      }
    });

    await Promise.allSettled(promises);
  }

  async probeHealth(modelId) {
    const aiConfigs = getAIConfigs();
    const config = aiConfigs[modelId];

    if (!config || !config.enabled || !config.apiKey) {
      aiHealthStatus.set(modelId, { status: 'unhealthy', lastCheck: Date.now(), error: '模型未配置或未启用', responseTime: 0 });
      return false;
    }

    aiHealthStatus.set(modelId, { status: 'checking', lastCheck: Date.now(), error: null, responseTime: 0 });

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      // 向实际的 /chat/completions 接口发送轻量级测试请求
      // 使用 max_tokens:1 降低成本，仅验证鉴权与路径可达性
      const testBody = {
        model: config.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      };

      try {
        const safeRequestOptions = await getSafeExternalRequestOptions(config.endpoint);
        await axios.post(config.endpoint, testBody, {
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal,
          timeout: 10000,
          ...safeRequestOptions,
          // 接受 2xx 与绝大多数 4xx 状态码：4xx 表示路径可达但鉴权/参数有问题，
          // 仍可证明网络层与端点路径正确；但 401/403 意味着密钥失效，必须判为不健康
          validateStatus: (status) => (status >= 200 && status < 300)
            || (status >= 400 && status < 500 && status !== 401 && status !== 403)
        });
      } catch (err) {
        // 若 axios 抛出，说明是网络层错误（DNS、连接超时、断网等）或鉴权失效，视为不健康
        throw err;
      }

      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;
      aiHealthStatus.set(modelId, { status: 'healthy', lastCheck: Date.now(), error: null, responseTime });

      const breaker = this.circuitBreakers.get(modelId);
      if (breaker) {
        breaker.failureCount = 0;
        breaker.state = 'CLOSED';
        breaker.nextAttempt = null;
      }

      return true;
    } catch (error) {
      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;
      aiHealthStatus.set(modelId, { status: 'unhealthy', lastCheck: Date.now(), error: error.message, responseTime });
      return false;
    }
  }

  /**
   * 记录成功调用
   */
  recordSuccess(modelId, responseTime, relevanceScore = null) {
    const model = this.ensureModelEntry(modelId);

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
    const model = this.ensureModelEntry(modelId);

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
        // 120秒后进入半开状态（给API更多恢复时间）
        breaker.nextAttempt = Date.now() + 120000;
        console.warn(`🚨 模型 ${modelId} 断路器打开，120秒后重试`);
      }
    }
  }

  /**
   * 确保模型统计与断路器档案存在（callAI 可能传入未预置的模型ID，动态建档）
   */
  ensureModelEntry(modelId) {
    let model = this.models.get(modelId);
    if (!model) {
      model = {
        id: modelId,
        name: modelId,
        apiKey: '',
        endpoint: '',
        model: modelId,
        enabled: true,
        priority: 99,
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
      };
      this.models.set(modelId, model);
      this.circuitBreakers.set(modelId, {
        failureCount: 0,
        lastFailureTime: null,
        state: 'CLOSED',
        nextAttempt: null
      });
    }
    return model;
  }

  /**
   * 重置断路器，返回重置后的快照；模型不存在时返回 null
   */
  resetCircuitBreaker(modelId) {
    const breaker = this.circuitBreakers.get(modelId);
    if (!breaker) {
      return null;
    }
    breaker.failureCount = 0;
    breaker.state = 'CLOSED';
    breaker.lastFailureTime = null;
    breaker.nextAttempt = null;
    return { state: breaker.state, failureCount: breaker.failureCount };
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
      if (key !== 'id' && key !== 'metrics' && key !== 'apiKey' && model.hasOwnProperty(key)) {
        model[key] = newConfig[key];
      }
    });

    const { apiKey: _stripped, ...safeModel } = model;
    return { success: true, modelId, updatedConfig: safeModel };
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
