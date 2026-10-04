import { clearWritingContent } from './taskRecovery';
import { invalidateLocalCacheWork } from './localCacheLifecycle';
import { clearAllCachesForUser, getCacheUserId } from './cacheUtils';
import { clearAllIndexedDBForUser } from './indexedDB';

// Previous releases cached authenticated responses under URL-only cache keys.
// Remove those legacy caches on upgrade and logout; API responses are NetworkOnly.
export async function purgeLegacyPrivateCaches(): Promise<boolean> {
  if (!('caches' in globalThis)) return false;
  try {
    // A fulfilled false means that cache was already absent, which is success.
    await Promise.all(['tts-audio-cache', 'file-download-cache'].map(name => caches.delete(name)));
    return true;
  } catch { return false; }
}

export async function clearCurrentUserCache(): Promise<void> {
  const userId = getCacheUserId();
  invalidateLocalCacheWork();
  const writingCleared = clearWritingContent(userId);
  const localCleared = clearAllCachesForUser(userId ?? undefined);
  const indexedCleared = await clearAllIndexedDBForUser(userId ?? undefined);
  const legacyCleared = await purgeLegacyPrivateCaches();
  if (!writingCleared || !localCleared || !indexedCleared || !legacyCleared) {
    throw Object.assign(new Error('缓存清理尚未完成，可能被其他页面占用。请关闭其他标签页后重试。'), { code: 'CACHE_CLEAR_INCOMPLETE' });
  }
}
