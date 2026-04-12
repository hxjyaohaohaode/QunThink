/**
 * AI模型管理和监控API路由
 * 提供负载均衡器状态、性能指标、模型配置等功能
 */

import express from 'express';
import aiLoadBalancer from '../services/ai/loadBalancer.js';

const router = express.Router();

/**
 * 获取所有AI模型状态
 * GET /api/ai/models
 */
router.get('/ai/models', async (req, res) => {
  try {
    const modelStats = aiLoadBalancer.getModelStats();
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      models: modelStats,
      totalModels: Object.keys(modelStats).length
    });
  } catch (error) {
    console.error('获取模型状态错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取模型状态失败',
      details: error.message 
    });
  }
});

/**
 * 获取AI模型性能报告
 * GET /api/ai/performance
 */
router.get('/ai/performance', async (req, res) => {
  try {
    const performanceReport = aiLoadBalancer.getPerformanceReport();
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...performanceReport
    });
  } catch (error) {
    console.error('获取性能报告错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取性能报告失败',
      details: error.message 
    });
  }
});

/**
 * 获取单个模型详情
 * GET /api/ai/models/:modelId
 */
router.get('/ai/models/:modelId', async (req, res) => {
  try {
    const { modelId } = req.params;
    const modelStats = aiLoadBalancer.getModelStats();
    
    if (!modelStats[modelId]) {
      return res.status(404).json({ 
        success: false, 
        error: '模型不存在' 
      });
    }
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      modelId,
      ...modelStats[modelId]
    });
  } catch (error) {
    console.error('获取模型详情错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取模型详情失败',
      details: error.message 
    });
  }
});

/**
 * 启用/禁用AI模型
 * PUT /api/ai/models/:modelId/enabled
 */
router.put('/ai/models/:modelId/enabled', async (req, res) => {
  try {
    const { modelId } = req.params;
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        error: 'enabled参数必须为布尔值' 
      });
    }
    
    const result = aiLoadBalancer.setModelEnabled(modelId, enabled);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('更新模型启用状态错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '更新模型启用状态失败',
      details: error.message 
    });
  }
});

/**
 * 更新模型配置
 * PUT /api/ai/models/:modelId/config
 */
router.put('/ai/models/:modelId/config', async (req, res) => {
  try {
    const { modelId } = req.params;
    const { config } = req.body;
    
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ 
        success: false, 
        error: '配置参数不能为空' 
      });
    }
    
    const result = aiLoadBalancer.updateModelConfig(modelId, config);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('更新模型配置错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '更新模型配置失败',
      details: error.message 
    });
  }
});

/**
 * 执行健康检查
 * POST /api/ai/health-check
 */
router.post('/ai/health-check', async (req, res) => {
  try {
    console.log('🔄 手动触发AI模型健康检查...');
    
    await aiLoadBalancer.performHealthChecks();
    
    const modelStats = aiLoadBalancer.getModelStats();
    const healthyModels = Object.values(modelStats).filter(m => 
      m.health === 'healthy' && m.enabled
    ).length;
    const totalModels = Object.values(modelStats).filter(m => m.enabled).length;
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: '健康检查完成',
      summary: {
        healthyModels,
        totalModels,
        healthRatio: totalModels > 0 ? healthyModels / totalModels : 0
      },
      models: modelStats
    });
  } catch (error) {
    console.error('执行健康检查错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '执行健康检查失败',
      details: error.message 
    });
  }
});

/**
 * 重置模型断路器
 * POST /api/ai/models/:modelId/reset-circuit-breaker
 */
router.post('/ai/models/:modelId/reset-circuit-breaker', async (req, res) => {
  try {
    const { modelId } = req.params;
    
    // 负载均衡器内部方法
    const breaker = aiLoadBalancer.circuitBreakers?.get(modelId);
    if (!breaker) {
      return res.status(404).json({ 
        success: false, 
        error: '模型断路器不存在' 
      });
    }
    
    breaker.state = 'CLOSED';
    breaker.failureCount = 0;
    breaker.lastFailureTime = null;
    breaker.nextAttempt = null;
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: `模型 ${modelId} 断路器已重置`,
      circuitBreaker: breaker
    });
  } catch (error) {
    console.error('重置断路器错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '重置断路器失败',
      details: error.message 
    });
  }
});

/**
 * 获取性能要求
 * GET /api/ai/requirements
 */
router.get('/ai/requirements', async (req, res) => {
  try {
    const { PERFORMANCE_REQUIREMENTS } = await import('../services/ai/loadBalancer.js');
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      requirements: PERFORMANCE_REQUIREMENTS,
      description: 'AI模型性能要求：调用成功率≥99%，API响应时间≤1.5秒，模型输出内容相关性评分≥4.0/5'
    });
  } catch (error) {
    console.error('获取性能要求错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取性能要求失败',
      details: error.message 
    });
  }
});

export default router;