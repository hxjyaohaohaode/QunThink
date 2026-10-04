import express from 'express';
import { sendSmsVerifyCode, checkSmsVerifyCode, isSmsConfigured } from '../services/sms/index.js';
import { getAuthDb, hashPasswordAsync, generateSessionToken } from '../models/authDb.js';
import { initUserDatabase, withWriteLock } from '../models/db.js';
import { validateBody, smsSendSchema, smsVerifySchema } from '../validators/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import crypto from 'crypto';

const router = express.Router();
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';
const MAX_SESSIONS_PER_USER = 5;

const VERIFY_FAILURE_LIMIT = 5;
const VERIFY_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const verifyFailureRecords = new Map();

function buildSessionCookieOptions() {
  return {
    httpOnly: true,
    path: '/',
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: SESSION_MAX_AGE,
    secure: isProduction
  };
}

function checkVerifyRateLimit(phone) {
  const record = verifyFailureRecords.get(phone);
  if (!record) return { blocked: false };
  if (Date.now() - record.firstAt > VERIFY_FAILURE_WINDOW_MS) {
    verifyFailureRecords.delete(phone);
    return { blocked: false };
  }
  return { blocked: record.count >= VERIFY_FAILURE_LIMIT };
}

function recordVerifyFailure(phone) {
  const now = Date.now();
  const record = verifyFailureRecords.get(phone);
  if (!record || now - record.firstAt > VERIFY_FAILURE_WINDOW_MS) {
    verifyFailureRecords.set(phone, { count: 1, firstAt: now });
    return;
  }
  record.count += 1;
}

function clearVerifyFailures(phone) {
  verifyFailureRecords.delete(phone);
}

function pruneUserSessions(db, userId) {
  const userSessions = db.data.sessions.filter(s => s.userId === userId);
  const excess = userSessions.length - (MAX_SESSIONS_PER_USER - 1);
  if (excess <= 0) return;
  userSessions.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
  const tokensToRemove = new Set(userSessions.slice(0, excess).map(s => s.token));
  db.data.sessions = db.data.sessions.filter(s => !tokensToRemove.has(s.token));
}

router.post('/sms/send', validateBody(smsSendSchema), asyncHandler(async (req, res) => {
  if (!isSmsConfigured()) {
    return res.status(503).json({ error: '短信服务未配置' });
  }

  const { phone } = req.body;

  try {
    const result = await sendSmsVerifyCode(phone);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('频繁') ? 429 : 400;
    res.status(status).json({ error: err.message });
  }
}));

router.post('/sms/verify', validateBody(smsVerifySchema), asyncHandler(async (req, res) => {
  if (!isSmsConfigured()) {
    return res.status(503).json({ error: '短信服务未配置' });
  }

  const { phone, code } = req.body;

  const rateLimit = checkVerifyRateLimit(phone);
  if (rateLimit.blocked) {
    return res.status(429).json({ error: '验证码尝试次数过多，请15分钟后再试' });
  }

  let verifyResult;
  try {
    verifyResult = await checkSmsVerifyCode(phone, code);
  } catch {
    return res.status(400).json({ error: '验证码校验失败，请稍后重试' });
  }

  if (!verifyResult.verified) {
    recordVerifyFailure(phone);
    return res.status(400).json({ error: verifyResult.message || '验证码错误或已过期' });
  }

  clearVerifyFailures(phone);

  const db = getAuthDb();
  let user;
  let isNewUser = false;

  await withWriteLock('auth', async () => {
    await db.read();
    user = db.data.users.find(u => u.phone === phone);
  });

  if (!user) {
    isNewUser = true;
    const userId = crypto.randomUUID();
    const phoneSuffix = phone.substring(phone.length - 4);
    const username = `user_${phoneSuffix}_${Date.now().toString(36)}`;
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const passwordHash = await hashPasswordAsync(randomPassword);

    user = {
      id: userId,
      username,
      password: passwordHash,
      nickname: `用户${phoneSuffix}`,
      phone,
      role: 'user',
      created_at: new Date().toISOString()
    };

    let raceDetected = false;
    await withWriteLock('auth', async () => {
      await db.read();
      if (db.data.users.find(u => u.phone === phone)) {
        raceDetected = true;
        user = db.data.users.find(u => u.phone === phone);
        isNewUser = false;
        return;
      }
      db.data.users.push(user);
      await db.write();
    });

    if (!raceDetected) {
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
    }
  }

  const token = generateSessionToken();
  const session = {
    token,
    userId: user.id,
    expires_at: new Date(Date.now() + SESSION_MAX_AGE).toISOString()
  };

  await withWriteLock('auth', async () => {
    await db.read();
    pruneUserSessions(db, user.id);
    db.data.sessions.push(session);
    await db.write();
  });

  res.cookie('session_token', token, buildSessionCookieOptions());

  res.json({
    success: true,
    isNewUser,
    user: { id: user.id, username: user.username, nickname: user.nickname, phone: user.phone }
  });
}));

export default router;
