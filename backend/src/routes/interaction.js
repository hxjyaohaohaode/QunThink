/**
 * 互动行为记录与分析API路由
 * 提供互动日志查询、统计分析、质量评估等功能
 * 所有数据严格限定在当前登录用户自己的数据库内
 */

import express from 'express';
import interactionLogger from '../services/interactionLogger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

function buildFilter(query) {
  const filter = {};
  if (query.type) filter.type = String(query.type).slice(0, 64);
  if (query.participantType) filter.participantType = String(query.participantType).slice(0, 32);
  if (query.participantId) filter.participantId = String(query.participantId).slice(0, 128);
  if (query.groupId) filter.groupId = String(query.groupId).slice(0, 128);
  if (query.startDate) filter.startDate = String(query.startDate).slice(0, 40);
  if (query.endDate) filter.endDate = String(query.endDate).slice(0, 40);
  return filter;
}

function parseLimit(raw, fallback = 100) {
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 1000);
}

function parseOffset(raw) {
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * 获取互动日志
 * GET /api/interaction/logs
 */
router.get('/interaction/logs', asyncHandler(async (req, res) => {
  const filter = buildFilter(req.query);
  const limit = parseLimit(req.query.limit ?? req.queryLimit);
  const offset = parseOffset(req.query.offset);

  const result = await interactionLogger.getLogs(req.userId, { ...filter, limit });

  const paginatedLogs = result.logs.slice(offset, offset + limit);

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    total: result.count,
    returned: paginatedLogs.length,
    offset,
    limit,
    logs: paginatedLogs
  });
}));

/**
 * 获取互动统计
 * GET /api/interaction/stats
 */
router.get('/interaction/stats', asyncHandler(async (req, res) => {
  const timeRange = String(req.query.timeRange || '24h').slice(0, 8);
  const groupId = req.query.groupId ? String(req.query.groupId).slice(0, 128) : null;
  const result = await interactionLogger.getInteractionStats(req.userId, timeRange, groupId);
  res.json({ success: true, ...result });
}));

/**
 * 获取话题参与度分析
 * GET /api/interaction/participation
 */
router.get('/interaction/participation', asyncHandler(async (req, res) => {
  const { groupId } = req.query;

  if (!groupId || typeof groupId !== 'string') {
    return res.status(400).json({
      success: false,
      error: '缺少groupId参数'
    });
  }

  const timeRange = String(req.query.timeRange || '24h').slice(0, 8);
  const result = await interactionLogger.getTopicParticipation(req.userId, groupId.slice(0, 128), timeRange);
  res.json({ success: true, ...result });
}));

/**
 * 获取互动质量评估
 * GET /api/interaction/quality
 */
router.get('/interaction/quality', asyncHandler(async (req, res) => {
  const timeRange = String(req.query.timeRange || '24h').slice(0, 8);
  const result = await interactionLogger.getInteractionQualityMetrics(req.userId, timeRange);
  res.json({ success: true, ...result });
}));

/**
 * 导出互动日志
 * GET /api/interaction/export
 */
router.get('/interaction/export', asyncHandler(async (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const filter = buildFilter(req.query);

  const result = await interactionLogger.exportLogs(req.userId, format, filter);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=interaction_logs_${Date.now()}.csv`);
    res.send(result.content);
  } else {
    res.json(result);
  }
}));

/**
 * 获取系统状态（当前用户视角）
 * GET /api/interaction/status
 */
router.get('/interaction/status', asyncHandler(async (req, res) => {
  const result = await interactionLogger.getSystemStatus(req.userId);
  res.json({ success: true, ...result });
}));

const ALLOWED_EVENT_TYPES = new Set(['like', 'comment', 'reply', 'message', 'topic_change', 'file_share', 'custom']);
const ALLOWED_PARTICIPANT_TYPES = new Set(['ai', 'user', 'system']);

/**
 * 记录自定义互动事件
 * POST /api/interaction/log
 */
router.post('/interaction/log', asyncHandler(async (req, res) => {
  const event = req.body || {};

  if (!ALLOWED_EVENT_TYPES.has(event.type) || !ALLOWED_PARTICIPANT_TYPES.has(event.participantType)) {
    return res.status(400).json({
      success: false,
      error: '参数不合法：type 或 participantType 不在允许范围内'
    });
  }

  if (!event.participantId || typeof event.participantId !== 'string' || event.participantId.length > 128) {
    return res.status(400).json({
      success: false,
      error: '缺少必要参数：participantId（≤128字符）'
    });
  }

  if (event.content !== undefined && (typeof event.content !== 'string' || event.content.length > 2000)) {
    return res.status(400).json({
      success: false,
      error: 'content 必须是不超过2000字符的字符串'
    });
  }

  if (event.metadata !== undefined && (typeof event.metadata !== 'object' || event.metadata === null || Array.isArray(event.metadata))) {
    return res.status(400).json({
      success: false,
      error: 'metadata 必须是对象'
    });
  }

  const result = await interactionLogger.logInteraction(req.userId, event);

  res.json({
    success: true,
    ...result
  });
}));

export default router;
