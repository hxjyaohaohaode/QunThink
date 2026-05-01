import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RATE_LIMIT_FILE = path.join(__dirname, '..', '..', 'data', '.rate_limits.json');
const MEMORY_STORE = new Map();
const PERSIST_INTERVAL = 30 * 1000;
const MAX_ENTRIES = 10000;
let persistTimer = null;
let dirty = false;

function loadPersistedStore() {
  try {
    if (fsSync.existsSync(RATE_LIMIT_FILE)) {
      const data = fsSync.readFileSync(RATE_LIMIT_FILE, 'utf8');
      const parsed = JSON.parse(data);
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        const recent = entry.timestamps.filter(t => now - t < entry.windowMs);
        if (recent.length > 0) {
          MEMORY_STORE.set(key, { windowMs: entry.windowMs, timestamps: recent });
        }
      }
    }
  } catch (error) {
    console.warn('限流数据加载失败，使用空存储:', error.message);
  }
}

function savePersistedStore() {
  if (!dirty) return;
  try {
    const now = Date.now();
    const data = {};
    let count = 0;
    for (const [key, entry] of MEMORY_STORE.entries()) {
      if (count >= MAX_ENTRIES) break;
      const recent = entry.timestamps.filter(t => now - t < entry.windowMs);
      if (recent.length > 0) {
        data[key] = { windowMs: entry.windowMs, timestamps: recent };
        count++;
      }
    }
    fsSync.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(data), 'utf8');
    dirty = false;
  } catch (error) {
    console.warn('限流数据持久化失败:', error.message);
  }
}

function startPersistTimer() {
  if (persistTimer) return;
  persistTimer = setInterval(() => {
    savePersistedStore();
    pruneExpiredEntries();
  }, PERSIST_INTERVAL);
  if (typeof persistTimer.unref === 'function') {
    persistTimer.unref();
  }
}

function pruneExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of MEMORY_STORE.entries()) {
    const recent = entry.timestamps.filter(t => now - t < entry.windowMs);
    if (recent.length === 0) {
      MEMORY_STORE.delete(key);
    } else {
      entry.timestamps = recent;
    }
  }

  if (MEMORY_STORE.size > MAX_ENTRIES) {
    const entries = [...MEMORY_STORE.entries()]
      .map(([key, entry]) => ({ key, lastTime: Math.max(...entry.timestamps) }))
      .sort((a, b) => a.lastTime - b.lastTime);
    const toDelete = entries.slice(0, MEMORY_STORE.size - MAX_ENTRIES);
    for (const { key } of toDelete) {
      MEMORY_STORE.delete(key);
    }
  }
}

loadPersistedStore();
startPersistTimer();

const _cleanupTimer = setInterval(() => {
  pruneExpiredEntries();
}, 5 * 60 * 1000);

if (typeof _cleanupTimer.unref === 'function') {
  _cleanupTimer.unref();
}

export function cleanup() {
  clearInterval(_cleanupTimer);
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
  }
  savePersistedStore();
}

export function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60000;
  const maxRequests = options.maxRequests || 30;

  return function rateLimiter(req, res, next) {
    const authMode = process.env.AUTH_MODE || 'session';
    const key = authMode === 'dev' || !req.userId ? (req.ip || 'unknown') : req.userId;
    const storeKey = `${key}:${windowMs}:${maxRequests}`;
    const now = Date.now();

    if (!MEMORY_STORE.has(storeKey)) {
      MEMORY_STORE.set(storeKey, { windowMs, timestamps: [] });
    }

    const entry = MEMORY_STORE.get(storeKey);
    const recent = entry.timestamps.filter(t => now - t < windowMs);

    const resetTime = recent.length > 0 ? recent[0] + windowMs : now + windowMs;

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - recent.length)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetTime / 1000)));

    if (recent.length >= maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((resetTime - now) / 1000)));
      return res.status(429).json({
        error: '请求过于频繁',
        message: `请稍后再试（每${windowMs / 1000}秒最多${maxRequests}次请求）`
      });
    }

    recent.push(now);
    entry.timestamps = recent;
    dirty = true;
    next();
  };
}

export const rateLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 30 });
export const messageRateLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 30 });
export const fileRateLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 10 });
export const aiRateLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 20 });
export const queryRateLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 60 });

export const authRateLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 10 });
