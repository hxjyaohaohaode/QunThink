import express from 'express';
import { systemMonitor } from '../services/monitoring/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { safeLog } from '../utils/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

const clientErrorBuckets = new Map();
const MAX_CLIENT_ERRORS_PER_USER = 32;
const MAX_CLIENT_ERROR_USERS = 500;
const MAX_CLIENT_ERRORS_PER_MINUTE = 20;
const CLIENT_ERROR_TYPES = new Set(['react_error', 'runtime_error', 'unhandled_promise_rejection']);

function getClientErrorBucket(userId) {
  let bucket = clientErrorBuckets.get(userId);
  if (!bucket) {
    if (clientErrorBuckets.size >= MAX_CLIENT_ERROR_USERS) {
      clientErrorBuckets.delete(clientErrorBuckets.keys().next().value);
    }
    bucket = [];
    clientErrorBuckets.set(userId, bucket);
  }
  return bucket;
}

function appendClientError(userId, entry) {
  const bucket = getClientErrorBucket(userId);
  bucket.push(entry);
  if (bucket.length > MAX_CLIENT_ERRORS_PER_USER) {
    bucket.splice(0, bucket.length - MAX_CLIENT_ERRORS_PER_USER);
  }
}

router.post('/monitoring/errors', asyncHandler(async (req, res) => {
  const errorData = req.body;
  if (!errorData || Array.isArray(errorData) || typeof errorData !== 'object' ||
      !CLIENT_ERROR_TYPES.has(errorData.type) || typeof errorData.message !== 'string' ||
      errorData.message.length > 1000 || !req.userId) {
    return res.status(400).json({ error: 'Invalid error report' });
  }
  const bucket = getClientErrorBucket(req.userId);
  const now = Date.now();
  if (bucket.filter(entry => now - Date.parse(entry.receivedAt) < 60000).length >= MAX_CLIENT_ERRORS_PER_MINUTE) {
    return res.status(429).json({ error: 'Error report rate limit exceeded' });
  }
  const entry = {
    type: errorData.type,
    message: errorData.message,
    receivedAt: new Date().toISOString(),
  };
  appendClientError(req.userId, entry);
  safeLog('warn', '客户端错误报告已记录', { userId: req.userId, type: entry.type });
  res.json({ success: true });
}));

router.get('/client-errors', requireAuth, asyncHandler(async (req, res) => {
  const bucket = clientErrorBuckets.get(req.userId) || [];
  res.json({ success: true, errors: bucket, count: bucket.length });
}));

router.get('/metrics', requireAdmin, asyncHandler(async (req, res) => {
  const metrics = systemMonitor.getCurrentMetrics();
  res.json({
    success: true,
    metrics,
    timestamp: new Date().toISOString()
  });
}));

router.get('/status', requireAdmin, asyncHandler(async (req, res) => {
  const status = systemMonitor.getSystemStatusReport();
  res.json({
    success: true,
    status,
    timestamp: new Date().toISOString()
  });
}));

router.get('/health', asyncHandler(async (req, res) => {
  const latestMetrics = systemMonitor.getCurrentMetrics();
  const health = {
    overallHealth: latestMetrics?.meetsAvailabilityRequirement === null ? 'unknown'
      : latestMetrics?.meetsAvailabilityRequirement ? 'healthy' : 'degraded',
    meetsAvailabilityRequirement: latestMetrics?.meetsAvailabilityRequirement ?? null,
    requiresScaling: latestMetrics?.requiresScaling ?? null,
    timestamp: new Date().toISOString()
  };
  res.json({
    success: true,
    health,
    timestamp: new Date().toISOString()
  });
}));

router.get('/scaling/history', requireAdmin, asyncHandler(async (req, res) => {
  const history = systemMonitor.getRecentEvents(100).filter(event =>
    event.type === 'scaling_recommended' || event.type === 'manual_scaling_recommended');
  res.json({
    success: true,
    history,
    persisted: false,
    note: '仅当前进程中的建议，重启后不保留；没有执行扩容。',
    timestamp: new Date().toISOString()
  });
}));

router.post('/scaling/trigger', requireAdmin, asyncHandler(async (req, res) => {
  const latestMetrics = systemMonitor.getCurrentMetrics();
  const scalingResult = await systemMonitor.triggerAutoScaling(latestMetrics);
  res.status(501).json({
    success: false,
    message: '当前部署没有配置扩容适配器；已记录建议，没有执行扩容。',
    result: scalingResult,
    timestamp: new Date().toISOString()
  });
}));

router.post('/scaling/manual', requireAdmin, asyncHandler(async (req, res) => {
  const { action, target, amount } = req.body;

  if (typeof action !== 'string' || !action.trim() || action.length > 80 ||
      typeof target !== 'string' || !target.trim() || target.length > 80 ||
      (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 1 || amount > 100))) {
    return res.status(400).json({
      success: false,
      error: '缺少必要参数: action, target'
    });
  }

  const scalingActions = systemMonitor.determineScalingActions(systemMonitor.getCurrentMetrics());

  const manualResult = {
    action,
    target,
    amount: amount || 1,
    timestamp: new Date().toISOString(),
    status: 'recorded_in_process',
    persisted: false,
    executed: false
  };

  await systemMonitor.recordEvent('manual_scaling_recommended', manualResult);

  res.json({
    success: true,
    implemented: false,
    message: '手动扩容请求已接收；单进程部署下仅记录扩容建议，不会实际执行任何扩缩容操作',
    result: manualResult,
    suggestedActions: scalingActions,
    timestamp: new Date().toISOString()
  });
}));

export default router;
