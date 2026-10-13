import { messageIdentityKeys } from '../utils/messageArrival';
import { createOrderedMessageRecovery, orderedReadEnvironmentReady } from '../services/orderedMessageRecovery';
import { compareSequence, protocolError, retryAfterMilliseconds, sortOrderedMessages, validOrderedMessage, validateOrderedMessagesPage } from '../services/orderedMessageProtocol';
import type { OrderedMessagesResponse, OrderedMessagesQuery } from '../../../shared/contracts';
import { getLocalCacheGeneration } from '../utils/localCacheLifecycle';
import { create } from 'zustand';
import { api, getAuthGeneration } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import { saveMessagesWithDurability, loadMessagesFromIndexedDB, deleteMessageFromIndexedDB, clearAllMessagesFromIndexedDB, clearOldMessagesFromIndexedDB } from '../utils/indexedDB';
import { useGroupsStore } from './groupsStore';
import { useAudioStore } from './audioStore';
import type { Comment, MessageAttachment, Message } from '../types';

interface SessionOwner { userId: string | null; generation: number; epoch: number }
let storeEpoch = 0;
let activeOwner: SessionOwner | undefined;
const sendingGroups = new Map<string, object>();
const pendingMessages = new Map<string, { tempId: string, groupId: string }>();

function sendFailure(error: unknown): { message: string; terminal: boolean } {
  const status = (error as { status?: number } | null)?.status;
  if (status === 410) return { message: '原消息已删除，不能重试这次发送。内容仍保留，请复制后作为新消息发送。', terminal: true };
  if (status === 409) return { message: '发送标识与已有消息冲突，不能重试这次发送。内容仍保留，请复制后作为新消息发送。', terminal: true };
  return { message: error instanceof Error ? error.message : String(error), terminal: false };
}

function reconcileDeliveredMessage(groupId: string, messages: Message[], tempId: string, delivered: Message): Message[] {
  delivered = { ...delivered, confirmation: validOrderedMessage(delivered, groupId) ? 'confirmed' : 'preview', preview_reason: validOrderedMessage(delivered, groupId) ? undefined : 'unverified' };
  let matched = false;
  const next: Message[] = [];
  for (const current of messages) {
    if (current.tempId === tempId || current.id === delivered.id) {
      if (!matched) {
        // A WebSocket confirmation may already have received a newer edit.
        next.push(current.id === delivered.id && current.status === 'sent'
          ? { ...delivered, ...current, tempId, status: 'sent' }
          : { ...current, ...delivered, tempId, status: 'sent' });
        matched = true;
      }
    } else {
      next.push(current);
    }
  }
  // A late receipt must not resurrect an optimistic row removed while sending.
  if (!matched && !deletedMessageIds.get(groupId)?.has(tempId) && !deletedMessageIds.get(groupId)?.has(delivered.id)) next.push({ ...delivered, tempId, status: 'sent' });
  return next;
}

interface PaginationState {
  hasMore: boolean;
  loadingMore: boolean;
  oldestMessageId: string | null;
  oldestMessageCreatedAt?: string | null;
}

export interface OrderedMessageState {
  generation: string | null;
  beforeCursor: string | null;
  afterCursor: string | null;
  consumedThrough: string | null;
  highWatermark: string | null;
  liveMax: string | null;
}
export interface MessageRecoveryState {
  phase: 'idle' | 'bootstrap' | 'ready' | 'catching_up' | 'backoff' | 'paused' | 'resync_required' | 'auth_required';
  reason?: string;
  error?: string;
  nextAllowedAt: number;
  bootstrapComplete: boolean;
  pending: boolean;
  failures: number;
  verificationAttempt?: number;
  verifiedAttempt?: number;
}
interface MessageView { groupId: string; lease: string; owner: SessionOwner }
let activeMessageView: MessageView | undefined;
let terminatedOwner: SessionOwner | undefined;
let leaseCounter = 0;
let readAbort: AbortController | undefined;
let readBusy: object | undefined;
let verificationAttemptCounter = 0;
const pendingReadEvents = new Map<string, { lease: string; events: (() => void)[] }>();
const blankOrder = (): OrderedMessageState => ({ generation: null, beforeCursor: null, afterCursor: null, consumedThrough: null, highWatermark: null, liveMax: null });
const blankRecovery = (): MessageRecoveryState => ({ phase: 'idle', nextAllowedAt: 0, bootstrapComplete: false, pending: false, failures: 0 });

export type LoadMoreMessagesResult = 'loaded' | 'busy' | 'blocked' | 'stale' | 'exhausted';

interface MessagesState {
  // Ephemeral activity for one actual view, bounded by its current rows. Never cached.
  messageActivity: { groupId: string; lease: string; ids: string[] } | null;
  readVersion: number;
  ordered: Record<string, OrderedMessageState>;
  recovery: Record<string, MessageRecoveryState>;
  durability: Record<string, { durable: boolean; reason?: string }>;
  activateMessageView: (groupId: string) => string;
  deactivateMessageView: (lease: string) => void;
  resumeOrderedMessages: (groupId: string) => Promise<void>;
  wakeOrderedMessages: () => Promise<void>;
  ingestOrderedMessage: (groupId: string, message: Message, durable: boolean) => void;
  bufferOrderedEvent: (groupId: string, replay: () => void) => void;
  messages: Record<string, Message[]>;
  streamUpdateCounter: number;
  pagination: Record<string, PaginationState>;
  loading: boolean;
  sending: Record<string, boolean>;
  error: string | null;
  fetchMessages: (groupId: string) => Promise<void>;
  loadMoreMessages: (groupId: string) => Promise<LoadMoreMessagesResult>;
  sendMessage: (groupId: string, content: string, replyTo?: string | string[], attachments?: MessageAttachment[]) => Promise<{ success: boolean; tempId: string; error?: string }>;
  retryMessage: (groupId: string, tempId: string) => Promise<{ success: boolean; error?: string }>;
  removeFailedMessage: (groupId: string, tempId: string) => void;
  confirmClientMessage: (groupId: string, tempId: string) => void;
  deleteMessage: (messageId: string, groupId: string) => Promise<void>;
  editMessage: (messageId: string, groupId: string, content: string) => Promise<void>;
  batchDeleteMessages: (messageIds: string[], groupId: string) => Promise<void>;
  clearAllMessages: (groupId: string) => Promise<void>;
  addMessage: (groupId: string, message: Message) => void;
  likeMessage: (messageId: string, groupId: string, userId?: string) => void;
  unlikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  dislikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  undislikeMessage: (messageId: string, groupId: string, userId?: string) => void;
  applyLikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  applyUnlikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  applyDislikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  applyUndislikeUpdate: (messageId: string, groupId: string, userId?: string) => void;
  addComment: (messageId: string, groupId: string, content: string, senderType: 'user' | 'ai', senderId?: string, parentId?: string, replyTo?: string) => Promise<void>;
  addCommentFromRemote: (messageId: string, groupId: string, comment: Comment) => void;
  updateMessage: (messageId: string, groupId: string, updates: Partial<Message>) => void;
  removeMessages: (groupId: string, messageIds: string[]) => void;
  clearMessages: (groupId: string) => void;
  addStreamMessage: (groupId: string, messageId: string, senderId: string) => void;
  updateStreamMessage: (groupId: string, messageId: string, content: string, isDone: boolean) => void;
  finalizeStreamMessage: (groupId: string, messageId: string, content: string, replyTo?: string | string[], replyToIds?: string[]) => void;
}

interface PendingSave { owner: SessionOwner; messages: Message[]; cacheGeneration: number; preserveHistory: boolean }
const persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const pendingSaveMessages: Record<string, PendingSave> = {};
const cacheQueues = new Map<string, Promise<void>>();
const groupEpochs = new Map<string, number>();
const editTokens = new Map<string, object>();
const messageChanges = new Map<string, Map<string, number>>();
const confirmedDocumentIds = new Map<string, Set<string>>();
const retiredClientIds = new Map<string, Set<string>>();
const unloadedEdits = new Map<string, Map<string, { revision: number; updates: Partial<Message> }>>();
const deletedMessageIds = new Map<string, Set<string>>();
let messageRevision = 0;
const MAX_CACHED_GROUPS = 15;
const MAX_COMMENT_DEPTH = 10;

const streamTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// 清理指定消息的流式超时定时器
function clearStreamTimeout(messageId: string) {
  const timer = streamTimeouts.get(messageId);
  if (timer) {
    clearTimeout(timer);
    streamTimeouts.delete(messageId);
  }
}

// 清理指定群组所有消息的流式超时定时器
function clearStreamTimeoutsForGroup(messages: Message[]) {
  for (const msg of messages) {
    if (msg.is_streaming) {
      clearStreamTimeout(msg.id);
    }
  }
}

function applyLikeState(messages: Message[], messageId: string, userId: string, liked: boolean): Message[] {
  return messages.map(message => {
    if (message.id !== messageId) {
      return message;
    }
    const likes = Array.isArray(message.likes) ? message.likes : (Array.isArray(message.liked_by) ? message.liked_by : []);
    const nextLikes = liked
      ? (likes.includes(userId) ? likes : [...likes, userId])
      : likes.filter(id => id !== userId);
    return {
      ...message,
      likes: nextLikes,
      liked_by: nextLikes,
      likes_count: nextLikes.length
    };
  });
}

function applyDislikeState(messages: Message[], messageId: string, userId: string, disliked: boolean): Message[] {
  return messages.map(message => {
    if (message.id !== messageId) {
      return message;
    }
    const dislikedBy = Array.isArray(message.disliked_by) ? message.disliked_by : [];
    const nextDislikedBy = disliked
      ? (dislikedBy.includes(userId) ? dislikedBy : [...dislikedBy, userId])
      : dislikedBy.filter(id => id !== userId);
    return {
      ...message,
      disliked_by: nextDislikedBy,
      dislikes: nextDislikedBy.length
    };
  });
}

function evictLeastRecentlyUsedMessages(state: MessagesState) {
  const groupIds = Object.keys(state.messages);
  if (groupIds.length <= MAX_CACHED_GROUPS) return;

  const groupsStore = useGroupsStore.getState();
  const currentGroupId = groupsStore.currentGroup?.id;

  const sortedByActivity = groupIds
    .filter(id => id !== currentGroupId && id !== activeMessageView?.groupId && !state.messages[id].some(message => message.status === 'failed' || message.status === 'sending'))
    .map(id => {
      const msgs = state.messages[id];
      const lastTime = msgs.length > 0
        ? new Date(msgs[msgs.length - 1].created_at).getTime()
        : 0;
      return { id, lastTime };
    })
    .sort((a, b) => a.lastTime - b.lastTime);

  const toEvict = sortedByActivity.slice(0, groupIds.length - MAX_CACHED_GROUPS);
  const evictIds = new Set(toEvict.map(e => e.id));

  const { messages: newMessages, pagination: newPagination } = Array.from(evictIds).reduce(
    (acc: { messages: Record<string, Message[]>; pagination: Record<string, PaginationState> }, id: string) => {
      const { [id]: _msg, ...restMessages } = acc.messages;
      const { [id]: _pag, ...restPagination } = acc.pagination;
      // Eviction retires sequence eligibility, never an outbox or disk history.
      invalidateGroup(id);
      confirmedDocumentIds.delete(id); unloadedEdits.delete(id);
      delete state.ordered?.[id];
      delete state.recovery?.[id];
      return { messages: restMessages, pagination: restPagination };
    },
    { messages: state.messages, pagination: state.pagination }
  );

  state.messages = newMessages;
  state.pagination = newPagination;
}

function isCurrent(owner: SessionOwner): boolean {
  return owner.epoch === storeEpoch && owner.userId === getCacheUserId() && owner.generation === getAuthGeneration();
}

function captureOwner(): SessionOwner {
  if (!activeOwner || !isCurrent(activeOwner)) {
    resetMessagesModuleState();
    activeOwner = { userId: getCacheUserId(), generation: getAuthGeneration(), epoch: storeEpoch };
  }
  return activeOwner;
}

function staleSend(tempId: string) {
  return { success: false, tempId, error: '账号或会话已切换，请在原账号核对发送结果' };
}

function groupIsCurrent(owner: SessionOwner, groupId: string, epoch: number): boolean {
  return isCurrent(owner) && (groupEpochs.get(groupId) || 0) === epoch;
}

// Serialize writes and targeted deletes. A pending old snapshot must finish before
// a newer edit/deletion, and every operation rechecks ownership before starting IO.
function queueCache(owner: SessionOwner, groupId: string, work: () => Promise<void>): Promise<void> {
  const cacheGeneration = getLocalCacheGeneration();
  const previous = cacheQueues.get(groupId) || Promise.resolve();
  const queued = previous.catch(() => {}).then(async () => {
    if (isCurrent(owner) && cacheGeneration === getLocalCacheGeneration()) await work();
  }).catch(() => { if (isCurrent(owner)) console.warn('消息缓存更新失败'); });
  cacheQueues.set(groupId, queued);
  void queued.finally(() => { if (cacheQueues.get(groupId) === queued) cacheQueues.delete(groupId); });
  return queued;
}

function flushMessages(groupId: string, pending = pendingSaveMessages[groupId]): Promise<void> {
  if (!pending || pending.cacheGeneration !== getLocalCacheGeneration()) return Promise.resolve();
  return queueCache(pending.owner, groupId, async () => {
    if (!isCurrent(pending.owner) || pending.cacheGeneration !== getLocalCacheGeneration()) return;
    const latest = pendingSaveMessages[groupId];
    if (!latest || latest.owner !== pending.owner || latest.cacheGeneration !== getLocalCacheGeneration()) return;
    const saved = await saveMessagesWithDurability(latest.messages);
    if (!isCurrent(pending.owner) || pending.cacheGeneration !== getLocalCacheGeneration() || pendingSaveMessages[groupId] !== latest) return;
    useMessagesStore.setState(state => ({ durability: { ...state.durability, [groupId]: saved } }));
    if (!saved.durable) return;
    // Failed writes retain their pending snapshot for the next mutation/flush.
    if (pendingSaveMessages[groupId] === latest) delete pendingSaveMessages[groupId];
    if (!latest.preserveHistory) await clearOldMessagesFromIndexedDB(groupId);
  });
}

function persistMessages(groupId: string, messages: Message[], owner = captureOwner(), preserveHistory = false) {
  if (!isCurrent(owner)) return;
  if (persistTimers[groupId]) clearTimeout(persistTimers[groupId]);
  const pending = { owner, messages: messages.filter(m => !m.is_streaming && m.preview_reason !== 'cached'), cacheGeneration: getLocalCacheGeneration(), preserveHistory };
  useMessagesStore.setState(state => ({ durability: { ...state.durability, [groupId]: { durable: false, reason: 'pending' } } }));
  pendingSaveMessages[groupId] = pending;
  const timer = setTimeout(() => {
    if (persistTimers[groupId] === timer) delete persistTimers[groupId];
    if (isCurrent(owner) && pending.cacheGeneration === getLocalCacheGeneration() && pendingSaveMessages[groupId] === pending) void flushMessages(groupId, pending);
  }, 2000);
  persistTimers[groupId] = timer;
}

function deleteCachedMessages(owner: SessionOwner, groupId: string, ids: string[]) {
  return queueCache(owner, groupId, async () => {
    for (const id of new Set(ids)) {
      if (!isCurrent(owner)) return;
      await deleteMessageFromIndexedDB(id);
    }
  });
}

function retireDeliveredIntents(owner: SessionOwner, groupId: string, ids: string[]) {
  const retired = retiredClientIds.get(groupId) || new Set<string>();
  const fresh = [...new Set(ids)].filter(id => !retired.has(id));
  for (const id of fresh) retired.add(id);
  retiredClientIds.set(groupId, retired);
  return fresh.length ? deleteCachedMessages(owner, groupId, fresh) : Promise.resolve();
}

function invalidateGroup(groupId: string) {
  groupEpochs.set(groupId, (groupEpochs.get(groupId) || 0) + 1);
  pendingReadEvents.delete(groupId);
  unloadedEdits.delete(groupId);
}

function recordChanges(groupId: string, previous: Message[], next: Message[]) {
  const before = new Map(previous.map(message => [message.id, message]));
  const after = new Map(next.map(message => [message.id, message]));
  const changes = messageChanges.get(groupId) || new Map<string, number>();
  const deleted = deletedMessageIds.get(groupId) || new Set<string>();
  for (const [id, message] of after) {
    if (before.get(id) !== message) changes.set(id, ++messageRevision);
    deleted.delete(id);
  }
  for (const id of before.keys()) if (!after.has(id)) {
    changes.set(id, ++messageRevision);
  }
  messageChanges.set(groupId, changes);
  deletedMessageIds.set(groupId, deleted);
}

function markDeleted(groupId: string, ids: string[]) {
  const deleted = deletedMessageIds.get(groupId) || new Set<string>();
  const changes = messageChanges.get(groupId) || new Map<string, number>();
  for (const id of ids) { deleted.add(id); changes.set(id, ++messageRevision); }
  deletedMessageIds.set(groupId, deleted);
  messageChanges.set(groupId, changes);
}

const clientIdOf = (message: Message) => (message as Message & { client_message_id?: string }).client_message_id;
const isDeliveredIntent = (message: Message, tempId: string) =>
  message.confirmation !== 'preview' && ((message.tempId === tempId && message.status === 'sent') ||
  (clientIdOf(message) === tempId && message.id !== tempId && message.status !== 'failed' && message.status !== 'sending'));

function mergeOrderedRead(groupId: string, incoming: Message[], current: Message[], revision: number, generation: string): Message[] {
  const changes = messageChanges.get(groupId);
  const deleted = deletedMessageIds.get(groupId);
  const byId = new Map(current.map(message => [message.id, message]));
  const confirmedClients = new Set(incoming.map(clientIdOf).filter(Boolean));
  const merged = new Map<string, Message>();
  const sequenceIds = new Map<string, string>();
  for (const message of [...current.filter(row => row.confirmation === 'confirmed' && row.server_order?.generation === generation), ...incoming]) {
    const seq = message.server_order!.sequence;
    if (sequenceIds.has(seq) && sequenceIds.get(seq) !== message.id) throw protocolError();
    const existing = byId.get(message.id);
    if (existing?.confirmation === 'confirmed' && existing.server_order?.generation === generation && existing.server_order.sequence !== seq) throw protocolError();
    sequenceIds.set(seq, message.id);
  }
  for (const message of incoming) {
    const clientId = clientIdOf(message);
    if (deleted?.has(message.id) || (clientId && deleted?.has(clientId))) continue;
    const live = byId.get(message.id);
    const local = clientId ? current.find(row => row.tempId === clientId) : undefined;
    const liveEditTime = Date.parse(live?.edited_at || '');
    const pageEditTime = Date.parse(message.edited_at || '');
    const pageHasNewerEdit = Number.isFinite(pageEditTime) && (!Number.isFinite(liveEditTime) || pageEditTime > liveEditTime);
    const keepLive = live?.confirmation === 'confirmed' && ((changes?.get(message.id) || 0) > revision || Date.parse(live.edited_at || '') > Date.parse(message.edited_at || ''));
    const overlay = unloadedEdits.get(groupId)?.get(message.id);
    const overlayTime = Date.parse(overlay?.updates.edited_at || '');
    const remoteTime = Date.parse(message.edited_at || '');
    const applyOverlay = overlay && overlay.revision > revision && !(Number.isFinite(remoteTime) && (!Number.isFinite(overlayTime) || remoteTime > overlayTime));
    merged.set(message.id, { ...message, ...(keepLive ? live : {}),
      ...(pageHasNewerEdit ? { content: message.content, content_type: message.content_type, edited_at: message.edited_at, is_edited: message.is_edited,
        metadata: message.metadata, attachments: message.attachments, audio_urls: message.audio_urls, ttsAudio: message.ttsAudio,
        reply_to: message.reply_to, reply_to_ids: message.reply_to_ids, reply_to_message: message.reply_to_message, reply_to_messages: message.reply_to_messages } : {}), server_order: message.server_order, confirmation: 'confirmed', preview_reason: undefined,
      ...(applyOverlay ? overlay.updates : {}), is_streaming: false, ...(local ? { tempId: local.tempId, status: 'sent' as const } : {}) });
  }
  for (const message of current) {
    if (message.tempId && confirmedClients.has(message.tempId) && (message.id === message.tempId || message.status === 'failed' || message.status === 'sending')) continue;
    if (deleted?.has(message.id) || merged.has(message.id)) continue;
    const liveConfirmed = message.confirmation === 'confirmed' && message.server_order?.generation === generation && confirmedDocumentIds.get(groupId)?.has(message.id);
    if (message.status === 'failed' || message.status === 'sending' || message.confirmation === 'preview' || message.is_streaming ||
      liveConfirmed) merged.set(message.id, message);
  }
  return sortOrderedMessages([...merged.values()]);
}

export function recoverCachedMessage(message: Message): Message {
  return message.status === 'sending'
    ? { ...message, status: 'failed', metadata: { ...message.metadata, send_unknown: true, send_error: '上次发送的结果尚未确认，可用原标识重试核对；不会自动重发' } }
    : message;
}

let orderedRecoveryRun: () => Promise<void>;

type StateUpdate = Partial<MessagesState> | ((state: MessagesState) => Partial<MessagesState> | MessagesState);
export const useMessagesStore = create<MessagesState>((rawSet, get) => {
  let applyingRead = false;
  let historyOnly = false;
  // All same-session updates, including edits, reactions and stream completion,
  // supersede delayed cache snapshots instead of leaving an older save behind.
  const set = (update: StateUpdate, source: 'activity' | 'history' = historyOnly ? 'history' : 'activity') => {
    const owner = captureOwner();
    rawSet(state => {
      const patch = typeof update === 'function' ? update(state) : update;
      if (patch.messages && patch.messages !== state.messages) {
        for (const [groupId, next] of Object.entries(patch.messages)) if (next !== state.messages[groupId]) {
          const sorted = sortOrderedMessages(next);
          patch.messages[groupId] = sorted;
          const view = activeMessageView;
          if (view?.groupId === groupId && isCurrent(view.owner)) {
            const oldActivity = state.messageActivity?.lease === view.lease ? new Set(state.messageActivity.ids) : new Set<string>();
            const previous = state.messages[groupId] || [];
            const known = new Set(previous.flatMap(messageIdentityKeys));
            const activityIdentities = new Set(previous.filter(message => oldActivity.has(message.id)).flatMap(messageIdentityKeys));
            patch.messageActivity = { groupId, lease: view.lease, ids: sorted.filter(message =>
              oldActivity.has(message.id) ||
              (message.confirmation === 'confirmed' && messageIdentityKeys(message).some(id => activityIdentities.has(id))) ||
              (source === 'activity' && !messageIdentityKeys(message).some(id => known.has(id)))
            ).map(message => message.id) };
          }
          recordChanges(groupId, state.messages[groupId] || [], sorted);
          persistMessages(groupId, sorted, owner, applyingRead);
        }
      }
      return patch;
    });
  };
  const recoveryPatch = (groupId: string, patch: Partial<MessageRecoveryState>) => set(state => ({ recovery: { ...state.recovery, [groupId]: { ...(state.recovery[groupId] || blankRecovery()), ...patch } } }));
  const viewCurrent = (view: MessageView, epoch: number, generation: string | null) => activeMessageView === view && groupIsCurrent(view.owner, view.groupId, epoch) &&
    (get().ordered[view.groupId]?.generation ?? null) === generation;
  const resetBaseline = (groupId: string, phase: MessageRecoveryState['phase'] = 'idle', reason?: string) => {
    invalidateGroup(groupId);
    confirmedDocumentIds.delete(groupId); unloadedEdits.delete(groupId);
    set(state => ({
      ordered: { ...state.ordered, [groupId]: blankOrder() },
      recovery: { ...state.recovery, [groupId]: { ...(state.recovery[groupId] || blankRecovery()), phase, reason, bootstrapComplete: false, pending: false } },
      messages: { ...state.messages, [groupId]: (state.messages[groupId] || []).filter(m => m.status === 'sending' || m.status === 'failed' || m.confirmation === 'preview' || m.is_streaming) },
      pagination: { ...state.pagination, [groupId]: { hasMore: false, loadingMore: false, oldestMessageId: null } }, loading: false,
    }));
  };
  const failedRead = (groupId: string, error: unknown) => {
    const e = error as { status?: number; code?: string; message?: string; retryAfter?: unknown; response?: {status?: number; headers?: Record<string,string>} };
    const status = e.status ?? e.response?.status;
    const old = get().recovery[groupId] || blankRecovery();
    if (status === 401 || e.code === 'ACCOUNT_CHANGED' || e.code === 'STALE_ACCOUNT_RESPONSE') {
      terminatedOwner = activeMessageView?.owner;
      recoveryPatch(groupId, { phase: 'auth_required', reason: e.code || 'UNAUTHENTICATED', error: '登录状态已变化，请重新登录后读取', pending: false });
      readAbort?.abort(); return;
    }
    if (status === 409 && e.code === 'CURSOR_RESET_REQUIRED') {
      resetBaseline(groupId, 'idle', 'CURSOR_RESET_REQUIRED');
      recoveryPatch(groupId, { nextAllowedAt: Math.max(old.nextAllowedAt, Date.now() + 30000) }); return;
    }
    const paused = status === 428 || e.code === 'MESSAGE_ORDER_UNAVAILABLE' || e.code === 'INVALID_MESSAGE_ORDER_SCHEMA' || e.code === 'INVALID_MESSAGE_CURSOR';
    const failures = old.failures + 1;
    const backoff = Math.min(30000 * 2 ** Math.min(failures - 1, 4), 300000);
    const retryAfter = status === 429 ? retryAfterMilliseconds(e.retryAfter ?? e.response?.headers?.['retry-after'], Date.now()) : undefined;
    const errorMessage = e.message || '消息读取失败，已保留未发送内容';
    recoveryPatch(groupId, { phase: paused ? 'paused' : 'backoff', reason: e.code || String(status || 'NETWORK_ERROR'), error: errorMessage,
      failures, pending: false, nextAllowedAt: Math.max(old.nextAllowedAt, Date.now() + backoff, Date.now() + (retryAfter || 0)) });
    set({ error: errorMessage, loading: false });
  };
  const applyPage = (groupId: string, page: OrderedMessagesResponse, revision: number, mode: 'bootstrap' | 'before' | 'after') => {
    const previous = get().messages[groupId] || [];
    const merged = mergeOrderedRead(groupId, page.messages, previous, revision, page.generation);
    const changedAudioIds = page.messages.filter(message => {
      const edited = Date.parse(message.edited_at || '');
      const existing = previous.find(row => row.id === message.id);
      const previousEdit = Date.parse(existing?.edited_at || '');
      const newerRevision = Number.isFinite(edited) && (!Number.isFinite(previousEdit) || edited > previousEdit);
      const sameBodyAudio = existing && existing.content === message.content &&
        JSON.stringify(existing.metadata?.tts) === JSON.stringify(message.metadata?.tts) &&
        JSON.stringify(existing.ttsAudio) === JSON.stringify(message.ttsAudio) &&
        JSON.stringify(existing.audio_urls) === JSON.stringify(message.audio_urls);
      return newerRevision && !sameBodyAudio;
    }).map(message => message.id);
    const old = get().ordered[groupId] || blankOrder();
    const next: OrderedMessageState = mode === 'before' ? { ...old, beforeCursor: page.before_cursor } : {
      ...old, generation: page.generation, afterCursor: page.after_cursor, consumedThrough: page.consumed_through, highWatermark: page.high_watermark,
      ...(mode === 'bootstrap' ? { beforeCursor: page.before_cursor } : {}),
    };
    const verified = confirmedDocumentIds.get(groupId) || new Set<string>();
    for (const m of merged) if (m.confirmation === 'confirmed') verified.add(m.id);
    confirmedDocumentIds.set(groupId, verified);
    applyingRead = true; historyOnly = mode !== 'after';
    try { set(state => {
      const newState = { messages: { ...state.messages, [groupId]: merged }, ordered: { ...state.ordered, [groupId]: next }, recovery: { ...state.recovery },
        pagination: { ...state.pagination, ...(mode !== 'after' ? { [groupId]: { hasMore: page.hasMore, loadingMore: false, oldestMessageId: page.messages[0]?.id || state.pagination[groupId]?.oldestMessageId || null } } : {}) }, loading: false };
      evictLeastRecentlyUsedMessages(newState as MessagesState); return newState;
    }); } finally { applyingRead = false; historyOnly = false; }
    for (const id of changedAudioIds) useAudioStore.getState().removeTTSAudio(id);
    // Only explicit receipt correlation is deleted. Omitted legacy history stays on disk.
    const confirmed = page.messages.map(clientIdOf).filter((id): id is string => !!id);
    if (activeMessageView) void retireDeliveredIntents(activeMessageView.owner, groupId, confirmed);
  };
  const replayReadEvents = (groupId: string, view: MessageView, current: () => boolean) => {
    const buffered = pendingReadEvents.get(groupId);
    if (!buffered || buffered.lease !== view.lease) return false;
    pendingReadEvents.delete(groupId);
    unloadedEdits.delete(groupId);
    for (const replay of buffered.events) { if (!current()) return false; replay(); }
    return current();
  };
  const runRound = async () => {
    const view = activeMessageView;
    if (!view || !isCurrent(view.owner) || !orderedReadEnvironmentReady() || readBusy) return;
    const groupId = view.groupId;
    const epoch = groupEpochs.get(groupId) || 0;
    let generation = get().ordered[groupId]?.generation ?? null;
    const current = () => viewCurrent(view, epoch, generation) && orderedReadEnvironmentReady();
    const token = {}; readBusy = token; const abort = new AbortController(); readAbort = abort;
    const bootstrapping = !get().recovery[groupId]?.bootstrapComplete;
    // A PAGE_BUDGET/backoff continuation still consumes the old fixed-H
    // snapshot. It must retain that snapshot's start identity across rounds.
    const frontier = get().ordered[groupId];
    const continuesSnapshot = !bootstrapping && frontier?.consumedThrough && frontier.highWatermark &&
      compareSequence(frontier.consumedThrough, frontier.highWatermark) < 0;
    const verificationAttempt = continuesSnapshot && get().recovery[groupId]?.verificationAttempt
      ? get().recovery[groupId].verificationAttempt! : ++verificationAttemptCounter;
    recoveryPatch(groupId, { verificationAttempt, phase: bootstrapping ? 'bootstrap' : 'catching_up', pending: true, error: undefined, nextAllowedAt: Date.now() + 30000 });
    if (bootstrapping) pendingReadEvents.set(groupId, { lease: view.lease, events: [] });
    try {
      if (bootstrapping) {
        set({ loading: true, error: null });
        const cached = await loadMessagesFromIndexedDB(groupId);
        if (!current()) return;
        const unconfirmed = cached.filter(m => m.status === 'sending' || m.status === 'failed' || m.confirmation === 'preview').map(recoverCachedMessage);
        if (unconfirmed.length) {
          // Preview correlation is not a receipt: it cannot hide a recoverable
          // original UUID, reply or attachment intent from the encrypted cache.
          const present = new Set((get().messages[groupId] || []).flatMap(m => [m.id,
            ...(m.confirmation === 'confirmed' && validOrderedMessage(m, groupId) ? [m.tempId, clientIdOf(m)] :
              m.confirmation !== 'preview' && (m.status === 'sending' || m.status === 'failed') ? [m.tempId] : [])
          ].filter(Boolean)));
          const restored = unconfirmed.filter(m => !present.has(m.id) && !(m.tempId && present.has(m.tempId)) && !deletedMessageIds.get(groupId)?.has(m.id));
          if (restored.length) {
            historyOnly = true;
            try { set(state => ({ messages: { ...state.messages, [groupId]: [...(state.messages[groupId] || []), ...restored] } })); }
            finally { historyOnly = false; }
          }
        }
        if (!current()) return;
        const revision = messageRevision;
        const page = validateOrderedMessagesPage(await api.getOrderedMessages(groupId, { limit: 50 }, abort.signal), { owner: view.owner.userId!, group: groupId, limit: 50 });
        if (!current()) return;
        const buffered = pendingReadEvents.get(groupId);
        if (!buffered || buffered.lease !== view.lease) return;
        const liveGenerations = new Set((get().messages[groupId] || []).filter(m => m.confirmation === 'confirmed').map(m => m.server_order?.generation));
        if ([...liveGenerations].some(value => value !== page.generation)) throw protocolError();
        applyPage(groupId, page, revision, 'bootstrap'); generation = page.generation;
        if (!replayReadEvents(groupId, view, current)) return;
        recoveryPatch(groupId, { verifiedAttempt: verificationAttempt, phase: 'ready', bootstrapComplete: true, pending: false, failures: 0, reason: undefined, error: undefined, nextAllowedAt: Date.now() + 30000 });
      } else {
        for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
          if (!current()) return;
          const after = get().ordered[groupId]?.afterCursor;
          if (!after) throw protocolError();
          const query: OrderedMessagesQuery = { limit: 100, after_cursor: after };
          const revision = messageRevision;
          unloadedEdits.delete(groupId);
          pendingReadEvents.set(groupId, { lease: view.lease, events: [] });
          const page = validateOrderedMessagesPage(await api.getOrderedMessages(groupId, query, abort.signal), { owner: view.owner.userId!, group: groupId, ...query });
          if (!current()) return;
          applyPage(groupId, page, revision, 'after');
          if (!replayReadEvents(groupId, view, current)) return;
          if (!page.hasMore) {
            recoveryPatch(groupId, { verifiedAttempt: verificationAttempt, phase: 'ready', pending: false, failures: 0, reason: undefined, error: undefined, nextAllowedAt: Date.now() + 30000 }); return;
          }
        }
        recoveryPatch(groupId, { phase: 'catching_up', pending: true, failures: 0, reason: 'PAGE_BUDGET', nextAllowedAt: Date.now() + 30000 });
      }
    } catch (error) { if (current()) failedRead(groupId, error); }
    finally {
      const released = readBusy === token;
      if (released) readBusy = undefined;
      if (readAbort === abort) readAbort = undefined;
      if (pendingReadEvents.get(groupId)?.lease === view.lease) { pendingReadEvents.delete(groupId); unloadedEdits.delete(groupId); }
      if (viewCurrent(view, epoch, generation) && get().loading) set({ loading: false });
      if (released) set(state => ({ readVersion: state.readVersion + 1 }));
    }
  };
  orderedRecoveryRun = runRound;
  return {
  messageActivity: null,
  readVersion: 0,
  ordered: {},
  recovery: {},
  durability: {},
  messages: {},
  streamUpdateCounter: 0,
  pagination: {},
  loading: false,
  sending: {},
  error: null,

  activateMessageView: (groupId: string) => {
    const owner = captureOwner();
    if (activeMessageView) { invalidateGroup(activeMessageView.groupId); readAbort?.abort(); }
    const lease = `message-view-${++leaseCounter}`;
    activeMessageView = { groupId, lease, owner };
    if (terminatedOwner && isCurrent(terminatedOwner)) {
      recoveryPatch(groupId, { phase: 'auth_required', reason: 'UNAUTHENTICATED', error: '登录状态已变化，请重新登录后读取' });
    }
    invalidateGroup(groupId);
    set(state => ({ messageActivity: { groupId, lease, ids: [] }, ordered: { ...state.ordered, [groupId]: state.ordered[groupId] || blankOrder() },
      recovery: { ...state.recovery, [groupId]: { ...(state.recovery[groupId] || blankRecovery()), pending: false } },
      pagination: { ...state.pagination, ...(state.pagination[groupId] ? { [groupId]: { ...state.pagination[groupId], loadingMore: false } } : {}) } }));
    void orderedRecovery.start();
    return lease;
  },
  deactivateMessageView: (lease: string) => {
    if (activeMessageView?.lease !== lease) return;
    const groupId = activeMessageView.groupId;
    invalidateGroup(groupId); activeMessageView = undefined; readAbort?.abort(); orderedRecovery.stop();
    set(state => ({ messageActivity: null, loading: false, recovery: { ...state.recovery, [groupId]: { ...(state.recovery[groupId] || blankRecovery()), pending: false } },
      pagination: { ...state.pagination, ...(state.pagination[groupId] ? { [groupId]: { ...state.pagination[groupId], loadingMore: false } } : {}) } }));
  },
  wakeOrderedMessages: () => orderedRecovery.wake(),
  resumeOrderedMessages: async (groupId: string) => {
    if (!activeMessageView || activeMessageView.groupId !== groupId || !isCurrent(activeMessageView.owner)) return;
    if (get().recovery[groupId]?.phase === 'auth_required') return;
    readAbort?.abort(); resetBaseline(groupId);
    // Explicit user action can recover a paused schema; it cannot bypass a retry deadline.
    await orderedRecovery.wake();
  },
  bufferOrderedEvent: (groupId: string, replay: () => void) => {
    const buffer = pendingReadEvents.get(groupId);
    if (!buffer || buffer.lease !== activeMessageView?.lease) return;
    if (buffer.events.length >= 500) {
      readAbort?.abort(); resetBaseline(groupId, 'resync_required', 'EVENT_BUFFER_OVERFLOW');
      recoveryPatch(groupId, { error: '实时消息较多，请重新读取历史以核对完整性' });
      return;
    }
    buffer.events.push(replay);
  },
  ingestOrderedMessage: (groupId: string, message: Message, durable: boolean) => {
    captureOwner();
    if (!message.id || message.group_id !== groupId) return;
    if (!durable || !validOrderedMessage(message, groupId)) {
      const existing = get().messages[groupId]?.find(m => m.id === message.id);
      if (existing?.confirmation === 'confirmed') return;
      get().addMessage(groupId, { ...message, server_order: undefined, confirmation: 'preview', preview_reason: 'not_saved', is_streaming: false }); return;
    }
    const order = get().ordered[groupId];
    if (order?.generation && order.generation !== message.server_order!.generation) {
      readAbort?.abort(); resetBaseline(groupId, 'idle', 'SERVER_GENERATION_CHANGED'); void orderedRecovery.wake(); return;
    }
    const rows = get().messages[groupId] || [];
    if (rows.some(m => m.confirmation === 'confirmed' && m.server_order?.generation === message.server_order!.generation &&
      ((m.id === message.id && m.server_order.sequence !== message.server_order!.sequence) || (m.id !== message.id && m.server_order.sequence === message.server_order!.sequence)))) {
      readAbort?.abort(); resetBaseline(groupId, 'paused', 'INVALID_MESSAGE_ORDER_SCHEMA');
      recoveryPatch(groupId, { error: '消息顺序冲突，请重新读取历史', pending: false }); return;
    }
    const current = order || blankOrder();
    set(state => ({ ordered: { ...state.ordered, [groupId]: { ...current, liveMax: !current.liveMax || compareSequence(message.server_order!.sequence, current.liveMax) > 0 ? message.server_order!.sequence : current.liveMax } } }));
    const existing = rows.find(m => m.id === message.id && m.confirmation === 'confirmed');
    const edited = Date.parse(existing?.edited_at || '');
    const incomingEdit = Date.parse(message.edited_at || '');
    if (existing && Number.isFinite(edited) && (!Number.isFinite(incomingEdit) || incomingEdit < edited)) message = { ...message, ...existing };
    get().addMessage(groupId, { ...message, confirmation: 'confirmed', preview_reason: undefined, is_streaming: false });
  },
  fetchMessages: async (groupId: string) => {
    // Compatibility entry point, subject to the same actual-page lease and budget.
    if (activeMessageView?.groupId !== groupId) return;
    await orderedRecovery.wake();
  },
  loadMoreMessages: async (groupId: string) => {
    const view = activeMessageView;
    const order = get().ordered[groupId];
    const recovery = get().recovery[groupId];
    if (!view || view.groupId !== groupId || !isCurrent(view.owner)) return 'stale';
    if (!orderedReadEnvironmentReady() || !recovery?.bootstrapComplete ||
      ['paused', 'resync_required', 'auth_required'].includes(recovery.phase) || Date.now() < recovery.nextAllowedAt && recovery.phase === 'backoff') return 'blocked';
    if (readBusy) return 'busy';
    if (!order?.beforeCursor) return 'exhausted';
    const epoch = groupEpochs.get(groupId) || 0;
    const current = () => viewCurrent(view, epoch, order.generation) && orderedReadEnvironmentReady();
    const token = {}; readBusy = token; const abort = new AbortController(); readAbort = abort;
    set(state => ({ pagination: { ...state.pagination, [groupId]: { ...state.pagination[groupId], loadingMore: true } } }));
    try {
      const query = { limit: 50, before_cursor: order.beforeCursor };
      const revision = messageRevision;
      unloadedEdits.delete(groupId);
      pendingReadEvents.set(groupId, { lease: view.lease, events: [] });
      const response = validateOrderedMessagesPage(await api.getOrderedMessages(groupId, query, abort.signal), { owner: view.owner.userId!, group: groupId, ...query });
      if (!current()) return 'stale';
      applyPage(groupId, response, revision, 'before');
      replayReadEvents(groupId, view, current);
      return current() ? 'loaded' : 'stale';
    } catch (error) { if (current()) failedRead(groupId, error); return current() ? 'blocked' : 'stale'; }
    finally {
      const released = readBusy === token;
      if (released) readBusy = undefined;
      if (readAbort === abort) readAbort = undefined;
      if (pendingReadEvents.get(groupId)?.lease === view.lease) { pendingReadEvents.delete(groupId); unloadedEdits.delete(groupId); }
      if (viewCurrent(view, epoch, order.generation)) set(state => ({ pagination: { ...state.pagination, [groupId]: { ...state.pagination[groupId], loadingMore: false } } }));
      if (released) set(state => ({ readVersion: state.readVersion + 1 }));
      void orderedRecovery.wake();
    }
  },

  sendMessage: async (groupId: string, content: string, replyTo?: string | string[], attachments?: MessageAttachment[]) => {
    const owner = captureOwner();
    if (sendingGroups.get(groupId)) {
      return { success: false, tempId: '', error: '消息正在发送中' };
    }

    const sendToken = {};
    sendingGroups.set(groupId, sendToken);
    set(state => ({ sending: { ...state.sending, [groupId]: true }, error: null }));

    const tempId = `temp_${crypto.randomUUID()}`;
    const tempMessage: Message = {
      id: tempId,
      group_id: groupId,
      sender_type: 'user',
      sender_id: 'user',
      content,
      content_type: 'text',
      reply_to: replyTo,
      attachments: attachments,
      created_at: new Date().toISOString(),
      status: 'sending',
      tempId
    };

    get().addMessage(groupId, tempMessage);
    pendingMessages.set(tempId, { tempId, groupId });

    try {
      // Persist the intent and exact retry ID before sending. A failed local
      // write remains pending; it never authorizes an automatic network retry.
      await flushMessages(groupId);
      if (!isCurrent(owner)) return staleSend(tempId);
      const intent = get().messages[groupId]?.find(message => message.tempId === tempId || clientIdOf(message) === tempId);
      if (!intent || intent.status !== 'sending') return { success: !!intent && isDeliveredIntent(intent, tempId), tempId, ...(intent && isDeliveredIntent(intent, tempId) ? {} : { error: '消息已移除，未继续发送' }) };
      const message = await api.sendMessage(groupId, content, 'text', replyTo, undefined, attachments, tempId);

      if (!isCurrent(owner)) return staleSend(tempId);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: reconcileDeliveredMessage(groupId, state.messages[groupId] || [], tempId, message)
        },
        sending: { ...state.sending, [groupId]: false }
      }));

      pendingMessages.delete(tempId);
      await retireDeliveredIntents(owner, groupId, [tempId]);
      if (!isCurrent(owner)) return staleSend(tempId);

      return { success: true, tempId };
    } catch (error) {
      if (!isCurrent(owner)) return staleSend(tempId);
      const delivered = get().messages[groupId]?.some(message => isDeliveredIntent(message, tempId));
      if (delivered) {
        set(state => ({ sending: { ...state.sending, [groupId]: false } }));
        pendingMessages.delete(tempId);
        return { success: true, tempId };
      }
      const failure = sendFailure(error);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (() => {
            const next = (state.messages[groupId] || []).map(m =>
              m.tempId === tempId ? { ...m, status: 'failed' as const, metadata: { ...m.metadata, send_error: failure.message, send_terminal: failure.terminal } } : m
            );
            return next;
          })()
        },
        error: failure.message,
        sending: { ...state.sending, [groupId]: false }
      }));

      pendingMessages.delete(tempId);
      await flushMessages(groupId);
      if (!isCurrent(owner)) return staleSend(tempId);
      return { success: false, tempId, error: failure.message };
    } finally {
      if (isCurrent(owner) && sendingGroups.get(groupId) === sendToken) {
        sendingGroups.delete(groupId);
        set(state => ({ sending: { ...state.sending, [groupId]: false } }));
      }
    }
  },

  retryMessage: async (groupId: string, tempId: string) => {
    const owner = captureOwner();
    if (sendingGroups.get(groupId)) return { success: false, error: '消息正在发送中' };
    const state = get();
    const failedMessage = (state.messages[groupId] || []).find(m => m.tempId === tempId);

    if (!failedMessage || failedMessage.status !== 'failed') {
      return { success: false, error: '消息不存在' };
    }
    if (failedMessage.metadata?.send_terminal === true) {
      return { success: false, error: String(failedMessage.metadata.send_error || '这次发送不能重试，请复制内容后重新发送') };
    }

    const sendToken = {};
    sendingGroups.set(groupId, sendToken);

    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).map(m =>
          m.tempId === tempId ? { ...m, status: 'sending' } : m
        )
      },
      sending: { ...state.sending, [groupId]: true },
      error: null
    }));

    try {
      // Persist the intent and exact retry ID before sending. A failed local
      // write remains pending; it never authorizes an automatic network retry.
      await flushMessages(groupId);
      if (!isCurrent(owner)) return staleSend(tempId);
      const intent = get().messages[groupId]?.find(message => message.tempId === tempId || clientIdOf(message) === tempId);
      if (!intent || intent.status !== 'sending') return { success: !!intent && isDeliveredIntent(intent, tempId), tempId, ...(intent && isDeliveredIntent(intent, tempId) ? {} : { error: '消息已移除，未继续发送' }) };
      const message = await api.sendMessage(groupId, failedMessage.content, 'text', failedMessage.reply_to, undefined, failedMessage.attachments, tempId);

      if (!isCurrent(owner)) return staleSend(tempId);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: reconcileDeliveredMessage(groupId, state.messages[groupId] || [], tempId, message)
        },
        sending: { ...state.sending, [groupId]: false }
      }));

      await retireDeliveredIntents(owner, groupId, [tempId]);
      if (!isCurrent(owner)) return staleSend(tempId);

      return { success: true };
    } catch (error) {
      if (!isCurrent(owner)) return staleSend(tempId);
      const delivered = get().messages[groupId]?.some(message => isDeliveredIntent(message, tempId));
      if (delivered) {
        set(state => ({ sending: { ...state.sending, [groupId]: false } }));
        pendingMessages.delete(tempId);
        return { success: true, tempId };
      }
      const failure = sendFailure(error);
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (() => {
            const next = (state.messages[groupId] || []).map(m =>
              m.tempId === tempId ? { ...m, status: 'failed' as const, metadata: { ...m.metadata, send_error: failure.message, send_terminal: failure.terminal } } : m
            );
            return next;
          })()
        },
        error: failure.message,
        sending: { ...state.sending, [groupId]: false }
      }));

      await flushMessages(groupId);
      if (!isCurrent(owner)) return staleSend(tempId);
      return { success: false, error: failure.message };
    } finally {
      if (isCurrent(owner) && sendingGroups.get(groupId) === sendToken) {
        sendingGroups.delete(groupId);
        set(state => ({ sending: { ...state.sending, [groupId]: false } }));
      }
    }
  },

  confirmClientMessage: (groupId: string, tempId: string) => {
    const owner = captureOwner();
    // Correlation cleanup is not a source deletion: never tombstone this ID.
    set(state => ({ messages: { ...state.messages, [groupId]: (state.messages[groupId] || []).filter(message => message.id !== tempId || message.tempId !== tempId) } }));
    void retireDeliveredIntents(owner, groupId, [tempId]);
  },

  removeFailedMessage: (groupId: string, tempId: string) => {
    const owner = captureOwner();
    markDeleted(groupId, [tempId]);
    set(state => {
      const next = (state.messages[groupId] || []).filter(m => m.tempId !== tempId);
      return { messages: { ...state.messages, [groupId]: next } };
    });
    void deleteCachedMessages(owner, groupId, [tempId]);
  },

  deleteMessage: async (messageId: string, groupId: string) => {
    const owner = captureOwner();
    const groupEpoch = groupEpochs.get(groupId) || 0;
    const originalMessages = get().messages[groupId] || [];
    const removedIndex = originalMessages.findIndex(m => m.id === messageId);
    const removedMessages = removedIndex >= 0 ? [originalMessages[removedIndex]] : [];
    const removedIds = [messageId, ...removedMessages.map(message => message.tempId).filter((id): id is string => !!id)];
    markDeleted(groupId, removedIds);
    // 清理被删除消息的流式超时定时器
    clearStreamTimeout(messageId);
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).filter(m => m.id !== messageId)
      }
    }));
    const removalRevisions = new Map(removedIds.map(id => [id, messageChanges.get(groupId)?.get(id)]));
    try {
      await api.deleteMessage(messageId);
      if (!isCurrent(owner)) return;
      void deleteCachedMessages(owner, groupId, removedIds);
      // 精确清理：仅删除该消息对应的pending条目（如有）
      for (const [tempId, entry] of pendingMessages.entries()) {
        if (entry.groupId === groupId && tempId === messageId) {
          pendingMessages.delete(tempId);
        }
      }
    } catch (error) {
      if (!groupIsCurrent(owner, groupId, groupEpoch)) return;
      console.error('Failed to delete message:');
      set({ error: error instanceof Error ? error.message : '删除消息失败' });
      // 回滚：按原始索引恢复消息，保持时间顺序
      if (removedMessages.length > 0 && removedIndex >= 0 && messageChanges.get(groupId)?.get(messageId) === removalRevisions.get(messageId)) {
        set(state => {
          const currentMsgs = state.messages[groupId] || [];
          if (currentMsgs.some(message => message.id === messageId)) return state;
          const newMsgs = [...currentMsgs];
          for (const id of removedIds) deletedMessageIds.get(groupId)?.delete(id);
          newMsgs.splice(Math.min(removedIndex, newMsgs.length), 0, removedMessages[0]);
          return {
            messages: {
              ...state.messages,
              [groupId]: newMsgs
            }
          };
        }, 'history');
      }
    }
  },

  editMessage: async (messageId: string, groupId: string, content: string) => {
    const owner = captureOwner();
    const original = get().messages[groupId]?.find(message => message.id === messageId);
    const editKey = JSON.stringify([groupId, messageId]);
    const token = {};
    editTokens.set(editKey, token);
    try {
      const updatedMessage = await api.editMessage(messageId, content);
      if (!isCurrent(owner)) return;
      if (editTokens.get(editKey) !== token) return;
      const current = get().messages[groupId]?.find(message => message.id === messageId);
      if (!current || current.content !== original?.content || current.edited_at !== original?.edited_at) return;
      if (!updatedMessage.metadata?.tts) useAudioStore.getState().removeTTSAudio(messageId);

      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(m =>
            m.id === messageId
              ? {
                ...m,
                content: updatedMessage.content || content,
                metadata: updatedMessage.metadata,
                is_edited: true,
                edited_at: updatedMessage.edited_at || new Date().toISOString()
              }
              : m
          )
        }
      }));
    } catch (error) {
      if (!isCurrent(owner) || editTokens.get(editKey) !== token) return;
      console.error('Failed to edit message:');
      set({ error: error instanceof Error ? error.message : '编辑消息失败' });
      throw error;
    }
  },

  batchDeleteMessages: async (messageIds: string[], groupId: string) => {
    const owner = captureOwner();
    const groupEpoch = groupEpochs.get(groupId) || 0;
    const removedMessages = (get().messages[groupId] || []).filter(m => messageIds.includes(m.id));
    const removedIds = [...messageIds, ...removedMessages.map(message => message.tempId).filter((id): id is string => !!id)];
    markDeleted(groupId, removedIds);
    for (const id of messageIds) clearStreamTimeout(id);
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: (state.messages[groupId] || []).filter(m => !messageIds.includes(m.id))
      }
    }));
    const removalRevisions = new Map(removedIds.map(id => [id, messageChanges.get(groupId)?.get(id)]));
    try {
      await api.batchDeleteMessages(messageIds, groupId);
      if (!isCurrent(owner)) return;
      void deleteCachedMessages(owner, groupId, removedIds);
    } catch (error) {
      if (!groupIsCurrent(owner, groupId, groupEpoch)) return;
      console.error('Failed to batch delete messages:');
      set({ error: error instanceof Error ? error.message : '批量删除消息失败' });
      const restorable = removedMessages.filter(message => messageChanges.get(groupId)?.get(message.id) === removalRevisions.get(message.id));
      if (restorable.length > 0) {
        for (const message of restorable) for (const id of [message.id, message.tempId]) if (id) deletedMessageIds.get(groupId)?.delete(id);
        set(state => ({
          messages: {
            ...state.messages,
            [groupId]: [...(state.messages[groupId] || []), ...restorable.filter(message => !(state.messages[groupId] || []).some(current => current.id === message.id))]
          }
        }), 'history');
      }
      throw error;
    }
  },

  clearAllMessages: async (groupId: string) => {
    const owner = captureOwner();
    invalidateGroup(groupId);
    try {
      await api.clearAllMessages(groupId);
      if (!isCurrent(owner)) return;
      get().clearMessages(groupId);
    } catch (error) {
      if (!isCurrent(owner)) return;
      console.error('Failed to clear all messages:');
      set(state => ({ error: error instanceof Error ? error.message : '清空消息失败', loading: false, pagination: { ...state.pagination, ...(state.pagination[groupId] ? { [groupId]: { ...state.pagination[groupId], loadingMore: false } } : {}) } }));
      throw error;
    }
  },

  removeMessages: (groupId: string, messageIds: string[]) => {
    const owner = captureOwner();
    const removed = (get().messages[groupId] || []).filter(message => messageIds.includes(message.id));
    const ids = [...messageIds, ...removed.map(message => message.tempId).filter((id): id is string => !!id)];
    markDeleted(groupId, ids);
    for (const id of ids) clearStreamTimeout(id);
    set(state => ({ messages: { ...state.messages, [groupId]: (state.messages[groupId] || []).filter(message => !messageIds.includes(message.id)) } }));
    void deleteCachedMessages(owner, groupId, ids);
  },

  clearMessages: (groupId: string) => {
    const owner = captureOwner();
    invalidateGroup(groupId);
    const messages = get().messages[groupId] || [];
    markDeleted(groupId, messages.flatMap(message => [message.id, ...(message.tempId ? [message.tempId] : [])]));
    clearStreamTimeoutsForGroup(messages);
    if (persistTimers[groupId]) clearTimeout(persistTimers[groupId]);
    delete persistTimers[groupId];
    delete pendingSaveMessages[groupId];
    set(state => ({ ordered: { ...state.ordered, [groupId]: blankOrder() }, recovery: { ...state.recovery, [groupId]: { ...blankRecovery(), nextAllowedAt: Date.now() + 30000 } }, messages: { ...state.messages, [groupId]: [] }, pagination: { ...state.pagination, [groupId]: { hasMore: false, loadingMore: false, oldestMessageId: null } }, loading: false }));
    void queueCache(owner, groupId, async () => { await clearAllMessagesFromIndexedDB(groupId); });
  },

  addMessage: (groupId: string, message: Message) => {
    const owner = captureOwner();
    if (message.confirmation === 'confirmed' && validOrderedMessage(message, groupId)) {
      const ids = confirmedDocumentIds.get(groupId) || new Set<string>(); ids.add(message.id); confirmedDocumentIds.set(groupId, ids);
    }
    const clientId = message.tempId || clientIdOf(message);
    if (clientId && message.id !== clientId && message.confirmation !== 'preview') message = { ...message, tempId: clientId, status: 'sent' };
    const deleted = deletedMessageIds.get(groupId);
    if ([message.id, message.tempId, clientIdOf(message)].some(id => id && deleted?.has(id))) return;
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      // A preview is not a receipt for the original send. A durable receipt can
      // match both an outbox row and an existing server-ID preview at once.
      const confirmsClientIntent = message.confirmation !== 'preview' && !!message.tempId && message.id !== message.tempId;
      const matches = (row: Message) => row.id === message.id || (confirmsClientIntent &&
        (row.tempId === message.tempId || row.id === message.tempId || clientIdOf(row) === message.tempId));
      const existingIndex = groupMessages.findIndex(matches);

      if (existingIndex !== -1) {
        const existing = groupMessages[existingIndex];
        const isTempMatch = confirmsClientIntent && existing.tempId && existing.tempId === message.tempId;
        const updatedMessage = isTempMatch
          ? { ...message, status: 'sent' as const }
          : { ...existing, ...message, status: (message.status || existing.status) as Message['status'] };

        // 仅当所有关键字段都相同时才跳过更新；
        // 但 metadata/attachments/likes/comments 等字段变化仍需触发更新
        const contentUnchanged = existing.content === updatedMessage.content;
        const statusUnchanged = existing.status === updatedMessage.status;
        const streamingUnchanged = existing.is_streaming === updatedMessage.is_streaming;
        const replyUnchanged = existing.reply_to === updatedMessage.reply_to;
        const metadataUnchanged = JSON.stringify(existing.metadata) === JSON.stringify(updatedMessage.metadata);
        const detailsUnchanged = JSON.stringify({ ...existing, content: undefined, status: undefined, is_streaming: undefined, reply_to: undefined, metadata: undefined }) === JSON.stringify({ ...updatedMessage, content: undefined, status: undefined, is_streaming: undefined, reply_to: undefined, metadata: undefined });
        const hasDuplicateIdentity = groupMessages.some((row, index) => index !== existingIndex && matches(row));
        if (!hasDuplicateIdentity && contentUnchanged && statusUnchanged && streamingUnchanged && replyUnchanged && metadataUnchanged && detailsUnchanged) {
          return state;
        }

        const newGroupMessages = groupMessages.flatMap((row, index) => index === existingIndex ? [updatedMessage] : matches(row) ? [] : [row]);
        return {
          messages: {
            ...state.messages,
            [groupId]: newGroupMessages
          }
        };
      }

      const newGroupMessages = [...groupMessages, message];
      return {
        messages: {
          ...state.messages,
          [groupId]: newGroupMessages
        }
      };
    });
    if (clientId && message.id !== clientId && message.confirmation !== 'preview') void retireDeliveredIntents(owner, groupId, [clientId]);
  },

  likeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    const owner = captureOwner();
    get().applyLikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.likeMessage(messageId);
      if (!isCurrent(owner)) return;
      set(state => {
        const nextLikes = result.likes || result.liked_by || [];
        return {
          messages: {
            ...state.messages,
            [groupId]: (state.messages[groupId] || []).map(message =>
              message.id === messageId
                ? { ...message, likes: nextLikes, liked_by: nextLikes, likes_count: result.likes_count ?? nextLikes.length }
                : message
            ),
          }
        };
      });
    } catch (error) {
      if (!isCurrent(owner)) return;
      console.error('Failed to like message:');
      get().applyUnlikeUpdate(messageId, groupId, _userId);
    }
  },

  unlikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    const owner = captureOwner();
    get().applyUnlikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.unlikeMessage(messageId);
      if (!isCurrent(owner)) return;
      set(state => {
        const nextLikes = result.likes || result.liked_by || [];
        return {
          messages: {
            ...state.messages,
            [groupId]: (state.messages[groupId] || []).map(message =>
              message.id === messageId
                ? { ...message, likes: nextLikes, liked_by: nextLikes, likes_count: result.likes_count ?? nextLikes.length }
                : message
            ),
          }
        };
      });
    } catch (error) {
      if (!isCurrent(owner)) return;
      console.error('Failed to unlike message:');
      get().applyLikeUpdate(messageId, groupId, _userId);
    }
  },

  dislikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    const owner = captureOwner();
    get().applyDislikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.dislikeMessage(messageId);
      if (!isCurrent(owner)) return;
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(message =>
            message.id === messageId
              ? {
                ...message,
                disliked_by: result.disliked_by || [],
                dislikes: result.dislikes ?? (result.disliked_by || []).length
              }
              : message
          )
        }
      }));
    } catch (error) {
      if (!isCurrent(owner)) return;
      console.error('Failed to dislike message:');
      get().applyUndislikeUpdate(messageId, groupId, _userId);
    }
  },

  undislikeMessage: async (messageId: string, groupId: string, _userId: string = 'user') => {
    const owner = captureOwner();
    get().applyUndislikeUpdate(messageId, groupId, _userId);
    try {
      const result = await api.undislikeMessage(messageId);
      if (!isCurrent(owner)) return;
      set(state => ({
        messages: {
          ...state.messages,
          [groupId]: (state.messages[groupId] || []).map(message =>
            message.id === messageId
              ? {
                ...message,
                disliked_by: result.disliked_by || [],
                dislikes: result.dislikes ?? (result.disliked_by || []).length
              }
              : message
          )
        }
      }));
    } catch (error) {
      if (!isCurrent(owner)) return;
      console.error('Failed to undislike message:');
      get().applyDislikeUpdate(messageId, groupId, _userId);
    }
  },

  applyLikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyLikeState(state.messages[groupId] || [], messageId, userId, true)
      }
    }));
  },

  applyUnlikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyLikeState(state.messages[groupId] || [], messageId, userId, false)
      }
    }));
  },

  applyDislikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyDislikeState(state.messages[groupId] || [], messageId, userId, true)
      }
    }));
  },

  applyUndislikeUpdate: (messageId: string, groupId: string, userId: string = 'user') => {
    set(state => ({
      messages: {
        ...state.messages,
        [groupId]: applyDislikeState(state.messages[groupId] || [], messageId, userId, false)
      }
    }));
  },

  addComment: async (messageId: string, groupId: string, content: string, senderType: 'user' | 'ai', senderId?: string, parentId?: string, replyTo?: string) => {
    const owner = captureOwner();
    try {
      const response = await api.addComment(messageId, content, parentId, replyTo);
      if (!isCurrent(owner)) return;
      const serverComment = response.comment || response;

      set(state => {
        const groupMessages = state.messages[groupId] || [];
        const existingComments = groupMessages.find(m => m.id === messageId)?.comments || [];
        const existingCommentIds = new Set(existingComments.map(c => c.id));

        if (serverComment.id && existingCommentIds.has(serverComment.id)) {
          return state;
        }

        const parentComment = parentId ? existingComments.find(c => c.id === parentId) : null;
        const parentDepth = parentComment?.depth || 0;
        const effectiveParentId = parentDepth >= MAX_COMMENT_DEPTH ? undefined : parentId;
        const effectiveReplyTo = parentDepth >= MAX_COMMENT_DEPTH ? undefined : replyTo;
        const commentDepth = parentDepth >= MAX_COMMENT_DEPTH ? 0 : parentDepth + 1;

        const newComment: Comment = serverComment.id ? {
          id: serverComment.id,
          message_id: serverComment.message_id || messageId,
          parent_id: serverComment.parent_id || effectiveParentId,
          reply_to: serverComment.reply_to || effectiveReplyTo,
          sender_type: serverComment.sender_type || senderType,
          sender_id: serverComment.sender_id || senderId,
          content: serverComment.content || content,
          created_at: serverComment.created_at || new Date().toISOString(),
          depth: serverComment.depth ?? commentDepth
        } : {
          id: `comment_${Date.now()}`,
          message_id: messageId,
          parent_id: effectiveParentId,
          reply_to: effectiveReplyTo,
          sender_type: senderType,
          sender_id: senderId,
          content,
          created_at: new Date().toISOString(),
          depth: commentDepth
        };

        return {
          messages: {
            ...state.messages,
            [groupId]: groupMessages.map(m => {
              if (m.id === messageId) {
                const currentComments = m.comments || [];
                if (currentComments.some(c => c.id === newComment.id)) {
                  return m;
                }
                return {
                  ...m,
                  comments: [...currentComments, newComment]
                };
              }
              return m;
            })
          }
        };
      });
    } catch (error) {
      if (!isCurrent(owner)) return;
      console.error('Failed to add comment:');
      set({ error: error instanceof Error ? error.message : '添加评论失败' });
    }
  },

  addCommentFromRemote: (messageId: string, groupId: string, comment: Comment) => {
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const existingMessage = groupMessages.find(m => m.id === messageId);
      if (!existingMessage) return state;

      const existingComments = existingMessage.comments || [];
      if (existingComments.some(c => c.id === comment.id)) {
        return state;
      }

      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              return {
                ...m,
                comments: [...(m.comments || []), comment]
              };
            }
            return m;
          })
        }
      };
    });
  },

  updateMessage: (messageId: string, groupId: string, updates: Partial<Message>) => {
    captureOwner();
    if (pendingReadEvents.has(groupId) && !(get().messages[groupId] || []).some(m => m.id === messageId)) {
      const pending = unloadedEdits.get(groupId) || new Map<string, { revision: number; updates: Partial<Message> }>();
      if (pending.size < 500 || pending.has(messageId)) pending.set(messageId, { revision: ++messageRevision, updates: { ...pending.get(messageId)?.updates, ...updates } });
      unloadedEdits.set(groupId, pending);
    }
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              return { ...m, ...updates };
            }
            return m;
          })
        }
      };
    });
  },

  addStreamMessage: (groupId: string, messageId: string, senderId: string) => {
    const owner = captureOwner();
    if (deletedMessageIds.get(groupId)?.has(messageId)) return;
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const exists = groupMessages.some(m => m.id === messageId);

      if (exists) return state;

      const streamMessage: Message = {
        id: messageId,
        group_id: groupId,
        sender_type: 'ai',
        sender_id: senderId,
        content: '',
        content_type: 'text',
        created_at: new Date().toISOString(),
        is_streaming: true, confirmation: 'preview', preview_reason: 'streaming'
      };

      return {
        messages: {
          ...state.messages,
          [groupId]: [...groupMessages, streamMessage]
        }
      };
    });

    if (streamTimeouts.has(messageId)) {
      clearTimeout(streamTimeouts.get(messageId)!);
    }
    const timer = setTimeout(() => {
      if (!isCurrent(owner) || streamTimeouts.get(messageId) !== timer) return;
      get().finalizeStreamMessage(groupId, messageId, '[流式传输超时，请重新发送]');
    }, 120000);
    streamTimeouts.set(messageId, timer);
  },

  updateStreamMessage: (groupId: string, messageId: string, content: string, isDone: boolean) => {
    if (isDone) clearStreamTimeout(messageId);
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const index = groupMessages.findIndex(m => m.id === messageId);
      if (index === -1) return state;
      if (groupMessages[index].confirmation === 'confirmed') return state;
      const updated = { ...groupMessages[index], content, is_streaming: !isDone, updated_at: new Date().toISOString() };
      const newMessages = [...groupMessages.slice(0, index), updated, ...groupMessages.slice(index + 1)];

      return {
        messages: {
          ...state.messages,
          [groupId]: newMessages
        },
        streamUpdateCounter: state.streamUpdateCounter + 1
      };
    });
  },

  finalizeStreamMessage: (groupId: string, messageId: string, content: string, replyTo?: string | string[], replyToIds?: string[]) => {
    if (streamTimeouts.has(messageId)) {
      clearTimeout(streamTimeouts.get(messageId)!);
      streamTimeouts.delete(messageId);
    }
    set(state => {
      const groupMessages = state.messages[groupId] || [];
      const existingIndex = groupMessages.findIndex(m => m.id === messageId);

      if (existingIndex === -1) {
        if (import.meta.env.DEV) console.log('[Store] Stream completion target unavailable');
        return state;
      }

      // 避免重复finalize：若消息已非streaming且内容已包含超时提示，跳过
      const existing = groupMessages[existingIndex];
      if (existing.confirmation === 'confirmed') return state;
      if (!existing.is_streaming && existing.content === content) {
        return state;
      }

      // 避免 message_stream_end 的空 content 覆盖已流式累积的非空内容
      const finalContent = (!content || content.trim().length === 0) && existing.content?.trim().length > 0
        ? existing.content
        : content;

      return {
        messages: {
          ...state.messages,
          [groupId]: groupMessages.map(m => {
            if (m.id === messageId) {
              return {
                ...m,
                content: finalContent,
                reply_to: replyTo,
                reply_to_ids: replyToIds,
                is_streaming: false
              };
            }
            return m;
          })
        },
        // 流式结束时也需更新 streamUpdateCounter，触发 MessageList 的滚动到底部逻辑
        // 否则流式输出停止后视图停留在中间位置，需手动滚动
        streamUpdateCounter: state.streamUpdateCounter + 1
      };
    });
  }
};
});

export function resetMessagesModuleState() {
  storeEpoch++;
  activeOwner = undefined;
  activeMessageView = undefined;
  terminatedOwner = undefined; confirmedDocumentIds.clear(); unloadedEdits.clear(); retiredClientIds.clear();
  readAbort?.abort(); readAbort = undefined;
  pendingReadEvents.clear();
  orderedRecovery.stop();
  useMessagesStore.setState({ ordered: {}, recovery: {}, durability: {}, messageActivity: null });
  cacheQueues.clear();
  groupEpochs.clear();
  editTokens.clear();
  messageChanges.clear();
  deletedMessageIds.clear();
  messageRevision = 0;
  sendingGroups.clear();
  pendingMessages.clear();
  for (const timeout of streamTimeouts.values()) {
    clearTimeout(timeout);
  }
  streamTimeouts.clear();
  for (const timer of Object.values(persistTimers)) {
    clearTimeout(timer);
  }
  Object.keys(persistTimers).forEach(key => {
    delete persistTimers[key];
  });
  Object.keys(pendingSaveMessages).forEach(key => {
    delete pendingSaveMessages[key];
  });
}

const orderedRecovery = createOrderedMessageRecovery({
  eligible: () => {
    const view = activeMessageView;
    if (!view || !view.owner.userId || !isCurrent(view.owner) || !orderedReadEnvironmentReady() || readBusy || (terminatedOwner && isCurrent(terminatedOwner))) return false;
    const phase = useMessagesStore.getState().recovery[view.groupId]?.phase;
    return !['paused', 'resync_required', 'auth_required'].includes(phase || '');
  },
  nextAllowedAt: () => activeMessageView ? useMessagesStore.getState().recovery[activeMessageView.groupId]?.nextAllowedAt || 0 : 0,
  run: () => orderedRecoveryRun(),
});
