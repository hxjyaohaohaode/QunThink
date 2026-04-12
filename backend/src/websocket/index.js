import { AI_LIST } from '../config/personas.js';
import { cancelGroupGeneration } from '../services/scheduler/index.js';

const clients = new Map();
const groupSubscriptions = new Map();
const heartbeatIntervals = new Map();
const missedPings = new Map();
const typingTimeouts = new Map();
const messageQueue = new Map();

export function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    const clientId = generateClientId();
    clients.set(clientId, { ws, subscriptions: new Set() });
    missedPings.set(clientId, 0);
    messageQueue.set(clientId, []);

    console.log(`WebSocket client connected: ${clientId}`);

    const heartbeatInterval = setInterval(() => {
      const client = clients.get(clientId);
      if (!client || client.ws.readyState !== 1) {
        clearInterval(heartbeatInterval);
        heartbeatIntervals.delete(clientId);
        return;
      }

      const missed = missedPings.get(clientId) || 0;
      if (missed >= 2) {
        console.log(`Client ${clientId} 心跳超时，断开连接`);
        client.ws.terminate();
        clearInterval(heartbeatInterval);
        heartbeatIntervals.delete(clientId);
        return;
      }

      missedPings.set(clientId, missed + 1);
      try {
        client.ws.send(JSON.stringify({ type: 'ping' }));
      } catch (e) {
        clearInterval(heartbeatInterval);
        heartbeatIntervals.delete(clientId);
      }
    }, 30000);

    heartbeatIntervals.set(clientId, heartbeatInterval);

    ws.on('pong', () => {
      missedPings.set(clientId, 0);
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleMessage(clientId, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    ws.on('close', () => {
      const client = clients.get(clientId);
      if (client) {
        client.subscriptions.forEach(groupId => {
          const subscribers = groupSubscriptions.get(groupId);
          if (subscribers) {
            subscribers.delete(clientId);
          }
        });
        clients.delete(clientId);
      }

      const hbInterval = heartbeatIntervals.get(clientId);
      if (hbInterval) {
        clearInterval(hbInterval);
        heartbeatIntervals.delete(clientId);
      }
      missedPings.delete(clientId);
      messageQueue.delete(clientId);

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

function handleMessage(clientId, message) {
  const client = clients.get(clientId);
  if (!client) return;

  switch (message.type) {
    case 'join_group':
      joinGroup(clientId, message.group_id);
      break;
    case 'leave_group':
      leaveGroup(clientId, message.group_id);
      break;
    case 'typing':
      broadcastTyping(clientId, message);
      break;
    case 'pong':
      missedPings.set(clientId, 0);
      break;
    case 'stop_generation':
      if (message.group_id) {
        cancelGroupGeneration(message.group_id);
        broadcastToGroup(message.group_id, {
          type: 'generation_stopped',
          group_id: message.group_id,
          timestamp: new Date().toISOString()
        });
      }
      break;
  }
}

function joinGroup(clientId, groupId) {
  const client = clients.get(clientId);
  if (!client) return;

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
  console.log(`[Broadcast] Group ${groupId} has ${subscribers?.size || 0} subscribers`);
  if (!subscribers) return;

  subscribers.forEach(clientId => {
    sendToClient(clientId, message);
  });
}

export function broadcastAIMessage(groupId, aiId, content, replyTo = null, messageId = null) {
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
  const client = clients.get(clientId);
  if (client && client.ws.readyState === 1) {
    client.ws.send(JSON.stringify(message));
  } else {
    const importantTypes = ['new_message', 'system_message'];
    if (importantTypes.includes(message.type)) {
      const queue = messageQueue.get(clientId);
      if (queue && queue.length < 100) {
        queue.push(message);
      }
    }
  }
}
