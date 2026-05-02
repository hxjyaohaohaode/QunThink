import express from 'express';
import { getAuthDb, hashPassword, verifyPassword, generateSessionToken } from '../models/authDb.js';
import { initUserDatabase, withWriteLock } from '../models/db.js';
import crypto from 'crypto';
import { validateBody, smsRegisterSchema, phoneLoginSchema } from '../validators/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { checkSmsVerifyCode, isSmsConfigured } from '../services/sms/index.js';

const router = express.Router();
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_MAX_AGE / 1000);
const isProduction = process.env.NODE_ENV === 'production';

router.post('/auth/login-phone', validateBody(phoneLoginSchema), asyncHandler(async (req, res) => {
  const { phone, password } = req.body;

  const db = getAuthDb();
  let user;
  await withWriteLock('auth', async () => {
    await db.read();
    user = db.data.users.find(u => u.phone === phone);
  });

  if (!user) {
    return res.status(401).json({ error: '该手机号未注册' });
  }

  if (!verifyPassword(password, user.password)) {
    return res.status(401).json({ error: '手机号或密码错误' });
  }

  const token = generateSessionToken();
  const session = {
    token,
    userId: user.id,
    expires_at: new Date(Date.now() + SESSION_MAX_AGE).toISOString()
  };

  await withWriteLock('auth', async () => {
    await db.read();
    const existingSessions = db.data.sessions.filter(s => s.userId === user.id);
    if (existingSessions.length >= 5) {
      existingSessions.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
      const sessionsToKeep = existingSessions.slice(-4);
      const sessionIdsToRemove = new Set(existingSessions.slice(0, -4).map(s => s.token));
      db.data.sessions = db.data.sessions.filter(s => !sessionIdsToRemove.has(s.token));
    }
    db.data.sessions.push(session);
    await db.write();
  });

  res.cookie('session_token', token, {
    httpOnly: true,
    domain: isProduction ? undefined : 'localhost',
    path: '/',
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: isProduction
  });

  res.json({
    success: true,
    user: { id: user.id, username: user.username, nickname: user.nickname, phone: user.phone }
  });
}));

router.post('/auth/register-sms', validateBody(smsRegisterSchema), asyncHandler(async (req, res) => {
  const { phone, password, code, nickname } = req.body;

  if (!isSmsConfigured()) {
    return res.status(503).json({ error: '短信服务未配置' });
  }

  try {
    const verifyResult = await checkSmsVerifyCode(phone, code);
    if (!verifyResult.verified) {
      return res.status(400).json({ error: verifyResult.message || '验证码错误或已过期' });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message || '验证码校验失败' });
  }

  const db = getAuthDb();

  let raceDetected = false;
  await withWriteLock('auth', async () => {
    await db.read();
    if (db.data.users.find(u => u.phone === phone)) {
      raceDetected = true;
    }
  });

  if (raceDetected) {
    return res.status(409).json({ error: '该手机号已注册' });
  }

  const userId = crypto.randomUUID();
  const phoneSuffix = phone.substring(phone.length - 4);
  const username = `user_${phoneSuffix}_${Date.now().toString(36)}`;
  const user = {
    id: userId,
    username,
    password: hashPassword(password),
    nickname: nickname || `用户${phoneSuffix}`,
    phone,
    created_at: new Date().toISOString()
  };

  await withWriteLock('auth', async () => {
    await db.read();
    if (db.data.users.find(u => u.phone === phone)) {
      raceDetected = true;
      return;
    }
    db.data.users.push(user);
    await db.write();
  });

  if (raceDetected) {
    return res.status(409).json({ error: '该手机号已注册' });
  }

  try {
    await initUserDatabase(userId);
  } catch (error) {
    await withWriteLock('auth', async () => {
      await db.read();
      db.data.users = db.data.users.filter(u => u.id !== userId);
      await db.write();
    });
    return res.status(500).json({ error: '用户数据库初始化失败' });
  }

  const token = generateSessionToken();
  const session = {
    token,
    userId,
    expires_at: new Date(Date.now() + SESSION_MAX_AGE).toISOString()
  };

  await withWriteLock('auth', async () => {
    await db.read();
    db.data.sessions.push(session);
    await db.write();
  });

  res.cookie('session_token', token, {
    httpOnly: true,
    domain: isProduction ? undefined : 'localhost',
    path: '/',
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: isProduction
  });

  res.status(201).json({
    success: true,
    user: { id: userId, username, nickname: user.nickname, phone }
  });
}));

router.post('/auth/logout', asyncHandler(async (req, res) => {
  const token = req.cookies?.session_token;
  if (token) {
    const db = getAuthDb();
    await withWriteLock('auth', async () => {
      await db.read();
      db.data.sessions = db.data.sessions.filter(s => s.token !== token);
      await db.write();
    });
  }

  res.clearCookie('session_token', {
    path: '/',
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction
  });
  res.json({ success: true });
}));

router.get('/auth/me', asyncHandler(async (req, res) => {
  const token = req.cookies?.session_token;
  if (!token) {
    return res.json({ user: null });
  }

  const db = getAuthDb();
  await db.read();

  const session = db.data.sessions.find(s => {
    if (s.token.length !== token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token));
    } catch {
      return false;
    }
  });
  if (!session || new Date(session.expires_at) < new Date()) {
    return res.json({ user: null });
  }

  const user = db.data.users.find(u => u.id === session.userId);
  if (!user) {
    return res.json({ user: null });
  }

  res.json({
    user: { id: user.id, username: user.username, nickname: user.nickname, phone: user.phone }
  });
}));

export default router;
