import { AI_LIST } from '../config/personas.js';
import { cancelGroupGeneration } from '../services/scheduler/index.js';
import { getAuthDb } from '../models/authDb.js';
import { getUserDb } from '../models/db.js';
import { safeLog } from '../utils/logger.js';

const clients = new Map();
const groupSubscriptions = new Map();
const missedPings = new Map();
const pendingPings = new Map();
const typingTimeouts = new Map();
const messageQueue = new Map();
const sendBuffers = new Map();
const sendBufferTimers = new Map();
const connectionRateLimit = new Map();

const SEND_BUFFER_DELAY = 5;
const HEARTBEAT_INTERVAL = 30000;
const MAX_MISSED_PINGS = 5;

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

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.trim().split('=');
    if (parts.length === 2) {
      cookies[parts[0]] = parts[1];
    }
  });
  return cookies;
}

async function verifySessionToken(token) {
  if (!token) return null;
  try {
    const authDb = getAuthDb();
    await authDb.read();
    const session = authDb.data.sessions.find(s => s.token === token);
    if (!session || new Date(session.expires_at) < new Date()) {
      return null;
    }
    return session.userId;
  } catch (error) {
    console.error('WebSocket session verification failed:', error);
    return null;
  }
}

function startServerHeartbeat(wss) {
  setInterval(() => {
    clients.forEach((client, clientId) => {
      if (client.ws.readyState !== 1) return;

      const isPending = pendingPings.get(clientId);
      if (isPending) {
        const missed = (missedPings.get(clientId) || 0) + 1;
        missedPings.set(clientId, missed);
        if (missed >= MAX_MISSED_PINGS) {
          console.log(`Client ${clientId} 心跳超时(${missed}次未响应)，断开连接`);
          try { client.ws.terminate(); } catch {}
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
        try { client.ws.terminate(); } catch {}
        cleanupClient(clientId);
      }
    });
  }, HEARTBEAT_INTERVAL);

  setInterval(() => {
    clients.forEach((client, clientId) => {
      if (client.ws.readyState !== 1 && client.ws.readyState !== 0) {
        console.log(`定时清理: 清理非活跃客户端 ${clientId}, readyState=${client.ws.readyState}`);
        try { client.ws.terminate(); } catch {}
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
  }, 5 * 60 * 1000);
}

function flushSendBuffer(clientId) {
  const client = clients.get(clientId);
  const buffer = sendBuffers.get(clientId);
  
  if (!client || client.ws.readyState !== 1 || !buffer || buffer.length === 0) {
    return;
  }
  
  const messagesToSend = [...buffer];
  buffer.length = 0;
  
  if (messagesToSend.length === 1) {
    try {
      client.ws.send(messagesToSend[0]);
    } catch (e) {
      console.error('WebSocket send error:', e);
    }
  } else {
    const batchMessage = JSON.stringify({
      type: 'batch',
      messages: messagesToSend.map(m => {
        try { return JSON.parse(m); } catch { return null; }
      }).filter(Boolean),
      timestamp: new Date().toISOString()
    });
    try {
      client.ws.send(batchMessage);
    } catch (e) {
      console.error('WebSocket batch send error:', e);
    }
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
    const importantTypes = ['new_message', 'system_message', 'message_stream', 'message_stream_start', 'message_stream_end'];
    if (importantTypes.includes(message.type)) {
      const queue = messageQueue.get(clientId);
      if (queue && queue.length < 100) {
        queue.push(message);
      }
    }
    return;
  }

  const realtimeTypes = ['message_stream', 'message_stream_start', 'message_stream_end', 'ai_typing', 'ai_typing_stop', 'generation_stopped'];
  if (realtimeTypes.includes(message.type)) {
    try {
      client.ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('WebSocket realtime send error:', e);
    }
    return;
  }

  const serialized = JSON.stringify(message);

  if (!sendBuffers.has(clientId)) {
    sendBuffers.set(clientId, []);
  }

  const buffer = sendBuffers.get(clientId);
  buffer.push(serialized);

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
  startServerHeartbeat(wss);

  wss.on('connection', async (ws, req) => {
    const now = Date.now();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
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
      console.warn(`WebSocket connection rejected: invalid origin ${origin}`);
      ws.close(4001, 'Invalid origin');
      return;
    }

    const authMode = process.env.AUTH_MODE || 'session';
    let userId = null;
    
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
        console.log('WebSocket connection rejected: no session token');
        ws.close(4001, '未认证');
        return;
      }
      
      userId = await verifySessionToken(token);
      if (!userId) {
        console.log('WebSocket connection rejected: invalid session');
        ws.close(4001, '会话已过期或无效');
        return;
      }
    }

    const clientId = generateClientId();
    clients.set(clientId, { ws, subscriptions: new Set(), userId });
    missedPings.set(clientId, 0);
    messageQueue.set(clientId, []);

    console.log(`WebSocket client connected: ${clientId}, user: ${userId}`);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        // 收到任何消息时重置 missedPings
        if (message.type !== 'ping' && message.type !== 'pong') {
          missedPings.set(clientId, 0);
        }
        handleMessage(clientId, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      cleanupClient(clientId);
      console.log(`WebSocket client disconnected: ${clientId}`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
}

function generateClientId() {
  return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function handleMessage(clientId, message) {
  const client = clients.get(clientId);
  console.log('[WS] Received message:', message.type, message.group_id || '', message.content ? `[content length: ${message.content.length}]` : '');
  if (!client) return;

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
            console.error('停止生成权限检查失败:', error);
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
      console.error('群组访问权限检查失败:', error);
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
  const subscribers = groupSubscriptions.get(group_id);

  if (!subscribers) return;

  subscribers.forEach(subscriberId => {
    if (subscriberId !== clientId) {
      sendToClient(subscriberId, {
        type: status ? 'ai_typing' : 'ai_typing_stop',
        group_id,
        sender: ai,
        ai
      });
    }
  });
}

export function broadcastToGroup(groupId, message) {
  const subscribers = groupSubscriptions.get(groupId);
  console.log(`[Broadcast] Group ${groupId}, type: ${message.type}, message_id: ${message.id || message.message_id || 'N/A'}, subscribers: ${subscribers?.size || 0}`);
  if (!subscribers) {
    console.warn(`[Broadcast] No subscribers for group ${groupId}, message type: ${message.type}`);
    return;
  }

  subscribers.forEach(clientId => {
    console.log(`[Broadcast] Sending to client ${clientId}: ${message.type}`);
    sendToClient(clientId, message);
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
  console.log(`[Typing] Broadcasting to group ${groupId}: ${aiId} is ${isTyping ? 'typing' : 'stopped'}`);
  broadcastToGroup(groupId, {
    type: isTyping ? 'ai_typing' : 'ai_typing_stop',
    group_id: groupId,
    sender: aiId,
    ai: aiId,
    timestamp: new Date().toISOString()
  });
}

export function broadcastTypingStatusWithTimeout(groupId, aiId, isTyping, timeoutMs = 30000) {
  const timeoutKey = `${groupId}_${aiId}`;

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
