/**
 * 群聊洞察结果缓存：(userId, groupId, days) -> payload，60s TTL。
 * 消息写入路径可调用 invalidateGroup(groupId) 主动失效，保证洞察准实时。
 */

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map();

function buildKey(userId, groupId, days) {
  return `${userId}:${groupId}:${days}`;
}

export function getInsightsCache(userId, groupId, days) {
  const key = buildKey(userId, groupId, days);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.payload;
  }
  if (hit) {
    cache.delete(key);
  }
  return null;
}

export function setInsightsCache(userId, groupId, days, payload) {
  if (cache.size >= MAX_ENTRIES) {
    cache.clear();
  }
  cache.set(buildKey(userId, groupId, days), { at: Date.now(), payload });
}

export function invalidateInsightsCache(userId, groupId) {
  for (const key of cache.keys()) {
    if (key.includes(`:${groupId}:`)) {
      cache.delete(key);
    }
  }
}
