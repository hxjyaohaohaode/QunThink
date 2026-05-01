import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { withWriteLock } from '../models/db.js';
import { createAgent, generateAgentQuestions, chatWithAgent, invokeAgentInGroup, generateSuggestions } from '../services/agent/index.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getUploadsDir } from '../models/db.js';
import { sanitizeObject, AGENT_SANITIZE_CONFIG } from '../utils/sanitize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown', 'text/xml', 'text/json',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];

const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.vbs', '.js', '.msi', '.com', '.scr', '.dll', '.pif', '.reg', '.wsf', '.ws'];

const uploadBaseDir = getUploadsDir();

function getUploadDir(userId) {
  const userDir = path.join(uploadBaseDir, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
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
    if (DANGEROUS_EXTENSIONS.includes(ext)) {
      return cb(new Error('不允许上传可执行文件'));
    }
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
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

router.get('/agents', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    res.json(db.data.agents || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/agents/:agentId', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const agent = (db.data.agents || []).find(a => a.id === req.params.agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json(agent);
  } catch (error) {
    console.error('获取Agent详情错误:', error);
    res.status(500).json({ error: '获取Agent详情失败' });
  }
});

router.post('/agents', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const sanitizedBody = sanitizeObject(req.body, AGENT_SANITIZE_CONFIG);
    const { name, description, openingMessage, enableSuggestions, capabilities, avatarUrl } = sanitizedBody;
    if (!name || !description || !openingMessage) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    const agent = await createAgent(userId, name, description, openingMessage, enableSuggestions, capabilities, avatarUrl || null);
    res.json(agent);
  } catch (error) {
    console.error('[Agent创建路由] 错误:', error.message);
    console.error('[Agent创建路由] 堆栈:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

router.post('/agents/generate-questions', async (req, res) => {
  try {
    console.log('[Agent问题生成路由] 请求体:', JSON.stringify(req.body));
    const { name, description, openingMessage } = req.body;
    if (!name || !description || !openingMessage) {
      console.error('[Agent问题生成路由] 缺少必要参数');
      return res.status(400).json({ error: '缺少必要参数' });
    }
    const questions = await generateAgentQuestions(name, description, openingMessage);
    console.log('[Agent问题生成路由] 成功生成问题:', JSON.stringify(questions));
    res.json(questions);
  } catch (error) {
    console.error('[Agent问题生成路由] 错误:', error.message);
    console.error('[Agent问题生成路由] 堆栈:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

router.put('/agents/:agentId', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { agentId } = req.params;
    const sanitizedBody = sanitizeObject(req.body, AGENT_SANITIZE_CONFIG);
    const { name, description, openingMessage, enableSuggestions, capabilities } = sanitizedBody;
    const db = await req.getUserDb();
    let updatedAgent;
    await withWriteLock(userId, async () => {
      await db.read();
      const agentIndex = (db.data.agents || []).findIndex(a => a.id === agentId);
      if (agentIndex === -1) {
        throw new Error('Agent not found');
      }
      const agent = db.data.agents[agentIndex];
      const capabilitiesChanged = capabilities !== undefined && JSON.stringify(capabilities) !== JSON.stringify(agent.capabilities);
      if (name !== undefined) agent.name = name;
      if (description !== undefined) agent.description = description;
      if (openingMessage !== undefined) agent.opening_message = openingMessage;
      if (enableSuggestions !== undefined) agent.enable_suggestions = enableSuggestions;
      if (capabilities !== undefined) agent.capabilities = capabilities;
      if (capabilitiesChanged) {
        const regenerated = await createAgent(
          userId,
          agent.name,
          agent.description,
          agent.opening_message,
          agent.enable_suggestions,
          agent.capabilities
        );
        agent.model_roles = regenerated.model_roles;
        agent.system_prompt = regenerated.system_prompt;
      }
      agent.updated_at = new Date().toISOString();
      updatedAgent = agent;
      await db.write();
    });
    res.json(updatedAgent);
  } catch (error) {
    if (error.message === 'Agent not found') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/agents/:agentId', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { agentId } = req.params;
    const db = await req.getUserDb();
    await withWriteLock(userId, async () => {
      await db.read();
      db.data.agents = (db.data.agents || []).filter(a => a.id !== agentId);
      db.data.agent_messages = (db.data.agent_messages || []).filter(m => m.agent_id !== agentId);
      await db.write();
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/agents/:agentId/messages', async (req, res) => {
  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before;
    const db = await req.getUserDb();
    await db.read();
    let messages = (db.data.agent_messages || []).filter(m => m.agent_id === agentId);
    if (before) {
      const beforeIndex = messages.findIndex(m => m.id === before);
      if (beforeIndex > -1) {
        messages = messages.slice(0, beforeIndex);
      }
    }
    messages = messages.slice(-limit);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/agents/:agentId/chat', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { agentId } = req.params;
    const { message, attachments } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    let fullContent = '';
    const result = await chatWithAgent(userId, agentId, message, (chunk) => {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }, attachments || []);
    if (result && result.suggestions && result.suggestions.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'suggestions', suggestions: result.suggestions })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('[Agent对话路由] 错误:', error.message);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

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
}, async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { agentId } = req.params;
    const message = req.body.message || '';
    
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
    
    let fullContent = '';
    const result = await chatWithAgent(userId, agentId, message, (chunk) => {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }, attachments);
    
    if (result && result.suggestions && result.suggestions.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'suggestions', suggestions: result.suggestions })}\n\n`);
    }
    
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('[Agent对话-文件上传] 错误:', error.message);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

router.get('/agents/:agentId/suggestions', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { agentId } = req.params;
    const { context } = req.query;

    const db = await req.getUserDb();
    await db.read();
    const agent = db.data.agents.find(a => a.id === agentId);
    if (!agent) {
      return res.status(404).json({ error: '智能体不存在' });
    }

    if (!agent.enable_suggestions) {
      return res.json({ suggestions: [] });
    }

    const chatHistory = (db.data.agent_messages || [])
      .filter(m => m.agent_id === agentId)
      .slice(-10);
    const userProfile = db.data.userProfile || null;

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
  } catch (error) {
    console.error('[获取建议] 失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/agents/:agentId/invoke', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { agentId } = req.params;
    const { context } = req.body;
    const response = await invokeAgentInGroup(userId, agentId, context);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
