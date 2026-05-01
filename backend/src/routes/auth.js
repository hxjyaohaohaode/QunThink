import express from 'express';
import { getAuthDb, generateSessionToken } from '../models/authDb.js';
import { withWriteLock } from '../models/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE) || 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';

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

  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true });
}));

router.get('/auth/me', asyncHandler(async (req, res) => {
  const token = req.cookies?.session_token;
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }

  const db = getAuthDb();
  await db.read();

  const session = db.data.sessions.find(s => s.token === token);
  if (!session || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: '会话已过期' });
  }

  const user = db.data.users.find(u => u.id === session.userId);
  if (!user) {
    return res.status(401).json({ error: '用户不存在' });
  }

  res.json({
    user: { id: user.id, username: user.username, nickname: user.nickname, phone: user.phone }
  });
}));

export default router;
