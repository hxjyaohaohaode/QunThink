import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

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
import { setupWebSocket } from './websocket/index.js';
import { checkAllAIHealth } from './services/ai/index.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3002;

app.use(cors());
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

initDatabase().then(() => {
  setupWebSocket(wss);

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);

    checkAllAIHealth().then(results => {
      console.log('AI健康检查完成:', results);
    });
  });
});
