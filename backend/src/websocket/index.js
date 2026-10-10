import { getCatalogData } from '../services/ai/catalog.js';
import { buildMergedPersonas } from '../routes/personas.js';
import { cancelGroupGeneration } from '../services/scheduler/index.js';
import { getAuthDb } from '../models/authDb.js';
import { getUserDb } from '../models/db.js';
import { safeLog } from '../utils/logger.js';
import wsPerformanceMonitor from './performanceMonitor.js';
import crypto from 'crypto';
import { currentUserId, runAsUser } from '../services/userScope.js';

const clients = new Map();
const groupSubscriptions = new Map();
const missedPings = new Map();
const pendingPings = new Map();
const typingTimeouts = new Map();
const messageQueue = new Map();
const sendBuffers = new Map();
const sendBufferTimers = new Map();
const connectionRateLimit = new Map();
const clientMsgRate = new Map();

const SEND_BUFFER_DELAY = 5;
const HEARTBEAT_INTERVAL = 30000;
const MAX_MISSED_PINGS = 3;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const SESSION_CACHE_TTL = 60 * 1000;
const AUTH_RECHECK_INTERVAL = 60 * 1000;
const SESSION_CACHE_MAX_ENTRIES = 1000;

let heartbeatCleanup = null;

const sessionTokenCache = new Map();

function cleanupClient(clientId) {
  const client = clients.get(clientId);
  if (client) {
    client.subscriptions.forEach(groupId => {
      const subscribers = groupSubscriptions.get(groupId);
      if (subscribers) {
        subscribers.delete(clientId);
        if (subscribers.size === 0) {
          groupSubscriptions.delete(groupId);
        }
      }
    });
    clients.delete(clientId);
  }

  missedPings.delete(clientId);
  pendingPings.delete(clientId);
  messageQueue.delete(clientId);

  const bufferTimer = sendBufferTimers.get(clientId);
  if (bufferTimer) {
    clearTimeout(bufferTimer);
    sendBufferTimers.delete(clientId);
  }
  const buffer = sendBuffers.get(clientId);
  if (buffer) {
    buffer.length = 0;
    sendBuffers.delete(clientId);
  }
}

export function revokeUserConnections(userId) {
  if (!userId) return 0;
  let terminated = 0;
  clients.forEach((client, clientId) => {
    if (client.userId === userId) {
      terminated++;
      try { client.ws.terminate(); } catch { }
      cleanupClient(clientId);
    }
  });
  if (terminated > 0) {
    safeLog('info', `已终止用户 ${userId} 的 ${terminated} 个WebSocket连接`);
  }
  return terminated;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const trimmed = cookie.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      cookies[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
    }
  });
  return cookies;
}

function pruneSessionTokenCache(now) {
  sessionTokenCache.forEach((entry, key) => {
    if (now - entry.cachedAt >= SESSION_CACHE_TTL) {
      sessionTokenCache.delete(key);
    }
  });
}

async function verifySessionToken(token) {
  if (!token) return null;
  try {
    const now = Date.now();
    const cached = sessionTokenCache.get(token);
    if (cached && now - cached.cachedAt < SESSION_CACHE_TTL) {
      if (cached.expiresAt !== null && now >= cached.expiresAt) {
        sessionTokenCache.delete(token);
        return null;
      }
      return cached.userId;
    }

    const authDb = getAuthDb();
    await authDb.read();
    const session = authDb.data.sessions.find(s => {
      if (s.token.length !== token.length) return false;
      try {
        return crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token));
      } catch {
        return false;
      }
    });
    if (!session || new Date(session.expires_at) < new Date()) {
      return null;
    }

    const expiresAt = new Date(session.expires_at).getTime();
    if (sessionTokenCache.size >= SESSION_CACHE_MAX_ENTRIES) {
      pruneSessionTokenCache(Date.now());
    }
    if (sessionTokenCache.size >= SESSION_CACHE_MAX_ENTRIES) {
      sessionTokenCache.clear();
    }
    sessionTokenCache.set(token, { userId: session.userId, expiresAt, cachedAt: Date.now() });
    return session.userId;
  } catch (error) {
    safeLog('error', 'WebSocket session verification failed', { error: error.message });
    return null;
  }
}

function startServerHeartbeat() {
  if (heartbeatCleanup) return heartbeatCleanup;

  const timers = [];
  timers.push(setInterval(() => {
    clients.forEach((client, clientId) => {
      if (client.ws.readyState !== 1) return;

      const isPending = pendingPings.get(clientId);
      if (isPending) {
        const missed = (missedPings.get(clientId) || 0) + 1;
        missedPings.set(clientId, missed);
        if (missed >= MAX_MISSED_PINGS) {
          safeLog('info', `Client ${clientId} 心跳超时(${missed}次未响应)，断开连接`);
          try { client.ws.terminate(); } catch { }
          cleanupClient(clientId);
          return;
        }
      } else {
        missedPings.set(clientId, 0);
      }

      try {
        client.ws.send(JSON.stringify({ type: 'ping' }));
        pendingPings.set(clientId, true);
      } catch (error) {
        try { client.ws.terminate(); } catch { }
        cleanupClient(clientId);
      }
    });
  }, HEARTBEAT_INTERVAL));

  timers.push(setInterval(() => {
    clients.forEach((client, clientId) => {
      if (client.ws.readyState !== 1 && client.ws.readyState !== 0) {
        safeLog('info', `定时清理: 清理非活跃客户端 ${clientId}, readyState=${client.ws.readyState}`);
        try { client.ws.terminate(); } catch { }
        cleanupClient(clientId);
      }
    });

    groupSubscriptions.forEach((subscribers, groupId) => {
      subscribers.forEach(clientId => {
        if (!clients.has(clientId)) {
          subscribers.delete(clientId);
        }
      });
      if (subscribers.size === 0) {
        groupSubscriptions.delete(groupId);
      }
    });

    // 清理过期60秒以上的clientMsgRate条目
    const rateNow = Date.now();
    clientMsgRate.forEach((entry, clientId) => {
      entry.timestamps = entry.timestamps.filter(t => rateNow - t < 60000);
      if (entry.timestamps.length === 0) {
        clientMsgRate.delete(clientId);
      }
    });

    // 清理过期1小时以上的connectionRateLimit条目
    const connNow = Date.now();
    connectionRateLimit.forEach((timestamps, ip) => {
      const recent = timestamps.filter(t => connNow - t < 3600000);
      if (recent.length === 0) {
        connectionRateLimit.delete(ip);
      } else {
        connectionRateLimit.set(ip, recent);
      }
    });
  }, 5 * 60 * 1000));

  heartbeatCleanup = () => {
    timers.forEach(t => clearInterval(t));
    heartbeatCleanup = null;
  };
  return heartbeatCleanup;
}

function flushSendBuffer(clientId) {
  const client = clients.get(clientId);
  const buffer = sendBuffers.get(clientId);

  if (!client || client.ws.readyState !== 1 || !buffer || buffer.length === 0) {
    return;
  }

  const messagesToSend = [...buffer];
  const trackedIds = [];
  messagesToSend.forEach(m => {
    const messageId = m.message_id || m.id;
    if (messageId) {
      wsPerformanceMonitor.trackMessage(messageId, clientId);
      trackedIds.push(messageId);
    }
  });

  const payload = messagesToSend.length === 1
    ? JSON.stringify(messagesToSend[0])
    : JSON.stringify({
      type: 'batch',
      messages: messagesToSend,
      timestamp: new Date().toISOString()
    });

  try {
    client.ws.send(payload);
    buffer.length = 0;
    trackedIds.forEach(id => wsPerformanceMonitor.markDelivered(id));
  } catch (e) {
    safeLog('error', 'WebSocket send error', { error: e?.message || e });
    // 发送失败时保留消息在buffer中，下次重试；tracked消息由超时/close路径标记为失败
  }
}

function sendToClientOptimized(clientId, message) {
  const client = clients.get(clientId);
  if (!client) {
    const bufferTimer = sendBufferTimers.get(clientId);
    if (bufferTimer) {
      clearTimeout(bufferTimer);
      sendBufferTimers.delete(clientId);
    }
    sendBuffers.delete(clientId);
    messageQueue.delete(clientId);
    return;
  }
  if (client.ws.readyState !== 1) {
    const importantTypes = ['new_message', 'system_message', 'message_stream', 'message_stream_start', 'message_stream_end', 'persona_updated', 'personas_sync', 'group_update'];
    if (importantTypes.includes(message.type)) {
      const queue = messageQueue.get(clientId);
      if (queue && queue.length < 100) {
        queue.push(message);
      }
    }
    return;
  }

  if (!sendBuffers.has(clientId)) {
    sendBuffers.set(clientId, []);
  }

  const buffer = sendBuffers.get(clientId);
  buffer.push(message);

  if (!sendBufferTimers.has(clientId)) {
    const timer = setTimeout(() => {
      flushSendBuffer(clientId);
      sendBufferTimers.delete(clientId);
    }, SEND_BUFFER_DELAY);
    sendBufferTimers.set(clientId, timer);
  }

  if (buffer.length >= 10) {
    clearTimeout(sendBufferTimers.get(clientId));
    sendBufferTimers.delete(clientId);
    flushSendBuffer(clientId);
  }
}

export function setupWebSocket(wss) {
  startServerHeartbeat();

  wss.on('close', () => {
    if (heartbeatCleanup) {
      heartbeatCleanup();
    }
  });

  const originalHandleUpgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = function handleUpgradeWithOriginGuard(req, socket, head, cb) {
    if (process.env.NODE_ENV === 'production' && !req.headers.origin) {
      safeLog('warn', 'WebSocket upgrade rejected: missing Origin header in production');
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
      } catch (e) {
        safeLog('error', 'WebSocket upgrade reject failed', { error: e?.message || e });
      }
      return;
    }
    originalHandleUpgrade(req, socket, head, cb);
  };

  wss.on('connection', async (ws, req) => {
    const now = Date.now();
    let clientIp = req.socket.remoteAddress;
    const trustProxy = process.env.TRUST_PROXY;
    const proxyTrusted = trustProxy !== undefined && trustProxy !== '' && trustProxy !== 'false' && trustProxy !== '0';
    if (proxyTrusted) {
      const forwardedFor = req.headers['x-forwarded-for'];
      if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
        const candidates = forwardedFor.split(',').map(s => s.trim()).filter(Boolean);
        if (candidates.length > 0) {
          clientIp = candidates[candidates.length - 1];
        }
      }
    }
    if (!connectionRateLimit.has(clientIp)) {
      connectionRateLimit.set(clientIp, []);
    }
    const connections = connectionRateLimit.get(clientIp).filter(t => now - t < 60000);
    if (connections.length > 10) {
      ws.close(1008, '连接过于频繁');
      return;
    }
    connections.push(now);
    connectionRateLimit.set(clientIp, connections);

    const allowedOrigins = process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',')
      : ['http://localhost:5173', 'http://localhost:3010', 'http://localhost:3002', 'http://127.0.0.1:5173'];
    const origin = req.headers.origin;
    const isProduction = process.env.NODE_ENV === 'production';
    const isLocalDev = !isProduction && origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

    if (origin && !allowedOrigins.includes(origin) && !isLocalDev) {
      safeLog('warn', 'WebSocket connection rejected: invalid origin', { origin });
      ws.close(4001, 'Invalid origin');
      return;
    }

    const authMode = process.env.AUTH_MODE || 'session';
    let userId = null;
    let sessionToken = null;

    if (authMode === 'dev') {
      if (isProduction) {
        ws.close(4001, '开发模式不允许在生产环境使用');
        return;
      }
      const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
      const devUserId = urlParams.get('userId') || req.headers['x-user-id'];
      if (!devUserId || !/^dev_[a-zA-Z0-9_-]+$/.test(devUserId)) {
        ws.close(4001, '开发模式需要提供有效的用户标识');
        return;
      }
      userId = devUserId;
    } else {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.session_token;

      if (!token) {
        safeLog('info', 'WebSocket connection rejected: no session token');
        ws.close(4001, '未认证');
        return;
      }

      userId = await verifySessionToken(token);
      if (!userId) {
        safeLog('info', 'WebSocket connection rejected: invalid session');
        ws.close(4001, '会话已过期或无效');
        return;
      }
      sessionToken = token;
    }

    const clientId = generateClientId();
    clients.set(clientId, { ws, subscriptions: new Set(), userId, token: sessionToken, _lastAuthCheck: Date.now() });
    missedPings.set(clientId, 0);
    messageQueue.set(clientId, []);

    safeLog('info', `WebSocket client connected: ${clientId}, user: ${userId}`);

    // The HTTP upgrade precedes async session verification. Tell the client
    // when authentication is finished so early subscriptions can be replayed.
    ws.send(JSON.stringify({ type: 'connected' }));

    ws.on('message', async (data) => {
      try {
        // 业务层限制单条消息最大1MB（wss层maxPayload为10MB），先判Buffer长度再做字符串转换
        if (data.length > MAX_MESSAGE_BYTES) {
          safeLog('warn', '[WS] Message too large', { clientId, size: data.length });
          return;
        }
        const raw = data.toString();
        const message = JSON.parse(raw);
        const currentClient = clients.get(clientId);
        if (!currentClient) return;
        // 收到任何消息时重置 missedPings
        if (message.type !== 'ping' && message.type !== 'pong') {
          missedPings.set(clientId, 0);
        }
        const authNow = Date.now();
        if (currentClient.token && authNow - (currentClient._lastAuthCheck || 0) > AUTH_RECHECK_INTERVAL) {
          currentClient._lastAuthCheck = authNow;
          const stillValid = await verifySessionToken(currentClient.token);
          if (!stillValid) {
            safeLog('info', 'WebSocket session revoked during connection, terminating', { clientId });
            try { currentClient.ws.terminate(); } catch { }
            cleanupClient(clientId);
            return;
          }
        }
        await runAsUser(currentClient.userId, () => handleMessage(clientId, message));
      } catch (error) {
        safeLog('error', 'WebSocket message error', { error: error?.message || error });
      }
    });

    ws.on('close', () => {
      wsPerformanceMonitor.failPendingForClient(clientId);
      cleanupClient(clientId);
      safeLog('info', 'WebSocket client disconnected: ' + clientId);
    });

    ws.on('error', (error) => {
      safeLog('error', 'WebSocket error', { error: error?.message || error });
    });
  });
}

function generateClientId() {
  return `client_${crypto.randomUUID()}`;
}

async function handleMessage(clientId, message) {
  const client = clients.get(clientId);
  safeLog('info', '[WS] Received message: ' + message.type, { group_id: message.group_id, content_length: message.content?.length });
  if (!client) return;

  // Per-client message rate limiting
  const now = Date.now();
  let rateEntry = clientMsgRate.get(clientId);
  if (!rateEntry) {
    rateEntry = { timestamps: [] };
    clientMsgRate.set(clientId, rateEntry);
  }
  rateEntry.timestamps = rateEntry.timestamps.filter(t => now - t < 1000);
  if (rateEntry.timestamps.length > 50) {
    safeLog('warn', '[WS] Rate limit exceeded', { clientId });
    return; // 丢弃消息但不断开
  }
  rateEntry.timestamps.push(now);

  switch (message.type) {
    case 'join_group':
      await joinGroup(clientId, message.group_id);
      break;
    case 'leave_group':
      leaveGroup(clientId, message.group_id);
      break;
    case 'typing':
      broadcastTyping(clientId, message);
      break;
    case 'pong':
      missedPings.set(clientId, 0);
      pendingPings.delete(clientId);
      break;
    case 'ping':
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(JSON.stringify({ type: 'pong' }));
        } catch (e) {
          // Client might have disconnected
        }
      }
      break;
    case 'stop_generation':
      if (message.group_id) {
        const authMode = process.env.AUTH_MODE || 'session';
        if (authMode !== 'dev' && client.userId) {
          try {
            const userDb = await getUserDb(client.userId);
            await userDb.read();
            const group = userDb.data.groups?.find(g => g.id === message.group_id);
            if (!group) {
              sendToClient(clientId, {
                type: 'error',
                message: '无权操作该群组'
              });
              break;
            }
            cancelGroupGeneration(message.group_id);
            broadcastToGroup(message.group_id, {
              type: 'generation_stopped',
              group_id: message.group_id,
              timestamp: new Date().toISOString()
            });
          } catch (error) {
            safeLog('error', '停止生成权限检查失败', { error: error?.message || error });
            sendToClient(clientId, {
              type: 'error',
              message: '停止生成权限检查失败'
            });
          }
        } else {
          cancelGroupGeneration(message.group_id);
          broadcastToGroup(message.group_id, {
            type: 'generation_stopped',
            group_id: message.group_id,
            timestamp: new Date().toISOString()
          });
        }
      }
      break;
  }
}

async function joinGroup(clientId, groupId) {
  const client = clients.get(clientId);
  if (!client) return;

  const authMode = process.env.AUTH_MODE || 'session';
  if (authMode !== 'dev' && client.userId) {
    try {
      const userDb = await getUserDb(client.userId);
      await userDb.read();
      const group = userDb.data.groups?.find(g => g.id === groupId);
      if (!group) {
        sendToClient(clientId, {
          type: 'error',
          message: '无权访问该群组'
        });
        return;
      }
    } catch (error) {
      safeLog('error', '群组访问权限检查失败', { error: error?.message || error });
      sendToClient(clientId, {
        type: 'error',
        message: '群组访问权限检查失败'
      });
      return;
    }
  }

  if (!groupSubscriptions.has(groupId)) {
    groupSubscriptions.set(groupId, new Set());
  }
  groupSubscriptions.get(groupId).add(clientId);
  client.subscriptions.add(groupId);

  sendToClient(clientId, {
    type: 'joined_group',
    group_id: groupId
  });

  const queuedMessages = messageQueue.get(clientId);
  if (queuedMessages && queuedMessages.length > 0) {
    const messagesToSend = [...queuedMessages];
    queuedMessages.length = 0;

    for (const msg of messagesToSend) {
      if (msg.group_id === groupId) {
        sendToClient(clientId, msg);
      }
    }
  }
}

function leaveGroup(clientId, groupId) {
  const client = clients.get(clientId);
  if (!client) return;

  const subscribers = groupSubscriptions.get(groupId);
  if (subscribers) {
    subscribers.delete(clientId);
  }
  client.subscriptions.delete(groupId);
}

function broadcastTyping(clientId, message) {
  const { group_id, ai, status } = message;
  const client = clients.get(clientId);

  if (!client || typeof group_id !== 'string' || group_id.length === 0) return;

  if (!client.subscriptions.has(group_id) || !groupSubscriptions.has(group_id)) {
    safeLog('warn', '[WS] Typing rejected: not subscribed to group', { clientId, group_id });
    sendToClient(clientId, {
      type: 'error',
      message: '未加入该群组，无法广播输入状态'
    });
    return;
  }

  const subscribers = groupSubscriptions.get(group_id);

  subscribers.forEach(subscriberId => {
    if (subscriberId !== clientId && clients.get(subscriberId)?.userId === client.userId) {
      sendToClient(subscriberId, {
        type: status ? 'ai_typing' : 'ai_typing_stop',
        group_id,
        sender: ai,
        ai
      });
    }
  });
}

export function broadcastToGroup(groupId, message, userId = currentUserId()) {
  if (!userId) return;
  const subscribers = groupSubscriptions.get(groupId);
  // 高频广播日志降级为debug，避免流式输出时日志爆炸
  safeLog('debug', `[Broadcast] Group ${groupId}, type: ${message.type}, message_id: ${message.id || message.message_id || 'N/A'}, subscribers: ${subscribers?.size || 0}`);
  if (!subscribers) {
    safeLog('warn', '[Broadcast] No subscribers for group', { groupId, messageType: message.type });
    return;
  }

  subscribers.forEach(clientId => {
    if (clients.get(clientId)?.userId === userId) sendToClient(clientId, message);
  });
}

export function broadcastAIMessage(groupId, aiId, content, replyTo = null, messageId = null, quotedMessages = null) {
  broadcastToGroup(groupId, {
    type: 'new_message',
    group_id: groupId,
    id: messageId || `ai_${aiId}_${Date.now()}`,
    sender: aiId,
    sender_id: aiId,
    sender_type: 'ai',
    content,
    content_type: 'text',
    reply_to: replyTo,
    quoted_messages: quotedMessages,
    created_at: new Date().toISOString(),
    timestamp: new Date().toISOString()
  });
}

export function broadcastStreamChunk(groupId, aiId, messageId, chunk, isDone = false, incrementalChunk = '') {
  broadcastToGroup(groupId, {
    type: 'message_stream',
    group_id: groupId,
    message_id: messageId,
    sender_id: aiId,
    sender_type: 'ai',
    chunk,
    incremental_chunk: incrementalChunk,
    is_done: isDone,
    timestamp: new Date().toISOString()
  });
}

export function broadcastStreamStart(groupId, aiId, messageId) {
  broadcastToGroup(groupId, {
    type: 'message_stream_start',
    group_id: groupId,
    message_id: messageId,
    sender_id: aiId,
    sender_type: 'ai',
    timestamp: new Date().toISOString()
  });
}

export function broadcastStreamEnd(groupId, aiId, messageId, content, replyTo = null, replyToIds = null) {
  broadcastToGroup(groupId, {
    type: 'message_stream_end',
    group_id: groupId,
    message_id: messageId,
    sender_id: aiId,
    sender_type: 'ai',
    content,
    reply_to: replyTo,
    reply_to_ids: replyToIds,
    created_at: new Date().toISOString(),
    timestamp: new Date().toISOString()
  });
}

export function broadcastSystemMessage(groupId, content) {
  broadcastToGroup(groupId, {
    type: 'system_message',
    group_id: groupId,
    content,
    timestamp: new Date().toISOString()
  });
}

export function broadcastTypingStatus(groupId, aiId, isTyping) {
  safeLog('info', `[Typing] Broadcasting to group ${groupId}: ${aiId} is ${isTyping ? 'typing' : 'stopped'}`);
  broadcastToGroup(groupId, {
    type: isTyping ? 'ai_typing' : 'ai_typing_stop',
    group_id: groupId,
    sender: aiId,
    ai: aiId,
    timestamp: new Date().toISOString()
  });
}

export function broadcastTypingStatusWithTimeout(groupId, aiId, isTyping, timeoutMs = 30000) {
  const timeoutKey = JSON.stringify([currentUserId(), groupId, aiId]);

  if (typingTimeouts.has(timeoutKey)) {
    clearTimeout(typingTimeouts.get(timeoutKey));
    typingTimeouts.delete(timeoutKey);
  }

  broadcastTypingStatus(groupId, aiId, isTyping);

  if (isTyping) {
    const timeoutId = setTimeout(() => {
      broadcastTypingStatus(groupId, aiId, false);
      typingTimeouts.delete(timeoutKey);
    }, timeoutMs);
    typingTimeouts.set(timeoutKey, timeoutId);
  }
}

function sendToClient(clientId, message) {
  sendToClientOptimized(clientId, message);
}

export async function broadcastPersonaUpdate(aiId, userId) {
  if (!userId) {
    safeLog('warn', '[WS] broadcastPersonaUpdate: userId is null/undefined');
    return;
  }

  try {
    const db = await getUserDb(userId);
    await db.read();
    const customPersonas = db.data.customPersonas || {};
    const merged = buildMergedPersonas(customPersonas, getCatalogData(db.data));
    const persona = merged[aiId];
    if (!persona) return;

    const allSubscribers = new Set();
    groupSubscriptions.forEach(subscribers => {
      subscribers.forEach(clientId => {
        const client = clients.get(clientId);
        if (client && client.userId === userId) {
          allSubscribers.add(clientId);
        }
      });
    });

    allSubscribers.forEach(clientId => {
      sendToClient(clientId, {
        type: 'persona_updated',
        aiId,
        persona,
        timestamp: new Date().toISOString()
      });
    });
  } catch (error) {
    safeLog('error', '广播人设更新失败', { error: error?.message || error });
  }
}

export async function broadcastPersonasSync(userId) {
  try {
    const db = await getUserDb(userId);
    await db.read();
    const customPersonas = db.data.customPersonas || {};
    const merged = buildMergedPersonas(customPersonas, getCatalogData(db.data));

    clients.forEach((client, clientId) => {
      if (client.userId === userId && client.ws.readyState === 1) {
        sendToClient(clientId, {
          type: 'personas_sync',
          all_personas: merged,
          timestamp: new Date().toISOString()
        });
      }
    });
  } catch (error) {
    safeLog('error', '广播全量人设同步失败', { error: error?.message || error });
  }
}
