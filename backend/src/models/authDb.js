import { JSONFile } from 'lowdb/node';
import { CustomLow } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authDbFile = process.env.AUTH_DB_PATH || path.join(__dirname, '../../data/auth.json');

let authDb = null;

const defaultAuthData = {
  users: [],
  sessions: []
};

export async function initAuthDb() {
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
        authDb.data = JSON.parse(clean);
        await authDb.write();
        console.log('✅ 认证数据库已从损坏中恢复');
      } else {
        throw err;
      }
    } catch (recoverErr) {
      console.warn('⚠️ 认证数据库恢复失败，使用默认数据');
      authDb.data = JSON.parse(JSON.stringify(defaultAuthData));
      await authDb.write();
    }
  }

  for (const [key, value] of Object.entries(defaultAuthData)) {
    if (authDb.data[key] === undefined) {
      authDb.data[key] = JSON.parse(JSON.stringify(value));
    }
  }

  await cleanupExpiredSessions();
  
  return authDb;
}

export function getAuthDb() {
  if (!authDb) {
    throw new Error('认证数据库未初始化');
  }
  return authDb;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return `${salt}:${hash.toString('hex')}`;
}

export function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return verifyHash.toString('hex') === hash;
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export async function cleanupExpiredSessions() {
  const db = getAuthDb();
  await db.read();
  const now = new Date();
  const before = db.data.sessions.length;
  db.data.sessions = db.data.sessions.filter(s => new Date(s.expires_at) > now);
  if (db.data.sessions.length < before) {
    await db.write();
    console.log(`[Auth] Cleaned ${before - db.data.sessions.length} expired sessions`);
  }
}
