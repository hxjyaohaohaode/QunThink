import { useMessagesStore } from '../stores/messagesStore';
import { useAudioStore } from '../stores/audioStore';
import type { Message } from '../types';
import { useUIStore } from '../stores/uiStore';
import { useGroupsStore } from '../stores/groupsStore';
import { usePersonasStore, PersonaConfig } from '../stores/personasStore';
import { api, axiosInstance, notifyAuthExpired, getDevUserId } from './api';
import { getWebSocketUrl } from './runtimeConfig';
import { getCacheUserId } from '../utils/cacheUtils';
import { saveGroupsCache } from '../utils/cacheUtils';
import { findMatchingLocalMessage } from './messageCorrelation';
import { deleteMessageFromIndexedDB } from '../utils/indexedDB';

interface WSIncomingMessage {
  type: string;
  group_id: string;
  message_id?: string;
  message?: Message | string;
  sender_id?: string;
  sender?: string;
  sender_type?: 'user' | 'ai' | 'system';
  content?: string;
  content_type?: 'text' | 'code' | 'file' | 'system';
  id?: string;
  client_message_id?: string;
  reply_to?: string;
  reply_to_ids?: string[];
  timestamp?: string;
  created_at?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  ai?: string;
  ai_id?: string;
  is_typing?: boolean;
  status?: 'running' | 'stopped';
  message_ids?: string[];
  liked_by?: string;
  liked_by_type?: string;
  unliked_by?: string;
  unliked_by_type?: string;
  disliked_by?: string;
  disliked_by_type?: string;
  undisliked_by?: string;
  undisliked_by_type?: string;
  comment?: {
    id?: string;
    content: string;
    sender_type: 'user' | 'ai';
    sender_id: string;
    parent_id?: string;
    reply_to?: string;
    created_at?: string;
    depth?: number;
  };
  chunk?: string;
  is_done?: boolean;
  is_edited?: boolean;
  edited_at?: string;
  audio_revoked?: boolean;
  messages?: WSIncomingMessage[];
  group?: Record<string, unknown>;
  aiId?: string;
  incremental_chunk?: string;
  ai_id_for_persona?: string;
  persona?: PersonaConfig;
  all_personas?: Record<string, PersonaConfig>;
}

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let currentGroupId: string | null = null;
let pendingGroupId: string | null = null;
let subscribedGroupIds: Set<string> = new Set();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let lastMessageTimestamp: Record<string, string> = {};
let isReconnecting = false;
let connectionError: string | null = null;
let connectionTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastMessageReceivedTime = Date.now();

const MAX_RECONNECT_ATTEMPTS = 30;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 45000;
const CONNECTION_TIMEOUT = 20000;
const CONNECTION_STABLE_THRESHOLD_MS = 30000;
const MAX_GAP_FILL_PAGES = 5;
let isCleanDisconnect = false;

let connectedSince = 0;

function markConnected(): void {
  connectedSince = Date.now();
}

function consumeStableConnectionReset(): boolean {
  const wasStable = connectedSince > 0 && Date.now() - connectedSince > CONNECTION_STABLE_THRESHOLD_MS;
  connectedSince = 0;
  if (wasStable) {
    reconnectAttempts = 0;
  }
  return wasStable;
}

function clearConnectedMarker(): void {
  connectedSince = 0;
}

function getReconnectDelay(attempt: number): number {
  const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, attempt - 1);
  const jitter = Math.random() * 1000;
  return Math.min(delay + jitter, MAX_RECONNECT_DELAY);
}

// 获取重连进度信息，供UI展示
export function getReconnectProgress(): { current: number; max: number } {
  return { current: reconnectAttempts, max: MAX_RECONNECT_ATTEMPTS };
}

function startHeartbeat(wsInstance: WebSocket) {
  stopHeartbeat();
  // 被动心跳：不再主动发送ping，只监听后端ping并回复pong
  // 后端每30s发送ping，如果45s内没有收到任何消息（ping/pong/其他），则认为连接断开
  heartbeatTimer = setInterval(() => {
    if (wsInstance.readyState === WebSocket.OPEN) {
      const timeSinceLastMessage = Date.now() - lastMessageReceivedTime;
      if (timeSinceLastMessage > HEARTBEAT_TIMEOUT) {
        if (import.meta.env.DEV) console.warn('[WS] 被动心跳超时，准备重连');
        if (wsInstance.readyState === WebSocket.OPEN) {
          wsInstance.close(4002, 'Heartbeat timeout');
        }
      }
    } else {
      stopHeartbeat();
    }
  }, HEARTBEAT_INTERVAL);
}

function resetHeartbeatTimeout() {
  if (heartbeatTimeoutTimer) {
    clearTimeout(heartbeatTimeoutTimer);
    heartbeatTimeoutTimer = null;
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (heartbeatTimeoutTimer) {
    clearTimeout(heartbeatTimeoutTimer);
    heartbeatTimeoutTimer = null;
  }
}

function clearConnectionTimer() {
  if (connectionTimer) {
    clearTimeout(connectionTimer);
    connectionTimer = null;
  }
}

function getTimestampsKey(): string {
  const userId = getCacheUserId();
  return userId ? `ws_last_msg_ts_${userId}` : 'ws_last_msg_ts';
}

function recordMessageTimestamp(groupId: string, timestamp: string) {
  lastMessageTimestamp[groupId] = timestamp;
  try {
    const stored = JSON.parse(localStorage.getItem(getTimestampsKey()) || '{}');
    stored[groupId] = timestamp;
    localStorage.setItem(getTimestampsKey(), JSON.stringify(stored));
  } catch { }
}

function loadPersistedTimestamps() {
  try {
    const stored = JSON.parse(localStorage.getItem(getTimestampsKey()) || '{}');
    for (const [groupId, ts] of Object.entries(stored)) {
      if (typeof ts === 'string') {
        lastMessageTimestamp[groupId] = ts;
      }
    }
  } catch { }
}

async function fetchMissedMessages(groupId: string) {
  const lastTimestamp = lastMessageTimestamp[groupId];
  if (!lastTimestamp) {
    void useMessagesStore.getState().fetchMessages(groupId).catch(error => {
      if (import.meta.env.DEV) console.warn('[WS] Initial messages fetch failed:', error);
    });
    return;
  }

  try {
    const collected: Message[] = [];
    let cursorBefore: string | undefined = undefined;

    for (let page = 0; page < MAX_GAP_FILL_PAGES; page++) {
      const response = await api.getMessages(groupId, 100, cursorBefore, lastTimestamp);
      const pageMessages = response.messages || [];

      if (pageMessages.length === 0) {
        break;
      }

      collected.unshift(...pageMessages);

      if (!response.hasMore) {
        break;
      }

      const oldestFetched = pageMessages[0]?.created_at;
      if (!oldestFetched || oldestFetched === cursorBefore) {
        break;
      }
      cursorBefore = oldestFetched;
    }

    if (collected.length === 0) {
      return;
    }

    const messagesStore = useMessagesStore.getState();
    const currentMsgs = messagesStore.messages[groupId] || [];
    const streamingIds = new Set(currentMsgs.filter(m => m.is_streaming).map(m => m.id));
    const existingIds = new Set(currentMsgs.map(m => m.id));
    let addedCount = 0;
    let finalizedCount = 0;

    collected.forEach((msg: Message) => {
      if (streamingIds.has(msg.id)) {
        messagesStore.finalizeStreamMessage(
          groupId,
          msg.id,
          msg.content || '',
          msg.reply_to,
          msg.reply_to_ids
        );
        streamingIds.delete(msg.id);
        finalizedCount++;
      } else if (!existingIds.has(msg.id)) {
        messagesStore.addMessage(groupId, {
          ...msg,
          sender_type: msg.sender_type,
          content_type: msg.content_type,
          is_streaming: false
        });
        addedCount++;
      }
    });

    if (import.meta.env.DEV) console.log(`[WS] Fetched ${collected.length} missed messages in pages, ${addedCount} new, ${finalizedCount} finalized for group ${groupId}`);
  } catch (error) {
    if (import.meta.env.DEV) console.error('[WS] Failed to fetch missed messages:', error);
  }
}

async function syncDataAfterReconnect() {
  try {
    const { fetchGroups } = useGroupsStore.getState();
    const { fetchPersonas } = usePersonasStore.getState();
    await Promise.all([
      fetchGroups(),
      fetchPersonas()
    ]);
    if (import.meta.env.DEV) console.log('[WS] Reconnect data sync completed');
  } catch (error) {
    if (import.meta.env.DEV) console.error('[WS] Reconnect data sync failed:', error);
  }
}

export function connectWebSocket(groupId?: string) {
  const uiStore = useUIStore.getState();
  isCleanDisconnect = false;

  // 重连锁：如果正在建立连接（CONNECTING状态），直接跳过，避免并发竞争
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    if (import.meta.env.DEV) console.log('[WS] Connection in progress, skipping...');
    return;
  }
  isReconnecting = false; // 重置标志，允许新连接

  loadPersistedTimestamps();
  setupMobileEventListeners();

  if (ws && ws.readyState === WebSocket.OPEN) {
    if (currentGroupId === groupId) return;
    if (currentGroupId && currentGroupId !== groupId) {
      leaveGroup(currentGroupId);
    }
    if (groupId) {
      joinGroup(groupId);
    }
    return;
  }

  if (ws && ws.readyState !== WebSocket.OPEN) {
    if (import.meta.env.DEV) console.log('[WS] Closing stale connection, readyState:', ws.readyState);
    try { ws.close(); } catch { }
    ws = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  uiStore.setConnectionStatus('connecting');
  clearConnectionTimer();

  const endpoint = new URL(getWebSocketUrl());
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === 'dev') endpoint.searchParams.set('userId', getDevUserId());
  const wsUrl = endpoint.toString();

  if (import.meta.env.DEV) console.log('[WS] Connecting to:', wsUrl);

  const wsInstance = new WebSocket(wsUrl);
  ws = wsInstance;

  connectionTimer = setTimeout(() => {
    if (wsInstance.readyState === WebSocket.CONNECTING) {
      if (import.meta.env.DEV) console.error('[WS] Connection timeout after', CONNECTION_TIMEOUT, 'ms');
      isCleanDisconnect = false;
      wsInstance.close(4002, 'Connection timeout');
    }
  }, CONNECTION_TIMEOUT);

  wsInstance.onopen = () => {
    clearConnectionTimer();
    lastMessageReceivedTime = Date.now();
    if (import.meta.env.DEV) console.log('[WS] WebSocket connected');
    markConnected();
    reconnectAttempts = 0;
    connectionError = null;
    uiStore.setConnectionStatus('connected');
    uiStore.setConnectionError(null);

    startHeartbeat(wsInstance);
    startHealthCheck();

    const groupIdToJoin = pendingGroupId || currentGroupId || groupId;
    if (import.meta.env.DEV) console.log('[WS] onopen - groupIdToJoin:', groupIdToJoin);
    if (groupIdToJoin) {
      currentGroupId = groupIdToJoin;
      pendingGroupId = null;
    }

    // 重连时必须清空已订阅组集合，确保subscribeAllGroups重新发送所有join_group
    subscribedGroupIds.clear();
    subscribeAllGroups();

    // 重连后获取所有群组的丢失消息，避免其他群组消息永久丢失
    if (currentGroupId) {
      if (import.meta.env.DEV) console.log('[WS] 获取丢失的消息并同步全局数据, isReconnecting:', isReconnecting);
      fetchMissedMessages(currentGroupId).then(() => {
        syncDataAfterReconnect();
      });
    }
    // 对其他已订阅群组也获取丢失消息
    const allGroups = useGroupsStore.getState().groups || [];
    for (const group of allGroups) {
      if (group.id !== currentGroupId) {
        fetchMissedMessages(group.id).catch(err => {
          if (import.meta.env.DEV) console.warn('[WS] Failed to fetch missed messages for group', group.id, err);
        });
      }
    }
    // 重连后恢复中断的流式消息：检查所有is_streaming消息是否已在后端finalize
    recoverInterruptedStreams();
    isReconnecting = false;
  };

  wsInstance.onmessage = (event) => {
    lastMessageReceivedTime = Date.now();
    try {
      const message = JSON.parse(event.data);

      if (message.type === 'ping') {
        if (wsInstance.readyState === WebSocket.OPEN) {
          wsInstance.send(JSON.stringify({ type: 'pong' }));
        }
        resetHeartbeatTimeout();
        return;
      }

      if (message.type === 'pong') {
        resetHeartbeatTimeout();
        return;
      }

      handleWebSocketMessage(message);
    } catch (error) {
      if (import.meta.env.DEV) console.error('WebSocket message parse error:', error);
    }
  };

  wsInstance.onclose = (event) => {
    clearConnectionTimer();
    stopHeartbeat();

    const uiStore = useUIStore.getState();

    if (import.meta.env.DEV) console.log('[WS] WebSocket disconnected, code:', event.code, 'reason:', event.reason || 'N/A', 'wasClean:', event.wasClean);

    uiStore.setConnectionStatus('disconnected');

    if (isCleanDisconnect) {
      if (import.meta.env.DEV) console.log('[WS] Clean disconnect, not reconnecting');
      isReconnecting = false;
      isCleanDisconnect = false;
      return;
    }

    if (event.code === 1000 || event.code === 1001) {
      if (import.meta.env.DEV) console.log('[WS] Normal close, not reconnecting');
      isReconnecting = false;
      return;
    }

    if (event.code === 4001) {
      if (import.meta.env.DEV) console.log('[WS] Auth error from server, triggering logout');
      isReconnecting = false;
      connectionError = event.reason || '认证失败，请重新登录';
      uiStore.setConnectionError(connectionError);
      notifyAuthExpired();
      return;
    }

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      // 统一使用指数退避+jitter，避免1006异常关闭时引发重连风暴
      const delay = getReconnectDelay(reconnectAttempts);
      if (import.meta.env.DEV) console.log(`[WS] Reconnecting... attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, delay ${delay}ms`);
      uiStore.setConnectionStatus('connecting');
      uiStore.setConnectionError(null);

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        isReconnecting = true;
        connectWebSocket(currentGroupId || undefined);
      }, delay);
    } else {
      if (import.meta.env.DEV) console.error('[WS] Max reconnection attempts reached, will retry in 60s');
      isReconnecting = false;
      connectionError = '连接已断开，重连失败，请刷新页面重试';
      uiStore.setConnectionError(connectionError);
      // 使用reconnectTimer存储60秒兜底重试定时器，确保可被disconnectWebSocket清除
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectAttempts = 0;
        if (currentGroupId) {
          connectWebSocket(currentGroupId);
        }
      }, 60000);
    }
  };

  wsInstance.onerror = (error) => {
    if (import.meta.env.DEV) {
      console.error('[WS] WebSocket error:', error);
      console.error('[WS] Error details - readyState:', wsInstance.readyState, 'URL:', wsUrl);
    }
    connectionError = 'WebSocket 连接出错，正在尝试重连...';
    useUIStore.getState().setConnectionError(connectionError);
  };
}

function handleWebSocketMessage(message: WSIncomingMessage) {
  const messagesStore = useMessagesStore.getState();
  const uiStore = useUIStore.getState();
  const groupsStore = useGroupsStore.getState();

  if (import.meta.env.DEV) console.log('[WS] Received message type:', message.type, message);

  try {
    switch (message.type) {
      case 'connected': {
        subscribeAllGroups();
        const current = useGroupsStore.getState().currentGroup;
        if (current) joinGroup(current.id);
        break;
      }
      case 'new_message':
        if (message.group_id) {
          const senderId = message.sender_id || message.sender || '';
          const messageTimestamp = message.created_at || message.timestamp || new Date().toISOString();
          const msgId = message.id || `${message.sender_type}_${Date.now()}`;

          const currentMessages = messagesStore.messages[message.group_id] || [];
          const existingStreamMsg = currentMessages.find(m => m.id === msgId && m.is_streaming);
          const existingMsgById = currentMessages.find(m => m.id === msgId);

          if (existingStreamMsg) {
            messagesStore.finalizeStreamMessage(
              message.group_id,
              msgId,
              message.content || existingStreamMsg.content,
              message.reply_to,
              message.reply_to_ids
            );
          } else if (!existingMsgById) {
            const localMsg = message.sender_type === 'user'
              ? findMatchingLocalMessage(currentMessages, message.client_message_id)
              : undefined;

            if (localMsg) {
              messagesStore.addMessage(message.group_id, {
                id: msgId,
                group_id: message.group_id,
                sender_type: 'user',
                sender_id: senderId,
                content: message.content || '',
                content_type: message.content_type || 'text',
                reply_to: message.reply_to,
                created_at: messageTimestamp,
                metadata: message.metadata,
                tempId: localMsg.tempId,
                status: 'sent'
              });
              if (localMsg.tempId) void deleteMessageFromIndexedDB(localMsg.tempId);
            } else {
              messagesStore.addMessage(message.group_id, {
                id: msgId,
                group_id: message.group_id,
                sender_type: message.sender_type || 'system',
                sender_id: senderId,
                content: message.content || '',
                content_type: message.content_type || 'text',
                reply_to: message.reply_to,
                created_at: messageTimestamp,
                metadata: message.metadata
              });
            }
          } else {
            // 消息已存在（非流式）：更新可能变化的字段（metadata、attachments 等）
            messagesStore.addMessage(message.group_id, {
              id: msgId,
              group_id: message.group_id,
              sender_type: message.sender_type || 'system',
              sender_id: senderId,
              content: message.content || existingMsgById.content,
              content_type: message.content_type || 'text',
              reply_to: message.reply_to,
              created_at: messageTimestamp,
              metadata: message.metadata
            });
          }

          recordMessageTimestamp(message.group_id, messageTimestamp);

          useGroupsStore.setState(state => ({
            groups: state.groups.map(g =>
              g.id === message.group_id
                ? { ...g, last_message_at: messageTimestamp, last_message_preview: (message.sender_type === 'user' ? '[我] ' : '') + (message.content || '').substring(0, 50) }
                : g
            )
          }));

          if (message.sender_type === 'ai') {
            uiStore.setTyping(message.group_id, senderId, false);
          }
        }
        break;

      case 'ai_typing':
        {
          const typingAiId = message.sender || message.ai;
          if (message.group_id && typingAiId) {
            groupsStore.setTypingAI(message.group_id, typingAiId);
            uiStore.setTyping(message.group_id, typingAiId, true);
          }
        }
        break;

      case 'ai_typing_stop':
        {
          const typingAiId = message.sender || message.ai;
          if (message.group_id && typingAiId) {
            groupsStore.setTypingAI(message.group_id, null);
            uiStore.setTyping(message.group_id, typingAiId, false);
          }
        }
        break;

      case 'system_message':
        if (message.group_id) {
          messagesStore.addMessage(message.group_id, {
            id: `system_${Date.now()}`,
            group_id: message.group_id,
            sender_type: 'system',
            content: message.content || '',
            content_type: 'system',
            created_at: message.timestamp || new Date().toISOString()
          });
        }
        break;

      case 'message_liked':
        if (message.group_id && message.message_id) {
          const likedBy = message.liked_by_type === 'ai' ? `ai_${message.liked_by}` : message.liked_by;
          messagesStore.applyLikeUpdate(message.message_id, message.group_id, likedBy);
        }
        break;

      case 'message_unliked':
        if (message.group_id && message.message_id) {
          const unlikedBy = message.unliked_by_type === 'ai' ? `ai_${message.unliked_by}` : message.unliked_by;
          messagesStore.applyUnlikeUpdate(message.message_id, message.group_id, unlikedBy);
        }
        break;

      case 'message_disliked':
        if (message.group_id && message.message_id) {
          const dislikedBy = message.disliked_by_type === 'ai' ? `ai_${message.disliked_by}` : message.disliked_by;
          messagesStore.applyDislikeUpdate(message.message_id, message.group_id, dislikedBy);
        }
        break;

      case 'message_undisliked':
        if (message.group_id && message.message_id) {
          const undislikedBy = message.undisliked_by_type === 'ai' ? `ai_${message.undisliked_by}` : message.undisliked_by;
          messagesStore.applyUndislikeUpdate(message.message_id, message.group_id, undislikedBy);
        }
        break;

      case 'new_comment':
        if (message.group_id && message.message_id && message.comment) {
          const wsComment = message.comment;
          const newComment: import('../types').Comment = {
            id: wsComment.id || `comment_${Date.now()}`,
            message_id: message.message_id,
            parent_id: wsComment.parent_id,
            reply_to: wsComment.reply_to,
            sender_type: wsComment.sender_type || 'user',
            sender_id: wsComment.sender_id,
            content: wsComment.content,
            created_at: wsComment.created_at || new Date().toISOString(),
            depth: wsComment.depth
          };
          messagesStore.addCommentFromRemote(
            message.message_id,
            message.group_id,
            newComment
          );
        }
        break;

      case 'joined_group':
        if (import.meta.env.DEV) console.log('Joined group:', message.group_id);
        break;

      case 'generation_stopped':
        if (message.group_id) {
          uiStore.clearAllTypingForGroup(message.group_id);
          const groupMsgs = messagesStore.messages[message.group_id] || [];
          groupMsgs.forEach(m => {
            if (m.is_streaming) {
              messagesStore.finalizeStreamMessage(message.group_id, m.id, m.content || '');
            }
          });
        }
        break;

      case 'message_stream_start':
        if (message.group_id && message.message_id && message.sender_id) {
          messagesStore.addStreamMessage(message.group_id, message.message_id, message.sender_id);
          uiStore.setTyping(message.group_id, message.sender_id, false);
        }
        break;

      case 'message_stream':
        if (message.group_id && message.message_id) {
          if (import.meta.env.DEV) console.log('[WS] Received message_stream:', message.message_id, 'is_done:', message.is_done, 'chunk_len:', message.chunk?.length, 'sender:', message.sender_id);
          const incremental = (message as any).incremental_chunk;
          const fullChunk = message.chunk;
          let contentToUse: string | undefined;

          if (fullChunk !== undefined) {
            contentToUse = fullChunk;
          } else if (incremental && incremental.length > 0) {
            const existingMsg = (messagesStore.messages[message.group_id] || []).find(m => m.id === message.message_id);
            contentToUse = `${existingMsg?.content || ''}${incremental}`;
          }

          if (contentToUse !== undefined) {
            const messagesStore = useMessagesStore.getState();
            const streamMsgs = messagesStore.messages[message.group_id] || [];
            const existingMsg = streamMsgs.find(m => m.id === message.message_id);
            if (import.meta.env.DEV) console.log('[WS] message_stream - existing:', !!existingMsg, 'content_len:', contentToUse.length);

            if (existingMsg) {
              messagesStore.updateStreamMessage(message.group_id, message.message_id, contentToUse, message.is_done ?? false);
            } else {
              messagesStore.addStreamMessage(message.group_id, message.message_id, message.sender_id || '');
              messagesStore.updateStreamMessage(message.group_id, message.message_id, contentToUse, message.is_done ?? false);
            }

            if (contentToUse.length > 0 && message.sender_id) {
              uiStore.setTyping(message.group_id, message.sender_id, false);
            }

            // 流式输出过程中实时更新侧边栏的最后消息预览
            // 避免侧边栏预览只在 message_stream_end 时才更新
            const previewContent = contentToUse.substring(0, 50);
            const senderPrefix = message.sender_type === 'user' ? '[我] ' : '';
            useGroupsStore.setState(state => ({
              groups: state.groups.map(g =>
                g.id === message.group_id
                  ? { ...g, last_message_preview: senderPrefix + previewContent }
                  : g
              )
            }));
          }

          if (message.is_done && message.sender_id) {
            uiStore.setTyping(message.group_id, message.sender_id, false);
          }
        }
        break;

      case 'message_stream_end':
        if (message.group_id && message.message_id && message.content !== undefined) {
          if (import.meta.env.DEV) console.log('[WS] Received message_stream_end:', message.message_id, 'content_len:', message.content.length);
          const messagesStore = useMessagesStore.getState();
          const streamMsgs = messagesStore.messages[message.group_id] || [];
          const existingMsg = streamMsgs.find(m => m.id === message.message_id);
          if (import.meta.env.DEV) console.log('[WS] message_stream_end - existing:', !!existingMsg);

          if (existingMsg) {
            messagesStore.finalizeStreamMessage(
              message.group_id,
              message.message_id,
              message.content,
              message.reply_to,
                message.reply_to_ids
              );
              if (message.sender_type === 'system') messagesStore.updateMessage(message.message_id, message.group_id, { sender_type: 'system', metadata: message.metadata });
            } else {
            if (import.meta.env.DEV) console.log('[WS] message_stream_end - creating new message directly');
            const finalMessage: Message = {
              id: message.message_id,
              group_id: message.group_id,
              sender_type: message.sender_type || 'ai',
              sender_id: message.sender_id || '',
              content: message.content,
              content_type: 'text',
              reply_to: message.reply_to,
              reply_to_ids: message.reply_to_ids,
              created_at: message.created_at || message.timestamp || new Date().toISOString()
            };
            messagesStore.addMessage(message.group_id, finalMessage);
          }

          const typingAiId = message.sender_id || message.sender || message.ai_id;
          if (typingAiId) {
            uiStore.setTyping(message.group_id, typingAiId, false);
          }

          const streamEndTime = message.created_at || message.timestamp || new Date().toISOString();
          useGroupsStore.setState(state => ({
            groups: state.groups.map(g =>
              g.id === message.group_id
                ? { ...g, last_message_at: streamEndTime, last_message_preview: (message.sender_type === 'user' ? '[我] ' : '') + (message.content || '').substring(0, 50) }
                : g
            )
          }));
        }
        break;

      case 'message_deleted':
        if (message.group_id && message.message_id) {
          messagesStore.removeMessages(message.group_id, [message.message_id]);
        }
        break;

      case 'message_updated':
        if (message.group_id && message.message_id && message.content !== undefined) {
          const existing = messagesStore.messages[message.group_id]?.find(item => item.id === message.message_id);
          const incomingTime = Date.parse(message.edited_at || '');
          const currentTime = Date.parse(existing?.edited_at || '');
          if (Number.isFinite(incomingTime) && Number.isFinite(currentTime) && incomingTime < currentTime) break;
          const metadata = { ...(existing?.metadata || {}) };
          if (message.audio_revoked) {
            delete metadata.tts;
            useAudioStore.getState().removeTTSAudio(message.message_id);
          }
          messagesStore.updateMessage(message.message_id, message.group_id, {
            content: message.content,
            is_edited: message.is_edited ?? true,
            edited_at: message.edited_at || new Date().toISOString(),
            ...(message.audio_revoked ? { metadata } : {})
          });
        }
        break;

      case 'messages_batch_deleted':
        if (message.group_id && message.message_ids && Array.isArray(message.message_ids)) {
          messagesStore.removeMessages(message.group_id, message.message_ids as string[]);
        }
        break;

      case 'messages_all_deleted':
        if (message.group_id) {
          messagesStore.clearMessages(message.group_id);
        }
        break;

      case 'chat_status':
        if (message.group_id) {
          const status = message.status as 'running' | 'stopped';
          groupsStore.updateChatStatus(message.group_id, {
            isRunning: status === 'running',
            currentSpeaker: null,
            status: status
          });
          if (status === 'stopped') {
            groupsStore.setTypingAI(message.group_id, null);
          }
        }
        break;

      case 'autonomous_chat_stopped':
        if (message.group_id) {
          groupsStore.updateChatStatus(message.group_id, {
            isRunning: false,
            currentSpeaker: null,
            status: 'stopped'
          });
          groupsStore.setTypingAI(message.group_id, null);
          uiStore.clearAllTypingForGroup(message.group_id);
        }
        break;

      case 'autonomous_chat_started':
        if (message.group_id) {
          groupsStore.updateChatStatus(message.group_id, {
            isRunning: true,
            currentSpeaker: null,
            status: 'running'
          });
        }
        break;

      case 'member_removed':
        if (message.group_id && message.aiId) {
          const currentGroup = groupsStore.currentGroup;
          if (currentGroup && currentGroup.id === message.group_id) {
            const updatedAiMembers = (currentGroup.ai_members || []).filter(
              (id: string) => id !== message.aiId
            );
            useGroupsStore.setState({
              currentGroup: { ...currentGroup, ai_members: updatedAiMembers },
              groups: useGroupsStore.getState().groups.map(g =>
                g.id === message.group_id ? { ...g, ai_members: (g.ai_members || []).filter((id: string) => id !== message.aiId) } : g
              )
            });
          }
          uiStore.setTyping(message.group_id, message.aiId, false);
        }
        break;

      case 'group_update':
        if (message.group_id && message.group) {
          const updatedGroup = message.group as unknown as import('../types').Group;
          const currentState = useGroupsStore.getState();
          useGroupsStore.setState({
            groups: currentState.groups.map(g =>
              g.id === message.group_id ? updatedGroup : g
            ),
            currentGroup: currentState.currentGroup?.id === message.group_id
              ? updatedGroup
              : currentState.currentGroup
          });
          saveGroupsCache(useGroupsStore.getState().groups);
        }
        break;

      case 'autonomous_chat_error':
        if (message.group_id) {
          groupsStore.updateChatStatus(message.group_id, {
            isRunning: false,
            currentSpeaker: null,
            status: 'stopped'
          });
          groupsStore.setTypingAI(message.group_id, null);
          uiStore.clearAllTypingForGroup(message.group_id);
          if (message.error) {
            useUIStore.getState().setConnectionError(`自动聊天出错: ${message.error}`);
            setTimeout(() => useUIStore.getState().setConnectionError(null), 5000);
          }
        }
        break;

      case 'persona_updated':
        if (message.aiId && message.persona) {
          const personasStore = usePersonasStore.getState();
          personasStore.handlePersonaUpdate(message.aiId, message.persona as PersonaConfig);
          if (import.meta.env.DEV) {
            console.log('[WS] Persona updated:', message.aiId, message.persona.name);
          }
        }
        break;

      case 'personas_sync':
        if (message.all_personas) {
          const dedupedPersonas: Record<string, PersonaConfig> = {};
          for (const [aiId, persona] of Object.entries(message.all_personas)) {
            dedupedPersonas[aiId] = persona as PersonaConfig;
          }
          usePersonasStore.setState({ personas: dedupedPersonas });
          if (import.meta.env.DEV) {
            console.log('[WS] Personas synced:', Object.keys(dedupedPersonas).length, 'personas');
          }
        }
        break;

      case 'batch':
        if (message.messages && Array.isArray(message.messages)) {
          for (const subMessage of message.messages) {
            if (subMessage && subMessage.type) {
              handleWebSocketMessage(subMessage);
            }
          }
        }
        break;

      case 'error':
        {
          const errorMsg = typeof message.message === 'string' ? message.message : message.error || '未知错误';
          useUIStore.getState().setConnectionError(errorMsg);
          setTimeout(() => useUIStore.getState().setConnectionError(null), 5000);
        }
        break;
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error('[WS] Error handling message type:', message.type, err);
    }
    // 记录错误但不中断后续消息处理
  }
}

export function joinGroup(groupId: string) {
  if (import.meta.env.DEV) console.log('[WS] joinGroup called:', groupId, 'ws state:', ws?.readyState, 'currentGroupId:', currentGroupId);

  currentGroupId = groupId;
  pendingGroupId = null;

  if (ws && ws.readyState === WebSocket.OPEN) {
    if (!subscribedGroupIds.has(groupId)) {
      ws.send(JSON.stringify({
        type: 'join_group',
        group_id: groupId
      }));
      subscribedGroupIds.add(groupId);
      if (import.meta.env.DEV) console.log('[WS] Sent join_group for:', groupId, 'total subscribed:', subscribedGroupIds.size);
    }
  } else {
    if (import.meta.env.DEV) console.log('[WS] WebSocket not open, will join when connected');
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      pendingGroupId = groupId;
    }
  }

  useMessagesStore.getState().fetchMessages(groupId);
}

export function leaveGroup(groupId: string) {
  if (subscribedGroupIds.has(groupId)) {
    subscribedGroupIds.delete(groupId);
  }
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

export function subscribeAllGroups() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const groupsStore = useGroupsStore.getState();
  const allGroups = groupsStore.groups || [];

  for (const group of allGroups) {
    if (!subscribedGroupIds.has(group.id)) {
      ws.send(JSON.stringify({
        type: 'join_group',
        group_id: group.id
      }));
      subscribedGroupIds.add(group.id);
    }
  }

  if (import.meta.env.DEV) console.log('[WS] subscribeAllGroups: subscribed to', subscribedGroupIds.size, 'groups');
}

export function disconnectWebSocket() {
  isCleanDisconnect = true;
  clearConnectionTimer();
  stopHeartbeat();
  stopHealthCheck();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const uiStore = useUIStore.getState();
  uiStore.setConnectionStatus('disconnected');
  if (ws) {
    ws.close();
    ws = null;
    currentGroupId = null;
    subscribedGroupIds.clear();
  }
  isReconnecting = false;
  reconnectAttempts = 0;
  clearConnectedMarker();
}

export function getConnectionError(): string | null {
  return connectionError;
}

let mobileListenersSetup = false;

function cleanupStaleStreamMessages() {
  const messagesStore = useMessagesStore.getState();
  const uiStore = useUIStore.getState();
  const now = Date.now();
  let cleanedCount = 0;
  // 与streamTimeouts的120秒保持一致，避免误杀正常流式传输
  const STALE_STREAM_THRESHOLD = 120000;

  for (const [groupId, msgs] of Object.entries(messagesStore.messages)) {
    const streamingMsgs = msgs.filter(m => m.is_streaming);
    for (const msg of streamingMsgs) {
      const msgAge = now - new Date(msg.created_at).getTime();
      if (msgAge > STALE_STREAM_THRESHOLD) {
        if (import.meta.env.DEV) console.log(`[WS] Cleaning up stale stream message: ${msg.id}, age: ${msgAge}ms`);
        // 保留已接收内容，追加超时提示
        const existingContent = msg.content || '';
        const finalContent = existingContent.trim()
          ? existingContent + '\n\n[流式传输超时，部分内容可能不完整]'
          : '[流式传输超时，请重新发送]';
        messagesStore.finalizeStreamMessage(groupId, msg.id, finalContent, undefined, undefined);
        const senderId = msg.sender_id;
        if (senderId) {
          uiStore.setTyping(groupId, senderId, false);
        }
        cleanedCount++;
      }
    }
  }

  if (cleanedCount > 0 && import.meta.env.DEV) {
    console.log(`[WS] Cleaned up ${cleanedCount} stale stream messages`);
  }
}

/**
 * 重连后恢复中断的流式消息
 * 检查所有is_streaming消息，若已超过10秒无更新则向后端查询是否已finalize
 */
async function recoverInterruptedStreams() {
  const messagesStore = useMessagesStore.getState();
  const now = Date.now();
  const RECOVERY_THRESHOLD = 10000; // 10秒无更新视为可能中断

  for (const [groupId, msgs] of Object.entries(messagesStore.messages)) {
    const streamingMsgs = msgs.filter(m => m.is_streaming);
    for (const msg of streamingMsgs) {
      const msgAge = now - new Date(msg.created_at).getTime();
      if (msgAge > RECOVERY_THRESHOLD) {
        if (import.meta.env.DEV) console.log(`[WS] Recovering interrupted stream: ${msg.id}, age: ${msgAge}ms`);
        try {
          // 向后端查询该消息的最新状态（axiosInstance 自动携带 cookie 与 CSRF 头）
          const response = await axiosInstance.get(`/messages/${msg.id}`);
          const serverMsg = response.data as { is_streaming?: boolean; content?: string } | null;
          if (serverMsg && !serverMsg.is_streaming) {
            // 后端已finalize，用完整内容替换前端部分内容
            const finalContent = serverMsg.content || msg.content || '[消息内容不可用]';
            messagesStore.finalizeStreamMessage(groupId, msg.id, finalContent, undefined, undefined);
            if (import.meta.env.DEV) console.log(`[WS] Recovered stream message ${msg.id} from server`);
          }
        } catch (err) {
          if (import.meta.env.DEV) console.warn(`[WS] Failed to recover stream message ${msg.id}:`, err);
        }
      }
    }
  }
}

let wasHidden = false;
let hiddenAt = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

function startHealthCheck() {
  stopHealthCheck();
  healthCheckTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (import.meta.env.DEV) console.log('[WS] Health check: connection lost, reconnecting...');
      if (ws) {
        try { ws.close(); } catch { }
        ws = null;
      }
      isReconnecting = false;
      consumeStableConnectionReset();
      connectWebSocket(currentGroupId || undefined);
    }
  }, 120000);
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    wasHidden = true;
    hiddenAt = Date.now();
    return;
  }

  if (document.visibilityState === 'visible' && wasHidden) {
    wasHidden = false;
    const hiddenDuration = Date.now() - hiddenAt;

    if (import.meta.env.DEV) console.log('[WS] Page became visible, checking connection... (hidden for', hiddenDuration, 'ms)');

    cleanupStaleStreamMessages();

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // 连接已断开，仅当隐藏时间超过5秒才重连，避免短暂切换标签页触发重连
      if (hiddenDuration < 5000) {
        if (import.meta.env.DEV) console.log('[WS] Page hidden for less than 5s, skipping reconnect');
        return;
      }
      if (import.meta.env.DEV) console.log('[WS] Connection lost while hidden, reconnecting...');
      if (ws) {
        try { ws.close(); } catch { }
        ws = null;
      }
      isReconnecting = false;
      consumeStableConnectionReset();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connectWebSocket(currentGroupId || undefined);
    } else {
      // 连接仍然 OPEN，只发送 ping 和获取丢失消息，不强制关闭重连
      if (currentGroupId) {
        if (import.meta.env.DEV) console.log('[WS] Connection still alive, fetching missed messages...');
        fetchMissedMessages(currentGroupId);
      }
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        if (import.meta.env.DEV) console.log('[WS] Ping failed, reconnecting...');
        try { ws.close(); } catch { }
        ws = null;
        isReconnecting = false;
        consumeStableConnectionReset();
        connectWebSocket(currentGroupId || undefined);
      }
    }
  }
}

function handleOnline() {
  if (import.meta.env.DEV) console.log('[WS] Network came back online');
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (ws) {
      try { ws.close(); } catch { }
      ws = null;
    }
    isReconnecting = false;
    consumeStableConnectionReset();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectWebSocket(currentGroupId || undefined);
  } else if (currentGroupId) {
    fetchMissedMessages(currentGroupId);
  }
}

function handleOffline() {
  // 连接断开时不需要特殊处理，重连机制会处理
}

function setupMobileEventListeners() {
  if (mobileListenersSetup) return;
  mobileListenersSetup = true;

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
}

function cleanupMobileEventListeners() {
  if (!mobileListenersSetup) return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  mobileListenersSetup = false;
}

export function destroyWebSocket() {
  isCleanDisconnect = true;
  clearConnectionTimer();
  stopHeartbeat();
  stopHealthCheck();
  if (ws) {
    ws.close();
    ws = null;
  }
  reconnectAttempts = 0;
  currentGroupId = null;
  pendingGroupId = null;
  subscribedGroupIds.clear();
  isReconnecting = false;
  clearConnectedMarker();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  cleanupMobileEventListeners();
  useUIStore.getState().setConnectionStatus('disconnected');
}
