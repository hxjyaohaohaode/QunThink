import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadLocalEncryptionKey } from './localKeyGuard.js';

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

const RECOVERY_CODE = 'ENCRYPTION_KEY_RECOVERY_REQUIRED';
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

function recoveryError(resource, cause) {
  // Do not attach the original error: messages, paths and JSON may contain secrets.
  const permissionCode = PERMISSION_CODES.has(cause?.code) ? cause.code
    : PERMISSION_CODES.has(cause?.permissionCode) ? cause.permissionCode : undefined;
  const permission = permissionCode
    ? ` 权限错误 ${permissionCode}；运行 UID=${process.getuid?.() ?? 'unknown'} GID=${process.getgid?.() ?? 'unknown'}。请检查原卷的属主、访问权限及只读挂载。`
    : '';
  return Object.assign(new Error(
    `加密密钥恢复失败（${resource}）。为保护已有数据，已停止启动；请恢复原文件，勿生成或替换密钥。${permission}`
  ), { code: RECOVERY_CODE, ...(permissionCode ? { permissionCode } : {}) });
}

function inspectPath(filePath, resource, directory = false, optional = false) {
  let stat;
  try { stat = fsSync.lstatSync(filePath); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw recoveryError(resource, error);
  }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw recoveryError(resource);
  }
  return stat;
}

function readRecoveryFile(filePath, resource, optional = false) {
  const stat = inspectPath(filePath, resource, false, optional);
  if (!stat) return null;
  let descriptor;
  try {
    // Refuse a symlink swapped in after lstat as well as non-regular files.
    descriptor = fsSync.openSync(filePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
    const opened = fsSync.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw recoveryError(resource);
    return fsSync.readFileSync(descriptor, 'utf8');
  } catch (error) {
    throw recoveryError(resource, error);
  } finally {
    if (descriptor !== undefined) {
      try { fsSync.closeSync(descriptor); }
      catch (error) { throw recoveryError(resource, error); }
    }
  }
}

function parseStoredKey(value, resource) {
  const encoded = value.trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_LENGTH || key.toString('base64') !== encoded) throw recoveryError(resource);
  return key;
}

function validVersion(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function readRecoveryState() {
  inspectPath(dataDir, '数据目录', true, true);
  const history = new Map();
  if (inspectPath(KEY_HISTORY_DIR, '历史密钥目录', true, true)) {
    let files;
    try { files = fsSync.readdirSync(KEY_HISTORY_DIR); }
    catch (error) { throw recoveryError('历史密钥目录', error); }
    for (const file of files) {
      if (!/^[1-9][0-9]*\.key$/.test(file)) throw recoveryError('历史密钥文件名');
      const version = Number(file.slice(0, -4));
      if (!validVersion(version)) throw recoveryError('历史密钥版本');
      const value = readRecoveryFile(path.join(KEY_HISTORY_DIR, file), '历史密钥');
      history.set(version, parseStoredKey(value, '历史密钥格式'));
    }
  }
  const value = readRecoveryFile(KEY_FILE_PATH + '.meta', '密钥元数据', true);
  let metadata;
  if (value === null) {
    if (history.size) throw recoveryError('历史密钥缺少元数据');
    metadata = { version: 1, createdAt: new Date().toISOString() };
  } else {
    try { metadata = JSON.parse(value); }
    catch { throw recoveryError('密钥元数据格式'); }
    const allowed = new Set(['version', 'createdAt', 'previousKeyVersion', 'rotatedAt']);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || Object.keys(metadata).some(key => !allowed.has(key))
      || !validVersion(metadata.version) || !validTimestamp(metadata.createdAt)
      || (Object.hasOwn(metadata, 'rotatedAt') && !validTimestamp(metadata.rotatedAt))) {
      throw recoveryError('密钥元数据格式');
    }
    if (metadata.version === 1) {
      if (Object.hasOwn(metadata, 'previousKeyVersion') || Object.hasOwn(metadata, 'rotatedAt')) {
        throw recoveryError('密钥元数据版本关系');
      }
    } else if (!validVersion(metadata.previousKeyVersion)
      || metadata.previousKeyVersion !== metadata.version - 1
      || !history.has(metadata.previousKeyVersion)) {
      throw recoveryError('密钥元数据缺少有效前序密钥');
    }
  }
  for (const version of history.keys()) {
    if (version >= metadata.version) throw recoveryError('历史密钥版本关系');
  }
  return { metadata, history };
}

async function ensureDirectoryExists(directory, resource) {
  if (inspectPath(directory, resource, true, true)) return;
  try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch (error) { throw recoveryError(resource, error); }
  inspectPath(directory, resource, true);
}

async function ensureKeyDirectoryExists() {
  await ensureDirectoryExists(getKeyDirectory(), '数据目录');
}

async function ensureKeyHistoryDirExists() {
  await ensureDirectoryExists(KEY_HISTORY_DIR, '历史密钥目录');
}

function setFilePermissions(filePath) {
  if (process.platform === 'win32') {
    try {
      const userName = process.env.USERNAME || process.env.USER;
      if (!userName || /[\\/"&|<>^]/.test(userName)) {
        console.warn('Windows密钥文件权限设置跳过（用户名缺失或含特殊字符）');
        return;
      }
      // 使用参数数组形式调用，避免 shell 注入；授予当前用户完全控制并移除继承，
      // 防止其他本机用户读取密钥，同时保留应用自身轮换密钥所需的写权限。
      const result = spawnSync('icacls', [filePath, '/inheritance:r', `/grant:r`, `${userName}:F`], { stdio: 'ignore' });
      if (result.status !== 0) {
        console.warn('Windows密钥文件权限设置失败（非致命）: icacls exit ' + result.status);
      }
    } catch (error) {
      console.warn('Windows密钥文件权限设置失败（非致命）');
    }
  } else {
    try {
      fsSync.chmodSync(filePath, 0o600);
    } catch (error) {
      throw recoveryError('密钥文件权限', error);
    }
  }
}

function generateKeyBuffer() {
  return crypto.randomBytes(KEY_LENGTH);
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

// All recovery files are checked before a key can be generated or published.
// This startup-only synchronous path is shared by sync and async accessors.
function loadValidatedState() {
  const state = readRecoveryState();
  state.key = loadCurrentKey();
  return state;
}

function publishState(state) {
  currentKey = state.key;
  keyMetadata = state.metadata;
  keyHistory = state.history;
}

async function loadOrGenerateEncryptionKey() {
  return loadValidatedState().key;
}

async function generateNewKey() {
  getKey();
  if (!validVersion(keyMetadata.version + 1)) throw recoveryError('密钥版本超出范围');
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
    publishState(loadValidatedState());
  }
  return currentKey;
}

async function getKeyAsync() {
  return getKey();
}

function getKeyByVersion(version) {
  if (keyMetadata && keyMetadata.version === version) {
    return currentKey;
  }
  return keyHistory.get(version) || null;
}

// NOTE: This function uses synchronous I/O and is only called during server startup.
// It should NEVER be called during request handling.
function loadCurrentKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  const isProduction = process.env.NODE_ENV === 'production';

  if (envKey) {
    showMigrationWarning();
    if (isProduction && envKey.length < 32) {
      throw new Error('生产环境 ENCRYPTION_KEY 强度过低：要求 base64 编码的 32 字节密钥（openssl rand -base64 32）');
    }
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

  const stored = readRecoveryFile(KEY_FILE_PATH, '当前密钥', true);
  if (stored !== null) return parseStoredKey(stored, '当前密钥格式');
  // The local guard deliberately sanitizes its errors. Preserve only a safe
  // permission code so its nested freshness checks still provide UID/GID advice.
  let permissionFailure;
  const io = { ...fsSync };
  for (const method of ['lstatSync', 'readFileSync', 'readdirSync', 'mkdirSync', 'openSync',
    'writeFileSync', 'fsyncSync', 'closeSync', 'linkSync', 'unlinkSync']) {
    io[method] = (...args) => {
      try { return fsSync[method](...args); }
      catch (error) {
        if (PERMISSION_CODES.has(error.code)) permissionFailure = { code: error.code };
        throw error;
      }
    };
  }
  try {
    return loadLocalEncryptionKey({ dataDir, keyPath: KEY_FILE_PATH, io, prepareNewFile: setFilePermissions });
  } catch (error) {
    throw recoveryError('当前密钥或数据目录', permissionFailure || error);
  }
}

async function getKeyMetadataAsync() {
  return getKeyMetadata();
}

function getKeyMetadata() {
  if (!keyMetadata) publishState(loadValidatedState());
  return keyMetadata;
}

async function initializeKeyManager() {
  const state = loadValidatedState();
  publishState(state);
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
