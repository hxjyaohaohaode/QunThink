import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { Mutex } from 'async-mutex';
import { isMongoEnabled, getMongoDb, MongoLow } from './mongoAdapter.js';
import { isSupabaseEnabled, PgLow, listAllKeys, getPool } from './supabaseAdapter.js';
import { encryptText, decryptText } from '../utils/encryption.js';
import { readWithWriteBarrier } from './readBarrier.js';
export { beginUserDbWriteBarrier, readCommittedUserDb } from './readBarrier.js';

const _writeTimestamps = new WeakMap();
const _lastReadTimestamps = new WeakMap();


function isEncryptedEnvelope(value) {
  return typeof value === 'string'
    && value.startsWith('{')
    && value.includes('"encrypted"');
}

function coerceToPlaintext(content) {
  if (!isEncryptedEnvelope(content)) {
    return typeof content === 'string' ? content : '';
  }
  try {
    const decrypted = decryptText(content);
    return typeof decrypted === 'string' ? decrypted : '';
  } catch {
    return '';
  }
}

function encryptStoredValue(plaintext) {
  if (!plaintext) return null;
  try {
    return encryptText(plaintext);
  } catch {
    return null;
  }
}

class CustomLow extends Low {
  invalidateReadCache() {
    // A write can commit without an acknowledgement. Callers recovering from
    // that uncertainty must not expose a pre-write snapshot as cached truth.
    // A failed read never restores this timestamp; only a durable read does.
    _lastReadTimestamps.delete(this);
  }

  async write() {
    try {
      await super.write();
      _writeTimestamps.set(this, Date.now());
    } catch (err) {
      if ((err.code === 'ENOENT' || err.code === 'EPERM') && err.syscall === 'rename') {
        let filePath = null;
        if (err.dest) {
          filePath = err.dest;
        } else if (err.path) {
          const tmpPath = err.path;
          const match = tmpPath.match(/^(.+)[/\\]\.([^/\\]+)\.tmp$/);
          if (match) {
            filePath = match[1] + path.sep + match[2];
          }
        }
        if (filePath) {
          try {
            const dir = path.dirname(filePath);
            const tmpFallback = path.join(dir, `.${path.basename(filePath)}.fb-${Date.now()}.tmp`);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(tmpFallback, JSON.stringify(this.data, null, 2), 'utf-8');
            await fs.rename(tmpFallback, filePath);
            _writeTimestamps.set(this, Date.now());
            return;
          } catch (writeErr) {
            console.warn(`Fallback write also failed: ${writeErr.message}`);
          }
        }
        console.warn('steno rename failed and could not determine file path for fallback write');
      }
      throw err;
    }
  }

  async read({ force = false } = {}) {
    return readWithWriteBarrier(this, async () => {
      const lastWrite = _writeTimestamps.get(this);
      const lastRead = _lastReadTimestamps.get(this);
      if (!force && lastWrite && lastRead && lastRead >= lastWrite && this.data) return { cached: true };
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try { return { data: await this.adapter.read() }; }
        catch (err) {
          if (err instanceof SyntaxError && err.message.includes('JSON') && attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    }, result => {
      if (!result.cached) {
        if (result.data) this.data = result.data;
        _lastReadTimestamps.set(this, Date.now());
      }
    });
  }

}

const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BACKUPS = 24;

export async function createBackup(dbPath) {
  try {
    // Keep each account's retention separate; the old shared directory let
    // similarly timed backups overwrite one another and share a 24-file cap.
    const backupDir = path.join(path.dirname(dbPath), 'backups', path.basename(dbPath, '.json'));
    await fs.mkdir(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `db-${timestamp}-${randomUUID()}.json`);
    const data = await fs.readFile(dbPath, 'utf-8');
    JSON.parse(data);
    await fs.writeFile(backupPath, data, { encoding: 'utf-8', flag: 'wx' });
    const files = await fs.readdir(backupDir);
    const backupFiles = files.filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
    while (backupFiles.length > MAX_BACKUPS) {
      const toDelete = backupFiles.shift();
      await fs.unlink(path.join(backupDir, toDelete));
    }
  } catch (err) {
    console.warn(`Database backup failed for ${dbPath}:`, err.message);
  }
}

const backupTimer = setInterval(async () => {
  try {
    for (const [userId] of userDbs) {
      const dbFile = getUserDbPath(userId);
      try {
        await fs.access(dbFile);
        await createBackup(dbFile);
      } catch {}
    }
  } catch {}
}, BACKUP_INTERVAL_MS);
if (typeof backupTimer.unref === 'function') backupTimer.unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');
const usersDataDir = path.join(dataDir, 'users');
const legacyDbFile = path.join(dataDir, 'db.json');
const uploadsDir = path.join(dataDir, 'uploads');

const userDbs = new Map();
const userMutexes = new Map();
const MAX_DB_CACHE_SIZE = 50;

function evictLeastRecentlyUsed() {
  if (userDbs.size <= MAX_DB_CACHE_SIZE) return;

  const entries = [...userDbs.entries()];
  entries.sort((a, b) => (a[1]._lastAccess || 0) - (b[1]._lastAccess || 0));

  const excess = userDbs.size - MAX_DB_CACHE_SIZE;
  const toEvict = [];
  for (const entry of entries) {
    if (toEvict.length >= excess) break;
    const mutex = userMutexes.get(entry[0]);
    if (mutex?.isLocked()) continue;
    toEvict.push(entry);
  }
  for (const [userId] of toEvict) {
    userDbs.delete(userId);
  }

  if (toEvict.length > 0) {
    console.log(`🗑️ LRU缓存淘汰: 移除了 ${toEvict.length} 个用户数据库缓存`);
  }
}

let defaultDb = null;

function getUserMutex(userId) {
  if (!userMutexes.has(userId)) {
    userMutexes.set(userId, new Mutex());
  }
  return userMutexes.get(userId);
}

export { CustomLow };

export async function withWriteLock(userId, fn) {
  const mutex = getUserMutex(userId);
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function safeWrite(userId, db) {
  return withWriteLock(userId, async () => {
    await db.write();
  });
}

const defaultUserData = {
  groups: [],
  messages: [],
  files: [],
  interaction_logs: [],
  monitoring_events: [],
  userProfile: {
    nickname: '',
    gender: '',
    age: null,
    height: null,
    weight: null,
    occupation: '',
    education: '',
    hobbies: [],
    personality: [],
    goals: '',
    bio: ''
  },
  customPersonas: {},
  agents: [],
  agent_messages: []
};

function buildMessagePreview(message) {
  if (!message) return null;
  const prefix = message.sender_type === 'user' ? '[我] ' : '';
  return `${prefix}${coerceToPlaintext(message.content).substring(0, 50)}`;
}

export function updateGroupActivity(group, message) {
  if (!group) return;
  group.last_message_at = message?.created_at || group.created_at;
  group.last_message_preview = encryptStoredValue(buildMessagePreview(message));
}

export function updateGroupActivityById(db, groupId, message) {
  const group = db.data.groups.find(entry => entry.id === groupId);
  updateGroupActivity(group, message);
}

export function resetGroupActivity(db, groupId) {
  const group = db.data.groups.find(entry => entry.id === groupId);
  if (!group) return;

  for (let i = db.data.messages.length - 1; i >= 0; i--) {
    const message = db.data.messages[i];
    if (message.group_id === groupId) {
      updateGroupActivity(group, message);
      return;
    }
  }

  group.last_message_at = group.created_at;
  group.last_message_preview = null;
}

export function decryptGroupPreview(preview) {
  if (!preview) return null;
  if (!isEncryptedEnvelope(preview)) {
    return typeof preview === 'string' ? preview : null;
  }
  try {
    return decryptText(preview);
  } catch {
    return '[消息]';
  }
}

export function sanitizeGroupForClient(group) {
  if (!group || typeof group !== 'object') return group;
  const copy = { ...group };
  copy.last_message_preview = decryptGroupPreview(copy.last_message_preview);
  return copy;
}

export function sanitizeGroupsForClient(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map(sanitizeGroupForClient);
}

function getUserDbPath(userId) {
  return path.join(usersDataDir, `db_${userId}.json`);
}

function createDefaultGroups() {
  const now = new Date().toISOString();

  return [
    {
      id: 'group-presidential',
      name: '智囊团会议室',
      description: '多个 AI 专家各抒己见，从不同角度分析问题',
      type: 'preset',
      is_private: false,
      background_url: null,
      announcement: '',
      notifications_enabled: true,
      debate_mode: false,
      debate_level: 1,
      debate_config: null,
      ai_members: ['deepseek', 'deepseek_reasoner', 'glm_air', 'qwen_flash'],
      created_at: now,
      last_message_at: now,
      last_message_preview: null
    },
    {
      id: 'group-debate',
      name: '辩论竞技场',
      description: 'AI 之间互相质疑、辩驳，激发深度思考',
      type: 'preset',
      is_private: false,
      background_url: null,
      announcement: '',
      notifications_enabled: true,
      debate_mode: true,
      debate_level: 2,
      debate_config: null,
      ai_members: ['deepseek', 'glm_flash', 'mimo_omni', 'qwen_turbo'],
      created_at: now,
      last_message_at: now,
      last_message_preview: null
    },
    {
      id: 'group-collaborative',
      name: '共创工作台',
      description: 'AI 们合作完成一个任务，接力式推进',
      type: 'preset',
      is_private: false,
      background_url: null,
      announcement: '',
      notifications_enabled: true,
      debate_mode: false,
      debate_level: 0,
      debate_config: null,
      ai_members: ['glm_air', 'mimo_flash', 'qwen_flash', 'glm_flashx'],
      created_at: now,
      last_message_at: now,
      last_message_preview: null
    }
  ];
}

export async function initUserDatabase(userId) {
  if (isSupabaseEnabled()) {
    const key = `user:${userId}`;
    const pgLow = new PgLow(key, defaultUserData);
    try {
      await pgLow.read();
    } catch (err) {
      console.warn(`⚠️ Supabase 用户 ${userId} 数据读取失败: ${err.message}`);
      throw err;
    }

    if (!pgLow._degradedRead && pgLow.data.groups.length === 0) {
      pgLow.data.groups = createDefaultGroups();
      try {
        await pgLow.write();
        console.log(`✅ Supabase: 用户 ${userId} 数据库初始化完成`);
      } catch (writeErr) {
        console.error(`❌ Supabase 用户 ${userId} 数据写入失败: ${writeErr.message}`);
        throw writeErr;
      }
    }

    return getUserDb(userId);
  }

  if (isMongoEnabled()) {
    const mongoDb = await getMongoDb();
    const collection = mongoDb.collection('users_data');
    const existing = await collection.findOne({ userId });
    if (!existing) {
      const initialData = JSON.parse(JSON.stringify(defaultUserData));
      initialData.groups = createDefaultGroups();
      const mongoLow = new MongoLow(collection, { userId }, defaultUserData);
      mongoLow.data = initialData;
      await mongoLow.write();
      userDbs.set(userId, mongoLow);
      console.log(`✅ MongoDB: 用户 ${userId} 数据库初始化完成`);
    }
    return getUserDb(userId);
  }

  const dbPath = getUserDbPath(userId);
  
  try {
    await fs.access(dbPath);
    console.log(`✅ 用户数据库文件已存在: ${userId}`);
  } catch (error) {
    console.log(`📁 创建用户数据库文件: ${userId}`);
    const adapter = new JSONFile(dbPath);
    const db = new CustomLow(adapter, JSON.parse(JSON.stringify(defaultUserData)));
    
    db.data.groups = createDefaultGroups();
    
    try {
      await fs.writeFile(dbPath, JSON.stringify(db.data, null, 2), 'utf-8');
      console.log(`✅ 用户数据库初始化完成: ${userId}`);
    } catch (writeError) {
      console.warn(`⚠️ 直接写入失败，尝试使用lowdb写入: ${writeError.message}`);
      await db.write();
      console.log(`✅ 用户数据库初始化完成: ${userId}`);
    }
  }
  
  return getUserDb(userId);
}

/**
 * 获取用户专属的数据库实例
 *
 * 这是获取用户数据库的标准方法。每个用户拥有独立的 JSON 文件存储数据，
 * 实现多用户之间的数据完全隔离。
 *
 * 数据库结构：
 * - groups: 群组列表
 * - messages: 消息列表（评论嵌套在message.comments中）
 * - files: 文件记录
 * - interaction_logs: 互动日志
 * - monitoring_events: 监控事件
 * - userProfile: 用户画像
 * - customPersonas: 自定义 AI 人设
 *
 * 使用方式：
 *   const db = await getUserDb(userId);
 *   await db.read();
 *   const messages = db.data.messages;
 *   await db.write();
 *
 * 注意：
 * - 已加载的数据库会被缓存，避免重复读取文件
 * - 使用 withWriteLock() 进行写操作以保证数据一致性
 *
 * @param {string} userId - 用户唯一标识
 * @returns {Promise<Low>} Lowdb 数据库实例
 */
export async function getUserDb(userId) {
  if (userDbs.has(userId)) {
    const db = userDbs.get(userId);
    db._lastAccess = Date.now();
    return db;
  }

  if (isSupabaseEnabled()) {
    const key = `user:${userId}`;
    const db = new PgLow(key, defaultUserData);

    try {
      await db.read();
      db._degradedRead = false;
    } catch (err) {
      console.warn(`⚠️ Supabase 用户 ${userId} 数据读取失败: ${err.message}`);
      throw err;
    }

    let needsWrite = false;
    for (const [k, value] of Object.entries(defaultUserData)) {
      if (db.data[k] === undefined) {
        db.data[k] = JSON.parse(JSON.stringify(value));
        needsWrite = true;
      }
    }

    if (!db._degradedRead && db.data.groups.length === 0) {
      db.data.groups = createDefaultGroups();
      needsWrite = true;
    }


    for (const group of db.data.groups) {
      if (group.last_message_at === undefined || group.last_message_preview === undefined) {
        resetGroupActivity(db, group.id);
        needsWrite = true;
      }
    }

    if (needsWrite && !db._degradedRead) {
      await db.write();
    } else if (needsWrite && db._degradedRead) {
      console.warn(`⚠️ [Supabase] 用户 ${userId} 处于降级读取状态，跳过初始化写入以保护远端数据`);
    }

    userDbs.set(userId, db);
    db._lastAccess = Date.now();
    evictLeastRecentlyUsed();

    console.log(`📖 [Supabase] 用户 ${userId} 数据加载完成 - 消息: ${db.data.messages.length}, 群组: ${db.data.groups.length}`);
    return db;
  }

  if (isMongoEnabled()) {
    const mongoDb = await getMongoDb();
    const collection = mongoDb.collection('users_data');
    const db = new MongoLow(collection, { userId }, defaultUserData);

    try {
      await db.read();
      db._degradedRead = false;
    } catch (err) {
      console.warn(`⚠️ MongoDB 用户 ${userId} 数据读取失败: ${err.message}`);
      throw err;
    }

    let needsWrite = false;
    for (const [key, value] of Object.entries(defaultUserData)) {
      if (db.data[key] === undefined) {
        db.data[key] = JSON.parse(JSON.stringify(value));
        needsWrite = true;
      }
    }

    if (!db._degradedRead && db.data.groups.length === 0) {
      db.data.groups = createDefaultGroups();
      needsWrite = true;
    }


    for (const group of db.data.groups) {
      if (group.last_message_at === undefined || group.last_message_preview === undefined) {
        resetGroupActivity(db, group.id);
        needsWrite = true;
      }
    }

    if (needsWrite && !db._degradedRead) {
      await db.write();
    } else if (needsWrite && db._degradedRead) {
      console.warn(`⚠️ [MongoDB] 用户 ${userId} 处于降级读取状态，跳过初始化写入以保护远端数据`);
    }

    userDbs.set(userId, db);
    db._lastAccess = Date.now();
    evictLeastRecentlyUsed();

    console.log(`📖 [MongoDB] 用户 ${userId} 数据加载完成 - 消息: ${db.data.messages.length}, 群组: ${db.data.groups.length}`);
    return db;
  }
  
  const dbPath = getUserDbPath(userId);
  const adapter = new JSONFile(dbPath);
  const db = new CustomLow(adapter, JSON.parse(JSON.stringify(defaultUserData)));
  
  try {
    await db.read();
    db._degradedRead = false;
  } catch (err) {
    console.warn(`⚠️ 用户 ${userId} 数据库读取失败，尝试恢复: ${err.message}`);
    try {
      const raw = await fs.readFile(dbPath, 'utf-8');
      const firstObjEnd = raw.indexOf('}{');
      if (firstObjEnd > -1) {
        const clean = raw.substring(0, firstObjEnd + 1);
        const recovered = JSON.parse(clean);
        try {
          const backupPath = dbPath + '.corrupted.' + Date.now();
          await fs.copyFile(dbPath, backupPath);
          console.log(`📦 恢复前已备份损坏文件到: ${backupPath}`);
        } catch {}
        db.data = recovered;
        await db.write();
        db._degradedRead = false;
        console.log(`✅ 用户 ${userId} 数据库已从损坏中恢复`);
      } else {
        throw err;
      }
    } catch (recoverErr) {
      console.error(`用户 ${userId} 数据库损坏且恢复失败，拒绝提供空白数据: ${recoverErr.message}`);
      try {
        const backupPath = dbPath + '.corrupted.' + Date.now();
        await fs.copyFile(dbPath, backupPath);
        console.log(`📦 损坏的用户数据库已备份到: ${backupPath}`);
      } catch {}
      throw new Error(`用户 ${userId} 数据库损坏且恢复失败: ${recoverErr.message}`, { cause: recoverErr });
    }
  }
  
  let needsWrite = false;
  for (const [key, value] of Object.entries(defaultUserData)) {
    if (db.data[key] === undefined) {
      db.data[key] = JSON.parse(JSON.stringify(value));
      console.log(`🔧 初始化用户 ${userId} 默认字段:`, key);
      needsWrite = true;
    }
  }

  if (!db._degradedRead && db.data.groups.length === 0) {
    console.log(`🏗️ 为用户 ${userId} 创建默认群组`);
    db.data.groups = createDefaultGroups();
    needsWrite = true;
  }


  for (const group of db.data.groups) {
    if (group.last_message_at === undefined || group.last_message_preview === undefined) {
      resetGroupActivity(db, group.id);
      needsWrite = true;
    }
  }

  if (needsWrite && !db._degradedRead) {
    await db.write();
  } else if (needsWrite && db._degradedRead) {
    console.warn(`⚠️ 用户 ${userId} 处于降级读取状态，跳过初始化写入以保护本地数据`);
  }

  userDbs.set(userId, db);
  db._lastAccess = Date.now();

  evictLeastRecentlyUsed();

  console.log(`📖 用户 ${userId} 数据加载完成 - 消息: ${db.data.messages.length}, 群组: ${db.data.groups.length}`);

  return db;
}

export async function migrateExistingData() {
  try {
    await fs.access(legacyDbFile);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('ℹ️ 没有需要迁移的旧数据');
      return;
    }
    throw error;
  }
  console.log('🔄 检测到旧版数据库文件，开始迁移...');
  const legacyData = await fs.readFile(legacyDbFile, 'utf-8');
  const parsedData = JSON.parse(legacyData);
  const defaultUserDbPath = getUserDbPath('default');
  try {
    await fs.access(defaultUserDbPath);
    console.log('⚠️ 默认用户数据库已存在，跳过迁移');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const adapter = new JSONFile(defaultUserDbPath);
  const db = new CustomLow(adapter, parsedData);
  await db.write();
  console.log('✅ 旧数据已迁移到默认用户 (user-default)');
  const backupPath = path.join(dataDir, 'db.json.backup');
  await fs.rename(legacyDbFile, backupPath);
  console.log('📦 旧数据库文件已备份为: db.json.backup');
}

export async function initDatabase() {
  if (isSupabaseEnabled()) {
    console.log('🐘 使用 Supabase/PostgreSQL 作为数据存储后端');
    let supabasePool = null;
    try {
      supabasePool = await getPool();
    } catch (err) {
      console.error('❌ Supabase 连接失败:', err.message);
      throw err;
    }
    if (supabasePool) {
      try {
        await initUserDatabase('default');
        defaultDb = userDbs.get('default');
        console.log('✅ Supabase/PostgreSQL 数据库系统初始化完成');
        return;
      } catch (err) {
        console.error('❌ Supabase 初始化失败:', err.message);
        throw err;
      }
    }
    throw new Error('PostgreSQL 未能初始化，拒绝切换到另一份数据');
  }

  if (isMongoEnabled()) {
    console.log('🍃 使用 MongoDB 作为数据存储后端');
    await getMongoDb();
    await initUserDatabase('default');
    defaultDb = userDbs.get('default');
    console.log('✅ MongoDB 数据库系统初始化完成');
    return;
  }

  try {
    await fs.access(dataDir);
    console.log('✅ 数据库目录已存在:', dataDir);
  } catch (error) {
    console.log('📁 创建数据库目录:', dataDir);
    await fs.mkdir(dataDir, { recursive: true });
  }
  
  try {
    await fs.access(usersDataDir);
    console.log('✅ 用户数据目录已存在:', usersDataDir);
  } catch (error) {
    console.log('📁 创建用户数据目录:', usersDataDir);
    await fs.mkdir(usersDataDir, { recursive: true });
  }
  
  await migrateExistingData();
  
  await initUserDatabase('default');
  defaultDb = userDbs.get('default');

  console.log('✅ 数据库系统初始化完成 (lowdb)');
}

export function getDb() {
  if (defaultDb) {
    return defaultDb;
  }
  throw new Error('数据库未初始化，请先调用 initDatabase()');
}

export async function getDbAsync() {
  return getUserDb('default');
}

export function getDataDir() {
  return dataDir;
}

export function getUploadsDir() {
  return uploadsDir;
}

export function clearUserDbCache(userId) {
  if (userId) {
    userDbs.delete(userId);
    console.log(`🗑️ 已清除用户 ${userId} 的数据库缓存`);
  } else {
    userDbs.clear();
    console.log('🗑️ 已清除所有用户的数据库缓存');
  }
}

export async function listUserDatabases() {
  if (isSupabaseEnabled()) {
    try {
      return await listAllKeys('user:');
    } catch (error) {
      console.warn('Supabase listUserDatabases failed:', error.message);
      throw error;
    }
  }

  if (isMongoEnabled()) {
    try {
      const mongoDb = await getMongoDb();
      const docs = await mongoDb.collection('users_data').find({}, { projection: { userId: 1 } }).toArray();
      return docs.map(d => d.userId);
    } catch (error) {
      console.warn('MongoDB listUserDatabases failed:', error.message);
      throw error;
    }
  }

  try {
    const files = await fs.readdir(usersDataDir);
    return files
      .filter(file => file.startsWith('db_') && file.endsWith('.json'))
      .map(file => file.replace('db_', '').replace('.json', ''));
  } catch (error) {
    return [];
  }
}
