import 'dotenv/config';
import express from 'express';

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import groupsRouter from './routes/groups.js';
import messagesRouter from './routes/messages.js';
import filesRouter from './routes/files.js';
import socialRouter from './routes/social.js';
import memoryRouter from './routes/memory.js';
import aiRouter from './routes/ai.js';
import interactionRouter from './routes/interaction.js';
import monitoringRouter from './routes/monitoring.js';
import profileRouter from './routes/profile.js';
import personasRouter, { buildMergedPersonas } from './routes/personas.js';
import ttsRouter from './routes/tts.js';
import agentsRouter from './routes/agents.js';
import authRouter from './routes/auth.js';
import smsRouter from './routes/sms.js';
import authMiddleware, { isAuthConfigured } from './middleware/auth.js';
import { injectUserDb } from './middleware/userDb.js';
import { rateLimiter, messageRateLimiter, fileRateLimiter, aiRateLimiter, queryRateLimiter, authRateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { getUploadsDir, initDatabase } from './models/db.js';
import { getAuthDb, initAuthDb } from './models/authDb.js';
import { closeMongoConnection } from './models/mongoAdapter.js';
import fs from 'fs/promises';
import crypto from 'crypto';
import { setupWebSocket } from './websocket/index.js';
import { checkAllAIHealth, loadAIConfigsFromDB } from './services/ai/index.js';
import { safeLog } from './utils/logger.js';
import { initializeKeyManager } from './utils/keyManager.js';
import { startAutonomousChatTimer } from './services/scheduler/index.js';
import { startTTSCleanupScheduler } from './services/scheduler/ttsCleanup.js';
import { initSmsClient } from './services/sms/index.js';

if (process.platform === 'win32') {
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = function(...args) {
    origWarn.apply(console, args);
  };
  console.error = function(...args) {
    origError.apply(console, args);
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = getUploadsDir();

const app = express();
const server = createServer(app);

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.timeout = 120000;

const wss = new WebSocketServer({ 
  server, 
  path: '/ws',
  maxPayload: 10 * 1024 * 1024,
  perMessageDeflate: false,
  clientTracking: true
});

const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3002;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "ws:", "wss:", "https://api.deepseek.com", "https://open.bigmodel.cn", "https://api.minimax.chat"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  xFrameOptions: 'DENY',
  xContentTypeOptions: true,
  referrerPolicy: 'strict-origin-when-cross-origin',
  crossOriginEmbedderPolicy: false
}));

app.use(cookieParser());

app.use((req, res, next) => {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:5173', 'http://localhost:3010', 'http://localhost:3002', 'http://127.0.0.1:5173'];
  const origin = req.headers.origin;
  const allowedDevPorts = ['3000', '3002', '3010', '4173', '4174', '5173'];
  const isLocalDev = !isProduction && origin && /^http:\/\/(localhost|127\.0\.0\.1):(\d+)$/.test(origin) && allowedDevPorts.includes(origin.match(/:(\d+)$/)?.[1] || '');
  const isLanDev = !isProduction && origin && /^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|198\.18\.\d+\.\d+):(\d+)$/.test(origin);

  if (allowedOrigins.includes(origin) || isLocalDev || isLanDev) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-id, x-csrf-token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

if (isAuthConfigured()) {
  const isProd = process.env.NODE_ENV === 'production';
  const CSRF_TOKEN_LENGTH = 32;
  const CSRF_COOKIE_NAME = 'XSRF-TOKEN';
  const CSRF_HEADER_NAME = 'x-csrf-token';

  function generateCsrfToken() {
    return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('base64url');
  }

  const csrfTokenMap = new Map();

  app.use((req, res, next) => {
    const existingToken = req.cookies?.[CSRF_COOKIE_NAME];
    let token = existingToken;
    if (!token || !csrfTokenMap.has(token)) {
      token = generateCsrfToken();
      csrfTokenMap.set(token, { createdAt: Date.now() });
      res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        sameSite: isProd ? 'none' : 'lax',
        secure: isProd,
        path: '/'
      });
    }
    req.csrfToken = () => token;
    next();
  });

  setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    for (const [token, meta] of csrfTokenMap) {
      if (now - meta.createdAt > maxAge) {
        csrfTokenMap.delete(token);
      }
    }
  }, 60 * 60 * 1000);

  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
    const headerToken = req.headers[CSRF_HEADER_NAME];
    if (!cookieToken || !headerToken || cookieToken !== headerToken || !csrfTokenMap.has(cookieToken)) {
      return res.status(403).json({ error: 'CSRF token validation failed' });
    }
    next();
  });
}



let healthCheckCache = { result: null, timestamp: 0 };
const HEALTH_CACHE_TTL = 60 * 1000;

app.get('/api/health', async (req, res) => {
  const now = Date.now();
  
  if (healthCheckCache.result && now - healthCheckCache.timestamp < HEALTH_CACHE_TTL) {
    const statusCode = healthCheckCache.result.status === 'ok' ? 200 : 503;
    return res.status(statusCode).json(healthCheckCache.result);
  }

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString()
  };

  try {
    const { listUserDatabases, getUserDb } = await import('./models/db.js');
    const userIds = await listUserDatabases();
    // 仅验证数据库可读性，不暴露用户数据统计
    if (userIds.length > 0) {
      const db = await getUserDb(userIds[0]);
      await db.read();
    }
    health.database = 'connected';
  } catch (error) {
    health.database = 'error';
    health.status = 'degraded';
  }

  healthCheckCache = { result: health, timestamp: now };

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

app.get('/api/csrf-token', (req, res) => {
  if (!isAuthConfigured()) {
    return res.json({ enabled: false });
  }

  res.json({
    enabled: true,
    csrfToken: req.csrfToken ? req.csrfToken() : null
  });
});

app.get('/api/auth/token', async (req, res) => {
  if (!isAuthConfigured()) {
    return res.json({
      enabled: false,
      message: '认证未启用（开发模式）'
    });
  }

  const token = req.cookies?.session_token;
  if (!token) {
    return res.json({
      enabled: true,
      valid: false,
      mode: 'session',
      message: '需要登录'
    });
  }

  const authDb = getAuthDb();
  await authDb.read();
  const session = authDb.data.sessions.find(entry => {
    if (entry.token.length !== token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(entry.token), Buffer.from(token));
    } catch {
      return false;
    }
  });
  const isValidSession = !!session && new Date(session.expires_at) >= new Date();

  if (!isValidSession) {
    return res.json({
      enabled: true,
      valid: false,
      mode: 'session',
      message: '会话已过期'
    });
  }

  return res.json({
    enabled: true,
    valid: true,
    mode: 'session',
    message: '会话有效'
  });
});

app.use('/api/auth', authRateLimiter);
app.use('/api/sms', authRateLimiter);
app.use('/api', authRouter);
app.use('/api', smsRouter);
app.use(authMiddleware);
app.use(injectUserDb);
app.use('/uploads', express.static(uploadsDir));

app.get('/api/bootstrap', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();

    let user = { id: req.userId };
    try {
      const authDb = getAuthDb();
      await authDb.read();
      const authUser = authDb.data.users.find(entry => entry.id === req.userId);
      if (authUser) {
        user = {
          id: authUser.id,
          username: authUser.username,
          nickname: authUser.nickname || db.data.userProfile?.nickname || ''
        };
      } else if (db.data.userProfile?.nickname) {
        user.nickname = db.data.userProfile.nickname;
      }
    } catch {
      if (db.data.userProfile?.nickname) {
        user.nickname = db.data.userProfile.nickname;
      }
    }

    res.json({
      success: true,
      user,
      groups: db.data.groups || [],
      profile: db.data.userProfile || {},
      personas: buildMergedPersonas(db.data.customPersonas || {})
    });
  } catch (error) {
    safeLog('error', 'bootstrap failed', { userId: req.userId, error: error?.message });
    res.status(500).json({ error: '首屏数据加载失败' });
  }
});

app.use('/api/groups/:groupId/messages', messageRateLimiter);
app.use('/api/groups', queryRateLimiter);
app.use('/api/ai', aiRateLimiter);
app.use('/api/tts', aiRateLimiter);
app.use('/api/files', fileRateLimiter);
app.use('/api/social', queryRateLimiter);
app.use('/api/memory', queryRateLimiter);
app.use('/api/interaction', queryRateLimiter);

app.use('/api', groupsRouter);
app.use('/api', messagesRouter);
app.use('/api', filesRouter);
app.use('/api', socialRouter);
app.use('/api', memoryRouter);
app.use('/api', aiRouter);
app.use('/api', interactionRouter);
app.use('/api', monitoringRouter);
app.use('/api', profileRouter);
app.use('/api', personasRouter);
app.use('/api', agentsRouter);
app.use('/api/tts', ttsRouter);

app.use(errorHandler);

initDatabase().then(async () => {
  if (process.env.AUTH_MODE === 'dev' && process.env.NODE_ENV === 'production') {
    console.error('\n🚨 CRITICAL SECURITY ERROR: AUTH_MODE=dev is not allowed in production!');
    console.error('   The server will NOT start. Please set AUTH_MODE=session in production.\n');
    process.exit(1);
  }

  await initAuthDb();
  initSmsClient();
  await initializeKeyManager();

  try {
    await fs.access(uploadsDir);
  } catch {
    await fs.mkdir(uploadsDir, { recursive: true });
    console.log('📁 创建上传目录:', uploadsDir);
  }

  console.log('\n🔑 ========== API密钥配置检查 ==========');
  const requiredKeys = [
    { key: 'DEEPSEEK_API_KEY', name: 'DeepSeek', env: process.env.DEEPSEEK_API_KEY },
    { key: 'GLM_API_KEY', name: '智谱清言(GLM)', env: process.env.GLM_API_KEY },
    { key: 'MIMO_API_KEY', name: 'MIMO', env: process.env.MIMO_API_KEY },
    { key: 'QWEN_API_KEY', name: '千问(Qwen)', env: process.env.QWEN_API_KEY },
  ];
  
  let configuredCount = 0;
  let misconfiguredCount = 0;
  
  for (const { key, name, env } of requiredKeys) {
    if (!env || env.startsWith('your_') || env.includes('_here')) {
      console.warn(`  ❌ ${name} (${key}): 未配置或使用占位符`);
      misconfiguredCount++;
    } else {
      console.log(`  ✅ ${name} (${key}): 已配置`);
      configuredCount++;
    }
  }
  
  if (misconfiguredCount === requiredKeys.length) {
    console.error('\n⚠️  严重警告：所有AI API密钥均未配置！系统将只能使用模拟回复。');
    console.error('   请在 backend/.env 文件中配置至少一个API密钥。\n');
  } else if (misconfiguredCount > 0) {
    console.warn(`\n⚠️  有 ${misconfiguredCount} 个API密钥未配置，对应AI将使用模拟回复。\n`);
  } else {
    console.log('\n✅ 所有API密钥已配置，AI对话功能完全可用！\n');
  }
  console.log('🔑 ==========================================\n');

  setupWebSocket(wss);

  await loadAIConfigsFromDB();

  const { listUserDatabases, getUserDb } = await import('./models/db.js');
  const userIds = await listUserDatabases();
  
  // 修复已存在的群组消息预览（解密加密的 content）
  try {
    let totalFixed = 0;
    for (const userId of userIds) {
      const db = await getUserDb(userId);
      await db.read();
      let userFixed = 0;
      
      for (const group of (db.data.groups || [])) {
        if (group.last_message_preview && group.last_message_preview.includes('"encrypted"')) {
          // 查找该群组的最后一条消息并生成正确的预览
          const groupMessages = (db.data.messages || [])
            .filter(m => m.group_id === group.id)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          
          if (groupMessages.length > 0) {
            const lastMsg = groupMessages[groupMessages.length - 1];
            const prefix = lastMsg.sender_type === 'user' ? '[我] ' : '';
            let content = lastMsg.content || '';
            
            // 如果内容被加密，尝试解密
            if (lastMsg.metadata?.encryption?.encrypted && typeof content === 'string') {
              try {
                const { decryptText } = await import('./utils/encryption.js');
                content = decryptText(content);
              } catch {
                content = '[加密消息]';
              }
            }
            
            group.last_message_preview = `${prefix}${content.substring(0, 50)}`;
            userFixed++;
          } else {
            group.last_message_preview = null;
            userFixed++;
          }
        }
      }
      
      if (userFixed > 0) {
        await db.write();
        console.log(`🔓 已修复用户 ${userId} 的 ${userFixed} 个群组的消息预览`);
        totalFixed += userFixed;
      }
    }
    if (totalFixed > 0) {
      console.log(`✅ 共修复了 ${totalFixed} 个群组的加密消息预览`);
    } else {
      console.log('✅ 所有群组的消息预览均已正常');
    }
  } catch (error) {
    console.warn('⚠️  修复消息预览时出错:', error.message);
  }
  let startedTimers = 0;
  
  // 禁用自动启动自发对话 - AI只在用户发言后才回复
  // for (const userId of userIds) {
  //   const db = await getUserDb(userId);
  //   await db.read();
  //   const groups = db.data.groups || [];
  //   for (const group of groups) {
  //     if (!group.is_private && !group.is_ai_private && group.ai_members && group.ai_members.length >= 2) {
  //       startAutonomousChatTimer(group.id);
  //       startedTimers++;
  //     }
  //   }
  // }
  
  console.log(`🤖 AI自发对话已禁用 - AI将只在用户发言后回复`);

  startTTSCleanupScheduler();

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);

    checkAllAIHealth().then(results => {
      console.log('AI健康检查完成:', results);
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n端口 ${PORT} 已被占用，请先关闭占用该端口的进程，或修改 .env 中的 PORT 配置。`);
      console.error(`提示: 使用 "netstat -ano | findstr :${PORT}" 查看占用进程\n`);
      process.exit(1);
    } else {
      console.error('服务器启动失败:', error.message);
      process.exit(1);
    }
  });
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('HTTP server closed');
    wss.close(() => {
      console.log('WebSocket server closed');
      closeMongoConnection().then(() => {
        process.exit(0);
      }).catch(() => {
        process.exit(0);
      });
    });
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    wss.close(() => {
      closeMongoConnection().then(() => {
        process.exit(0);
      }).catch(() => {
        process.exit(0);
      });
    });
  });
});
