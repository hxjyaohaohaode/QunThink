import express from 'express';
import { systemMonitor } from '../services/monitoring/index.js';
import { requireAuth } from '../middleware/auth.js';
import { safeLog } from '../utils/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

const clientErrorBuckets = new Map();
const MAX_CLIENT_ERRORS_PER_USER = 200;

function getClientErrorBucket(userId) {
  let bucket = clientErrorBuckets.get(userId);
  if (!bucket) {
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
  if (!errorData || !errorData.type) {
    return res.status(400).json({ error: 'Invalid error report' });
  }
  const entry = {
    ...errorData,
    receivedAt: new Date().toISOString(),
  };
  appendClientError(req.userId || 'anonymous', entry);
  safeLog('warn', `[ClientError] ${entry.type}: ${entry.message?.slice(0, 200)}`);
  res.json({ success: true });
}));

router.get('/client-errors', requireAuth, asyncHandler(async (req, res) => {
  const bucket = clientErrorBuckets.get(req.userId) || [];
  res.json({ success: true, errors: bucket, count: bucket.length });
}));

router.get('/metrics', requireAuth, asyncHandler(async (req, res) => {
  const metrics = systemMonitor.getCurrentMetrics();
  res.json({
    success: true,
    metrics,
    timestamp: new Date().toISOString()
  });
}));

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
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
    overallHealth: latestMetrics?.meetsAvailabilityRequirement ? 'healthy' : 'degraded',
    meetsAvailabilityRequirement: latestMetrics?.meetsAvailabilityRequirement || false,
    requiresScaling: latestMetrics?.requiresScaling || false,
    timestamp: new Date().toISOString()
  };
  res.json({
    success: true,
    health,
    timestamp: new Date().toISOString()
  });
}));

router.get('/scaling/history', asyncHandler(async (req, res) => {
  const history = systemMonitor.getScalingHistory ? systemMonitor.getScalingHistory() : [];
  res.json({
    success: true,
    history,
    timestamp: new Date().toISOString()
  });
}));

router.post('/scaling/trigger', requireAuth, asyncHandler(async (req, res) => {
  const latestMetrics = systemMonitor.getCurrentMetrics();
  const scalingResult = systemMonitor.triggerAutoScaling(latestMetrics);
  res.json({
    success: true,
    message: '自动扩容已触发',
    result: scalingResult,
    timestamp: new Date().toISOString()
  });
}));

router.post('/scaling/manual', requireAuth, asyncHandler(async (req, res) => {
  const { action, target, amount } = req.body;

  if (!action || !target) {
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
    status: 'recorded'
  };

  console.log(`手动扩容请求（仅记录建议）: ${action} ${target} ${amount || 1}`);

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
