import express from 'express';
import { systemMonitor } from '../services/monitoring/index.js';
import { requireAuth } from '../middleware/auth.js';
import { safeLog } from '../utils/logger.js';

const router = express.Router();

const clientErrorLog = [];
const MAX_CLIENT_ERRORS = 100;

router.post('/errors', (req, res) => {
  try {
    const errorData = req.body;
    if (!errorData || !errorData.type) {
      return res.status(400).json({ error: 'Invalid error report' });
    }
    const entry = {
      ...errorData,
      receivedAt: new Date().toISOString(),
    };
    clientErrorLog.push(entry);
    if (clientErrorLog.length > MAX_CLIENT_ERRORS) {
      clientErrorLog.shift();
    }
    safeLog('warn', `[ClientError] ${entry.type}: ${entry.message?.slice(0, 200)}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to log error' });
  }
});

router.get('/client-errors', requireAuth, (req, res) => {
  res.json({ success: true, errors: clientErrorLog, count: clientErrorLog.length });
});

router.get('/metrics', requireAuth, (req, res) => {
  try {
    const metrics = systemMonitor.getCurrentMetrics();
    res.json({
      success: true,
      metrics,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取系统指标时出错:', error);
    res.status(500).json({
      success: false,
      error: '获取系统指标失败'
    });
  }
});

router.get('/status', requireAuth, (req, res) => {
  try {
    const status = systemMonitor.getSystemStatusReport();
    res.json({
      success: true,
      status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取系统状态时出错:', error);
    res.status(500).json({
      success: false,
      error: '获取系统状态失败'
    });
  }
});

router.get('/health', (req, res) => {
  try {
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
  } catch (error) {
    console.error('获取系统健康状态时出错:', error);
    res.status(500).json({
      success: false,
      error: '获取系统健康状态失败'
    });
  }
});

router.get('/scaling/history', (req, res) => {
  try {
    const history = systemMonitor.getScalingHistory ? systemMonitor.getScalingHistory() : [];
    res.json({
      success: true,
      history,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取扩容历史时出错:', error);
    res.status(500).json({
      success: false,
      error: '获取扩容历史失败'
    });
  }
});

router.post('/scaling/trigger', requireAuth, (req, res) => {
  try {
    const latestMetrics = systemMonitor.getCurrentMetrics();
    const scalingResult = systemMonitor.triggerAutoScaling(latestMetrics);
    res.json({
      success: true,
      message: '自动扩容已触发',
      result: scalingResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('触发自动扩容时出错:', error);
    res.status(500).json({
      success: false,
      error: '触发自动扩容失败'
    });
  }
});

router.post('/scaling/manual', requireAuth, (req, res) => {
  try {
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
      status: 'pending'
    };

    console.log(`手动扩容请求: ${action} ${target} ${amount || 1}`);
    
    res.json({
      success: true,
      message: '手动扩容请求已接收',
      result: manualResult,
      suggestedActions: scalingActions,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('处理手动扩容请求时出错:', error);
    res.status(500).json({
      success: false,
      error: '处理手动扩容请求失败'
    });
  }
});

export default router;