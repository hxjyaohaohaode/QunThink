import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '../../data');
const usersDataDir = path.join(dataDir, 'users');
const legacyDbFile = path.join(dataDir, 'db.json');

const userDbs = new Map();
let defaultDb = null;

const defaultUserData = {
  groups: [],
  messages: [],
  files: [],
  comments: [],
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
  customPersonas: {}
};

function getUserDbPath(userId) {
  return path.join(usersDataDir, `db_${userId}.json`);
}

function createDefaultGroups() {
  const now = new Date().toISOString();
  
  return [
    {
      id: 'group-presidential',
      name: '智囊团会议室',
      description: '四个 AI 专家各抒己见，从不同角度分析问题',
      type: 'preset',
      debate_mode: false,
      debate_level: 1,
      ai_members: ['deepseek', 'glm', 'mimo', 'qwen'],
      created_at: now
    },
    {
      id: 'group-debate',
      name: '辩论竞技场',
      description: 'AI 之间互相质疑、辩驳，激发深度思考',
      type: 'preset',
      debate_mode: true,
      debate_level: 2,
      ai_members: ['deepseek', 'glm', 'mimo', 'qwen'],
      created_at: now
    },
    {
      id: 'group-collaborative',
      name: '共创工作台',
      description: 'AI 们合作完成一个任务，接力式推进',
      type: 'preset',
      debate_mode: false,
      debate_level: 0,
      ai_members: ['deepseek', 'glm', 'mimo', 'qwen'],
      created_at: now
    }
  ];
}

export async function initUserDatabase(userId) {
  const dbPath = getUserDbPath(userId);
  
  try {
    await fs.access(dbPath);
    console.log(`✅ 用户数据库文件已存在: ${userId}`);
  } catch (error) {
    console.log(`📁 创建用户数据库文件: ${userId}`);
    const adapter = new JSONFile(dbPath);
    const db = new Low(adapter, JSON.parse(JSON.stringify(defaultUserData)));
    
    db.data.groups = createDefaultGroups();
    
    await db.write();
    console.log(`✅ 用户数据库初始化完成: ${userId}`);
  }
  
  return getUserDb(userId);
}

export async function getUserDb(userId) {
  if (userDbs.has(userId)) {
    return userDbs.get(userId);
  }
  
  const dbPath = getUserDbPath(userId);
  const adapter = new JSONFile(dbPath);
  const db = new Low(adapter, JSON.parse(JSON.stringify(defaultUserData)));
  
  await db.read();
  
  for (const [key, value] of Object.entries(defaultUserData)) {
    if (db.data[key] === undefined) {
      db.data[key] = JSON.parse(JSON.stringify(value));
      console.log(`🔧 初始化用户 ${userId} 默认字段:`, key);
    }
  }
  
  if (db.data.groups.length === 0) {
    console.log(`🏗️ 为用户 ${userId} 创建默认群组`);
    db.data.groups = createDefaultGroups();
    await db.write();
  }
  
  userDbs.set(userId, db);
  
  console.log(`📖 用户 ${userId} 数据加载完成 - 消息: ${db.data.messages.length}, 群组: ${db.data.groups.length}`);
  
  return db;
}

export async function migrateExistingData() {
  try {
    await fs.access(legacyDbFile);
    console.log('🔄 检测到旧版数据库文件，开始迁移...');
    
    const legacyData = await fs.readFile(legacyDbFile, 'utf-8');
    const parsedData = JSON.parse(legacyData);
    
    const defaultUserDbPath = getUserDbPath('default');
    try {
      await fs.access(defaultUserDbPath);
      console.log('⚠️ 默认用户数据库已存在，跳过迁移');
    } catch (error) {
      const adapter = new JSONFile(defaultUserDbPath);
      const db = new Low(adapter, parsedData);
      await db.write();
      console.log('✅ 旧数据已迁移到默认用户 (user-default)');
      
      const backupPath = path.join(dataDir, 'db.json.backup');
      await fs.rename(legacyDbFile, backupPath);
      console.log('📦 旧数据库文件已备份为: db.json.backup');
    }
  } catch (error) {
    console.log('ℹ️ 没有需要迁移的旧数据');
  }
}

export async function initDatabase() {
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

  console.log('✅ 数据库系统初始化完成');
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
  try {
    const files = await fs.readdir(usersDataDir);
    return files
      .filter(file => file.startsWith('db_') && file.endsWith('.json'))
      .map(file => file.replace('db_', '').replace('.json', ''));
  } catch (error) {
    return [];
  }
}
