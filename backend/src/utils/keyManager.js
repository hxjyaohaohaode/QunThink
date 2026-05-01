import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const KEY_FILE_PATH = path.join(dataDir, '.encryption_key');
const KEY_HISTORY_DIR = path.join(dataDir, '.key_history');
const KEY_LENGTH = 32;
const MAX_KEY_HISTORY = 5;

let currentKey = null;
let keyMetadata = null;
let migrationWarningShown = false;
let keyHistory = new Map();

function showMigrationWarning() {
  if (!migrationWarningShown) {
    migrationWarningShown = true;
    console.warn('⚠️  迁移警告：');
    console.warn('  如果之前使用旧版随机生成的密钥加密数据，');
    console.warn('  切换到新的密钥管理系统后，那些数据将无法解密。');
    console.warn('  请确保在生产环境中设置 ENCRYPTION_KEY 环境变量。');
  }
}

function getKeyDirectory() {
  return path.dirname(KEY_FILE_PATH);
}

async function ensureKeyDirectoryExists() {
  const dir = getKeyDirectory();
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function ensureKeyHistoryDirExists() {
  try {
    await fs.access(KEY_HISTORY_DIR);
  } catch {
    await fs.mkdir(KEY_HISTORY_DIR, { recursive: true });
  }
}

function setFilePermissions(filePath) {
  if (process.platform === 'win32') {
    try {
      execSync(`icacls "${filePath}" /inheritance:r /grant:r "%USERNAME%:R"`, { stdio: 'ignore' });
    } catch (error) {
      console.warn('Windows密钥文件权限设置失败（非致命）:', error.message);
    }
  } else {
    try {
      fsSync.chmodSync(filePath, 0o600);
    } catch (error) {
      console.error('设置密钥文件权限失败:', error.message);
    }
  }
}

function generateKeyBuffer() {
  return crypto.randomBytes(KEY_LENGTH);
}

async function loadKeyHistory() {
  await ensureKeyHistoryDirExists();
  try {
    const files = await fs.readdir(KEY_HISTORY_DIR);
    for (const file of files) {
      if (file.endsWith('.key')) {
        const version = parseInt(file.replace('.key', ''));
        if (!isNaN(version)) {
          const keyData = await fs.readFile(path.join(KEY_HISTORY_DIR, file), 'utf8');
          const keyBuffer = Buffer.from(keyData.trim(), 'base64');
          if (keyBuffer.length === KEY_LENGTH) {
            keyHistory.set(version, keyBuffer);
          }
        }
      }
    }
  } catch {
  }
}

async function saveKeyToHistory(version, keyBuffer) {
  await ensureKeyHistoryDirExists();
  const filePath = path.join(KEY_HISTORY_DIR, `${version}.key`);
  await fs.writeFile(filePath, keyBuffer.toString('base64'), 'utf8');
  setFilePermissions(filePath);
  keyHistory.set(version, keyBuffer);
}

async function pruneOldKeyHistory() {
  const versions = Array.from(keyHistory.keys()).sort((a, b) => b - a);
  if (versions.length > MAX_KEY_HISTORY) {
    const toDelete = versions.slice(MAX_KEY_HISTORY);
    for (const version of toDelete) {
      keyHistory.delete(version);
      try {
        await fs.unlink(path.join(KEY_HISTORY_DIR, `${version}.key`));
      } catch {
      }
    }
  }
}

async function loadOrGenerateEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  const isProduction = process.env.NODE_ENV === 'production';

  if (envKey) {
    showMigrationWarning();
    const keyBuffer = Buffer.from(envKey, 'base64');
    if (keyBuffer.length < KEY_LENGTH) {
      const hash = crypto.createHash('sha256');
      hash.update(envKey);
      return hash.digest().slice(0, KEY_LENGTH);
    }
    return keyBuffer.slice(0, KEY_LENGTH);
  }

  if (isProduction) {
    throw new Error('生产环境必须设置 ENCRYPTION_KEY 环境变量');
  }

  console.warn('⚠️  未设置 ENCRYPTION_KEY，使用文件存储的密钥');
  showMigrationWarning();

  try {
    await fs.access(KEY_FILE_PATH);
    const keyData = await fs.readFile(KEY_FILE_PATH, 'utf8');
    const keyBuffer = Buffer.from(keyData.trim(), 'base64');
    if (keyBuffer.length === KEY_LENGTH) {
      return keyBuffer;
    }
  } catch {
  }

  const newKey = generateKeyBuffer();
  await ensureKeyDirectoryExists();
  await fs.writeFile(KEY_FILE_PATH, newKey.toString('base64'), 'utf8');
  setFilePermissions(KEY_FILE_PATH);

  console.log('🔑 已生成新的加密密钥并保存到:', KEY_FILE_PATH);

  return newKey;
}

async function generateNewKey() {
  const newKey = generateKeyBuffer();

  const oldVersion = keyMetadata ? keyMetadata.version : 1;
  const newVersion = oldVersion + 1;

  if (currentKey) {
    await saveKeyToHistory(oldVersion, currentKey);
  }

  const metadata = {
    version: newVersion,
    createdAt: new Date().toISOString(),
    previousKeyVersion: oldVersion,
    rotatedAt: new Date().toISOString()
  };

  currentKey = newKey;
  keyMetadata = metadata;

  await ensureKeyDirectoryExists();
  await fs.writeFile(KEY_FILE_PATH, newKey.toString('base64'), 'utf8');
  setFilePermissions(KEY_FILE_PATH);

  const metadataPath = KEY_FILE_PATH + '.meta';
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  setFilePermissions(metadataPath);

  await pruneOldKeyHistory();

  console.log('🔄 密钥已轮换，新版本:', metadata.version);

  return newKey;
}

function getKey() {
  if (!currentKey) {
    currentKey = loadOrGenerateEncryptionKeySync();
  }
  return currentKey;
}

async function getKeyAsync() {
  if (!currentKey) {
    currentKey = await loadOrGenerateEncryptionKey();
  }
  return currentKey;
}

function getKeyByVersion(version) {
  if (keyMetadata && keyMetadata.version === version) {
    return currentKey;
  }
  return keyHistory.get(version) || null;
}

// NOTE: This function uses synchronous I/O and is only called during server startup.
// It should NEVER be called during request handling.
function loadOrGenerateEncryptionKeySync() {
  const envKey = process.env.ENCRYPTION_KEY;
  const isProduction = process.env.NODE_ENV === 'production';

  if (envKey) {
    showMigrationWarning();
    const keyBuffer = Buffer.from(envKey, 'base64');
    if (keyBuffer.length < KEY_LENGTH) {
      const hash = crypto.createHash('sha256');
      hash.update(envKey);
      return hash.digest().slice(0, KEY_LENGTH);
    }
    return keyBuffer.slice(0, KEY_LENGTH);
  }

  if (isProduction) {
    throw new Error('生产环境必须设置 ENCRYPTION_KEY 环境变量');
  }

  if (fsSync.existsSync(KEY_FILE_PATH)) {
    const keyData = fsSync.readFileSync(KEY_FILE_PATH, 'utf8').trim();
    const keyBuffer = Buffer.from(keyData, 'base64');
    if (keyBuffer.length === KEY_LENGTH) {
      return keyBuffer;
    }
  }

  const newKey = generateKeyBuffer();
  const dir = getKeyDirectory();
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  fsSync.writeFileSync(KEY_FILE_PATH, newKey.toString('base64'), 'utf8');
  setFilePermissions(KEY_FILE_PATH);
  console.log('🔑 已生成新的加密密钥并保存到:', KEY_FILE_PATH);
  return newKey;
}

async function getKeyMetadataAsync() {
  if (!keyMetadata) {
    const metadataPath = KEY_FILE_PATH + '.meta';
    try {
      await fs.access(metadataPath);
      const data = await fs.readFile(metadataPath, 'utf8');
      keyMetadata = JSON.parse(data);
    } catch {
      keyMetadata = { version: 1, createdAt: new Date().toISOString() };
    }
  }
  return keyMetadata;
}

function getKeyMetadata() {
  if (!keyMetadata) {
    const metadataPath = KEY_FILE_PATH + '.meta';
    if (fsSync.existsSync(metadataPath)) {
      try {
        const data = fsSync.readFileSync(metadataPath, 'utf8');
        keyMetadata = JSON.parse(data);
      } catch (error) {
        keyMetadata = { version: 1, createdAt: new Date().toISOString() };
      }
    } else {
      keyMetadata = { version: 1, createdAt: new Date().toISOString() };
    }
  }
  return keyMetadata;
}

async function initializeKeyManager() {
  currentKey = await loadOrGenerateEncryptionKey();
  await loadKeyHistory();
  await getKeyMetadataAsync();
  console.log(`🔑 密钥管理器已初始化，当前版本: ${keyMetadata.version}, 历史密钥: ${keyHistory.size}个`);
}

export {
  loadOrGenerateEncryptionKey,
  generateNewKey,
  getKey,
  getKeyAsync,
  getKeyMetadata,
  getKeyMetadataAsync,
  getKeyByVersion,
  initializeKeyManager,
  KEY_FILE_PATH
};

export default {
  loadOrGenerateEncryptionKey,
  generateNewKey,
  getKey,
  getKeyAsync,
  getKeyMetadata,
  getKeyMetadataAsync,
  getKeyByVersion,
  initializeKeyManager
};
