import { encryptData, decryptData } from './crypto';
import type { Message, Group } from '../types';

const CACHE_VERSION = '1.0';
const CACHE_EXPIRY_DAYS = 7;
const CACHE_PREFIX = 'app_cache_';
const ENCRYPTED_MARKER = 'enc_v1_';
const USER_ID_STORAGE_KEY = 'app_current_user_id';

let currentCacheUserId: string | null = null;

export function setCacheUserId(userId: string | null): void {
  const previousUserId = currentCacheUserId;
  currentCacheUserId = userId;
  if (userId) {
    try {
      localStorage.setItem(USER_ID_STORAGE_KEY, userId);
    } catch {}
    if (previousUserId !== userId) {
      migrateOldCaches(userId);
    }
  } else {
    try {
      localStorage.removeItem(USER_ID_STORAGE_KEY);
    } catch {}
  }
}

function migrateOldCaches(userId: string): void {
  try {
    const cacheKeys = ['messages_cache', 'groups_cache', 'personas_cache'];
    for (const key of cacheKeys) {
      const oldFullKey = CACHE_PREFIX + key;
      const raw = localStorage.getItem(oldFullKey);
      if (raw) {
        const newFullKey = CACHE_PREFIX + userId + '_' + key;
        if (!localStorage.getItem(newFullKey)) {
          localStorage.setItem(newFullKey, raw);
        }
        localStorage.removeItem(oldFullKey);
      }
    }
    if (import.meta.env.DEV) {
      console.log(`[Cache] Migrated old caches for user: ${userId}`);
    }
  } catch (e) {
    console.warn('[Cache] Migration failed:', e);
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
  try {
    const cacheData: CacheData<T> = {
      data,
      timestamp: Date.now(),
      version: CACHE_VERSION
    };
    localStorage.setItem(getFullKey(key), JSON.stringify(cacheData));
    return true;
  } catch (e) {
    console.warn('localStorage write failed:', e);
    clearOldCaches();
    try {
      const cacheData: CacheData<T> = {
        data,
        timestamp: Date.now(),
        version: CACHE_VERSION
      };
      localStorage.setItem(getFullKey(key), JSON.stringify(cacheData));
      return true;
    } catch (retryError) {
      console.warn('localStorage retry write failed:', retryError);
      // 更激进的清理：仅保留最近5个最活跃群组的缓存，或清理当前用户的所有缓存
      aggressiveCleanup();
      try {
        const cacheData: CacheData<T> = {
          data,
          timestamp: Date.now(),
          version: CACHE_VERSION
        };
        localStorage.setItem(getFullKey(key), JSON.stringify(cacheData));
        return true;
      } catch (lastError) {
        console.warn('localStorage aggressive cleanup still failed:', lastError);
        return false;
      }
    }
  }
}

export function loadCache<T>(key: string): T | null {
  const storageKey = getFullKey(key);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;

    if (isEncrypted(raw)) {
      return null;
    }
    
    const cache: CacheData<T> = JSON.parse(raw);
    
    if (cache.version !== CACHE_VERSION) {
      localStorage.removeItem(storageKey);
      return null;
    }
    
    const expiryMs = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - cache.timestamp > expiryMs) {
      localStorage.removeItem(storageKey);
      return null;
    }
    
    return cache.data;
  } catch (e) {
    try {
      localStorage.removeItem(storageKey);
    } catch {
    }
    console.warn('localStorage read failed:', e);
    return null;
  }
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
  try {
    localStorage.removeItem(getFullKey(key));
  } catch (e) {
    console.warn('localStorage remove failed:', e);
  }
}

export function clearOldCaches(): void {
  try {
    const userPrefix = CACHE_PREFIX + getUserPrefix();
    const keysToRemove: string[] = [];
    const expiryThreshold = 24 * 60 * 60 * 1000; // 24 hours
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(userPrefix)) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const cache = JSON.parse(raw);
            const timestamp = cache.timestamp || 0;
            // 删除超过24小时的缓存条目
            if (timestamp > 0 && Date.now() - timestamp > expiryThreshold) {
              keysToRemove.push(key);
            }
          }
        } catch {
          keysToRemove.push(key);
        }
      }
    }
    
    keysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        console.warn('Failed to remove cache key:', key, e);
      }
    });
  } catch (e) {
    console.warn('clearOldCaches failed:', e);
  }
}

function aggressiveCleanup(): void {
  try {
    const userPrefix = CACHE_PREFIX + getUserPrefix();
    // 收集所有缓存条目并按时间戳排序
    const entries: { key: string; timestamp: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(userPrefix)) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const cache = JSON.parse(raw);
            entries.push({ key, timestamp: cache.timestamp || 0 });
          }
        } catch {
          // 损坏的条目直接删除
          try { localStorage.removeItem(key!); } catch {}
        }
      }
    }
    
    // 按时间戳降序排序，保留最近5个条目，删除其余
    entries.sort((a, b) => b.timestamp - a.timestamp);
    const toDelete = entries.slice(5);
    for (const { key } of toDelete) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
    
    if (toDelete.length > 0) {
      console.warn(`[Cache] Aggressive cleanup: removed ${toDelete.length} entries, kept ${Math.min(entries.length, 5)} most recent`);
    }
  } catch (e) {
    console.warn('[Cache] Aggressive cleanup failed:', e);
    // 最后手段：清理当前用户的所有缓存
    try {
      clearAllCachesForUser();
    } catch {}
  }
}

export function clearAllCachesForUser(userId?: string): void {
  try {
    const prefix = userId ? `${CACHE_PREFIX}${userId}_` : `${CACHE_PREFIX}${getUserPrefix()}`;
    const keysToRemove: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
      } catch {}
    });
    
    if (import.meta.env.DEV) {
      console.log(`[Cache] Cleared ${keysToRemove.length} cache entries for user: ${userId || 'current'}`);
    }
  } catch (e) {
    console.warn('clearAllCachesForUser failed:', e);
  }
}

export function clearAllCaches(): void {
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

export function saveMessagesCache(
  messages: Record<string, Message[]>,
  config: CacheConfig = DEFAULT_CACHE_CONFIG
): boolean {
  try {
    const maxGroups = config.maxGroups || 3;
    const maxMessages = config.maxMessagesPerGroup || 100;
    
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
    
    return saveCache('messages_cache', trimmedMessages);
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
  if (isCryptoAvailable()) {
    try {
      const cacheData: CacheData<T> = {
        data,
        timestamp: Date.now(),
        version: CACHE_VERSION
      };
      const plainText = JSON.stringify(cacheData);
      const encrypted = await encryptData(plainText);
      if (encrypted) {
        localStorage.setItem(getFullKey(key), ENCRYPTED_MARKER + encrypted);
        return true;
      }
    } catch (e) {
      console.warn('加密缓存写入失败，回退到明文:', e);
    }
  }
  
  return saveCache(key, data);
}

export async function loadCacheAsync<T>(key: string): Promise<T | null> {
  const storageKey = getFullKey(key);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    
    if (isEncrypted(raw)) {
      const encryptedContent = raw.slice(ENCRYPTED_MARKER.length);
      const decrypted = await decryptData(encryptedContent);
      if (decrypted) {
        try {
          const cache: CacheData<T> = JSON.parse(decrypted);
          
          if (cache.version !== CACHE_VERSION) {
            localStorage.removeItem(storageKey);
            return null;
          }
          
          const expiryMs = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
          if (Date.now() - cache.timestamp > expiryMs) {
            localStorage.removeItem(storageKey);
            return null;
          }
          
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
      
      const expiryMs = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
      if (Date.now() - cache.timestamp > expiryMs) {
        localStorage.removeItem(storageKey);
        return null;
      }
      
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
    const maxGroups = config.maxGroups || 3;
    const maxMessages = config.maxMessagesPerGroup || 100;
    
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

    return await saveCacheAsync('messages_cache', trimmedMessages);
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
