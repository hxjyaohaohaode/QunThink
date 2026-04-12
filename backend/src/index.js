import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import groupsRouter from './routes/groups.js';
import messagesRouter from './routes/messages.js';
import filesRouter from './routes/files.js';
import socialRouter from './routes/social.js';
import memoryRouter from './routes/memory.js';
import aiRouter from './routes/ai.js';
import interactionRouter from './routes/interaction.js';
import monitoringRouter from './routes/monitoring.js';
import profileRouter from './routes/profile.js';
import personasRouter from './routes/personas.js';
import { initDatabase } from './models/db.js';
import fs from 'fs/promises';
import { setupWebSocket } from './websocket/index.js';
import { checkAllAIHealth } from './services/ai/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3002;

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    if (process.env.NODE_ENV === 'production') {
      const allowedOrigins = process.env.CORS_ORIGIN 
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : [];
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`CORS blocked origin: ${origin}`);
        callback(null, false);
      }
    } else {
      callback(null, true);
    }
  },
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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

app.get('/api/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  };

  try {
    const { getDb } = await import('./models/db.js');
    const db = getDb();
    await db.read();
    health.database = 'connected';
    health.groups = db.data.groups?.length || 0;
    health.messages = db.data.messages?.length || 0;
  } catch (error) {
    health.database = 'error';
    health.databaseError = error.message;
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

initDatabase().then(async () => {
  const uploadsDir = path.join(__dirname, '../uploads');
  try {
    await fs.access(uploadsDir);
  } catch {
    await fs.mkdir(uploadsDir, { recursive: true });
    console.log('📁 创建上传目录:', uploadsDir);
  }

  setupWebSocket(wss);

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);

    checkAllAIHealth().then(results => {
      console.log('AI健康检查完成:', results);
    });
  });
});
