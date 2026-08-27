import { JSONFile } from 'lowdb/node';
import { CustomLow } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import crypto from 'crypto';
import { isMongoEnabled, getMongoDb, MongoLow } from './mongoAdapter.js';
import { isSupabaseEnabled, PgLow } from './supabaseAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');
const authDbFile = process.env.AUTH_DB_PATH || path.join(dataDir, 'auth.json');

let authDb = null;

const defaultAuthData = {
  users: [],
  sessions: []
};

export async function initAuthDb() {
  if (isSupabaseEnabled()) {
    authDb = new PgLow('auth:main', defaultAuthData);

    try {
      await authDb.read();
    } catch (err) {
      console.warn(`⚠️ Supabase 认证数据库读取失败: ${err.message}`);
      if (process.env.NODE_ENV === 'production') throw err;
      authDb.data = JSON.parse(JSON.stringify(defaultAuthData));
    }

    for (const [key, value] of Object.entries(defaultAuthData)) {
      if (authDb.data[key] === undefined) {
        authDb.data[key] = JSON.parse(JSON.stringify(value));
      }
    }

    try {
      await cleanupExpiredSessions();
      console.log('✅ Supabase 认证数据库初始化完成');
      return authDb;
    } catch (err) {
      console.error(`❌ Supabase 认证数据库清理失败: ${err.message}`);
      if (process.env.NODE_ENV === 'production') throw err;
      console.warn('⚠️ Supabase 不可用，回退到本地文件存储');
      authDb = null;
    }
  }

  if (isMongoEnabled()) {
    const mongoDb = await getMongoDb();
    const collection = mongoDb.collection('auth_data');
    authDb = new MongoLow(collection, { id: 'main' }, defaultAuthData);

    try {
      await authDb.read();
    } catch (err) {
      console.warn(`⚠️ MongoDB 认证数据库读取失败: ${err.message}`);
      if (process.env.NODE_ENV === 'production') throw err;
      authDb.data = JSON.parse(JSON.stringify(defaultAuthData));
    }

    for (const [key, value] of Object.entries(defaultAuthData)) {
      if (authDb.data[key] === undefined) {
        authDb.data[key] = JSON.parse(JSON.stringify(value));
      }
    }

    try {
      await cleanupExpiredSessions();
      console.log('✅ MongoDB 认证数据库初始化完成');
      return authDb;
    } catch (err) {
      console.error(`❌ MongoDB 认证数据库初始化失败: ${err.message}`);
      if (process.env.NODE_ENV === 'production') throw err;
      console.warn('⚠️ MongoDB 不可用，回退到本地文件存储');
      authDb = null;
    }
  }

  const adapter = new JSONFile(authDbFile);
  authDb = new CustomLow(adapter, defaultAuthData);
  
  try {
    await fs.access(authDbFile);
  } catch {
    authDb.data = JSON.parse(JSON.stringify(defaultAuthData));
    await authDb.write();
    console.log('✅ 认证数据库已创建');
  }
  
  try {
    await authDb.read();
  } catch (err) {
    console.warn(`⚠️ 认证数据库读取失败，尝试恢复: ${err.message}`);
    try {
      const raw = await fs.readFile(authDbFile, 'utf-8');
      const firstObjEnd = raw.indexOf('}{');
      if (firstObjEnd > -1) {
        const clean = raw.substring(0, firstObjEnd + 1);
        const recovered = JSON.parse(clean);
        try {
          const backupPath = authDbFile + '.corrupted.' + Date.now();
          await fs.copyFile(authDbFile, backupPath);
          console.log(`📦 恢复前已备份损坏文件到: ${backupPath}`);
        } catch {}
        authDb.data = recovered;
        await authDb.write();
        console.log('✅ 认证数据库已从损坏中恢复');
      } else {
        throw err;
      }
    } catch (recoverErr) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`认证数据库损坏且恢复失败: ${recoverErr.message}`);
      }
      console.error('⚠️ 认证数据库恢复失败，保留磁盘原始数据，使用内存默认数据');
      try {
        const backupPath = authDbFile + '.corrupted.' + Date.now();
        await fs.copyFile(authDbFile, backupPath);
        console.log(`📦 损坏的认证数据库已备份到: ${backupPath}`);
      } catch {}
      authDb.data = JSON.parse(JSON.stringify(defaultAuthData));
    }
  }

  for (const [key, value] of Object.entries(defaultAuthData)) {
    if (authDb.data[key] === undefined) {
      authDb.data[key] = JSON.parse(JSON.stringify(value));
    }
  }

  await cleanupExpiredSessions();

  if (!globalThis.__authSessionPruneTimer) {
    const timer = setInterval(() => {
      cleanupExpiredSessions().catch(err => {
        console.warn('[Auth] 周期性会话清理失败:', err?.message);
      });
    }, 60 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    globalThis.__authSessionPruneTimer = timer;
  }

  return authDb;
}

export function getAuthDb() {
  if (!authDb) {
    throw new Error('认证数据库未初始化');
  }
  return authDb;
}

const pbkdf2Promise = (password, salt, iterations, keylen, digest) =>
  new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });

export async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await pbkdf2Promise(password, salt, 100000, 64, 'sha512');
  return `${salt}:${hash.toString('hex')}`;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPasswordAsync(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !hash) return false;
  const verifyHash = await pbkdf2Promise(password, salt, 100000, 64, 'sha512');
  const verifyHex = verifyHash.toString('hex');
  const hashBuf = Buffer.from(hash, 'utf-8');
  const verifyBuf = Buffer.from(verifyHex, 'utf-8');
  if (hashBuf.length !== verifyBuf.length) {
    crypto.timingSafeEqual(hashBuf.subarray(0, Math.min(hashBuf.length, verifyBuf.length)), verifyBuf.subarray(0, Math.min(hashBuf.length, verifyBuf.length)));
    return false;
  }
  return crypto.timingSafeEqual(hashBuf, verifyBuf);
}

export function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !hash) return false;
  const verifyHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  const hashBuf = Buffer.from(hash, 'utf-8');
  const verifyBuf = Buffer.from(verifyHash.toString('hex'), 'utf-8');
  if (hashBuf.length !== verifyBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, verifyBuf);
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function findSessionByToken(db, token) {
  if (!token) return null;
  return db.data.sessions.find(s => {
    if (!s?.token || s.token.length !== token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token));
    } catch {
      return false;
    }
  }) || null;
}

export function isAdminUserId(userId) {
  if (!userId) return false;
  const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return adminIds.includes(userId);
}

export async function cleanupExpiredSessions() {
  const db = getAuthDb();
  try {
    await db.read();
  } catch (err) {
    console.warn('[Auth] 读取会话数据失败:', err.message);
    return;
  }
  const now = new Date();
  const before = db.data.sessions.length;
  db.data.sessions = db.data.sessions.filter(s => new Date(s.expires_at) > now);
  if (db.data.sessions.length < before) {
    try {
      await db.write();
      console.log(`[Auth] Cleaned ${before - db.data.sessions.length} expired sessions`);
    } catch (err) {
      console.warn('[Auth] 写入会话数据失败:', err.message);
    }
  }
}
