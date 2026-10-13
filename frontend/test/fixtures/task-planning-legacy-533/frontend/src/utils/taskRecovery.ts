import { getCacheUserId } from './cacheUtils';
import { getAuthGeneration } from '../services/api';

/** These identifiers are not an offline content cache. Never put text in a receipt. */
export interface TaskCommandReceipt {
  key: string;
  action: 'create' | 'run' | 'save_revision' | 'accept_revision' | 'adopt_revision' | 'review_brief';
  taskId: string | null;
  baseRevisionId?: string | null;
  revisionId?: string;
  contentHash?: string;
  payloadHash: string;
  createdAt: string;
}
export interface DraftRecoveryRecord {
  body: string;
  baseRevisionId: string | null;
  savedAt: string;
}
const journalPrefix = 'qunthink_command_v1_';
const contentPrefix = 'qunthink_writing_v1_';
const preferencePrefix = 'qunthink_writing_preferences_v1_';
const keyDatabasePrefix = 'qunthink-writing-key-';
const generationPrefix = 'qunthink_writing_epoch_v1_';
function storedGeneration(user: string | null) {
  if (!user) return '';
  try { return localStorage.getItem(generationPrefix + encodeURIComponent(user)) || 'initial'; } catch { return 'storage-unavailable'; }
}
function contentEpochKey(user: string, taskId: string, kind: 'draft' | 'offline') { return generationPrefix + encodeURIComponent(user) + ':' + kind + ':' + encodeURIComponent(taskId); }
function storedContentEpoch(user: string, taskId: string, kind: 'draft' | 'offline') { try { return localStorage.getItem(contentEpochKey(user, taskId, kind)) || 'initial'; } catch { return 'storage-unavailable'; } }
function kindGeneration(user: string, kind: 'draft' | 'offline') { try { return localStorage.getItem(generationPrefix + encodeURIComponent(user) + ':' + kind) || 'initial'; } catch { return 'storage-unavailable'; } }
function bumpStoredGeneration(user: string, kind?: 'draft' | 'offline') {
  const key = generationPrefix + encodeURIComponent(user) + (kind ? ':' + kind : ''), value = crypto.randomUUID();
  localStorage.setItem(key, value);
  if (localStorage.getItem(key) !== value) throw new Error('无法隔离其他页面中的文稿保存，请关闭其他页面后重试');
}
let contentGeneration = 0;
const writeVersions = new Map<string, number>();
export const recoveryContext = () => { const user = getCacheUserId(); return { user, auth: getAuthGeneration(), generation: contentGeneration, storedGeneration: storedGeneration(user) }; };
export const recoveryCurrent = (scope: ReturnType<typeof recoveryContext>) => !!scope.user && scope.user === getCacheUserId() && scope.auth === getAuthGeneration() && scope.generation === contentGeneration && scope.storedGeneration === storedGeneration(scope.user);
const accountKey = (prefix: string, user: string) => prefix + encodeURIComponent(user) + ':';
function requireUser() { const user = getCacheUserId(); if (!user) throw new Error('请先登录，再保存文稿'); return user; }

export async function textHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
const receiptFields = new Set(['key', 'action', 'taskId', 'baseRevisionId', 'revisionId', 'contentHash', 'payloadHash', 'createdAt']);
const receiptActions = new Set(['create', 'run', 'save_revision', 'accept_revision', 'adopt_revision', 'review_brief']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/i;
const objectId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
class InvalidTaskReceiptError extends Error {
  constructor() { super('此设备的待核验记录不完整，已暂停新的提交。请保留当前文字，检查浏览器存储后重新读取；不要清除请求记录或站点数据'); }
}
function validReceipt(value: unknown, storedKey: string): value is TaskCommandReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !receiptFields.has(key)) || typeof item.key !== 'string' || !uuidPattern.test(item.key) || item.key !== storedKey || typeof item.action !== 'string' || !receiptActions.has(item.action)) return false;
  if (item.action === 'create' ? item.taskId !== null : !objectId(item.taskId)) return false;
  if (typeof item.payloadHash !== 'string' || !hashPattern.test(item.payloadHash) || typeof item.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(item.createdAt) || !Number.isFinite(Date.parse(item.createdAt))) return false;
  if ('baseRevisionId' in item && item.baseRevisionId !== null && (typeof item.baseRevisionId !== 'string' || !uuidPattern.test(item.baseRevisionId))) return false;
  if ('revisionId' in item && (typeof item.revisionId !== 'string' || !uuidPattern.test(item.revisionId))) return false;
  if ('contentHash' in item && (typeof item.contentHash !== 'string' || !hashPattern.test(item.contentHash))) return false;
  if (['create', 'run'].includes(item.action) && ['baseRevisionId', 'revisionId', 'contentHash'].some(key => key in item)) return false;
  if (['accept_revision', 'adopt_revision'].includes(item.action) && !objectId(item.revisionId)) return false;
  if (item.action === 'accept_revision' && (typeof item.contentHash !== 'string' || !hashPattern.test(item.contentHash))) return false;
  return true;
}
export function readTaskReceipts(): TaskCommandReceipt[] {
  const user = getCacheUserId(); if (!user) return [];
  try {
    const prefix = accountKey(journalPrefix, user), items: TaskCommandReceipt[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i); if (!key?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      // A concurrent tab can remove a confirmed key between enumeration and read.
      if (raw === null) continue;
      let item: unknown; try { item = JSON.parse(raw); } catch { throw new InvalidTaskReceiptError(); }
      if (!validReceipt(item, key.slice(prefix.length))) throw new InvalidTaskReceiptError();
      items.push(item);
    }
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  } catch (error) {
    if (error instanceof InvalidTaskReceiptError) throw error;
    throw new Error('无法读取待核验记录，已暂停新的提交。请检查浏览器存储后重新读取；不要清除请求记录');
  }
}
export function persistTaskReceipt(receipt: TaskCommandReceipt): void {
  const user = requireUser(), key = accountKey(journalPrefix, user) + receipt.key;
  // Construct an allowlisted object; callers cannot accidentally persist private text.
  const value = JSON.stringify({ key: receipt.key, action: receipt.action, taskId: receipt.taskId, baseRevisionId: receipt.baseRevisionId, revisionId: receipt.revisionId, contentHash: receipt.contentHash, payloadHash: receipt.payloadHash, createdAt: receipt.createdAt });
  try { localStorage.setItem(key, value); if (localStorage.getItem(key) !== value) throw new Error(); }
  catch { throw new Error('尚未发送：无法安全保存请求编号。请腾出浏览器存储空间后重试；文稿仍在编辑区'); }
}
export function removeTaskReceipt(key: string): void {
  const user = requireUser();
  localStorage.removeItem(accountKey(journalPrefix, user) + key);
}

export interface WritingPreferences { recoverDrafts: boolean; offlineCopies: boolean }
export function writingPreferences(): WritingPreferences {
  const user = getCacheUserId(); if (!user) return { recoverDrafts: false, offlineCopies: false };
  try { const value = JSON.parse(localStorage.getItem(preferencePrefix + encodeURIComponent(user)) || '{}'); return { recoverDrafts: value.recoverDrafts === true, offlineCopies: value.offlineCopies === true }; }
  catch { return { recoverDrafts: false, offlineCopies: false }; }
}
export function setWritingPreferences(value: WritingPreferences): void {
  const user = requireUser(), previous = writingPreferences();
  const key = preferencePrefix + encodeURIComponent(user), encoded = JSON.stringify(value);
  try { if (previous.recoverDrafts !== value.recoverDrafts) bumpStoredGeneration(user, 'draft'); if (previous.offlineCopies !== value.offlineCopies) bumpStoredGeneration(user, 'offline'); localStorage.setItem(key, encoded); if (localStorage.getItem(key) !== encoded) throw new Error(); }
  catch { throw new Error('无法保存此设备的文稿恢复选择，请检查浏览器存储空间'); }
  contentGeneration++; writeVersions.clear();
  const prefix = accountKey(contentPrefix, user);
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix) && ((!value.recoverDrafts && key.startsWith(prefix + 'draft:')) || (!value.offlineCopies && key.startsWith(prefix + 'offline:')))) localStorage.removeItem(key);
  }
}

async function encryptionKey(user: string): Promise<{ key: CryptoKey; db: IDBDatabase }> {
  if (!crypto?.subtle || typeof indexedDB === 'undefined') throw new Error('此浏览器无法加密恢复文稿，请先保存到服务器或下载文本');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(keyDatabasePrefix + encodeURIComponent(user), 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开文稿加密存储'));
    request.onblocked = () => reject(new Error('文稿加密存储被其他页面占用'));
  });
  try {
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const key = await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys'), request = store.get('key');
      let selected: CryptoKey;
      request.onsuccess = () => { selected = request.result || candidate; if (!request.result) store.put(selected, 'key'); };
      tx.oncomplete = () => resolve(selected);
      tx.onerror = tx.onabort = () => reject(new Error('无法保存文稿加密密钥'));
    });
    return { key, db };
  } catch (error) { db.close(); throw error; }
}
function contentKey(user: string, taskId: string, kind: 'draft' | 'offline') { return accountKey(contentPrefix, user) + kind + ':' + encodeURIComponent(taskId); }
function permitted(kind: 'draft' | 'offline') { const settings = writingPreferences(); return kind === 'draft' ? settings.recoverDrafts : settings.offlineCopies; }
/** Encryption and persistence settle before “recovered on this device” is shown. */
export async function saveWritingContent(taskId: string, value: DraftRecoveryRecord, kind: 'draft' | 'offline' = 'draft'): Promise<boolean> {
  const scope = recoveryContext(); if (!scope.user || !permitted(kind)) return false;
  const kindEpoch = kindGeneration(scope.user, kind), contentEpoch = storedContentEpoch(scope.user, taskId, kind);
  const stillCurrent = () => recoveryCurrent(scope) && kindGeneration(scope.user!, kind) === kindEpoch && storedContentEpoch(scope.user!, taskId, kind) === contentEpoch && permitted(kind);
  const storageKey = contentKey(scope.user, taskId, kind), revision = (writeVersions.get(storageKey) || 0) + 1;
  writeVersions.set(storageKey, revision);
  let db: IDBDatabase | undefined;
  try {
    const entry = await encryptionKey(scope.user); db = entry.db;
    if (!stillCurrent() || writeVersions.get(storageKey) !== revision || !permitted(kind)) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(storageKey) }, entry.key, new TextEncoder().encode(JSON.stringify(value)));
    if (!stillCurrent() || writeVersions.get(storageKey) !== revision || !permitted(kind)) return false;
    const bytes = JSON.stringify({ v: 1, generation: scope.storedGeneration, kind_generation: kindEpoch, content_generation: contentEpoch, iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) });
    localStorage.setItem(storageKey, bytes);
    // A second tab can clear between our pre-write check and this synchronous write.
    // A stale writer removes only its own ciphertext, never a later writer's value.
    if (!stillCurrent() || !permitted(kind)) { if (localStorage.getItem(storageKey) === bytes) localStorage.removeItem(storageKey); return false; }
    return localStorage.getItem(storageKey) === bytes;
  } catch { return false; } finally { db?.close(); }
}
export async function loadWritingContent(taskId: string, kind: 'draft' | 'offline' = 'draft'): Promise<DraftRecoveryRecord | null> {
  const scope = recoveryContext(); if (!scope.user || !permitted(kind)) return null;
  const kindEpoch = kindGeneration(scope.user, kind), contentEpoch = storedContentEpoch(scope.user, taskId, kind);
  const storageKey = contentKey(scope.user, taskId, kind), revision = writeVersions.get(storageKey) || 0;
  let db: IDBDatabase | undefined;
  try {
    const raw = localStorage.getItem(storageKey); if (!raw) return null;
    const value = JSON.parse(raw); if (value.v !== 1 || value.generation !== scope.storedGeneration || value.kind_generation !== kindEpoch || value.content_generation !== contentEpoch) return null;
    const entry = await encryptionKey(scope.user); db = entry.db;
    const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(value.iv), additionalData: new TextEncoder().encode(storageKey) }, entry.key, new Uint8Array(value.data));
    if (!recoveryCurrent(scope) || kindGeneration(scope.user, kind) !== kindEpoch || storedContentEpoch(scope.user, taskId, kind) !== contentEpoch || (writeVersions.get(storageKey) || 0) !== revision || !permitted(kind)) return null;
    const parsed = JSON.parse(new TextDecoder().decode(result));
    return typeof parsed.body === 'string' && (typeof parsed.baseRevisionId === 'string' || parsed.baseRevisionId === null) ? parsed : null;
  } catch { return null; } finally { db?.close(); }
}
export function removeWritingDraft(taskId: string, kind: 'draft' | 'offline' = 'draft') {
  const user = getCacheUserId(); if (!user) return;
  const key = contentKey(user, taskId, kind); writeVersions.set(key, (writeVersions.get(key) || 0) + 1);
  try {
    const markerKey = contentEpochKey(user, taskId, kind), marker = crypto.randomUUID();
    // Retire other tabs' pending encryption before removing this one content key.
    localStorage.setItem(markerKey, marker);
    if (localStorage.getItem(markerKey) !== marker) throw new Error();
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null;
  } catch { try { localStorage.removeItem(key); } catch {} return false; }
}
/** Content cleanup must never remove unresolved command identifiers. */
export function clearWritingContent(user = getCacheUserId()) {
  contentGeneration++; writeVersions.clear();
  if (!user) return true;
  const prefix = accountKey(contentPrefix, user);
  try { bumpStoredGeneration(user); for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) { localStorage.removeItem(key); if (localStorage.getItem(key) !== null) return false; } return true; } catch { return false; }
}
