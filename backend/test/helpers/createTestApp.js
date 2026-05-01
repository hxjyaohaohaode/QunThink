import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

import authRouter from '../../src/routes/auth.js';
import groupsRouter from '../../src/routes/groups.js';
import messagesRouter from '../../src/routes/messages.js';
import filesRouter from '../../src/routes/files.js';
import memoryRouter from '../../src/routes/memory.js';
import ttsRouter from '../../src/routes/tts.js';
import authMiddleware, { isAuthConfigured } from '../../src/middleware/auth.js';
import { injectUserDb } from '../../src/middleware/userDb.js';
import { getAuthDb } from '../../src/models/authDb.js';
import { getUserDb, listUserDatabases } from '../../src/models/db.js';

export function createTestApp() {
  const app = express();

  app.use(cookieParser());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.get('/api/health', async (req, res) => {
    try {
      const userIds = await listUserDatabases();
      let totalGroups = 0;
      let totalMessages = 0;

      for (const userId of userIds) {
        const db = await getUserDb(userId);
        await db.read();
        totalGroups += db.data.groups?.length || 0;
        totalMessages += db.data.messages?.length || 0;
      }

      res.json({
        status: 'ok',
        environment: process.env.NODE_ENV || 'test',
        database: 'connected',
        groups: totalGroups,
        messages: totalMessages
      });
    } catch (error) {
      res.status(503).json({
        status: 'degraded',
        database: 'error',
        error: error.message
      });
    }
  });

  app.get('/api/csrf-token', (req, res) => {
    res.json({ enabled: false });
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
      return res.status(401).json({
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
      return res.status(401).json({
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
  app.use(authMiddleware);
  app.use(injectUserDb);
  app.use('/api', groupsRouter);
  app.use('/api', messagesRouter);
  app.use('/api', filesRouter);
  app.use('/api', memoryRouter);
  app.use('/api/tts', ttsRouter);

  return app;
}
