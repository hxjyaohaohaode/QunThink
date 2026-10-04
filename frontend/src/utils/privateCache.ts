import { clearAllCachesForUser, getCacheUserId } from './cacheUtils';
import { clearAllIndexedDBForUser } from './indexedDB';

// Previous releases cached authenticated responses under URL-only cache keys.
// Remove those legacy caches on upgrade and logout; API responses are NetworkOnly.
export async function purgeLegacyPrivateCaches(): Promise<void> {
  if (!('caches' in globalThis)) return;
  await Promise.all(['tts-audio-cache', 'file-download-cache'].map(name => caches.delete(name))).catch(() => {});
}

export async function clearCurrentUserCache(): Promise<void> {
  const userId = getCacheUserId();
  if (userId) {
    clearAllCachesForUser(userId);
    await clearAllIndexedDBForUser(userId);
  }
  await purgeLegacyPrivateCaches();
}
