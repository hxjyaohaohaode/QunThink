import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const temporaryPrefix = '.encryption_key.initializing-';
const recoveryError = () => Object.assign(new Error(
  '本地加密密钥缺失、损坏或不可读。为保护已有数据，已停止启动；请恢复原密钥，勿生成或替换密钥。'
), { code: 'ENCRYPTION_KEY_RECOVERY_REQUIRED' });

// Only an empty local installation proves that generating a key cannot strand
// existing ciphertext. Never inspect/decrypt user records to guess freshness.
function assertFreshLocalStore(dataDir, env, io) {
  if (env.SUPABASE_DB_URL || env.MONGODB_URI) throw recoveryError();
  if (env.AUTH_DB_PATH && path.resolve(env.AUTH_DB_PATH) !== path.join(path.resolve(dataDir), 'auth.json')) {
    try { io.lstatSync(env.AUTH_DB_PATH); throw recoveryError(); }
    catch (error) { if (error.code !== 'ENOENT') throw recoveryError(); }
  }
  if (env.MEMORY_DELETION_DIR && path.resolve(env.MEMORY_DELETION_DIR) !== path.join(path.resolve(dataDir), 'memory-deletions')) {
    try { io.lstatSync(env.MEMORY_DELETION_DIR); throw recoveryError(); }
    catch (error) { if (error.code !== 'ENOENT') throw recoveryError(); }
  }
  function emptyDirectory(directory) {
    let stat;
    try { stat = io.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw recoveryError(); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw recoveryError();
    for (const name of io.readdirSync(directory)) {
      // Unpublished first-install candidates never encrypted application data.
      // Their names cannot be mistaken for data files or a published key.
      if (directory === dataDir && /^\.encryption_key\.initializing-\d+-[a-f0-9]{32}$/.test(name)) continue;
      emptyDirectory(path.join(directory, name));
    }
  }
  emptyDirectory(dataDir);
}

function readKey(keyPath, io) {
  let stat;
  try { stat = io.lstatSync(keyPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw recoveryError(); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw recoveryError();
  try {
    const value = io.readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) throw recoveryError();
    return key;
  } catch { throw recoveryError(); }
}

// Startup-only synchronous implementation shared by sync and async callers.
// Publish an already-fsynced complete file by an exclusive link: concurrent
// starters either use the same winning key or fail closed, never overwrite it.
export function loadLocalEncryptionKey({ dataDir, keyPath, env = process.env, io = fs, prepareNewFile = () => {} }) {
  const existing = readKey(keyPath, io);
  if (existing) return existing;
  try { assertFreshLocalStore(dataDir, env, io); }
  catch (error) {
    const winner = readKey(keyPath, io);
    if (winner) return winner;
    throw recoveryError();
  }
  io.mkdirSync(dataDir, { recursive: true });
  const temporary = path.join(dataDir, `${temporaryPrefix}${process.pid}-${crypto.randomBytes(16).toString('hex')}`);
  let descriptor;
  try {
    descriptor = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(descriptor, crypto.randomBytes(32).toString('base64'), 'utf8');
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    prepareNewFile(temporary);
    try { io.linkSync(temporary, keyPath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const key = readKey(keyPath, io);
    if (!key) throw recoveryError();
    let directory;
    try { directory = io.openSync(dataDir, 'r'); io.fsyncSync(directory); }
    catch (error) {
      if (process.platform !== 'win32' || !['EINVAL', 'EPERM', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
    } finally { if (directory !== undefined) io.closeSync(directory); }
    return key;
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
    try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
