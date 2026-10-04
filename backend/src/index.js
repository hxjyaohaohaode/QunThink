import 'dotenv/config';
import { getCatalogData } from './services/ai/catalog.js';
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
import apiConfigRouter from './routes/apiconfig.js';
import modelCatalogRouter from './routes/modelCatalog.js';
import tasksRouter from './routes/tasks.js';
import personalGoalsRouter from './routes/personalGoals.js';
import { closePersonalGoalRuntime, getPersonalGoalRuntime } from './foundations/personalWorkspace.js';
import { startGoalBriefScheduler } from './foundations/goalBriefScheduler.js';
import { startTaskScheduler, stopTaskScheduler } from './services/tasks.js';
import authMiddleware, { isAuthConfigured } from './middleware/auth.js';
import { injectUserDb } from './middleware/userDb.js';
import { rateLimiter, messageRateLimiter, fileRateLimiter, aiRateLimiter, queryRateLimiter, authRateLimiter, cleanup as cleanupRateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { getUploadsDir, initDatabase, sanitizeGroupsForClient } from './models/db.js';
import { getAuthDb, initAuthDb } from './models/authDb.js';
import { closeMongoConnection } from './models/mongoAdapter.js';
import { closeSupabaseConnection } from './models/supabaseAdapter.js';
import fs from 'fs/promises';
import crypto from 'crypto';
import { setupWebSocket } from './websocket/index.js';
import { checkAllAIHealth, loadAIConfigsFromDB } from './services/ai/index.js';
import { safeLog } from './utils/logger.js';
import { initializeKeyManager } from './utils/keyManager.js';
import { startTTSCleanupScheduler } from './services/scheduler/ttsCleanup.js';
import { initSmsClient } from './services/sms/index.js';
import { toPublicApiConfigs } from './utils/apiConfigSecurity.js';
import { migrateApiConfigSecrets } from './services/apiConfigMigration.js';

if (process.platform === 'win32') {
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = function (...args) {
    origWarn.apply(console, args);
  };
  console.error = function (...args) {
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
let goalBriefScheduler = null;

if (process.env.AUTH_MODE === 'dev' && isProduction) {
  console.error('\n🚨 CRITICAL SECURITY ERROR: AUTH_MODE=dev is not allowed in production!');
  console.error('   The server will NOT start. Please set AUTH_MODE=session in production.\n');
  process.exit(1);
}

const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY !== undefined) {
  if (TRUST_PROXY === 'false' || TRUST_PROXY === '') {
    app.set('trust proxy', false);
  } else if (/^\d+$/.test(TRUST_PROXY)) {
    app.set('trust proxy', parseInt(TRUST_PROXY, 10));
  } else {
    app.set('trust proxy', TRUST_PROXY.split(',').map(s => s.trim()).filter(Boolean));
  }
  console.log(`🔗 trust proxy 设置为: ${TRUST_PROXY}`);
} else if (isProduction) {
  app.set('trust proxy', 1);
  console.log('🔗 生产环境默认启用 trust proxy=1（可用 TRUST_PROXY=false 关闭）');
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
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

// Beacon diagnostics have a much smaller body contract than file or message
// APIs. Parse and cap them before the general JSON parser accepts 5 MB.
app.use('/api/monitoring/errors', express.json({ limit: '8kb' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// 限流必须先于其保护的路由注册（Express 按注册顺序匹配）。
// /api/csrf-token 与 /api/auth/token 定义在后，若限流挂载在其后将永不生效。
app.use('/api/auth', (req, res, next) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? queryRateLimiter(req, res, next) : authRateLimiter(req, res, next));
app.use('/api/sms', authRateLimiter);
// 消息端点：仅对写操作（POST/DELETE）限流；GET 拉取与已读回执走宽松的查询桶，
// 避免列表刷新/已读上报流量把发送配额饿死（用户主动浏览不应惩罚自己的发送）
app.use('/api/groups/:groupId/messages', (req, res, next) => {
  if (req.method === 'GET' || /\.\/read$/.test(req.path) || req.path === '/read-batch') return queryRateLimiter(req, res, next);
  return messageRateLimiter(req, res, next);
});

if (isAuthConfigured()) {
  const isProd = process.env.NODE_ENV === 'production';
  const CSRF_TOKEN_LENGTH = 32;
  const CSRF_COOKIE_NAME = 'XSRF-TOKEN';
  const CSRF_HEADER_NAME = 'x-csrf-token';
  const CSRF_MAX_MAP_SIZE = 5000;

  function generateCsrfToken() {
    return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('base64url');
  }

  const csrfTokenMap = new Map();

  app.use((req, res, next) => {
    const existingToken = req.cookies?.[CSRF_COOKIE_NAME];
    let token = existingToken;
    if (!token || !csrfTokenMap.has(token)) {
      token = generateCsrfToken();
      if (csrfTokenMap.size >= CSRF_MAX_MAP_SIZE) {
        const oldestKey = csrfTokenMap.keys().next().value;
        csrfTokenMap.delete(oldestKey);
      }
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

  const csrfCleanupTimer = setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000;
    for (const [token, meta] of csrfTokenMap) {
      if (now - meta.createdAt > maxAge) {
        csrfTokenMap.delete(token);
      }
    }
  }, 60 * 60 * 1000);
  if (typeof csrfCleanupTimer.unref === 'function') csrfCleanupTimer.unref();

  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    // 监控错误上报走 sendBeacon（无法携带自定义头），豁免 CSRF；该端点仅写入内存分桶
    if (req.path === '/api/monitoring/errors') return next();
    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
    const headerToken = req.headers[CSRF_HEADER_NAME];
    let tokensMatch = false;
    if (cookieToken && headerToken && cookieToken.length === headerToken.length) {
      try {
        tokensMatch = crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
      } catch {
        tokensMatch = false;
      }
    }
    if (!tokensMatch || !csrfTokenMap.has(cookieToken)) {
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
    const { listUserDatabases } = await import('./models/db.js');
    const userIds = await listUserDatabases();
    // 仅验证存储层可枚举性，不加载用户数据（避免健康检查产生重 IO）
    health.database = Array.isArray(userIds) ? 'connected' : 'error';
    if (!Array.isArray(userIds)) health.status = 'degraded';
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

app.use('/api', authRouter);
app.use('/api', smsRouter);
app.use(authMiddleware);
app.use(injectUserDb);

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
      groups: sanitizeGroupsForClient(db.data.groups || []),
      profile: db.data.userProfile || {},
      personas: buildMergedPersonas(db.data.customPersonas || {}, getCatalogData(db.data)),
      apiConfigs: toPublicApiConfigs(db.data.aiApiConfigs || {})
    });
  } catch (error) {
    safeLog('error', 'bootstrap failed', { userId: req.userId, error: error?.message });
    res.status(500).json({ error: '首屏数据加载失败' });
  }
});

app.use('/api/groups', queryRateLimiter);
app.use('/api/ai', aiRateLimiter);
app.use('/api/tts', aiRateLimiter);
app.use('/api/files', fileRateLimiter);
app.use('/api/social', queryRateLimiter);
app.use('/api/memory', queryRateLimiter);
app.use('/api/interaction', queryRateLimiter);

app.use('/api/user', apiConfigRouter);
app.use('/api/user', modelCatalogRouter);
app.use('/api', tasksRouter);
app.use('/api', personalGoalsRouter);
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
  await initAuthDb();
  initSmsClient();
  await initializeKeyManager();
  await migrateApiConfigSecrets();

  try {
    await fs.access(uploadsDir);
  } catch {
    await fs.mkdir(uploadsDir, { recursive: true });
    console.log('📁 创建上传目录:', uploadsDir);
  }

  console.log('模型连接由各用户的模型中心管理；未配置的模型会显示连接提示。');

  setupWebSocket(wss);

  await loadAIConfigsFromDB();

  const { listUserDatabases, getUserDb } = await import('./models/db.js');
  const userIds = await listUserDatabases();

  // 将历史遗留的明文消息预览统一迁移为加密存储（静态加密完整性修复）
  try {
    let totalFixed = 0;
    for (const userId of userIds) {
      const db = await getUserDb(userId);
      await db.read();
      let userFixed = 0;

      for (const group of (db.data.groups || [])) {
        const preview = group.last_message_preview;
        const isPlaintext = typeof preview === 'string' && preview.length > 0 && !preview.includes('"encrypted"');
        if (isPlaintext) {
          try {
            const { encryptText } = await import('./utils/encryption.js');
            group.last_message_preview = encryptText(preview);
            userFixed++;
          } catch {
            group.last_message_preview = null;
            userFixed++;
          }
        } else if (preview !== null && preview !== undefined && typeof preview !== 'string') {
          group.last_message_preview = null;
          userFixed++;
        }
      }

      if (userFixed > 0) {
        await db.write();
        console.log(`🔒 已加密用户 ${userId} 的 ${userFixed} 个群组的明文消息预览`);
        totalFixed += userFixed;
      }
    }
    if (totalFixed > 0) {
      console.log(`✅ 共加密了 ${totalFixed} 个群组的明文消息预览`);
    } else {
      console.log('✅ 所有群组的消息预览均为加密状态');
    }
  } catch (error) {
    console.warn('⚠️  迁移消息预览时出错:', error.message);
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
  await startTaskScheduler();

  if (process.env.QUNTHINK_GOAL_BRIEF_SCHEDULER === '1') {
    const runtime = getPersonalGoalRuntime();
    if (!runtime?.pool) throw new Error('Goal brief scheduler requires QUNTHINK_FOUNDATIONS_RUNTIME_URL');
    goalBriefScheduler = startGoalBriefScheduler({
      ...runtime,
      intervalMs: process.env.QUNTHINK_GOAL_BRIEF_POLL_MS || undefined,
      usersPerTick: process.env.QUNTHINK_GOAL_BRIEF_USERS_PER_TICK || undefined,
      runsPerUser: process.env.QUNTHINK_GOAL_BRIEF_RUNS_PER_USER || undefined,
      listUserIds: async () => {
        const authDb = getAuthDb();
        await authDb.read();
        return authDb.data.users.filter(user => user.active !== false).map(user => user.id);
      },
      onError: error => safeLog('error', '受限目标简报调度失败', { code: error?.code || 'UNKNOWN' }),
      onTick: report => {
        if (report?.advanced || report?.waiting || report?.errors) {
          safeLog('info', '受限目标简报调度结果', report);
        }
      }
    });
  }

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

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);

    if (process.env.AI_HEALTH_PROBES === '1') checkAllAIHealth().then(results => {
      console.log('AI健康检查完成:', results);
    });
  });
}).catch((error) => {
  safeLog('error', '服务启动失败，已安全终止', { error: error?.message });
  process.exitCode = 1;
  server.close();
  wss.close();
});

async function closeAllConnections() {
  await goalBriefScheduler?.stop();
  await Promise.all([
    closeMongoConnection().catch(() => { }),
    closeSupabaseConnection().catch(() => { }),
    closePersonalGoalRuntime().catch(() => { })
  ]);
}

function gracefulShutdown(signal) {
  stopTaskScheduler();
  void goalBriefScheduler?.stop();
  console.log(`${signal} received, shutting down gracefully...`);
  try { cleanupRateLimiter(); } catch {}
  server.close(() => {
    console.log('HTTP server closed');
    wss.close(() => {
      console.log('WebSocket server closed');
      closeAllConnections().then(() => process.exit(0)).catch(() => process.exit(0));
    });
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    wss.clients?.forEach(client => {
      try { client.terminate(); } catch {}
    });
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 全局未捕获异常处理，防止单次异常导致进程崩溃
process.on('uncaughtException', (err) => {
  safeLog('error', '未捕获的异常', { message: err.message, stack: err.stack?.split('\n').slice(0, 3).join('\n') });
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
    // 网络相关错误不退出进程
    return;
  }
  console.error('致命未捕获异常，进程即将退出:', err.message);
  try { server.close(); } catch {}
  setTimeout(() => process.exit(1), 3000).unref?.();
});

process.on('unhandledRejection', (reason) => {
  safeLog('error', '未处理的Promise拒绝', { message: reason?.message || String(reason) });
});
