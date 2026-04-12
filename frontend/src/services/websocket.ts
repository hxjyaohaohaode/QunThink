import { useMessagesStoreInternal } from '../stores/messagesStore';
import { useUIStore } from '../stores/uiStore';

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let currentGroupId: string | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;

const typingTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};

function getReconnectDelay(attempt: number): number {
  const delay = BASE_RECONNECT_DELAY * Math.pow(2, attempt - 1);
  return Math.min(delay, MAX_RECONNECT_DELAY);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  }, 25000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function setTypingTimeout(groupId: string, aiId: string) {
  const key = `${groupId}_${aiId}`;
  clearTypingTimeout(groupId, aiId);
  typingTimeouts[key] = setTimeout(() => {
    const uiStore = useUIStore.getState();
    uiStore.setTyping(groupId, aiId, false);
    delete typingTimeouts[key];
  }, 30000);
}

function clearTypingTimeout(groupId: string, aiId: string) {
  const key = `${groupId}_${aiId}`;
  if (typingTimeouts[key]) {
    clearTimeout(typingTimeouts[key]);
    delete typingTimeouts[key];
  }
}

function clearAllTypingTimeouts() {
  Object.keys(typingTimeouts).forEach(key => {
    clearTimeout(typingTimeouts[key]);
    delete typingTimeouts[key];
  });
}

export function connectWebSocket(groupId?: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (currentGroupId === groupId) return;
    if (currentGroupId) {
      leaveGroup(currentGroupId);
    }
  }

  let wsUrl: string;
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  
  if (backendUrl) {
    const wsProtocol = backendUrl.startsWith('https') ? 'wss' : 'ws';
    const wsHost = backendUrl.replace(/^https?:\/\//, '');
    wsUrl = `${wsProtocol}://${wsHost}/ws`;
  } else {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;
    wsUrl = `${wsProtocol}//${wsHost}/ws`;
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    reconnectAttempts = 0;

    startHeartbeat();

    if (groupId) {
      joinGroup(groupId);
    }

    if (currentGroupId) {
      useMessagesStoreInternal.getState().fetchMessages(currentGroupId);
    }
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      
      if (message.type === 'ping') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      }
      
      handleWebSocketMessage(message);
    } catch (error) {
      console.error('WebSocket message parse error:', error);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    stopHeartbeat();

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && currentGroupId) {
      reconnectAttempts++;
      const delay = getReconnectDelay(reconnectAttempts);
      console.log(`Reconnecting... attempt ${reconnectAttempts}, delay ${delay}ms`);
      setTimeout(() => {
        if (currentGroupId) {
          connectWebSocket(currentGroupId);
        }
      }, delay);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function handleWebSocketMessage(message: any) {
  const messagesStore = useMessagesStoreInternal.getState();
  const uiStore = useUIStore.getState();

  switch (message.type) {
    case 'new_message':
      if (message.group_id) {
        const senderId = message.sender_id || message.sender;
        
        messagesStore.addMessage(message.group_id, {
          id: message.id || `${message.sender_type}_${Date.now()}`,
          group_id: message.group_id,
          sender_type: message.sender_type,
          sender_id: senderId,
          content: message.content,
          content_type: message.content_type || 'text',
          reply_to: message.reply_to,
          created_at: message.created_at || message.timestamp,
          metadata: message.metadata
        });

        if (message.sender_type === 'ai') {
          uiStore.setTyping(message.group_id, senderId, false);
          clearTypingTimeout(message.group_id, senderId);
        }
      }
      break;

    case 'ai_typing':
      console.log('[WS] Received ai_typing:', message);
      {
        const typingAiId = message.sender || message.ai;
        if (message.group_id && typingAiId) {
          uiStore.setTyping(message.group_id, typingAiId, true);
          setTypingTimeout(message.group_id, typingAiId);
        }
      }
      break;

    case 'ai_typing_stop':
      console.log('[WS] Received ai_typing_stop:', message);
      {
        const typingAiId = message.sender || message.ai;
        if (message.group_id && typingAiId) {
          uiStore.setTyping(message.group_id, typingAiId, false);
          clearTypingTimeout(message.group_id, typingAiId);
        }
      }
      break;

    case 'system_message':
      if (message.group_id) {
        messagesStore.addMessage(message.group_id, {
          id: `system_${Date.now()}`,
          group_id: message.group_id,
          sender_type: 'system',
          content: message.content,
          content_type: 'system',
          created_at: message.timestamp
        });
      }
      break;

    case 'message_liked':
      if (message.group_id && message.message_id) {
        const likedBy = message.liked_by_type === 'ai' ? `ai_${message.liked_by}` : message.liked_by;
        messagesStore.likeMessage(message.message_id, message.group_id, likedBy);
      }
      break;

    case 'new_comment':
      if (message.group_id && message.message_id && message.comment) {
        messagesStore.addComment(
          message.message_id,
          message.group_id,
          message.comment.content,
          message.comment.sender_type,
          message.comment.sender_id
        );
      }
      break;

    case 'joined_group':
      console.log('Joined group:', message.group_id);
      break;

    case 'generation_stopped':
      if (message.group_id) {
        uiStore.clearAllTypingForGroup(message.group_id);
      }
      break;

    case 'message_deleted':
      if (message.group_id && message.message_id) {
        messagesStore.deleteMessage(message.message_id, message.group_id);
      }
      break;
  }
}

export function joinGroup(groupId: string) {
  console.log('[WS] Joining group:', groupId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'join_group',
      group_id: groupId
    }));
    currentGroupId = groupId;
  }
}

export function leaveGroup(groupId: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'leave_group',
      group_id: groupId
    }));
    if (currentGroupId === groupId) {
      currentGroupId = null;
    }
  }
}

export function sendTypingStatus(groupId: string, aiId: string, status: boolean) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'typing',
      group_id: groupId,
      ai: aiId,
      status
    }));
  }
}

export function stopGeneration(groupId: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stop_generation',
      group_id: groupId
    }));
  }
}

export function disconnectWebSocket() {
  stopHeartbeat();
  clearAllTypingTimeouts();
  if (ws) {
    ws.close();
    ws = null;
    currentGroupId = null;
  }
}
