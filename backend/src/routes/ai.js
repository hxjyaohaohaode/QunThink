/**
 * AI模型管理和监控API路由
 * 提供负载均衡器状态、性能指标、模型配置等功能
 */

import express from 'express';
import aiLoadBalancer from '../services/ai/loadBalancer.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

router.use('/ai', requireAdmin);

/**
 * 获取所有AI模型状态
 * GET /api/ai/models
 */
router.get('/ai/models', asyncHandler(async (req, res) => {
  const modelStats = aiLoadBalancer.getModelStats();

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    models: modelStats,
    totalModels: Object.keys(modelStats).length
  });
}));

/**
 * 获取AI模型性能报告
 * GET /api/ai/performance
 */
router.get('/ai/performance', asyncHandler(async (req, res) => {
  const performanceReport = aiLoadBalancer.getPerformanceReport();

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    ...performanceReport
  });
}));

/**
 * 获取单个模型详情
 * GET /api/ai/models/:modelId
 */
router.get('/ai/models/:modelId', asyncHandler(async (req, res) => {
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
}));

/**
 * 启用/禁用AI模型
 * PUT /api/ai/models/:modelId/enabled
 */
router.put('/ai/models/:modelId/enabled', asyncHandler(async (req, res) => {
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
}));

/**
 * 更新模型配置
 * PUT /api/ai/models/:modelId/config
 */
router.put('/ai/models/:modelId/config', asyncHandler(async (req, res) => {
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
}));

/**
 * 执行健康检查
 * POST /api/ai/health-check
 */
router.post('/ai/health-check', asyncHandler(async (req, res) => {
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
}));

/**
 * 重置模型断路器
 * POST /api/ai/models/:modelId/reset-circuit-breaker
 */
router.post('/ai/models/:modelId/reset-circuit-breaker', asyncHandler(async (req, res) => {
  const { modelId } = req.params;

  const resetResult = aiLoadBalancer.resetCircuitBreaker(modelId);
  if (!resetResult) {
    return res.status(404).json({
      success: false,
      error: '模型断路器不存在'
    });
  }

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    message: `模型 ${modelId} 断路器已重置`,
    circuitBreaker: resetResult
  });
}));

/**
 * 获取性能要求
 * GET /api/ai/requirements
 */
router.get('/ai/requirements', asyncHandler(async (req, res) => {
  const { PERFORMANCE_REQUIREMENTS } = await import('../services/ai/loadBalancer.js');

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    requirements: PERFORMANCE_REQUIREMENTS,
    description: 'AI模型性能要求：调用成功率≥99%，API响应时间≤1.5秒，模型输出内容相关性评分≥4.0/5'
  });
}));

export default router;
