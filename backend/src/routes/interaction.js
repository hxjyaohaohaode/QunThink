/**
 * 互动行为记录与分析API路由
 * 提供互动日志查询、统计分析、质量评估等功能
 */

import express from 'express';
import interactionLogger from '../services/interactionLogger.js';

const router = express.Router();

/**
 * 获取互动日志
 * GET /api/interaction/logs
 */
router.get('/interaction/logs', async (req, res) => {
  try {
    const {
      type,
      participantType,
      participantId,
      groupId,
      startDate,
      endDate,
      limit = 100,
      offset = 0
    } = req.query;
    
    const filter = {};
    if (type) filter.type = type;
    if (participantType) filter.participantType = participantType;
    if (participantId) filter.participantId = participantId;
    if (groupId) filter.groupId = groupId;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    if (limit) filter.limit = parseInt(limit, 10);
    
    const result = await interactionLogger.getLogs(filter);
    
    // 应用分页
    const start = parseInt(offset, 10) || 0;
    const paginatedLogs = result.logs.slice(start, start + (filter.limit || 100));
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      total: result.count,
      returned: paginatedLogs.length,
      offset: start,
      limit: filter.limit,
      logs: paginatedLogs
    });
  } catch (error) {
    console.error('获取互动日志错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取互动日志失败',
      details: error.message 
    });
  }
});

/**
 * 获取互动统计
 * GET /api/interaction/stats
 */
router.get('/interaction/stats', async (req, res) => {
  try {
    const { timeRange = '24h', groupId } = req.query;
    
    const result = await interactionLogger.getInteractionStats(timeRange, groupId);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('获取互动统计错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取互动统计失败',
      details: error.message 
    });
  }
});

/**
 * 获取话题参与度分析
 * GET /api/interaction/participation
 */
router.get('/interaction/participation', async (req, res) => {
  try {
    const { groupId, timeRange = '24h' } = req.query;
    
    if (!groupId) {
      return res.status(400).json({ 
        success: false, 
        error: '缺少groupId参数' 
      });
    }
    
    const result = await interactionLogger.getTopicParticipation(groupId, timeRange);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('获取话题参与度分析错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取话题参与度分析失败',
      details: error.message 
    });
  }
});

/**
 * 获取互动质量评估
 * GET /api/interaction/quality
 */
router.get('/interaction/quality', async (req, res) => {
  try {
    const { timeRange = '24h' } = req.query;
    
    const result = await interactionLogger.getInteractionQualityMetrics(timeRange);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('获取互动质量评估错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取互动质量评估失败',
      details: error.message 
    });
  }
});

/**
 * 导出互动日志
 * GET /api/interaction/export
 */
router.get('/interaction/export', async (req, res) => {
  try {
    const { 
      format = 'json',
      type,
      participantType,
      participantId,
      groupId,
      startDate,
      endDate
    } = req.query;
    
    const filter = {};
    if (type) filter.type = type;
    if (participantType) filter.participantType = participantType;
    if (participantId) filter.participantId = participantId;
    if (groupId) filter.groupId = groupId;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await interactionLogger.exportLogs(format, filter);
    
    // 设置响应头
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=interaction_logs_${Date.now()}.csv`);
      res.send(result.content);
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error('导出互动日志错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '导出互动日志失败',
      details: error.message 
    });
  }
});

/**
 * 获取系统状态
 * GET /api/interaction/status
 */
router.get('/interaction/status', async (req, res) => {
  try {
    const result = await interactionLogger.getSystemStatus();
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('获取系统状态错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取系统状态失败',
      details: error.message 
    });
  }
});

/**
 * 清理旧日志（需要管理员权限）
 * POST /api/interaction/cleanup
 */
router.post('/interaction/cleanup', async (req, res) => {
  try {
    const { daysToKeep = 30, confirm } = req.body;
    
    if (confirm !== 'CONFIRM_CLEANUP') {
      return res.status(400).json({ 
        success: false, 
        error: '需要确认操作，请提供正确的确认代码' 
      });
    }
    
    const result = await interactionLogger.cleanupOldLogs(daysToKeep);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('清理旧日志错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '清理旧日志失败',
      details: error.message 
    });
  }
});

/**
 * 记录自定义互动事件（用于测试）
 * POST /api/interaction/log
 */
router.post('/interaction/log', async (req, res) => {
  try {
    const event = req.body;
    
    if (!event.type || !event.participantType || !event.participantId) {
      return res.status(400).json({ 
        success: false, 
        error: '缺少必要参数：type, participantType, participantId' 
      });
    }
    
    const result = await interactionLogger.logInteraction(event);
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('记录互动事件错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '记录互动事件失败',
      details: error.message 
    });
  }
});

export default router;