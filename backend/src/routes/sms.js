import express from 'express';
import { sendSmsVerifyCode, checkSmsVerifyCode, isSmsConfigured } from '../services/sms/index.js';
import { getAuthDb, hashPassword, generateSessionToken } from '../models/authDb.js';
import { initUserDatabase, withWriteLock } from '../models/db.js';
import { validateBody, smsSendSchema, smsVerifySchema } from '../validators/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import crypto from 'crypto';

const router = express.Router();
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 30 * 24 * 60 * 60 * 1000;

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

  try {
    const verifyResult = await checkSmsVerifyCode(phone, code);

    if (!verifyResult.verified) {
      return res.status(400).json({ error: verifyResult.message || '验证码错误或已过期' });
    }

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

      user = {
        id: userId,
        username,
        password: hashPassword(randomPassword),
        nickname: `用户${phoneSuffix}`,
        phone,
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
      db.data.sessions = db.data.sessions.filter(s => s.userId !== user.id);
      db.data.sessions.push(session);
      await db.write();
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const sameSite = isProduction ? 'None' : 'Lax';
    const maxAgeSeconds = Math.floor(SESSION_MAX_AGE / 1000);
    res.setHeader('Set-Cookie', `session_token=${token}; HttpOnly; Path=/; SameSite=${sameSite}; Max-Age=${maxAgeSeconds};${isProduction ? ' Secure;' : ''}`);

    res.json({
      success: true,
      isNewUser,
      user: { id: user.id, username: user.username, nickname: user.nickname, phone: user.phone }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

export default router;
