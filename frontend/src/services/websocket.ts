import { useMessagesStore, recoverCachedMessage } from '../stores/messagesStore';
import { useAudioStore } from '../stores/audioStore';
import type { Group, Message } from '../types';
import { useUIStore } from '../stores/uiStore';
import { useGroupsStore } from '../stores/groupsStore';
import { usePersonasStore, PersonaConfig } from '../stores/personasStore';
import { axiosInstance, notifyAuthExpired, getDevUserId, getAuthGeneration } from './api';
import { getWebSocketUrl } from './runtimeConfig';
import { getCacheUserId } from '../utils/cacheUtils';
import { saveGroupsCache, savePersonasCache } from '../utils/cacheUtils';
import { findMatchingLocalMessage } from './messageCorrelation';
import { loadMessagesFromIndexedDB } from '../utils/indexedDB';

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

// A lifetime belongs to one explicit connection session and authentication generation.
// Socket identity alone is insufficient when the same account logs out and back in.
interface ConnectionOwner {
  userId: string;
  authGeneration: number;
}
interface GapFillChanges {
  touched: Set<string>;
  deleted: Set<string>;
  pendingEvents: WSIncomingMessage[];
  confirmedClientIds: Set<string>;
  cleared: boolean;
}
interface ConnectionContext {
  owner: ConnectionOwner;
  socket: WebSocket;
  closed: boolean;
  openedAt: number | null;
  lastMessageAt: number;
  connectionTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  errorTimer: ReturnType<typeof setTimeout> | null;
  gapFills: Map<string, Promise<void>>;
  gapFillChanges: Map<string, GapFillChanges>;
  abort: AbortController;
}

let owner: ConnectionOwner | null = null;
let connection: ConnectionContext | null = null;
let reconnectAttempts = 0;
let currentGroupId: string | null = null;
let pendingGroupId: string | null = null;
const subscribedGroupIds = new Set<string>();
let lastMessageTimestamp: Record<string, string> = {};
let connectionError: string | null = null;
let mobileListenersSetup = false;
let wasHidden = false;
let hiddenAt = 0;

const MAX_RECONNECT_ATTEMPTS = 30;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 45000;
const CONNECTION_TIMEOUT = 20000;
const CONNECTION_STABLE_THRESHOLD_MS = 30000;
const MAX_GAP_FILL_PAGES = 5;

function currentUserId(): string | null {
  return getCacheUserId() || (import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === 'dev' ? getDevUserId() : null);
}

function isOwnerCurrent(candidate: ConnectionOwner): boolean {
  return owner === candidate && candidate.userId === currentUserId() && candidate.authGeneration === getAuthGeneration();
}

function isCurrent(context: ConnectionContext): boolean {
  return connection === context && !context.closed && isOwnerCurrent(context.owner);
}

function isOpen(context: ConnectionContext): boolean {
  return isCurrent(context) && context.socket.readyState === WebSocket.OPEN;
}

function clearTimers(context: ConnectionContext) {
  if (context.connectionTimer !== null) clearTimeout(context.connectionTimer);
  if (context.reconnectTimer !== null) clearTimeout(context.reconnectTimer);
  if (context.heartbeatTimer !== null) clearInterval(context.heartbeatTimer);
  if (context.errorTimer !== null) clearTimeout(context.errorTimer);
  context.connectionTimer = context.reconnectTimer = context.heartbeatTimer = context.errorTimer = null;
}

function retireConnection(context: ConnectionContext) {
  // Invalidate before close: browsers may dispatch onclose later, mocks may dispatch synchronously.
  context.closed = true;
  context.abort.abort();
  clearTimers(context);
  context.socket.onopen = context.socket.onmessage = context.socket.onclose = context.socket.onerror = null;
  try { context.socket.close(); } catch { /* Already closed or unavailable. */ }
}

function setConnectionError(error: string | null) {
  connectionError = error;
  useUIStore.getState().setConnectionError(error);
}

function showTransientError(context: ConnectionContext, error: string) {
  if (!isOpen(context)) return;
  if (context.errorTimer !== null) clearTimeout(context.errorTimer);
  setConnectionError(error);
  context.errorTimer = setTimeout(() => {
    if (!isOpen(context)) return;
    context.errorTimer = null;
    // Do not erase a different HTTP/connection error from another source.
    if (useUIStore.getState().connectionError === error) setConnectionError(null);
  }, 5000);
}

function getReconnectDelay(attempt: number): number {
  return Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, attempt - 1) + Math.random() * 1000, MAX_RECONNECT_DELAY);
}

export function getReconnectProgress(): { current: number; max: number } {
  return { current: reconnectAttempts, max: MAX_RECONNECT_ATTEMPTS };
}

function getTimestampsKey(candidate: ConnectionOwner): string {
  return `ws_last_msg_ts_${candidate.userId}`;
}

function recordMessageTimestamp(context: ConnectionContext, groupId: string, timestamp: string) {
  if (!isOpen(context)) return;
  lastMessageTimestamp[groupId] = timestamp;
  try {
    localStorage.setItem(getTimestampsKey(context.owner), JSON.stringify(lastMessageTimestamp));
  } catch { /* Recovery still works with the in-memory cursor. */ }
}

function loadPersistedTimestamps(candidate: ConnectionOwner) {
  lastMessageTimestamp = {};
  try {
    const stored = JSON.parse(localStorage.getItem(getTimestampsKey(candidate)) || '{}');
    for (const [groupId, ts] of Object.entries(stored)) {
      if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) lastMessageTimestamp[groupId] = ts;
    }
  } catch { /* Malformed/unavailable cache is not an authentication failure. */ }
}

function readForConnection<T>(context: ConnectionContext, path: string, params?: Record<string, unknown>) {
  // Stamp ownership before Axios's asynchronous request interceptor can yield to
  // logout/login. Cancellation also stops retries and stale auth errors at source.
  const config = { signal: context.abort.signal, authGeneration: context.owner.authGeneration,
    headers: { 'X-Expected-User-Id': context.owner.userId }, params };
  return axiosInstance.get<T>(path, config).then(response => response.data);
}

function fetchMissedMessages(context: ConnectionContext, groupId: string): Promise<void> {
  if (!isOpen(context)) return Promise.resolve();
  const existing = context.gapFills.get(groupId);
  if (existing) return existing;
  const liveChanges: GapFillChanges = { touched: new Set(), deleted: new Set(), pendingEvents: [], confirmedClientIds: new Set(), cleared: false };
  context.gapFillChanges.set(groupId, liveChanges);
  const hasVisibleMessages = (useMessagesStore.getState().messages[groupId] || []).length > 0;
  // A persisted cursor is not loaded history. A cold tab must fetch the first page.
  const lastTimestamp = hasVisibleMessages ? lastMessageTimestamp[groupId] : undefined;
  const pending = Promise.resolve().then(async () => {
    try {
      if (!isOpen(context)) return;
      if (!hasVisibleMessages) {
        const cached = (await loadMessagesFromIndexedDB(groupId)).map(recoverCachedMessage);
        if (!isOpen(context) || liveChanges.cleared) return;
        const current = useMessagesStore.getState().messages[groupId] || [];
        const knownIds = new Set(current.map(item => item.id));
        const restored = cached.filter(item => !knownIds.has(item.id) && !liveChanges.deleted.has(item.id)
          && !(item.tempId && liveChanges.confirmedClientIds.has(item.tempId)));
        for (const item of cached) {
          if (item.tempId && liveChanges.confirmedClientIds.has(item.tempId)) useMessagesStore.getState().confirmClientMessage(groupId, item.tempId);
        }
        if (restored.length) {
          useMessagesStore.setState(state => ({ messages: { ...state.messages, [groupId]: [...current, ...restored]
            .sort((a, b) => a.created_at.localeCompare(b.created_at)) } }));
          const restoredIds = new Set(restored.map(item => item.id));
          for (const event of liveChanges.pendingEvents) {
            if (event.message_id && restoredIds.has(event.message_id)) handleWebSocketMessage(event, context, false);
          }
        }
      }
      if (!isOpen(context)) return;
      const beforeRead = new Map((useMessagesStore.getState().messages[groupId] || []).map(item => [item.id, item]));
      const paginationBefore = useMessagesStore.getState().pagination[groupId];
      const collected: Message[] = [];
      let cursorBefore: string | undefined;
      let hasMore = false;
      for (let page = 0; page < (lastTimestamp ? MAX_GAP_FILL_PAGES : 1); page++) {
        if (!isOpen(context)) return;
        const response = await readForConnection<{ messages?: Message[]; hasMore?: boolean }>(context, `/groups/${groupId}/messages`, {
          limit: lastTimestamp ? 100 : 50, ...(cursorBefore ? { before: cursorBefore } : {}), ...(lastTimestamp ? { after: lastTimestamp } : {})
        });
        if (!isOpen(context)) return;
        const pageMessages = response.messages || [];
        hasMore = response.hasMore || false;
        if (pageMessages.length === 0) break;
        collected.unshift(...pageMessages);
        if (!hasMore) break;
        const oldestFetched = pageMessages[0]?.created_at;
        if (!oldestFetched || oldestFetched === cursorBefore) break;
        cursorBefore = oldestFetched;
      }
      if (!isOpen(context) || liveChanges.cleared) return;
      const messagesStore = useMessagesStore.getState();
      if (!lastTimestamp) {
        const confirmedIds = new Set(collected.map(item => item.id));
        const oldestConfirmed = collected[0]?.created_at;
        const removed = (messagesStore.messages[groupId] || []).filter(item => !confirmedIds.has(item.id)
          && (!hasMore || (oldestConfirmed && item.created_at >= oldestConfirmed))
          && item.status !== 'failed' && item.status !== 'sending' && !item.is_streaming
          && !liveChanges.touched.has(item.id) && beforeRead.get(item.id) === item).map(item => item.id);
        // A first page only proves absence inside its fetched time range.
        // Older cached history is not a source deletion when more pages exist.
        // Keep unsent drafts/live changes while reconciling covered cached bodies.
        if (removed.length) messagesStore.removeMessages(groupId, removed);
      }
      const insertedIds = new Set<string>();
      for (const msg of collected) {
        if (!isOpen(context)) return;
        if (liveChanges.deleted.has(msg.id)) continue;
        const currentMessages = useMessagesStore.getState().messages[groupId] || [];
        const existingMessage = currentMessages.find(item => item.id === msg.id);
        const local = findMatchingLocalMessage(currentMessages, (msg as Message & { client_message_id?: string }).client_message_id);
        if (local && existingMessage) {
          if (local.id !== existingMessage.id) messagesStore.confirmClientMessage(groupId, local.tempId!);
          else messagesStore.addMessage(groupId, { ...existingMessage, status: 'sent' });
          if (local.id === existingMessage.id && local.tempId) messagesStore.confirmClientMessage(groupId, local.tempId);
        }
        if (existingMessage && (liveChanges.touched.has(msg.id) || existingMessage !== beforeRead.get(msg.id))) continue;
        if (existingMessage?.is_streaming && !msg.is_streaming) {
          messagesStore.finalizeStreamMessage(groupId, msg.id, msg.content || '', msg.reply_to, msg.reply_to_ids);
        } else if (!existingMessage) {
          insertedIds.add(msg.id);
          messagesStore.addMessage(groupId, { ...msg, ...(local?.tempId ? { tempId: local.tempId, status: 'sent' as const } : {}) });
        } else if (!lastTimestamp) {
          // Cold-tab cached confirmed messages may have been edited while offline.
          messagesStore.addMessage(groupId, msg);
        }
      }
      if (!isOpen(context)) return;
      // An edit/reaction can arrive for a message missing until this history read.
      // Replay only for newly inserted IDs, never double-apply already visible events.
      for (const event of liveChanges.pendingEvents) {
        if (event.message_id && insertedIds.has(event.message_id)) handleWebSocketMessage(event, context, false);
      }
      if (!isOpen(context)) return;
      useMessagesStore.setState(state => ({
        messages: { ...state.messages, [groupId]: [...(state.messages[groupId] || [])].sort((a, b) => a.created_at.localeCompare(b.created_at)) },
        // Only a first-page fetch knows whether older history exists.
        ...(!lastTimestamp && state.pagination[groupId] === paginationBefore ? { pagination: { ...state.pagination, [groupId]: {
          hasMore, loadingMore: false, oldestMessageId: collected[0]?.id || null, oldestMessageCreatedAt: collected[0]?.created_at || null
        } } } : {})
      }));
    } catch {
      if (isOpen(context)) showTransientError(context, '消息同步失败，保留已显示内容；可重新打开群聊重试');
    } finally {
      if (context.gapFills.get(groupId) === pending) {
        context.gapFills.delete(groupId);
        context.gapFillChanges.delete(groupId);
      }
    }
  });
  context.gapFills.set(groupId, pending);
  return pending;
}

function mergeLiveFields<T extends object>(remote: T, current?: T, before?: T): T {
  if (!current || current === before) return remote;
  if (!before) return { ...remote, ...current };
  const merged = { ...remote } as Record<string, unknown>;
  const live = current as Record<string, unknown>;
  const initial = before as Record<string, unknown>;
  for (const key of new Set([...Object.keys(initial), ...Object.keys(live)])) {
    if (!Object.is(live[key], initial[key])) {
      if (key in live) merged[key] = live[key]; else delete merged[key];
    }
  }
  return merged as T;
}

async function syncDataAfterReconnect(context: ConnectionContext) {
  if (!isOpen(context)) return;
  // Store-owned fetch actions commit internally. Fetch here so ownership is checked
  // before every store/cache mutation, including same-user connection replacement.
  const groupsBefore = new Map(useGroupsStore.getState().groups.map(group => [group.id, group]));
  const personasBefore = usePersonasStore.getState().personas;
  const [groupsResult, personasResult] = await Promise.allSettled([
    readForConnection<Group[]>(context, '/groups'),
    readForConnection<{ personas: Record<string, PersonaConfig> }>(context, '/personas')
  ]);
  if (!isOpen(context)) return;
  const validGroups = groupsResult.status === 'fulfilled' && Array.isArray(groupsResult.value)
    && groupsResult.value.every(group => group && typeof group.id === 'string');
  const validPersonas = personasResult.status === 'fulfilled' && personasResult.value?.personas
    && typeof personasResult.value.personas === 'object' && !Array.isArray(personasResult.value.personas)
    && Object.values(personasResult.value.personas).every(persona => persona && typeof persona === 'object');
  if (groupsResult.status === 'fulfilled' && validGroups) {
    const current = new Map(useGroupsStore.getState().groups.map(group => [group.id, group]));
    const groups = groupsResult.value.filter(group => !groupsBefore.has(group.id) || current.has(group.id)).map(group => {
      const existing = current.get(group.id);
      const hydrated = existing ? { ...group, avatar_url: existing.avatar_url || group.avatar_url,
        background_url: existing.background_url || group.background_url,
        announcement: existing.announcement || group.announcement,
        last_message_preview: group.last_message_preview || existing.last_message_preview } : group;
      return mergeLiveFields(hydrated, existing, groupsBefore.get(group.id));
    });
    const returnedIds = new Set(groups.map(group => group.id));
    for (const group of current.values()) if (!groupsBefore.has(group.id) && !returnedIds.has(group.id)) groups.push(group);
    const selected = useGroupsStore.getState().currentGroup?.id;
    useGroupsStore.setState({ groups, currentGroup: groups.find(group => group.id === selected) || null, loading: false, initialized: true });
    if (!isOpen(context)) return;
    saveGroupsCache(groups);
    subscribeAllGroups();
    for (const group of groups) if (!groupsBefore.has(group.id)) void fetchMissedMessages(context, group.id);
  }
  if (!isOpen(context)) return;
  if (personasResult.status === 'fulfilled' && validPersonas) {
    const current = usePersonasStore.getState().personas;
    const personas: Record<string, PersonaConfig> = {};
    for (const [id, persona] of Object.entries(personasResult.value.personas)) {
      if (personasBefore[id] && !current[id]) continue;
      personas[id] = mergeLiveFields({ ...persona, avatar_url: persona.avatar_url || current[id]?.avatar_url || null,
        color: persona.color || current[id]?.color }, current[id], personasBefore[id]);
    }
    for (const [id, persona] of Object.entries(current)) if (!personasBefore[id] && !personas[id]) personas[id] = persona;
    usePersonasStore.setState({ personas, loading: false, error: null });
    if (!isOpen(context)) return;
    savePersonasCache(personas);
  }
  if (!validGroups || !validPersonas) {
    showTransientError(context, '部分群聊资料同步失败，已保留当前内容');
  }
}

function finishConnection(context: ConnectionContext, code: number) {
  if (!isCurrent(context)) return;
  context.closed = true;
  context.abort.abort();
  clearTimers(context);
  subscribedGroupIds.clear();
  useUIStore.getState().setConnectionStatus('disconnected');
  // Opening a TCP/WebSocket connection is not evidence that the server is healthy.
  // At least one valid frame after the stable window is needed to reset backoff.
  if (context.openedAt !== null && context.lastMessageAt - context.openedAt >= CONNECTION_STABLE_THRESHOLD_MS) reconnectAttempts = 0;
  if (code === 4001) {
    // Authentication failure must not accept arbitrary server reason text or retry.
    disconnectWebSocket();
    setConnectionError('认证失败，请重新登录');
    notifyAuthExpired();
    return;
  }
  if (code === 1000 || code === 1001) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setConnectionError('连接已断开，重连失败，请刷新页面重试');
    return;
  }
  reconnectAttempts++;
  useUIStore.getState().setConnectionStatus('connecting');
  setConnectionError(null);
  context.reconnectTimer = setTimeout(() => {
    // Checking the closed context itself prevents an old queued timer stealing
    // ownership from a new socket even if both belong to the same account.
    if (connection !== context || !isOwnerCurrent(context.owner)) return;
    context.reconnectTimer = null;
    openConnection(context.owner);
  }, getReconnectDelay(reconnectAttempts));
}

function failConnection(context: ConnectionContext, reason: string) {
  if (!isCurrent(context)) return;
  finishConnection(context, 4002);
  try { context.socket.close(4002, reason); } catch { /* Retry already scheduled. */ }
}

function openConnection(candidate: ConnectionOwner) {
  if (!isOwnerCurrent(candidate)) return;
  if (connection) retireConnection(connection);
  connection = null;
  useUIStore.getState().setConnectionStatus('connecting');
  let socket: WebSocket;
  try {
    const endpoint = new URL(getWebSocketUrl());
    if (import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === 'dev') endpoint.searchParams.set('userId', getDevUserId());
    socket = new WebSocket(endpoint.toString());
  } catch {
    // Invalid URL/security/constructor failures need intervention, not a hot loop.
    useUIStore.getState().setConnectionStatus('disconnected');
    setConnectionError('无法建立实时连接，请检查服务地址后刷新页面');
    return;
  }
  const context: ConnectionContext = { owner: candidate, socket, closed: false, openedAt: null,
    lastMessageAt: Date.now(), connectionTimer: null, reconnectTimer: null, heartbeatTimer: null,
    errorTimer: null, gapFills: new Map(), gapFillChanges: new Map(), abort: new AbortController() };
  connection = context;
  context.connectionTimer = setTimeout(() => {
    if (isCurrent(context) && socket.readyState === WebSocket.CONNECTING) failConnection(context, 'Connection timeout');
  }, CONNECTION_TIMEOUT);

  socket.onopen = () => {
    if (!isCurrent(context) || socket.readyState !== WebSocket.OPEN || context.openedAt !== null) return;
    if (context.connectionTimer !== null) clearTimeout(context.connectionTimer);
    context.connectionTimer = null;
    context.lastMessageAt = Date.now();
    context.openedAt = Date.now();
    useUIStore.getState().setConnectionStatus('connected');
    setConnectionError(null);
    context.heartbeatTimer = setInterval(() => {
      if (!isCurrent(context)) return;
      if (socket.readyState !== WebSocket.OPEN || Date.now() - context.lastMessageAt > HEARTBEAT_TIMEOUT) {
        failConnection(context, 'Heartbeat timeout');
      }
    }, HEARTBEAT_INTERVAL);
    currentGroupId = pendingGroupId || currentGroupId;
    pendingGroupId = null;
    subscribedGroupIds.clear();
    subscribeAllGroups();
    if (currentGroupId) joinGroup(currentGroupId);
    for (const group of useGroupsStore.getState().groups) void fetchMissedMessages(context, group.id);
    void syncDataAfterReconnect(context);
    void recoverInterruptedStreams(context);
  };
  socket.onmessage = event => {
    if (!isOpen(context)) return;
    try {
      const message = JSON.parse(event.data);
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      context.lastMessageAt = Date.now();
      if (message.type === 'ping') { send(context, { type: 'pong' }); return; }
      if (message.type === 'pong') return;
      handleWebSocketMessage(message, context);
    } catch {
      // JSON parser errors may embed message bodies. Never log their raw text.
      if (import.meta.env.DEV) console.warn('[WS] Invalid incoming event');
    }
  };
  socket.onclose = event => finishConnection(context, event.code);
  socket.onerror = () => {
    if (!isCurrent(context)) return;
    setConnectionError('WebSocket 连接出错，正在尝试重连...');
    // The browser emits close after error; connecting/open timeouts cover silent failures.
  };
}

export function connectWebSocket(groupId?: string) {
  if (owner && !isOwnerCurrent(owner)) disconnectWebSocket();
  if (!owner) {
    const userId = currentUserId();
    if (!userId) return;
    owner = { userId, authGeneration: getAuthGeneration() };
    loadPersistedTimestamps(owner);
  }
  setupMobileEventListeners();
  if (groupId) { currentGroupId = groupId; pendingGroupId = groupId; }
  if (connection && isCurrent(connection)) {
    if (connection.socket.readyState === WebSocket.OPEN) {
      if (groupId) joinGroup(groupId);
      return;
    }
    if (connection.socket.readyState === WebSocket.CONNECTING) return;
  }
  // An explicit connect (e.g. a user retry) may start a fresh bounded attempt cycle.
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) reconnectAttempts = 0;
  openConnection(owner);
}

function handleWebSocketMessage(message: WSIncomingMessage, context: ConnectionContext, trackGapChanges = true) {
  if (!isOpen(context)) return;
  const liveChanges = trackGapChanges ? context.gapFillChanges.get(message.group_id) : undefined;
  if (liveChanges) {
    const existingMessages = useMessagesStore.getState().messages[message.group_id] || [];
    if (message.id) liveChanges.touched.add(message.id);
    if (message.type === 'new_message' && message.sender_type === 'user' && message.client_message_id) {
      liveChanges.confirmedClientIds.add(message.client_message_id);
    }
    if (message.message_id) {
      liveChanges.touched.add(message.message_id);
      if (!existingMessages.some(item => item.id === message.message_id)) liveChanges.pendingEvents.push(message);
    }
    if (message.type === 'message_deleted' && message.message_id) liveChanges.deleted.add(message.message_id);
    if (message.type === 'messages_batch_deleted') {
      for (const id of message.message_ids || []) liveChanges.deleted.add(id);
    }
    if (message.type === 'messages_all_deleted') liveChanges.cleared = true;
    if (message.type === 'generation_stopped') {
      for (const item of existingMessages) if (item.is_streaming) liveChanges.touched.add(item.id);
    }
  }
  const messagesStore = useMessagesStore.getState();
  const uiStore = useUIStore.getState();
  const groupsStore = useGroupsStore.getState();

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

          recordMessageTimestamp(context, message.group_id, messageTimestamp);

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
          const messagesStore = useMessagesStore.getState();
          const streamMsgs = messagesStore.messages[message.group_id] || [];
          const existingMsg = streamMsgs.find(m => m.id === message.message_id);

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
            showTransientError(context, '自动聊天出错，请检查连接后重试');
          }
        }
        break;

      case 'persona_updated':
        if (message.aiId && message.persona) {
          const personasStore = usePersonasStore.getState();
          personasStore.handlePersonaUpdate(message.aiId, message.persona as PersonaConfig);
        }
        break;

      case 'personas_sync':
        if (message.all_personas) {
          const dedupedPersonas: Record<string, PersonaConfig> = {};
          for (const [aiId, persona] of Object.entries(message.all_personas)) {
            dedupedPersonas[aiId] = persona as PersonaConfig;
          }
          usePersonasStore.setState({ personas: dedupedPersonas });
        }
        break;

      case 'batch':
        if (message.messages && Array.isArray(message.messages)) {
          for (const subMessage of message.messages) {
            if (subMessage && subMessage.type) {
              handleWebSocketMessage(subMessage, context);
            }
          }
        }
        break;

      case 'error':
        {
          showTransientError(context, '实时消息处理失败，请稍后重试');
        }
        break;
    }
  } catch {
    showTransientError(context, '实时消息处理失败，请稍后重试');
  }
}

function send(context: ConnectionContext, message: Record<string, unknown>): boolean {
  if (!isOpen(context)) return false;
  try { context.socket.send(JSON.stringify(message)); return true; }
  catch { failConnection(context, 'Send failed'); return false; }
}

export function joinGroup(groupId: string) {
  if (!owner || !isOwnerCurrent(owner) || !groupId) return;
  currentGroupId = groupId;
  pendingGroupId = groupId;
  const context = connection;
  if (!context || !isOpen(context)) return;
  pendingGroupId = null;
  if (!subscribedGroupIds.has(groupId) && send(context, { type: 'join_group', group_id: groupId })) {
    subscribedGroupIds.add(groupId);
  }
  void fetchMissedMessages(context, groupId);
}

export function leaveGroup(groupId: string) {
  if (!owner || !isOwnerCurrent(owner)) return;
  subscribedGroupIds.delete(groupId);
  if (currentGroupId === groupId) currentGroupId = null;
  if (pendingGroupId === groupId) pendingGroupId = null;
  if (connection) send(connection, { type: 'leave_group', group_id: groupId });
}

export function sendTypingStatus(groupId: string, aiId: string, status: boolean) {
  if (connection) send(connection, { type: 'typing', group_id: groupId, ai: aiId, status });
}

export function stopGeneration(groupId: string) {
  if (connection) send(connection, { type: 'stop_generation', group_id: groupId });
}

export function subscribeAllGroups() {
  const context = connection;
  if (!context || !isOpen(context)) return;
  for (const group of useGroupsStore.getState().groups) {
    if (!subscribedGroupIds.has(group.id) && send(context, { type: 'join_group', group_id: group.id })) {
      subscribedGroupIds.add(group.id);
    }
  }
}

export function disconnectWebSocket() {
  // Clear intent first. Online/visibility events can never revive a logged-out session.
  owner = null;
  const previous = connection;
  connection = null;
  if (previous) retireConnection(previous);
  reconnectAttempts = 0;
  currentGroupId = null;
  pendingGroupId = null;
  subscribedGroupIds.clear();
  lastMessageTimestamp = {};
  wasHidden = false;
  hiddenAt = 0;
  cleanupMobileEventListeners();
  setConnectionError(null);
  useUIStore.getState().setConnectionStatus('disconnected');
}

export function getConnectionError(): string | null { return connectionError; }

async function recoverInterruptedStreams(context: ConnectionContext) {
  if (!isOpen(context)) return;
  const snapshot = useMessagesStore.getState().messages;
  for (const [groupId, messages] of Object.entries(snapshot)) {
    for (const message of messages) {
      if (!isOpen(context)) return;
      if (!message.is_streaming || Date.now() - Date.parse(message.created_at) <= 10000) continue;
      try {
        const serverMessage = await readForConnection<{ is_streaming?: boolean; content?: string } | null>(context, `/messages/${message.id}`);
        if (!isOpen(context)) return;
        // A deletion/edit/new stream event supersedes this individual recovery read.
        const current = useMessagesStore.getState().messages[groupId]?.find(item => item.id === message.id);
        if (current !== message || !current.is_streaming) continue;
        if (serverMessage && !serverMessage.is_streaming) {
          useMessagesStore.getState().finalizeStreamMessage(groupId, message.id, serverMessage.content || message.content || '[消息内容不可用]');
        }
      } catch {
        if (isOpen(context)) showTransientError(context, '中断消息暂时无法核验，已保留收到的内容');
      }
    }
  }
}

function resumeConnection() {
  if (!owner || !isOwnerCurrent(owner)) return;
  const context = connection;
  if (context && isOpen(context)) {
    if (currentGroupId) void fetchMissedMessages(context, currentGroupId);
    send(context, { type: 'ping' });
    return;
  }
  // Preserve backoff and its cap; browser events are not permission to reconnect forever.
  if (context && context.reconnectTimer !== null) return;
  if (context && isCurrent(context) && context.socket.readyState === WebSocket.CONNECTING) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
  if (context && !context.closed) { failConnection(context, 'Connection unavailable'); return; }
  openConnection(owner);
}

function handleVisibilityChange() {
  if (!owner || !isOwnerCurrent(owner)) return;
  if (document.visibilityState === 'hidden') { wasHidden = true; hiddenAt = Date.now(); return; }
  if (document.visibilityState === 'visible' && wasHidden) {
    wasHidden = false;
    if (Date.now() - hiddenAt >= 5000) resumeConnection();
  }
}

function handleOnline() { resumeConnection(); }

function setupMobileEventListeners() {
  if (mobileListenersSetup) return;
  mobileListenersSetup = true;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', handleOnline);
}

function cleanupMobileEventListeners() {
  if (!mobileListenersSetup) return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('online', handleOnline);
  mobileListenersSetup = false;
}

export function destroyWebSocket() { disconnectWebSocket(); }
