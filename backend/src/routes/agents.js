import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { withWriteLock, readCommittedUserDb } from '../models/db.js';
import { createAgent, buildBaseAgentPrompt, generateAgentQuestions, chatWithAgent, invokeAgentInGroup, generateSuggestions } from '../services/agent/index.js';
import { resolveModel } from '../services/ai/catalog.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getUploadsDir } from '../models/db.js';
import { sanitizeObject, AGENT_SANITIZE_CONFIG } from '../utils/sanitize.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown', 'text/xml', 'application/json',
  'text/yaml', 'text/x-yaml', 'application/x-toml',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv', 'video/x-flv',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-ms-wma',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];

const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.vbs', '.js', '.msi', '.com', '.scr', '.dll', '.pif', '.reg', '.wsf', '.ws'];

const uploadBaseDir = getUploadsDir();

function getUploadDir(userId) {
  const userDir = path.join(uploadBaseDir, userId);
  if (!fs.existsSync(userDir)) {
    try {
      fs.mkdirSync(userDir, { recursive: true });
    } catch (err) {
      console.warn('上传目录创建失败:', err.message);
    }
  }
  return userDir;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.userId || 'anonymous';
    cb(null, getUploadDir(userId));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
      '.pdf', '.txt', '.csv', '.md', '.xml', '.json', '.yaml', '.yml', '.toml',
      '.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv',
      '.mp3', '.wav', '.m4a', '.aac', '.flac', '.wma',
      '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.py', '.rs', '.go', '.java', '.c', '.cpp', '.ts', '.tsx', '.html', '.css'];
    if (DANGEROUS_EXTENSIONS.includes(ext)) {
      return cb(new Error('不允许上传可执行文件'));
    }
    const mimeOk = ALLOWED_MIME_TYPES.includes(file.mimetype)
      || !file.mimetype
      || file.mimetype === 'application/octet-stream';
    if (!mimeOk && !allowedExts.includes(ext)) {
      return cb(new Error('不支持的文件类型'));
    }
    cb(null, true);
  }
});

const router = express.Router();

function requireUserId(req) {
  if (!req.userId) {
    throw new Error('用户身份缺失');
  }
  return req.userId;
}

function isValidLength(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function validateAgentFields(name, description, openingMessage) {
  if (!isValidLength(name, 1, 100)) {
    return 'name 必须为1-100个字符的字符串';
  }
  if (!isValidLength(description, 1, 2000)) {
    return 'description 必须为不超过2000字符的字符串';
  }
  if (!isValidLength(openingMessage, 1, 2000)) {
    return 'openingMessage 必须为不超过2000字符的字符串';
  }
  return null;
}

function notFoundError(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

router.get('/agents', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  res.json(db.data.agents || []);
}));

router.get('/agents/:agentId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const agent = (db.data.agents || []).find(a => a.id === req.params.agentId);
  if (!agent) {
    throw notFoundError('Agent not found');
  }
  res.json(agent);
}));

router.post('/agents', asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const sanitizedBody = sanitizeObject(req.body, AGENT_SANITIZE_CONFIG);
  const { name, description, openingMessage, enableSuggestions, capabilities, avatarUrl } = sanitizedBody;
  if (!name || !description || !openingMessage) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const lengthError = validateAgentFields(name, description, openingMessage);
  if (lengthError) {
    return res.status(400).json({ error: lengthError });
  }
  const agent = await createAgent(userId, name, description, openingMessage, enableSuggestions, capabilities, avatarUrl || null, req.body.modelId || null);
  res.json(agent);
}));

router.post('/agents/generate-questions', asyncHandler(async (req, res) => {
  const { name, description, openingMessage } = req.body;
  if (!name || !description || !openingMessage) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const lengthError = validateAgentFields(name, description, openingMessage);
  if (lengthError) {
    return res.status(400).json({ error: lengthError });
  }
  const questions = await generateAgentQuestions(name, description, openingMessage, req.userId);
  res.json(questions);
}));

router.put('/agents/:agentId', asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { agentId } = req.params;
  const sanitizedBody = sanitizeObject(req.body, AGENT_SANITIZE_CONFIG);
  const modelId = req.body.modelId;
  if (modelId !== undefined) await resolveModel(userId, modelId, 'chat');
  const { name, description, openingMessage, enableSuggestions, capabilities } = sanitizedBody;
  if (name !== undefined && !isValidLength(name, 1, 100)) {
    return res.status(400).json({ error: 'name 必须为1-100个字符的字符串' });
  }
  if (description !== undefined && !isValidLength(description, 1, 2000)) {
    return res.status(400).json({ error: 'description 必须为不超过2000字符的字符串' });
  }
  if (openingMessage !== undefined && !isValidLength(openingMessage, 1, 2000)) {
    return res.status(400).json({ error: 'openingMessage 必须为不超过2000字符的字符串' });
  }
  const db = await req.getUserDb();
  let updatedAgent;
  await withWriteLock(userId, async () => {
    await db.read();
    const agentIndex = (db.data.agents || []).findIndex(a => a.id === agentId);
    if (agentIndex === -1) {
      throw notFoundError('Agent not found');
    }
    const agent = db.data.agents[agentIndex];
    if (name !== undefined) agent.name = name;
    if (description !== undefined) agent.description = description;
    if (openingMessage !== undefined) agent.opening_message = openingMessage;
    if (enableSuggestions !== undefined) agent.enable_suggestions = enableSuggestions;
    if (capabilities !== undefined) agent.capabilities = { ...capabilities, web_search: false, scheduled_tasks: false };
    if (modelId !== undefined) agent.model_roles = [{ modelId, role: '主回复', description: '使用用户选择的模型' }];
    // Updating an agent must not create a second agent or acquire this lock again.
    if (name !== undefined || description !== undefined) agent.system_prompt = buildBaseAgentPrompt(agent.name, agent.description);
    agent.updated_at = new Date().toISOString();
    updatedAgent = agent;
    await db.write();
  });
  res.json(updatedAgent);
}));

router.delete('/agents/:agentId', asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { agentId } = req.params;
  const db = await req.getUserDb();
  let deleted = false;
  await withWriteLock(userId, async () => {
    await db.read();
    const agents = db.data.agents || [];
    const agentIndex = agents.findIndex(a => a.id === agentId);
    if (agentIndex === -1) {
      throw notFoundError('Agent not found');
    }
    agents.splice(agentIndex, 1);
    deleted = true;
    db.data.agent_messages = (db.data.agent_messages || []).filter(m => m.agent_id !== agentId);
    await db.write();
  });
  res.json({ success: deleted });
}));

router.get('/agents/:agentId/messages', asyncHandler(async (req, res) => {
  const { agentId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before;
  const db = await req.getUserDb();
  const messages = await readCommittedUserDb(db, data => {
    let entries = (data.agent_messages || []).filter(m => m.agent_id === agentId);
    if (before) {
      const beforeIndex = entries.findIndex(m => m.id === before);
      if (beforeIndex > -1) entries = entries.slice(0, beforeIndex);
    }
    return entries.slice(-limit);
  });
  res.json(messages);
}));

router.post('/agents/:agentId/chat', asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { agentId } = req.params;
  const { message, attachments } = req.body;
  if (!isValidLength(message, 1, 8000)) {
    return res.status(400).json({ error: 'message 必须为1-8000个字符的字符串' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    await chatWithAgent(userId, agentId, message, (chunk) => {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }, attachments || []);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('[Agent对话路由] 错误:', error.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}));

router.post('/agents/:agentId/chat-with-files', (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '文件大小超过50MB限制' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: '上传文件数量超过10个限制' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { agentId } = req.params;
  const message = typeof req.body.message === 'string' ? req.body.message : '';
  if (message.length > 8000) {
    return res.status(400).json({ error: 'message 不能超过8000个字符' });
  }

  const attachments = (req.files || []).map(file => ({
    filename: file.originalname,
    name: file.originalname,
    file_path: file.path,
    mime_type: file.mimetype,
    type: file.mimetype,
    size: file.size
  }));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    await chatWithAgent(userId, agentId, message, (chunk) => {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }, attachments);

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('[Agent对话-文件上传] 错误:', error.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    const files = req.files || [];
    for (const file of files) {
      if (file?.path) {
        await fs.promises.unlink(file.path).catch(() => {});
      }
    }
  }
}));

router.get('/agents/:agentId/suggestions', asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { agentId } = req.params;
  const { context } = req.query;

  const db = await req.getUserDb();
  const { agent, chatHistory, userProfile } = await readCommittedUserDb(db, data => ({
    agent: (data.agents || []).find(a => a.id === agentId),
    chatHistory: (data.agent_messages || []).filter(m => m.agent_id === agentId).slice(-10),
    userProfile: data.userProfile || null
  }));
  if (!agent) {
    throw notFoundError('智能体不存在');
  }

  if (!agent.enable_suggestions) {
    return res.json({ suggestions: [] });
  }

  const lastAgentMsg = [...chatHistory].reverse().find(m => m.sender_type === 'agent');
  const lastUserMsg = [...chatHistory].reverse().find(m => m.sender_type === 'user');

  const agentResponse = lastAgentMsg ? lastAgentMsg.content : agent.opening_message;
  const userMessage = lastUserMsg ? lastUserMsg.content : (typeof context === 'string' ? context : '');

  const suggestions = await generateSuggestions(
    agent,
    agentResponse,
    userMessage,
    userId,
    chatHistory,
    userProfile
  );

  res.json({ suggestions: suggestions || [] });
}));

router.post('/agents/:agentId/invoke', asyncHandler(async (req, res) => {
  const userId = requireUserId(req);
  const { agentId } = req.params;
  const { context } = req.body;
  const response = await invokeAgentInGroup(userId, agentId, context);
  res.json({ response });
}));

export default router;
