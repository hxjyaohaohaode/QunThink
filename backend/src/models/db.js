import { withPostgresMemoryLock, createPostgresDeletionLedger } from '../services/memory/postgresDeletionLedger.js';
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
import { beginUserDbWriteBarrier, readWithWriteBarrier, assertSynchronousPublishHook, runSynchronousPublishHook, assertExplicitDbSnapshot } from './readBarrier.js';
import { createUserDbRegistry } from './userDbRegistry.js';
import { createAccountJson, readAccountJson, requireAccountStore, createOnlyAccount, validateRequiredAccount, accountStoreError, assertEmptyConfiguredPostgresLedger } from './accountStoreLifecycle.js';
import { initializeNewAccountOrder, buildLegacyMessageOrder } from '../services/messageOrder.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { buildPostgresTlsConfig } from './postgresTls.js';
import { createLocalAccountRegistry } from '../services/memory/localAccountRegistry.js';
import { prepareRestorePlan, buildRestoreTarget, inspectRestoreSnapshot, restoreFingerprint, restoreDigest, restoreError } from '../services/accountGenerationRestore.js';
import { restoreDirectory, readRestoreFile, writeRestoreFile, readRestorePlan, inspectRestoreAttempts, createRestoreAttempt } from '../services/accountGenerationRestoreFiles.js';
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
  constructor(adapter, defaultData, { readWithMetadata, filePath } = {}) {
    super(adapter, defaultData);
    if (readWithMetadata !== undefined && typeof readWithMetadata !== 'function') throw new TypeError('readWithMetadata must be a function');
    // A loader can supply one raw file read that distinguishes an existing JSON
    // null from ENOENT. JSONFile alone deliberately collapses both to null.
    this._readWithMetadata = readWithMetadata;
    this._filePath = filePath;
    this._exists = null; // Unknown until a successful read or acknowledged write.
    this._revision = null; // JSON is single-process storage, not durable CAS.
  }

  invalidateReadCache() {
    // A write can commit without an acknowledgement. Callers recovering from
    // that uncertainty must not expose a pre-write snapshot as cached truth.
    // A failed read never restores this timestamp; only a durable read does.
    _lastReadTimestamps.delete(this);
  }

  async create({ snapshot }) {
    const releaseBarrier = beginUserDbWriteBarrier(this);
    try {
      assertExplicitDbSnapshot(snapshot);
      const data = JSON.parse(JSON.stringify(snapshot));
      assertExplicitDbSnapshot(data);
      if (!this._filePath) throw new TypeError('JSON create requires an explicit filePath');
      this.assertCurrentLease?.();
      this.invalidateReadCache();
      await createAccountJson(this._filePath, data, () => this.assertCurrentLease?.());
      this.assertCurrentLease?.();
      this.data = data; this._exists = true;
      _writeTimestamps.set(this, Date.now());
    } finally {
      releaseBarrier();
    }
  }

  async write(options) {
    const releaseBarrier = beginUserDbWriteBarrier(this);
    try {
      // Capture before the first await; neither caller mutations nor a concurrent
      // read may change this attempt's bytes. Never stage candidates in db.data.
      const explicit = options !== undefined;
      if (explicit && (!options || !Object.hasOwn(options, 'snapshot'))) {
        throw new TypeError('write options must include snapshot');
      }
      if (explicit) assertExplicitDbSnapshot(options.snapshot);
      if (explicit && options.expectedRevision != null) {
        throw Object.assign(new Error('JSON storage does not support revision CAS'), {
          code: 'REVISION_CAS_UNSUPPORTED', status: 503
        });
      }
      const source = explicit ? options.snapshot : this.data;
      if (!explicit && !source && !this._accountStoreContract) return; // Generic Low only; required accounts must validate every write.
      const data = JSON.parse(JSON.stringify(source));
      if (explicit) assertExplicitDbSnapshot(data);
      const permit = this._accountStoreContract?.beforeWrite(data);
      const confirmRequiredTarget = async () => {
        if (!this._accountStoreContract || !this._filePath) return;
        try {
          const current = await this._readWithMetadata();
          this.assertCurrentLease?.();
          this._accountStoreContract.checkTarget(current.data, current.exists);
          this._accountStoreContract.checkWrite(permit);
        } catch (error) { this._accountStoreContract.uncertain(); throw error; }
      };
      // This only detects a target already missing/corrupt at this check. JSON
      // has no interprocess CAS against an external replacement after the read.
      await confirmRequiredTarget();
      this.assertCurrentLease?.();
      this.invalidateReadCache();
      try {
        this._accountStoreContract?.checkWrite(permit);
        await this.adapter.write(data);
      } catch (err) {
        this._accountStoreContract?.checkWrite(permit, { afterIo: true });
        this.assertCurrentLease?.();
        if (!((err.code === 'ENOENT' || err.code === 'EPERM') && err.syscall === 'rename')) { this._accountStoreContract?.uncertain(); throw err; }
        let filePath = err.dest || null;
        if (!filePath && err.path) {
          const match = err.path.match(/^(.+)[/\\]\.([^/\\]+)\.tmp$/);
          if (match) filePath = match[1] + path.sep + match[2];
        }
        if (!filePath) { this._accountStoreContract?.uncertain(); throw err; }
        const dir = path.dirname(filePath);
        const tmpFallback = path.join(dir, `.${path.basename(filePath)}.fb-${randomUUID()}.tmp`);
        try {
          await confirmRequiredTarget();
          await fs.mkdir(dir, { recursive: true });
          this.assertCurrentLease?.();
          this._accountStoreContract?.checkWrite(permit, { afterIo: true });
          await fs.writeFile(tmpFallback, JSON.stringify(data, null, 2), 'utf-8');
          this.assertCurrentLease?.();
          this._accountStoreContract?.checkWrite(permit, { afterIo: true });
          await confirmRequiredTarget();
          await fs.rename(tmpFallback, filePath);
        } catch (writeErr) {
          // Clean up only our own uncommitted temporary file, never the target.
          await fs.unlink(tmpFallback).catch(() => {});
          this._accountStoreContract?.uncertain();
          throw writeErr;
        }
      }
      // Legacy writers mutate shared data before calling write and may retain
      // its object identities. Explicit candidates alone replace that graph.
      this.assertCurrentLease?.();
      this._accountStoreContract?.checkWrite(permit, { afterIo: true });
      if (explicit) this.data = data;
      this._exists = true;
      this._accountStoreContract?.committed(data);
      _writeTimestamps.set(this, Date.now());
    } finally {
      releaseBarrier();
    }
  }

  async read({ force = false, onPublished } = {}) {
    assertSynchronousPublishHook(onPublished);
    return readWithWriteBarrier(this, async () => {
      this.assertCurrentLease?.();
      const lastWrite = _writeTimestamps.get(this);
      const lastRead = _lastReadTimestamps.get(this);
      if (!force && !this._accountStoreContract && lastWrite && lastRead && lastRead >= lastWrite && this.data) return { cached: true };
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          this.assertCurrentLease?.();
          if (this._readWithMetadata) {
            const result = await this._readWithMetadata();
            if (!result || typeof result.exists !== 'boolean' || !Object.hasOwn(result, 'data')
              || result.data === undefined || (!result.exists && result.data !== null)) {
              throw Object.assign(new Error('Invalid raw database read metadata'), { code: 'INVALID_READ_METADATA', status: 503 });
            }
            return { data: result.data, exists: result.exists };
          }
          const data = await this.adapter.read();
          return { data, exists: data == null ? null : true };
        }
        catch (err) {
          if (err instanceof SyntaxError && err.message.includes('JSON') && attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
            continue;
          }
          this._accountStoreContract?.uncertain();
          throw err;
        }
      }
    }, result => {
      if (!result.cached) {
        this._accountStoreContract?.read(result.data, result.exists);
        // Preserve actual existing values, including null/falsy corruption,
        // for later schema checks. Missing/unknown reads retain Low defaults.
        if (result.exists === true) this.data = result.data;
        this._exists = result.exists;
        _lastReadTimestamps.set(this, Date.now());
      }
      runSynchronousPublishHook(onPublished, { data: this.data, revision: null, exists: this._exists, supportsRevisionCas: false });
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

const userMutexes = new Map();
const userDbRegistry = createUserDbRegistry({
  maxSize: 50,
  isLocked: userId => Boolean(userMutexes.get(userId)?.isLocked()),
  onEvict: count => console.log(`🗑️ LRU缓存淘汰: 移除了 ${count} 个用户数据库缓存`)
});
const userDbs = userDbRegistry.cache;

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
    return await withPostgresMemoryLock(userId, fn);
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
      ai_members: [],
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
      ai_members: [],
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
      ai_members: [],
      created_at: now,
      last_message_at: now,
      last_message_preview: null
    }
  ];
}

// Kept as an existing-only alias for callers upgrading from the old API.
// Only the explicit server-side registration path may create a new account.
export async function initUserDatabase(userId) { return getUserDb(userId); }

function assertAccountId(userId) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw accountStoreError('ACCOUNT_ID_INVALID', '账号标识无效');
  }
}

async function rawAccountDb(userId, protect) {
  assertAccountId(userId);
  if (isSupabaseEnabled()) return protect(new PgLow(`user:${userId}`, defaultUserData));
  if (isMongoEnabled()) return protect(new MongoLow((await getMongoDb()).collection('users_data'), { userId }, defaultUserData));
  const filePath = getUserDbPath(userId);
  return protect(new CustomLow(new JSONFile(filePath), structuredClone(defaultUserData), {
    filePath, readWithMetadata: () => readAccountJson(filePath)
  }));
}

export async function getUserDb(userId) {
  assertAccountId(userId);
  return userDbRegistry.get(userId, async protect => {
    const db = requireAccountStore(await rawAccountDb(userId, protect), userId);
    await db.read({ force: true });
    return db;
  });
}

function newAccountSnapshot(userId) {
  const data = { ...structuredClone(defaultUserData), groups: createDefaultGroups() };
  return initializeNewAccountOrder(data, userId, { generationForGroup: () => randomUUID() });
}

function verifyPreprovisionedAccount(data, userId) {
  validateRequiredAccount(data, userId);
  // Reusing an existing UUID is read-only and limited to an unchanged initial
  // document. Never treat arbitrary valid but already used data as a new user.
  const expected = { ...structuredClone(defaultUserData), groups: createDefaultGroups() };
  if (data.groups.length !== expected.groups.length) throw accountStoreError('ACCOUNT_DATA_EXISTS', '账号已有数据，不能作为新账号初始化');
  expected.groups = expected.groups.map((group, i) => ({ ...group,
    created_at: data.groups[i].created_at, last_message_at: data.groups[i].created_at }));
  expected.message_order = structuredClone(data.message_order);
  if (data.message_order.groups.length !== 3 || data.message_order.groups.some(group => group.next_sequence !== '1' || group.bindings.length)
    || !isDeepStrictEqual(expected, data)) throw accountStoreError('ACCOUNT_DATA_EXISTS', '账号已有数据，不能作为新账号初始化');
}

export async function createNewUserDatabase(userId) {
  if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId)) {
    throw accountStoreError('ACCOUNT_ID_INVALID', '新账号必须使用服务端新建 UUID');
  }
  const db = await userDbRegistry.get(userId, async protect => createOnlyAccount(
    await rawAccountDb(userId, protect), newAccountSnapshot(userId), userId,
    { verifyExisting: data => verifyPreprovisionedAccount(data, userId) }
  ));
  db.assertCurrentLease?.();
  // A cached initial snapshot is not proof that the durable account still exists.
  await db.read({ force: true });
  verifyPreprovisionedAccount(db.data, userId);
  return db;
}

function sourceFingerprint(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function prepareLegacyMigration(data, userId) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw accountStoreError('ACCOUNT_DATA_INVALID', '旧账号数据不是有效文档');
  }
  const order = buildLegacyMessageOrder(data, userId, { generationForGroup: () => randomUUID() });
  const snapshot = { ...structuredClone(data), message_order: order };
  return { snapshot, report: { sourceHash: sourceFingerprint(data), groups: order.groups.length,
    messages: data.messages.length, bindings: order.groups.reduce((sum, group) => sum + group.bindings.length, 0),
    sidecarBytes: Buffer.byteLength(JSON.stringify(order)), applied: false } };
}

function assertMigrationOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['apply', 'expectedSourceHash'].includes(key))
    || (options.apply !== undefined && typeof options.apply !== 'boolean')) throw new TypeError('Invalid migration options');
  if (options.apply && (typeof options.expectedSourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedSourceHash))) {
    throw accountStoreError('MIGRATION_SOURCE_HASH_REQUIRED', '执行迁移必须提供 dry-run 的原始数据指纹');
  }
}
function assertSourceFingerprint(actual, expected) {
  if (actual !== expected) throw accountStoreError('MIGRATION_SOURCE_CHANGED', '原始数据已改变，请重新 dry-run');
}
function verifyMigrationResult(data, userId, originalHash) {
  validateRequiredAccount(data, userId);
  const { message_order, ...original } = data;
  assertSourceFingerprint(sourceFingerprint(original), originalHash);
}

// Explicit, offline-only operation. No normal loader, default repair, model
// source projection, or independent deletion ledger is read or rewritten.
export async function migrateLegacyUserDatabase(userId, options = {}) {
  assertAccountId(userId); assertMigrationOptions(options);
  return userDbRegistry.maintain(userId, async protect => {
    const db = await rawAccountDb(userId, protect);
    await db.read({ force: true });
    if (db._exists !== true) validateRequiredAccount(db.data, userId, db._exists);
    const { snapshot, report } = prepareLegacyMigration(db.data, userId);
    if (!options.apply) return report;
    assertSourceFingerprint(report.sourceHash, options.expectedSourceHash);
    const revision = db._revision;
    // JSON has no interprocess CAS. Require stopped writers, and recheck raw
    // bytes within the drained local registry before the one replacement.
    if (revision === null) {
      await db.read({ force: true });
      if (db._exists !== true) validateRequiredAccount(db.data, userId, db._exists);
      assertSourceFingerprint(sourceFingerprint(db.data), report.sourceHash);
    }
    let failure;
    try { await db.write({ snapshot, expectedRevision: revision }); }
    catch (error) { if (error.code === 'USER_DB_REPLACED') throw error; failure = error; }
    try { await db.read({ force: true }); }
    catch (error) {
      if (error.code === 'USER_DB_REPLACED') throw error;
      throw accountStoreError('ACCOUNT_MIGRATION_OUTCOME_UNKNOWN', '迁移提交结果待权威核验', error);
    }
    if (failure && db._exists === true && !Object.hasOwn(db.data || {}, 'message_order')
      && sourceFingerprint(db.data) === report.sourceHash) throw failure;
    try { verifyMigrationResult(db.data, userId, report.sourceHash); }
    catch (error) { throw accountStoreError('ACCOUNT_MIGRATION_OUTCOME_UNKNOWN', '迁移结果与原始数据不一致，保持停写', error); }
    return { ...report, applied: true, confirmedByRead: true };
  });
}

// Explicit old db.json import. Keep the original file intact for recovery; a
// missing/invalid source or existing different target is never auto-salvaged.
export async function migrateExistingData(options = {}) {
  assertMigrationOptions(options);
  return userDbRegistry.maintain('default', async protect => {
    const source = await readAccountJson(legacyDbFile);
    if (!source.exists) throw accountStoreError('ACCOUNT_DATA_MISSING', '旧版源数据库文件缺失');
    const { snapshot, report } = prepareLegacyMigration(source.data, 'default');
    if (!options.apply) return report;
    assertSourceFingerprint(report.sourceHash, options.expectedSourceHash);
    const latest = await readAccountJson(legacyDbFile);
    if (!latest.exists) throw accountStoreError('ACCOUNT_DATA_MISSING', '旧版源数据库文件缺失');
    assertSourceFingerprint(sourceFingerprint(latest.data), report.sourceHash);
    await createOnlyAccount(await rawAccountDb('default', protect), snapshot, 'default', {
      verifyExisting: data => verifyMigrationResult(data, 'default', report.sourceHash)
    });
    return { ...report, applied: true, confirmedByRead: true };
  });
}

// Explicit stopped-writer restore only. Keep this boundary independent of the
// ordinary getPool/withWriteLock paths: those can initialize legacy PG schema.
async function readExistingRestoreJson(filename) {
  try {
    const bytes = await readRestoreFile(filename, { maxBytes: Number.MAX_SAFE_INTEGER });
    try { return { exists: true, data: JSON.parse(bytes.toString('utf8')) }; }
    catch (error) { throw accountStoreError('ACCOUNT_DATA_CORRUPT', '恢复源 JSON 损坏', error); }
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, data: null };
    throw error;
  }
}
async function validateLocalRestoreLedger(owner) {
  const root = path.resolve(process.env.MEMORY_DELETION_DIR || path.join(dataDir, 'memory-deletions'));
  const auth = await readExistingRestoreJson(process.env.AUTH_DB_PATH || path.join(dataDir, 'auth.json'));
  if (!auth.exists || auth.data?.memoryBarrierInstallation?.version !== 1 || auth.data.memoryBarrierInstallation.root !== root) {
    throw restoreError('MEMORY_BARRIER_UNAVAILABLE');
  }
  if (!(await restoreDirectory(root))) throw restoreError('MEMORY_BARRIER_UNAVAILABLE');
  const registry = createLocalAccountRegistry({ directory: path.join(root, 'registry'), createIfMissing: false });
  await registry.initialize();
  const { barrier } = await registry.openAccount(owner, {
    ledgerDirectory: path.join(root, restoreDigest(JSON.stringify(owner))), allowNew: false
  });
  await barrier.deletedIds(owner, []);
}
async function withRestoreMaintenance(owner, work) {
  assertAccountId(owner);
  if (!isSupabaseEnabled() && isMongoEnabled()) throw restoreError('RESTORE_STORAGE_UNSUPPORTED');
  const release = await getUserMutex(owner).acquire();
  const pools = [];
  try {
    let ledger, businessPool;
    if (isSupabaseEnabled()) {
      if (!process.env.MEMORY_DELETION_DATABASE_URL || process.env.MEMORY_DELETION_CONNECTION_MODE !== 'session'
        || (process.env.MEMORY_DELETION_MODE && process.env.MEMORY_DELETION_MODE !== 'independent')) throw restoreError('RESTORE_INDEPENDENT_LEDGER_REQUIRED');
      // Build both configurations before allocating either pool. No getPool,
      // ensureSchema, auth initializer or ledger installer may run here.
      const configs = [buildPostgresTlsConfig(process.env.SUPABASE_DB_URL, process.env.SUPABASE_DB_CA_FILE),
        buildPostgresTlsConfig(process.env.MEMORY_DELETION_DATABASE_URL, process.env.MEMORY_DELETION_DATABASE_CA_FILE)];
      for (const config of configs) {
        const pool = new pg.Pool({ ...config, max: 2, connectionTimeoutMillis: 15000 });
        pool.on('error', () => {}); pools.push(pool);
      }
      businessPool = pools[0];
      ledger = createPostgresDeletionLedger({ businessPool, ledgerPool: pools[1],
        installationId: process.env.MEMORY_DELETION_INSTALLATION_ID, requireBusinessMarker: true });
    }
    const validateLedger = () => ledger ? ledger.deletedIds(owner, []) : validateLocalRestoreLedger(owner);
    const maintain = () => userDbRegistry.maintain(owner, async protect => {
      await validateLedger();
      const filename = getUserDbPath(owner);
      // The wrapper redacts driver errors before PgLow's existing logger sees
      // them. Existing-only prevents raw revision-zero CAS from inserting.
      const rawPool = businessPool && { query: async (...args) => {
        try { return await businessPool.query(...args); }
        catch (error) { throw restoreError('RESTORE_STORAGE_UNAVAILABLE', error); }
      } };
      const jsonAdapter = businessPool ? null : new JSONFile(filename);
      if (jsonAdapter) {
        const write = jsonAdapter.write.bind(jsonAdapter);
        jsonAdapter.write = async data => {
          try { return await write(data); }
          catch (error) { throw restoreError('RESTORE_STORAGE_UNAVAILABLE', error); }
        };
      }
      const db = protect(businessPool ? new PgLow(`user:${owner}`, {}, rawPool, { existingOnly: true })
        : new CustomLow(jsonAdapter, {}, { filePath: filename, readWithMetadata: () => readExistingRestoreJson(filename) }));
      const result = await work(db, validateLedger);
      await validateLedger();
      return result;
    });
    return await (ledger ? ledger.withAccountLock(owner, maintain) : maintain());
  } finally {
    // Both dedicated pools are closed even when the final ledger lease fails.
    try { await Promise.all(pools.map(pool => pool.end())); } finally { release(); }
  }
}

export async function restoreAccountGenerations(owner, { operation, planFile, writersStopped, expectedPlanSha } = {}) {
  if (writersStopped !== true || !['prepare', 'apply', 'verify'].includes(operation)
    || typeof planFile !== 'string' || !planFile || (operation === 'apply' && !/^[0-9a-f]{64}$/.test(expectedPlanSha || ''))) {
    throw restoreError('RESTORE_OPTIONS_INVALID');
  }
  // Reading a selected plan cannot create metadata or initialize any store.
  const selected = operation === 'prepare' ? null : await readRestorePlan(planFile, owner, operation === 'apply' ? expectedPlanSha : undefined);
  let writeAttempted = false;
  try {
    return await withRestoreMaintenance(owner, async (db, validateLedger) => {
      const alreadyAttempted = await inspectRestoreAttempts(dataDir, owner, selected);
      await db.read({ force: true }); validateRequiredAccount(db.data, owner, db._exists);
      if (operation === 'prepare') {
        const plan = prepareRestorePlan(db.data, owner);
        await validateLedger();
        const sha = await writeRestoreFile(planFile, plan);
        return { outcome: 'prepared', planSha: sha, sourceHash: plan.source_hash, targetHash: plan.target_hash, groups: plan.generations.length };
      }
      const { plan, sha } = selected;
      const report = outcome => ({ outcome, planSha: sha, sourceHash: plan.source_hash, targetHash: plan.target_hash,
        groups: plan.generations.length, businessWriteAttempted: writeAttempted });
      const outcome = inspectRestoreSnapshot(db.data, db._exists, plan, owner);
      // A receipt, even for a source still visible after a crash, is never a
      // second write permit. An exact target is also always verification-only.
      if (operation === 'verify' || alreadyAttempted || outcome === 'confirmed') return report(outcome);
      const snapshot = buildRestoreTarget(db.data, plan, owner), revision = db._revision;
      await validateLedger();
      await createRestoreAttempt(dataDir, selected);
      // An uncertain receipt is retained; dependent I/O never runs unless all
      // file and directory fsyncs above have completed successfully.
      await validateLedger();
      if (revision === null) {
        await db.read({ force: true }); validateRequiredAccount(db.data, owner, db._exists);
        if (restoreFingerprint(db.data) !== plan.source_hash) throw restoreError('RESTORE_SOURCE_CHANGED');
      }
      writeAttempted = true;
      try { await db.write({ snapshot, expectedRevision: revision }); }
      catch { /* Lost ACK or CAS failure: exactly one authoritative read follows. */ }
      try {
        await db.read({ force: true });
        return report(inspectRestoreSnapshot(db.data, db._exists, plan, owner));
      } catch (error) { throw restoreError('RESTORE_OUTCOME_UNKNOWN', error); }
    });
  } catch (error) {
    // Includes registry retirement and the final outer ledger validation. Never
    // acknowledge an inner success before the entire boundary has returned.
    if (writeAttempted && error.code !== 'RESTORE_OUTCOME_UNKNOWN') throw restoreError('RESTORE_OUTCOME_UNKNOWN', error);
    throw error;
  }
}

async function assertEmptyInstallation() {
  const occupied = () => accountStoreError('INSTALLATION_NOT_EMPTY', '已有安装数据，请使用显式迁移或恢复流程');
  // Any existing file counts, including null auth/legacy documents and empty
  // ledger files. An inaccessible directory is not an empty installation.
  const inspect = async directory => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory()) throw occupied();
      await inspect(path.join(directory, entry.name));
    }
  };
  if (process.env.MEMORY_DELETION_DIR) await inspect(path.resolve(process.env.MEMORY_DELETION_DIR));
  if (process.env.AUTH_DB_PATH) {
    try { await fs.lstat(process.env.AUTH_DB_PATH); throw occupied(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await assertEmptyConfiguredPostgresLedger();
  if (isSupabaseEnabled()) {
    const p = await getPool();
    const result = await p.query('SELECT key FROM kv_store LIMIT 1');
    if (result.rows.length) throw occupied();
    return;
  }
  if (isMongoEnabled()) {
    const mongo = await getMongoDb();
    const collections = await mongo.listCollections({}, { nameOnly: true }).toArray();
    for (const item of collections) if (await mongo.collection(item.name).findOne({})) throw occupied();
    return;
  }
  await inspect(dataDir);
}

export async function initializeEmptyInstallation() {
  return userDbRegistry.maintain('default', async protect => {
    await assertEmptyInstallation();
    await createOnlyAccount(await rawAccountDb('default', protect), newAccountSnapshot('default'), 'default', {
      verifyExisting: data => verifyPreprovisionedAccount(data, 'default')
    });
    return { initialized: true, confirmedByRead: true };
  });
}

export async function initDatabase() {
  // Startup is always required/read-only. Empty install and legacy migration
  // are separate explicit maintenance operations, never guesses from absence.
  if (isSupabaseEnabled()) await getPool();
  else if (isMongoEnabled()) await getMongoDb();
  defaultDb = await getUserDb('default');
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
    userDbRegistry.clear(userId);
    console.log(`🗑️ 已清除用户 ${userId} 的数据库缓存`);
  } else {
    userDbRegistry.clear();
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
