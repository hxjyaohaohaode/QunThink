/**
 * AI模型管理和监控API路由
 * 提供负载均衡器状态、性能指标、模型配置等功能
 */

import express from 'express';
import { readCatalog } from '../services/ai/catalog.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

router.use('/ai', requireAdmin);

const retiredControl = (_req, res) => res.status(410).json({
  success: false,
  error: '此接口只修改旧进程内状态，不能控制真实模型调用；请在模型中心管理并测试连接。',
  replacement: '/api/user/model-catalog'
});

/**
 * 获取所有AI模型状态
 * GET /api/ai/models
 */
router.get('/ai/models', asyncHandler(async (req, res) => {
  const catalog = await readCatalog(req.userId);

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    source: 'user_model_catalog',
    models: Object.fromEntries(catalog.models.map(model => [model.id, model])),
    totalModels: catalog.models.length
  });
}));

/**
 * 获取AI模型性能报告
 * GET /api/ai/performance
 */
router.get('/ai/performance', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    status: 'unavailable',
    source: 'no_authoritative_usage_ledger',
    reason: '当前没有可核验的跨服务调用与费用账本，不能计算成功率或延迟达标情况。'
  });
}));

/**
 * 获取单个模型详情
 * GET /api/ai/models/:modelId
 */
router.get('/ai/models/:modelId', asyncHandler(async (req, res) => {
  const { modelId } = req.params;
  const catalog = await readCatalog(req.userId);
  const model = catalog.models.find(item => item.id === modelId);

  if (!model) {
    return res.status(404).json({
      success: false,
      error: '模型不存在'
    });
  }

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    modelId,
    source: 'user_model_catalog',
    ...model
  });
}));

/**
 * 启用/禁用AI模型
 * PUT /api/ai/models/:modelId/enabled
 */
router.put('/ai/models/:modelId/enabled', retiredControl);

/**
 * 更新模型配置
 * PUT /api/ai/models/:modelId/config
 */
router.put('/ai/models/:modelId/config', retiredControl);

/**
 * 执行健康检查
 * POST /api/ai/health-check
 */
router.post('/ai/health-check', retiredControl);

/**
 * 重置模型断路器
 * POST /api/ai/models/:modelId/reset-circuit-breaker
 */
router.post('/ai/models/:modelId/reset-circuit-breaker', retiredControl);

/**
 * 获取性能要求
 * GET /api/ai/requirements
 */
router.get('/ai/requirements', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    status: 'not_validated',
    requirements: null,
    description: '尚无基于真实调用与费用账本校验的服务等级目标。'
  });
}));

export default router;
