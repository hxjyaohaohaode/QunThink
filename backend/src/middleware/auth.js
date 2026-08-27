import crypto from 'crypto';
import { getAuthDb, findSessionByToken, isAdminUserId } from '../models/authDb.js';
import { safeLog } from '../utils/logger.js';

const authMode = process.env.AUTH_MODE || 'session';
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_THRESHOLD = SESSION_MAX_AGE * 0.5;

const publicPaths = [
  '/api/health',
  '/api/csrf-token',
  '/api/auth/token',
  '/api/auth/register',
  '/api/auth/login-phone',
  '/api/auth/register-sms',
  '/api/auth/me',
  '/api/sms/send',
  '/api/sms/verify',
  '/api/files/public'
];

async function refreshSessionIfNeeded(session, req, res) {
  const now = Date.now();
  const expiresAt = new Date(session.expires_at).getTime();
  const remaining = expiresAt - now;

  if (remaining < SESSION_REFRESH_THRESHOLD) {
    try {
      const db = getAuthDb();
      const newExpiresAt = new Date(now + SESSION_MAX_AGE).toISOString();
      const { withWriteLock } = await import('../models/db.js');
      await withWriteLock('auth', async () => {
        await db.read();
        const s = findSessionByToken(db, session.token);
        if (s) {
          s.expires_at = newExpiresAt;
          await db.write();
        }
      });

      const isProduction = process.env.NODE_ENV === 'production';
      res.cookie('session_token', session.token, {
        httpOnly: true,
        domain: isProduction ? undefined : 'localhost',
        path: '/',
        sameSite: isProduction ? 'none' : 'lax',
        // Express res.cookie 的 maxAge 单位是毫秒。
        maxAge: SESSION_MAX_AGE,
        secure: isProduction
      });
      session.expires_at = newExpiresAt;
    } catch (err) {
      safeLog('warn', '会话刷新失败:', { error: err?.message });
    }
  }
}

async function resolveSessionUser(req) {
  const token = req.cookies?.session_token;
  if (!token) return { error: 'unauthenticated' };
  const db = getAuthDb();
  await db.read();
  const session = findSessionByToken(db, token);
  if (!session || new Date(session.expires_at) < new Date()) {
    return { error: 'expired' };
  }
  return { session };
}

const authMiddleware = async (req, res, next) => {
  if (authMode === 'dev' && process.env.NODE_ENV === 'production') {
    console.error('[Security] CRITICAL: Dev auth mode detected in production! Rejecting all requests.');
    return res.status(500).json({ error: '服务器配置错误' });
  }

  const requestPath = req.path || req.originalUrl?.split('?')[0] || '';
  const isPublicPath = publicPaths.some(publicPath =>
    requestPath === publicPath || requestPath.startsWith(publicPath + '/')
  );

  if (isPublicPath) {
    return next();
  }

  if (authMode === 'dev') {
    if (process.env.NODE_ENV === 'production') {
      console.error('[Security] Dev auth mode is not allowed in production');
      return res.status(500).json({ error: '服务器配置错误' });
    }
    const userId = req.headers['x-user-id'];
    if (!userId || !/^dev_[a-zA-Z0-9_-]+$/.test(userId)) {
      return res.status(401).json({ error: '开发模式需要提供有效的用户标识', requiresAuth: true });
    }
    req.userId = userId;
    return next();
  }


  try {
    const { session, error } = await resolveSessionUser(req);
    if (error === 'unauthenticated') {
      return res.status(401).json({
        error: '未登录',
        requiresAuth: true
      });
    }
    if (error === 'expired' || !session) {
      return res.status(401).json({
        error: '会话已过期',
        requiresAuth: true
      });
    }

    req.userId = session.userId;
    req.session = session;

    await refreshSessionIfNeeded(session, req, res);

    next();
  } catch (err) {
    safeLog('error', '会话验证失败:', { error: err?.message });
    res.status(500).json({ error: '服务器错误' });
  }
};

export const isSessionAuthEnabled = () => authMode === 'session';
export const isAuthConfigured = () => authMode !== 'dev';

export const requireAuth = async (req, res, next) => {
  if (!isSessionAuthEnabled()) {
    return next();
  }

  try {
    const { session, error } = await resolveSessionUser(req);
    if (error === 'unauthenticated') {
      return res.status(401).json({
        error: '需要身份验证',
        requiresAuth: true
      });
    }
    if (error === 'expired' || !session) {
      return res.status(401).json({
        error: '会话已过期',
        requiresAuth: true
      });
    }

    req.userId = session.userId;
    req.session = session;

    await refreshSessionIfNeeded(session, req, res);

    next();
  } catch (err) {
    safeLog('error', '身份验证失败:', { error: err?.message });
    res.status(500).json({ error: '服务器错误' });
  }
};

export const requireAdmin = async (req, res, next) => {
  const proceed = async () => {
    let isAdmin = isAdminUserId(req.userId);
    if (!isAdmin) {
      try {
        const db = getAuthDb();
        await db.read();
        const user = db.data.users.find(u => u.id === req.userId);
        isAdmin = user?.role === 'admin' || isAdminUserId(user?.id);
      } catch (err) {
        safeLog('error', '管理员校验失败:', { error: err?.message });
      }
    }
    if (!isAdmin) {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
  };

  if (req.session || req.userId) {
    return proceed();
  }
  await requireAuth(req, res, proceed);
};

export default authMiddleware;
