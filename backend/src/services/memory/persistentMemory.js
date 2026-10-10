import { PgLow } from '../../models/supabaseAdapter.js';
import { postgresMemoryRequired, getPostgresMemoryLedger } from './postgresDeletionLedger.js';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { getUserDb, getDataDir, withWriteLock, clearUserDbCache, CustomLow } from '../../models/db.js';
import { getAuthDb } from '../../models/authDb.js';
import { encryptText, decryptText } from '../../utils/encryption.js';
import { createLocalAccountRegistry } from './localAccountRegistry.js';
import { safeLog } from '../../utils/logger.js';

const memoryError = (code, status, message) =>
  Object.assign(new Error(message), { code, statusCode: status, isOperational: true });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const records = db => Array.isArray(db.data.memoryRecords) ? db.data.memoryRecords : [];
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 5000;
const allowedCategories = new Set(['factual', 'emotional', 'relational', 'preference', 'note']);
const barriers = new Map();
const registries = new Map();
const sourceGroupKey = groupId => hash(['source_group', groupId]);
const sourceMessageKey = (groupId, messageId) => hash(['source_message', groupId, messageId]);
const sourceFileKey = (groupId, fileId) => hash(['source_file', groupId, fileId]);
const sourceRevisionKey = (groupId, messageId, sourceHash) =>
  hash(['source_revision', groupId, messageId, sourceHash]);

async function localBarrier(userId, db, { allowNew = false } = {}) {
  if (db instanceof PgLow && await postgresMemoryRequired()) return getPostgresMemoryLedger();
  if (!(db instanceof CustomLow)) {
    throw memoryError('MEMORY_STORAGE_UNSUPPORTED', 503,
      '此存储尚无独立删除账本，记忆功能暂不可用');
  }
  const root = path.resolve(process.env.MEMORY_DELETION_DIR ||
    path.join(getDataDir(), 'memory-deletions'));
  const installation = getAuthDb().data?.memoryBarrierInstallation;
  if (installation?.version !== 1 || installation.root !== root) {
    throw memoryError('MEMORY_BARRIER_UNAVAILABLE', 503,
      '记忆删除账本尚未初始化或配置路径已变化');
  }
  const barrierKey = JSON.stringify([root, userId]);
  let barrier = barriers.get(barrierKey);
  if (!barrier) {
    const directory = path.join(root, hash(userId));
    let registryReady = registries.get(root);
    if (!registryReady) {
      registryReady = (async () => {
        const registry = createLocalAccountRegistry({
          directory: path.join(root, 'registry'),
          createIfMissing: false
        });
        await registry.initialize();
        return registry;
      })();
      registries.set(root, registryReady);
      registryReady.catch(() => registries.delete(root));
    }
    try {
      const registry = await registryReady;
      ({ barrier } = await registry.openAccount(userId, {
        ledgerDirectory: directory,
        // Only the account-creation path may admit a new ledger. An empty
        // restored memoryRecords array is never proof that an account is new.
        allowNew
      }));
    }
    catch {
      throw memoryError('MEMORY_BARRIER_UNAVAILABLE', 503,
        '记忆删除记录或账号注册簿不可用，请检查首次初始化及恢复状态');
    }
    barriers.set(barrierKey, barrier);
  }
  return barrier;
}

/** Provision a ledger for a freshly generated account before its session is exposed. */
export async function provisionNewLocalMemoryAccount(userId, db) {
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return { supported: false };
  if (records(db).length || db.data.messages?.length) {
    throw memoryError('MEMORY_BARRIER_UNAVAILABLE', 503,
      '已有数据的账号不能按新账号初始化删除账本');
  }
  if (db instanceof PgLow) await (await getPostgresMemoryLedger()).registerNewAccount(userId);
  else await localBarrier(userId, db, { allowNew: true });
  return { supported: true };
}

async function barrierDeletedIds(barrier, userId, ids) {
  try { return await barrier.deletedIds(userId, ids); }
  catch {
    throw memoryError('MEMORY_BARRIER_UNAVAILABLE', 503,
      '记忆删除记录不可用，请检查存储及恢复状态');
  }
}

async function barrierMark(barrier, userId, id) {
  try { return await barrier.markDeleted(userId, id); }
  catch {
    throw memoryError('MEMORY_BARRIER_UNAVAILABLE', 503,
      '记忆删除记录写入结果不确定，请检查存储及恢复状态');
  }
}

function safeMetadata(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  // Client metadata is never accepted as evidence, source ownership or a
  // confirmation decision.
  return {
    ...(typeof data.traceId === 'string' ? { traceId: data.traceId.slice(0, 128) } : {}),
    ...(typeof data.tag === 'string' ? { tag: data.tag.slice(0, 64) } : {})
  };
}

function messageSourceHash(message) {
  return hash({ content: message.content, revision: message.revision || null,
    edited_at: message.edited_at || null, groupId: message.group_id });
}

function attachmentFileId(attachment) {
  if (typeof attachment?.id === 'string' && attachment.id) return attachment.id;
  if (typeof attachment?.url !== 'string' || !attachment.url.startsWith('/')) return null;
  const pathOnly = attachment.url.split(/[?#]/, 1)[0];
  const match = /^\/(?:api\/)?files\/(?:public\/)?([^/]+)(?:\/download)?\/?$/.exec(pathOnly);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); }
  catch { return null; }
}

// Call while holding the account lock after refreshing the user DB. The same
// durable source marks used for memory quotes also protect raw message reads
// when an older user JSON snapshot is restored without the deletion ledger.
export async function readableSourceMessages(userId, db, messages = db.data.messages || []) {
  const candidates = Array.isArray(messages) ? messages : [];
  const live = candidates.filter(message => !message.deleted_at && !message.is_deleted);
  // PostgreSQL can opt into the independent ledger. Unconfigured cloud
  // adapters retain ordinary live reads without rollback protection.
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return live;
  const barrier = await localBarrier(userId, db);
  const linkedFiles = new Map((db.data.files || []).map(file => [file.id, file]));
  const keys = live.flatMap(message => [
    sourceGroupKey(message.group_id),
    sourceMessageKey(message.group_id, message.id),
    sourceRevisionKey(message.group_id, message.id, messageSourceHash(message)),
    ...(Array.isArray(message.attachments) ? message.attachments
      .map(attachmentFileId).filter(Boolean)
      .map(fileId => sourceFileKey(message.group_id, fileId)) : [])
  ]);
  const deleted = await barrierDeletedIds(barrier, userId, keys);
  return live.filter(message =>
    !deleted.has(sourceGroupKey(message.group_id)) &&
    !deleted.has(sourceMessageKey(message.group_id, message.id)) &&
    !deleted.has(sourceRevisionKey(message.group_id, message.id, messageSourceHash(message))))
    .map(message => {
      if (!Array.isArray(message.attachments)) return message;
      const attachments = message.attachments.filter(attachment => {
        const fileId = attachmentFileId(attachment);
        const file = fileId && linkedFiles.get(fileId);
        // A legacy attachment without a provable same-account file identity
        // cannot safely carry cached descriptions or parsed content forward.
        if (!file || file.group_id !== message.group_id ||
            (file.owner_user_id && file.owner_user_id !== userId) ||
            (file.uploader_id && file.uploader_id !== userId) ||
            deleted.has(sourceFileKey(message.group_id, fileId))) return false;
        return true;
      });
      if (attachments.length !== message.attachments.length) {
        // Keep the underlying message identity for routes that mutate likes,
        // comments and TTS metadata after this visibility check.
        message.attachments = attachments;
      }
      return message;
    });
}

export async function readableSourceGroups(userId, db, groups = db.data.groups || []) {
  const candidates = Array.isArray(groups) ? groups : [];
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return candidates;
  const barrier = await localBarrier(userId, db);
  const deleted = await barrierDeletedIds(barrier, userId,
    candidates.map(group => sourceGroupKey(group.id)));
  return candidates.filter(group => !deleted.has(sourceGroupKey(group.id)));
}

// File identity is revoked independently of the group. A restored user JSON
// and restored upload bytes must not bring a separately deleted file back.
export async function readableSourceFiles(userId, db, files = db.data.files || []) {
  const candidates = Array.isArray(files) ? files : [];
  const groups = await readableSourceGroups(userId, db);
  const liveGroupIds = new Set(groups.map(group => group.id));
  const live = candidates.filter(file => liveGroupIds.has(file.group_id));
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return live;
  const barrier = await localBarrier(userId, db);
  const deleted = await barrierDeletedIds(barrier, userId,
    live.map(file => sourceFileKey(file.group_id, file.id)));
  return live.filter(file => !deleted.has(sourceFileKey(file.group_id, file.id)));
}

export async function isSourceIdentityRevoked(userId, db, message) {
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return false;
  const barrier = await localBarrier(userId, db);
  const deleted = await barrierDeletedIds(barrier, userId, [
    sourceGroupKey(message.group_id), sourceMessageKey(message.group_id, message.id)
  ]);
  return deleted.size > 0;
}

function visibleSource(record, db) {
  if (!record.source) return true;
  if (record.source.type !== 'message') return false;
  const group = db.data.groups?.find(item => item.id === record.source.groupId);
  const message = db.data.messages?.find(item =>
    item.id === record.source.id && item.group_id === record.source.groupId);
  return !!group && !!message && !message.deleted_at && !message.is_deleted &&
    messageSourceHash(message) === record.source.hash;
}

function publicMemory(record) {
  return {
    id: record.id, content: decryptText(record.content),
    category: record.category, kind: record.kind, evidence: record.evidence,
    confirmedFact: false, sender_id: record.ownerId,
    sender_type: record.kind === 'user_note' ? 'user' : 'source_message',
    source: record.source ? {
      type: record.source.type, id: record.source.id, groupId: record.source.groupId
    } : null,
    metadata: record.metadata, revision: record.revision,
    timestamp: record.recordedAt, recordedAt: record.recordedAt,
    validFrom: null, validTo: null
  };
}

async function withReadableUser(userId, reader) {
  const db = await getUserDb(userId);
  return withWriteLock(userId, async () => {
    await db.read();
    const barrier = await localBarrier(userId, db);
    await reconcileBarrier(userId, db, barrier);
    // Keep the read under the account lock. Otherwise a source can be revoked
    // after the barrier check but before its old content is decrypted.
    return reader(db);
  });
}

function available(record, db, userId) {
  return record.ownerId === userId && record.state === 'active' && visibleSource(record, db);
}

async function reconcileBarrier(userId, db, barrier) {
  const active = records(db).filter(record => record.ownerId === userId && record.state === 'active');
  const keys = active.flatMap(record => record.source?.type === 'message'
    ? [record.id, sourceGroupKey(record.source.groupId),
      sourceMessageKey(record.source.groupId, record.source.id),
      sourceRevisionKey(record.source.groupId, record.source.id, record.source.hash)]
    : [record.id]);
  const deleted = await barrierDeletedIds(barrier, userId, keys);
  if (!deleted.size) return;
  const now = stamp();
  const next = records(db).map(record => {
    if (record.ownerId !== userId || record.state !== 'active') return record;
    const source = record.source;
    const sourceRevoked = source?.type === 'message' && (
      deleted.has(sourceGroupKey(source.groupId)) ||
      deleted.has(sourceMessageKey(source.groupId, source.id)) ||
      deleted.has(sourceRevisionKey(source.groupId, source.id, source.hash)));
    if (!deleted.has(record.id) && !sourceRevoked) return record;
    return { ...record, state: sourceRevoked ? 'source_revoked' : 'forgotten',
      content: null, metadata: {}, source: null, requestHash: null,
      revision: record.revision + 1, updatedAt: now };
  });
  await writeMemoryRecords(db, userId, next);
}

export async function markMessageRevisionRevoked(userId, db, message) {
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return;
  const barrier = await localBarrier(userId, db);
  await barrierMark(barrier, userId,
    sourceRevisionKey(message.group_id, message.id, messageSourceHash(message)));
}

export async function markMessageDeleted(userId, db, groupId, messageIds) {
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return;
  const barrier = await localBarrier(userId, db);
  for (const id of new Set(messageIds)) {
    await barrierMark(barrier, userId, sourceMessageKey(groupId, id));
  }
}

export async function markGroupDeleted(userId, db, groupId) {
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return;
  const barrier = await localBarrier(userId, db);
  await barrierMark(barrier, userId, sourceGroupKey(groupId));
}

export async function markFileDeleted(userId, db, groupId, fileId) {
  if (!(db instanceof CustomLow) && !(db instanceof PgLow && await postgresMemoryRequired())) return;
  const barrier = await localBarrier(userId, db);
  await barrierMark(barrier, userId, sourceFileKey(groupId, fileId));
}

async function writeMemoryRecords(db, userId, nextRecords) {
  const previous = db.data.memoryRecords;
  db.data.memoryRecords = nextRecords;
  try {
    await db.write();
  } catch (error) {
    db.data.memoryRecords = previous;
    // A failed acknowledgement may still follow a committed remote write.
    // Evict this snapshot so the next request reads the authoritative store.
    clearUserDbCache(userId);
    throw error;
  }
}

export function sourceMutationUncertain(userId, error) {
  // A storage acknowledgement may be lost after the source write committed.
  // The deletion prewrite remains durable either way, so never reuse a cached
  // snapshot or report an ordinary all-or-nothing failure to the user.
  clearUserDbCache(userId);
  safeLog('error', '来源变更写入结果待核验', { userId, error: error?.message });
  return memoryError('SOURCE_CHANGE_UNCERTAIN', 503,
    '来源变更结果待核验，旧来源已暂停使用；请刷新相关消息、文件和记忆状态后再核验');
}

// Call inside the same user write lock and database write as a source change.
// The previous array can be restored by the caller if that write fails.
export function revokeMessageMemories(data, groupId, messageIds = null) {
  if (!Array.isArray(data.memoryRecords)) return 0;
  const ids = messageIds && new Set(messageIds);
  const now = stamp();
  let revoked = 0;
  data.memoryRecords = data.memoryRecords.map(record => {
    if (record.state !== 'active' || record.source?.type !== 'message' ||
      record.source.groupId !== groupId || (ids && !ids.has(record.source.id))) return record;
    revoked += 1;
    return { ...record, state: 'source_revoked', content: null, source: null,
      metadata: {}, revision: record.revision + 1, updatedAt: now };
  });
  return revoked;
}

export async function storeUserMemory(userId, { content, category = 'note', metadata, requestKey } = {}) {
  if (!validText(content) || !allowedCategories.has(category)) {
    throw memoryError('INVALID_MEMORY', 400, '记忆内容或分类无效');
  }
  const cleanMetadata = safeMetadata(metadata);
  const db = await getUserDb(userId);
  return withWriteLock(userId, async () => {
    await db.read();
    const barrier = await localBarrier(userId, db);
    await reconcileBarrier(userId, db, barrier);
    if (requestKey) {
      const old = records(db).find(item => item.ownerId === userId &&
        item.requestKey === requestKey);
      if (old) {
        if (old.state !== 'active') throw memoryError('MEMORY_FORGOTTEN', 410, '该记忆已遗忘');
        if (decryptText(old.content) !== content || old.category !== category ||
          JSON.stringify(old.metadata) !== JSON.stringify(cleanMetadata)) {
          throw memoryError('IDEMPOTENCY_CONFLICT', 409, '相同请求号已用于不同内容');
        }
        return { memoryId: old.id, memory: publicMemory(old), replayed: true };
      }
    }
    const now = stamp();
    const record = {
      id: randomUUID(), ownerId: userId, kind: 'user_note',
      evidence: 'user_asserted', category, content: encryptText(content),
      metadata: cleanMetadata, source: null, revision: 0, state: 'active',
      recordedAt: now, updatedAt: now, requestKey: requestKey || null
    };
    await writeMemoryRecords(db, userId, [...records(db), record]);
    return { memoryId: record.id, memory: publicMemory(record), replayed: false };
  });
}

export async function storeMessageMemories(userId, messageIds, groupId) {
  if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100 ||
    messageIds.some(id => typeof id !== 'string' || !id)) {
    throw memoryError('INVALID_SOURCE', 400, '消息 ID 列表无效');
  }
  const ids = [...new Set(messageIds)];
  const db = await getUserDb(userId);
  return withWriteLock(userId, async () => {
    await db.read();
    const barrier = await localBarrier(userId, db);
    await reconcileBarrier(userId, db, barrier);
    const selected = ids.map(id => db.data.messages?.find(message =>
      message.id === id && (!groupId || message.group_id === groupId)));
    if (selected.some(message => !message || message.deleted_at || message.is_deleted ||
      !db.data.groups?.some(group => group.id === message.group_id))) {
      throw memoryError('SOURCE_UNAVAILABLE', 404, '来源消息不存在或已撤回');
    }
    const result = [];
    const nextRecords = [...records(db)];
    for (const message of selected) {
      if (typeof message.content !== 'string') {
        throw memoryError('SOURCE_UNAVAILABLE', 409, '来源内容无法保存');
      }
      const sourceHash = messageSourceHash(message);
      const blocked = await barrierDeletedIds(barrier, userId, [
        sourceGroupKey(message.group_id), sourceMessageKey(message.group_id, message.id),
        sourceRevisionKey(message.group_id, message.id, sourceHash)
      ]);
      if (blocked.size) throw memoryError('SOURCE_REVOKED', 410, '来源已撤销');
      const existing = nextRecords.find(item => item.ownerId === userId &&
        item.state === 'active' && item.source?.type === 'message' &&
        item.source.id === message.id && item.source.hash === sourceHash);
      if (existing) {
        result.push({ memoryId: existing.id, replayed: true });
        continue;
      }
      const now = stamp();
      const plaintext = message.metadata?.encryption?.encrypted
        ? decryptText(message.content) : message.content;
      if (!validText(plaintext)) throw memoryError('SOURCE_UNAVAILABLE', 409, '来源内容无法保存');
      const record = {
        id: randomUUID(), ownerId: userId, kind: 'message_quote',
        evidence: 'source_quote_unverified', category: 'note',
        content: encryptText(plaintext), metadata: {},
        source: { type: 'message', id: message.id, groupId: message.group_id, hash: sourceHash },
        revision: 0, state: 'active', recordedAt: now, updatedAt: now
      };
      nextRecords.push(record);
      result.push({ memoryId: record.id, replayed: false });
    }
    if (nextRecords.length !== records(db).length) {
      await writeMemoryRecords(db, userId, nextRecords);
    }
    return { batchSize: ids.length, storedCount: result.filter(item => !item.replayed).length,
      results: result, evidence: 'source_quote_unverified' };
  });
}

export async function listMemories(userId, { limit = 30, offset = 0, includeContent = true, groupId = null } = {}) {
  return withReadableUser(userId, db => {
    const visible = records(db).filter(record => available(record, db, userId) &&
      (!groupId || record.source?.groupId === groupId))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
    return { total: visible.length, offset, memories: visible.slice(offset, offset + limit).map(record => {
      const value = publicMemory(record);
      return includeContent ? value : { ...value, content: value.content.slice(0, 300) };
    }) };
  });
}

export async function getMemory(userId, memoryId) {
  return withReadableUser(userId, db => {
    const record = records(db).find(item => item.id === memoryId);
    if (!record || record.ownerId !== userId) throw memoryError('MEMORY_NOT_FOUND', 404, '记忆不存在');
    if (record.state === 'forgotten') throw memoryError('MEMORY_FORGOTTEN', 410, '记忆已遗忘');
    if (!available(record, db, userId)) {
      throw memoryError('SOURCE_UNAVAILABLE', 410, '记忆来源已撤回或修订');
    }
    return publicMemory(record);
  });
}

export async function retrieveMemories(userId, query, options = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw memoryError('INVALID_QUERY', 400, '查询内容不能为空');
  }
  return withReadableUser(userId, db => searchVisible(db, userId, query, options));
}

function searchVisible(db, userId, query, options) {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const start = options.dateRange?.start;
    const end = options.dateRange?.end;
    const result = [];
    for (const record of records(db)) {
      // Authoritative source and owner checks precede even candidate scoring.
      if (!available(record, db, userId)) continue;
      if (options.groupId && record.source?.groupId !== options.groupId) continue;
      if (options.category && record.category !== options.category) continue;
      if (options.senderId && record.ownerId !== options.senderId) continue;
      const day = record.recordedAt.slice(0, 10);
      if ((start && day < start) || (end && day > end)) continue;
      const memory = publicMemory(record);
      const content = memory.content.toLocaleLowerCase();
      const hits = terms.filter(term => content.includes(term)).length;
      if (!hits) continue;
      result.push({ memory, relevance: hits / terms.length, similarity: hits / terms.length });
    }
    result.sort((a, b) => b.relevance - a.relevance ||
      b.memory.recordedAt.localeCompare(a.memory.recordedAt));
    const limited = result.slice(0, options.limit || 10);
    return {
      query, results: limited, count: limited.length,
      totalCandidate: result.length, searchMode: 'literal_after_source_check',
      performance: { retrievalTime: null, accuracy: null, measured: false }
    };
}

export async function retrieveForConversation(userId, groupId, limit = 5) {
  return withReadableUser(userId, async db => {
    if (!db.data.groups?.some(group => group.id === groupId)) {
      throw memoryError('GROUP_NOT_FOUND', 404, '群组不存在或无权访问');
    }
    const recent = (await readableSourceMessages(userId, db)).filter(message =>
      message.group_id === groupId).slice(-5);
    const query = recent.map(message => {
      if (typeof message.content !== 'string') return '';
      return message.metadata?.encryption?.encrypted
        ? decryptText(message.content) : message.content;
    }).join(' ').trim().slice(0, 500);
    return query ? searchVisible(db, userId, query, { limit, groupId }) : {
      query: '', results: [], count: 0, totalCandidate: 0,
      searchMode: 'literal_after_source_check',
      performance: { retrievalTime: null, accuracy: null, measured: false }
    };
  });
}

export async function correctMemory(userId, memoryId, content, expectedRevision) {
  if (!validText(content) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw memoryError('INVALID_MEMORY', 400, '更正内容或修订号无效');
  }
  const db = await getUserDb(userId);
  return withWriteLock(userId, async () => {
    await db.read();
    const barrier = await localBarrier(userId, db);
    await reconcileBarrier(userId, db, barrier);
    const record = records(db).find(item => item.id === memoryId && item.ownerId === userId);
    if (!record) throw memoryError('MEMORY_NOT_FOUND', 404, '记忆不存在');
    if (record.state !== 'active') throw memoryError('MEMORY_FORGOTTEN', 410, '记忆已遗忘');
    if (record.kind !== 'user_note') throw memoryError('SOURCE_LINKED', 409, '来源摘录不能改写为已确认事实');
    if (record.revision !== expectedRevision) throw memoryError('STALE_MEMORY', 409, '记忆已有新修订');
    const changed = { ...record, content: encryptText(content), revision: record.revision + 1,
      updatedAt: stamp(), evidence: 'user_asserted', requestHash: null };
    await writeMemoryRecords(db, userId, records(db).map(item => item.id === memoryId ? changed : item));
    return publicMemory(changed);
  });
}

export async function forgetMemory(userId, memoryId) {
  const db = await getUserDb(userId);
  return withWriteLock(userId, async () => {
    await db.read();
    const barrier = await localBarrier(userId, db);
    await reconcileBarrier(userId, db, barrier);
    const record = records(db).find(item => item.id === memoryId && item.ownerId === userId);
    if (!record) throw memoryError('MEMORY_NOT_FOUND', 404, '记忆不存在');
    await barrierMark(barrier, userId, memoryId);
    if (record.state !== 'forgotten') {
      const changed = { ...record, state: 'forgotten', content: null, metadata: {}, source: null,
        requestHash: null, revision: record.revision + 1, updatedAt: stamp() };
      await writeMemoryRecords(db, userId, records(db).map(item => item.id === memoryId ? changed : item));
    }
    return { memoryId, forgotten: true };
  });
}

export async function forgetAllMemories(userId) {
  const db = await getUserDb(userId);
  return withWriteLock(userId, async () => {
    await db.read();
    const barrier = await localBarrier(userId, db);
    await reconcileBarrier(userId, db, barrier);
    for (const record of records(db)) {
      if (record.ownerId === userId && record.state !== 'forgotten') {
        await barrierMark(barrier, userId, record.id);
      }
    }
    let count = 0;
    const now = stamp();
    const nextRecords = records(db).map(record => {
      if (record.ownerId !== userId || record.state === 'forgotten') return record;
      count += 1;
      return { ...record, state: 'forgotten', content: null, metadata: {}, source: null,
        requestHash: null, revision: record.revision + 1, updatedAt: now };
    });
    if (count) await writeMemoryRecords(db, userId, nextRecords);
    return { forgottenCount: count };
  });
}
