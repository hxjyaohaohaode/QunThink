import { encryptData, decryptData } from './crypto';
import type { Message, Group } from '../types';

const CACHE_VERSION = '1.0';
const CACHE_EXPIRY_DAYS = 7;
const CACHE_PREFIX = 'app_cache_';
const ENCRYPTED_MARKER = 'enc_v1_';
const USER_ID_STORAGE_KEY = 'app_current_user_id';

let currentCacheUserId: string | null = null;

const memoryMirrors = new Map<string, CacheData<unknown>>();
const inFlightWrites = new Map<string, Promise<boolean>>();
const pendingWriteData = new Map<string, unknown>();
const keyRevisions = new Map<string, number>();
let cacheGeneration = 0;

function isCacheExpired(cache: CacheData<unknown>): boolean {
  const expiryMs = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - cache.timestamp > expiryMs;
}

function readMemoryMirror<T>(key: string): T | null {
  const cached = memoryMirrors.get(key);
  if (!cached) return null;
  if (isCacheExpired(cached)) {
    memoryMirrors.delete(key);
    return null;
  }
  return cached.data as T;
}

function writeMemoryMirror<T>(key: string, data: T): void {
  memoryMirrors.set(key, {
    data,
    timestamp: Date.now(),
    version: CACHE_VERSION
  });
}

function clearMemoryMirrors(): void {
  cacheGeneration++;
  memoryMirrors.clear();
  inFlightWrites.clear();
  pendingWriteData.clear();
  keyRevisions.clear();
}

function handleQuotaPressure(failedKey: string): void {
  try {
    const userPrefix = CACHE_PREFIX + getUserPrefix();
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storedKey = localStorage.key(i);
      if (storedKey && storedKey.startsWith(userPrefix)) {
        const raw = localStorage.getItem(storedKey);
        if (!raw || !isEncrypted(raw)) {
          keysToRemove.push(storedKey);
        }
      }
    }
    keysToRemove.forEach(storedKey => {
      try { localStorage.removeItem(storedKey); } catch {}
    });
    try { localStorage.removeItem(getFullKey(failedKey)); } catch {}
  } catch (e) {
    console.warn('[Cache] Quota cleanup failed:', e);
  }
}

async function writeEncryptedCache<T>(key: string, data: T): Promise<boolean> {
  const storageKey = getFullKey(key);
  const generation = cacheGeneration;
  const revision = keyRevisions.get(storageKey) || 0;
  const stillCurrent = () => generation === cacheGeneration && revision === (keyRevisions.get(storageKey) || 0);
  writeMemoryMirror(storageKey, data);

  // 写入进行中又有新数据到达：记录最新值，当前写入完成后补写一次，
  // 保证 localStorage 最终状态与最后一次写入一致（否则会被旧数据覆盖）。
  const inFlight = inFlightWrites.get(storageKey);
  if (inFlight) {
    pendingWriteData.set(storageKey, data as unknown);
    return inFlight;
  }

  const runWrite = async (): Promise<boolean> => {
    let payload: unknown = data;
    let result = false;
    for (;;) {
      if (!stillCurrent()) return false;
      const cacheData: CacheData<unknown> = {
        data: payload,
        timestamp: Date.now(),
        version: CACHE_VERSION
      };
      result = false;
      if (isCryptoAvailable()) {
        try {
          const encrypted = await encryptData(JSON.stringify(cacheData));
          if (!stillCurrent()) return false;
          if (encrypted) {
            try {
              localStorage.setItem(storageKey, ENCRYPTED_MARKER + encrypted);
              result = true;
            } catch (quotaError) {
              console.warn('加密缓存写入失败（配额），清理后重试:', quotaError);
              handleQuotaPressure(key);
              try {
                if (!stillCurrent()) return false;
                localStorage.setItem(storageKey, ENCRYPTED_MARKER + encrypted);
                result = true;
              } catch (retryError) {
                console.warn('加密缓存重试写入失败:', retryError);
              }
            }
          }
        } catch (e) {
          console.warn('加密缓存写入失败:', e);
        }
      }
      const next = pendingWriteData.get(storageKey);
      if (next === undefined) {
        break;
      }
      pendingWriteData.delete(storageKey);
      payload = next;
    }
    return result;
  };

  let writePromise!: Promise<boolean>;
  writePromise = (async () => {
    try {
      return await runWrite();
    } finally {
      if (inFlightWrites.get(storageKey) === writePromise) {
        inFlightWrites.delete(storageKey);
      }
      if (stillCurrent() && pendingWriteData.has(storageKey)) {
        const nextData = pendingWriteData.get(storageKey);
        pendingWriteData.delete(storageKey);
        if (nextData !== undefined) {
          void writeEncryptedCache(key, nextData);
        }
      }
    }
  })();

  inFlightWrites.set(storageKey, writePromise);
  return writePromise;
}

export function setCacheUserId(userId: string | null): void {
  const previousUserId = currentCacheUserId;
  currentCacheUserId = userId;
  if (previousUserId !== userId) {
    clearMemoryMirrors();
  }
  if (userId) {
    try {
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    } catch {}
    // Legacy unscoped cache has no reliable owner. Leave its bytes isolated;
    // never attach another person's history or draft to the next login.
  } else {
    try {
      localStorage.removeItem(USER_ID_STORAGE_KEY);
    } catch {}
  }
}

export function getCacheUserId(): string | null {
  if (currentCacheUserId) return currentCacheUserId;
  try {
    return localStorage.getItem(USER_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getUserPrefix(): string {
  const userId = getCacheUserId();
  return userId ? `${userId}_` : '';
}

function getFullKey(key: string): string {
  return CACHE_PREFIX + getUserPrefix() + key;
}

export interface CacheData<T> {
  data: T;
  timestamp: number;
  version: string;
}

export interface CacheConfig {
  maxGroups?: number;
  maxMessagesPerGroup?: number;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxGroups: 3,
  maxMessagesPerGroup: 100
};

export function saveCache<T>(key: string, data: T): boolean {
  writeEncryptedCache(key, data).catch(() => { });
  return true;
}

export function loadCache<T>(key: string): T | null {
  return readMemoryMirror<T>(getFullKey(key));
}

export function isCacheEncrypted(key: string): boolean {
  try {
    const raw = localStorage.getItem(getFullKey(key));
    return raw !== null && isEncrypted(raw);
  } catch {
    return false;
  }
}

export function removeCache(key: string): void {
  const storageKey = getFullKey(key);
  keyRevisions.set(storageKey, (keyRevisions.get(storageKey) || 0) + 1);
  memoryMirrors.delete(storageKey);
  inFlightWrites.delete(storageKey);
  pendingWriteData.delete(storageKey);
  try {
    localStorage.removeItem(storageKey);
  } catch (e) {
    console.warn('localStorage remove failed:', e);
  }
}

export function clearAllCachesForUser(userId?: string): boolean {
  clearMemoryMirrors();
  try {
    const prefix = userId ? `${CACHE_PREFIX}${userId}_` : `${CACHE_PREFIX}${getUserPrefix()}`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keysToRemove.push(key);
    }
    let cleared = true;
    for (const key of keysToRemove) {
      try {
        localStorage.removeItem(key);
        if (localStorage.getItem(key) !== null) cleared = false;
      } catch { cleared = false; }
    }
    if (!cleared) console.warn('[Cache] Local cleanup incomplete');
    return cleared;
  } catch {
    console.warn('[Cache] Local cleanup unavailable');
    return false;
  }
}

export function clearAllCaches(): void {
  clearMemoryMirrors();
  try {
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
      } catch {}
    });
  } catch (e) {
    console.warn('clearAllCaches failed:', e);
  }
}

function trimMessagesForCache(
  messages: Record<string, Message[]>,
  config: CacheConfig
): Record<string, Message[]> {
  const maxGroups = config.maxGroups || DEFAULT_CACHE_CONFIG.maxGroups!;
  const maxMessages = config.maxMessagesPerGroup || DEFAULT_CACHE_CONFIG.maxMessagesPerGroup!;

  const groupIds = Object.keys(messages);

  let selectedGroups: { id: string; lastActivity: number }[] = groupIds.map(id => {
    const msgs = messages[id] || [];
    const lastMsg = msgs[msgs.length - 1];
    return {
      id,
      lastActivity: lastMsg?.created_at ? new Date(lastMsg.created_at).getTime() : 0
    };
  });

  selectedGroups.sort((a, b) => b.lastActivity - a.lastActivity);
  selectedGroups = selectedGroups.slice(0, maxGroups);

  const trimmedMessages: Record<string, Message[]> = {};
  for (const { id } of selectedGroups) {
    const msgs = messages[id] || [];
    trimmedMessages[id] = msgs.slice(-maxMessages);
  }

  return trimmedMessages;
}

export function saveMessagesCache(
  messages: Record<string, Message[]>,
  config: CacheConfig = DEFAULT_CACHE_CONFIG
): boolean {
  try {
    return saveCache('messages_cache', trimMessagesForCache(messages, config));
  } catch (e) {
    console.warn('saveMessagesCache failed:', e);
    return false;
  }
}

export function loadMessagesCache(): Record<string, Message[]> | null {
  return loadCache<Record<string, Message[]>>('messages_cache');
}

export function saveGroupsCache(groups: Group[]): boolean {
  return saveCache('groups_cache', groups);
}

export function loadGroupsCache<T>(): T | null {
  return loadCache<T>('groups_cache');
}

export function savePersonasCache(personas: Record<string, import('../stores/personasStore').PersonaConfig>): boolean {
  return saveCache('personas_cache', personas);
}

export function loadPersonasCache<T>(): T | null {
  return loadCache<T>('personas_cache');
}

export function saveProfileCache(profile: import('../stores/profileStore').UserProfile): boolean {
  return saveCache('profile_cache', profile);
}

export function loadProfileCache<T>(): T | null {
  return loadCache<T>('profile_cache');
}

function isCryptoAvailable(): boolean {
  return typeof window !== 'undefined' &&
         typeof window.crypto !== 'undefined' &&
         typeof window.crypto.subtle !== 'undefined';
}

function isEncrypted(raw: string): boolean {
  return raw.startsWith(ENCRYPTED_MARKER);
}

export async function saveCacheAsync<T>(key: string, data: T): Promise<boolean> {
  return writeEncryptedCache(key, data);
}

export async function loadCacheAsync<T>(key: string): Promise<T | null> {
  const storageKey = getFullKey(key);
  const generation = cacheGeneration;
  const revision = keyRevisions.get(storageKey) || 0;
  const mirrored = readMemoryMirror<T>(storageKey);
  if (mirrored !== null) {
    return mirrored;
  }

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;

    if (isEncrypted(raw)) {
      const encryptedContent = raw.slice(ENCRYPTED_MARKER.length);
      const decrypted = await decryptData(encryptedContent);
      if (generation !== cacheGeneration || revision !== (keyRevisions.get(storageKey) || 0)) return null;
      const newerMirror = readMemoryMirror<T>(storageKey);
      if (newerMirror !== null) return newerMirror;
      if (decrypted) {
        try {
          const cache: CacheData<T> = JSON.parse(decrypted);

          if (cache.version !== CACHE_VERSION) {
            localStorage.removeItem(storageKey);
            return null;
          }

          if (isCacheExpired(cache)) {
            localStorage.removeItem(storageKey);
            return null;
          }

          writeMemoryMirror(storageKey, cache.data);
          return cache.data;
        } catch (parseError) {
          console.warn('解密数据解析失败:', parseError);
          localStorage.removeItem(storageKey);
          return null;
        }
      }
      localStorage.removeItem(storageKey);
      return null;
    }

    try {
      const cache: CacheData<T> = JSON.parse(raw);

      if (cache.version !== CACHE_VERSION) {
        localStorage.removeItem(storageKey);
        return null;
      }

      if (isCacheExpired(cache)) {
        localStorage.removeItem(storageKey);
        return null;
      }

      writeMemoryMirror(storageKey, cache.data);
      return cache.data;
    } catch (e) {
      try {
        localStorage.removeItem(storageKey);
      } catch {}
      return null;
    }
  } catch (e) {
    console.warn('异步缓存读取失败:', e);
    return null;
  }
}

export async function saveMessagesCacheAsync(
  messages: Record<string, Message[]>,
  config: CacheConfig = DEFAULT_CACHE_CONFIG
): Promise<boolean> {
  try {
    return await saveCacheAsync('messages_cache', trimMessagesForCache(messages, config));
  } catch (e) {
    console.warn('saveMessagesCacheAsync failed:', e);
    return false;
  }
}

export async function loadMessagesCacheAsync(): Promise<Record<string, Message[]> | null> {
  return await loadCacheAsync<Record<string, Message[]>>('messages_cache');
}

export async function saveGroupsCacheAsync(groups: Group[]): Promise<boolean> {
  return await saveCacheAsync('groups_cache', groups);
}

export async function loadGroupsCacheAsync<T>(): Promise<T | null> {
  return await loadCacheAsync<T>('groups_cache');
}

export async function savePersonasCacheAsync(personas: Record<string, import('../stores/personasStore').PersonaConfig>): Promise<boolean> {
  return await saveCacheAsync('personas_cache', personas);
}

export async function loadPersonasCacheAsync<T>(): Promise<T | null> {
  return await loadCacheAsync<T>('personas_cache');
}

export async function saveProfileCacheAsync(profile: import('../stores/profileStore').UserProfile): Promise<boolean> {
  return await saveCacheAsync('profile_cache', profile);
}

export async function loadProfileCacheAsync<T>(): Promise<T | null> {
  return await loadCacheAsync<T>('profile_cache');
}
