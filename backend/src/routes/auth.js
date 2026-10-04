import express from 'express';
import { getAuthDb, hashPasswordAsync, verifyPasswordAsync, generateSessionToken, findSessionByToken } from '../models/authDb.js';
import { initUserDatabase, withWriteLock } from '../models/db.js';
import crypto from 'crypto';
import { validateBody, smsRegisterSchema, phoneLoginSchema } from '../validators/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { checkSmsVerifyCode, isSmsConfigured } from '../services/sms/index.js';
import { provisionNewLocalMemoryAccount } from '../services/memory/persistentMemory.js';

const router = express.Router();
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';
const MAX_SESSIONS_PER_USER = 5;

function buildSessionCookieOptions() {
  return {
    httpOnly: true,
    // Keep the cookie host-only. A fixed localhost domain is rejected when
    // Windows development and test browsers use 127.0.0.1.
    path: '/',
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: SESSION_MAX_AGE,
    secure: isProduction
  };
}

function buildClearSessionCookieOptions() {
  return {
    path: '/',
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction
  };
}

function pruneUserSessions(db, userId) {
  const userSessions = db.data.sessions.filter(s => s.userId === userId);
  const excess = userSessions.length - (MAX_SESSIONS_PER_USER - 1);
  if (excess <= 0) return;
  userSessions.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
  const tokensToRemove = new Set(userSessions.slice(0, excess).map(s => s.token));
  db.data.sessions = db.data.sessions.filter(s => !tokensToRemove.has(s.token));
}

async function confirmRegistrationWrite(db, userId, token, originalError) {
  // A write may commit and lose its acknowledgement. Re-read the authority
  // before deciding whether to return a usable account or a failure.
  try { await db.read({ force: true }); }
  catch {
    throw Object.assign(new Error('注册写入结果待核验，请稍后尝试登录'), {
      code: 'REGISTRATION_OUTCOME_UNKNOWN', statusCode: 503, isOperational: true
    });
  }
  const userExists = db.data.users?.some(user => user.id === userId);
  const sessionExists = token ? db.data.sessions?.some(session =>
    session.userId === userId && session.token === token) : false;
  if (userExists && (!token || sessionExists)) return;
  if (!userExists && !sessionExists) throw originalError;
  throw Object.assign(new Error('注册账号与会话状态不一致，请联系管理员核验'), {
    code: 'REGISTRATION_OUTCOME_UNKNOWN', statusCode: 503, isOperational: true
  });
}

// 仅供本地开发和自动化测试使用；生产注册必须经过短信验证。
if (!isProduction) {
  router.post('/auth/register', asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.trim() : '';
    // 可选 phone：填写后即可通过登录页「手机号+密码」表单登录（开发便利，生产仍走短信注册）
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: '手机号格式不正确' });
    }
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(username) || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: '用户名或密码格式不正确' });
    }

    const passwordHash = await hashPasswordAsync(password);
    const db = getAuthDb();
    const userId = crypto.randomUUID();
    const user = {
      id: userId,
      username,
      password: passwordHash,
      nickname: nickname || username,
      role: 'user',
      created_at: new Date().toISOString()
    };
    if (phone) {
      user.phone = phone;
    }
    const token = generateSessionToken();

    let duplicate = false;
    let duplicateField = '';
    await withWriteLock('auth', async () => {
      await db.read();
      duplicate = db.data.users.some(entry => entry.username === username);
      if (duplicate) { duplicateField = '用户名已存在'; return; }
      if (phone && db.data.users.some(entry => entry.phone === phone)) {
        duplicate = true;
        duplicateField = '手机号已被使用';
        return;
      }
      // Provision the independent deletion ledger before this account/session
      // becomes visible. A crash can leave an orphan UUID, never an account
      // that is readable but lacks its required ledger.
      const userDb = await initUserDatabase(userId);
      await provisionNewLocalMemoryAccount(userId, userDb);
      db.data.users = [...db.data.users, user];
      db.data.sessions = [...db.data.sessions,
        { token, userId, expires_at: new Date(Date.now() + SESSION_MAX_AGE).toISOString() }];
      try { await db.write(); }
      catch (error) {
        await confirmRegistrationWrite(db, userId, token, error);
      }
    });
    if (duplicate) return res.status(409).json({ error: duplicateField || '用户名已存在' });

    res.cookie('session_token', token, buildSessionCookieOptions());
    return res.status(201).json({ success: true, user: { id: userId, username, nickname: user.nickname } });
  }));
}

router.post('/auth/login-phone', validateBody(phoneLoginSchema), asyncHandler(async (req, res) => {
  const { phone, password } = req.body;

  const db = getAuthDb();
  let user;
  await withWriteLock('auth', async () => {
    await db.read();
    user = db.data.users.find(u => u.phone === phone);
  });

  let passwordValid = false;
  if (user) {
    passwordValid = await verifyPasswordAsync(password, user.password);
  } else {
    await hashPasswordAsync(password);
  }
  if (!passwordValid) {
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
    pruneUserSessions(db, user.id);
    db.data.sessions.push(session);
    await db.write();
  });

  res.cookie('session_token', token, buildSessionCookieOptions());

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
  const passwordHash = await hashPasswordAsync(password);
  const user = {
    id: userId,
    username,
    password: passwordHash,
    nickname: nickname || `用户${phoneSuffix}`,
    phone,
    role: 'user',
    created_at: new Date().toISOString()
  };

  await withWriteLock('auth', async () => {
    await db.read();
    if (db.data.users.find(u => u.phone === phone)) {
      raceDetected = true;
      return;
    }
    const userDb = await initUserDatabase(userId);
    await provisionNewLocalMemoryAccount(userId, userDb);
    db.data.users = [...db.data.users, user];
    try { await db.write(); }
    catch (error) { await confirmRegistrationWrite(db, userId, null, error); }
  });

  if (raceDetected) {
    return res.status(409).json({ error: '该手机号已注册' });
  }

  const token = generateSessionToken();
  const session = {
    token,
    userId,
    expires_at: new Date(Date.now() + SESSION_MAX_AGE).toISOString()
  };

  await withWriteLock('auth', async () => {
    await db.read();
    pruneUserSessions(db, userId);
    db.data.sessions.push(session);
    await db.write();
  });

  res.cookie('session_token', token, buildSessionCookieOptions());

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

  res.clearCookie('session_token', buildClearSessionCookieOptions());
  res.json({ success: true });
}));

router.get('/auth/me', asyncHandler(async (req, res) => {
  const token = req.cookies?.session_token;
  if (!token) {
    return res.status(401).json({ user: null, requiresAuth: true });
  }

  const db = getAuthDb();
  await db.read();

  const session = findSessionByToken(db, token);
  if (!session || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ user: null, requiresAuth: true });
  }

  const user = db.data.users.find(u => u.id === session.userId);
  if (!user) {
    return res.status(401).json({ user: null, requiresAuth: true });
  }

  res.json({
    user: { id: user.id, username: user.username, nickname: user.nickname, phone: user.phone }
  });
}));

export default router;
