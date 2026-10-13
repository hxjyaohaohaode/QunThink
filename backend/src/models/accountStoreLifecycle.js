import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { buildPostgresTlsConfig } from './postgresTls.js';
import { assertExplicitDbSnapshot } from './readBarrier.js';
import { validateMessageOrder, assertMessageOrderPreserved } from '../services/messageOrder.js';

export const accountStoreError = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), {
  code, status: 503, statusCode: 503, isOperational: true
});
export const accountDataExists = () => accountStoreError('ACCOUNT_DATA_EXISTS', '账号数据已存在，未覆盖原数据');

export async function readAccountJson(filePath) {
  let raw;
  try { raw = await fs.readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, data: null };
    throw error;
  }
  try { return { exists: true, data: JSON.parse(raw) }; }
  catch (error) { throw accountStoreError('ACCOUNT_DATA_CORRUPT', '账号数据文件损坏，未自动修复', error); }
}

// Hard-link publication is atomic and cannot replace an existing target. A
// private wx temp is fully written before publication, unlike opening target
// with wx and exposing partially written JSON. JSON remains single-process.
export async function createAccountJson(filePath, data, assertLease = () => {}, io = fs) {
  const directory = path.dirname(filePath);
  await io.mkdir(directory, { recursive: true });
  assertLease();
  const temporary = path.join(directory, `.${path.basename(filePath)}.create-${randomUUID()}.tmp`);
  let handle, owned = false;
  try {
    handle = await io.open(temporary, 'wx', 0o600); owned = true;
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    assertLease();
    try { await io.link(temporary, filePath); }
    catch (error) { if (error.code === 'EEXIST') throw accountDataExists(); throw error; }
    assertLease();
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (owned) await io.unlink(temporary);
  }
}

export function validateRequiredAccount(data, ownerId, exists = true) {
  if (exists === false) throw accountStoreError('ACCOUNT_DATA_MISSING', '账号数据缺失，请执行显式安装、迁移或恢复核验');
  if (exists !== true) throw accountStoreError('ACCOUNT_DATA_UNKNOWN', '无法确定账号数据是否存在');
  try { assertExplicitDbSnapshot(data); }
  catch (error) { throw accountStoreError('ACCOUNT_DATA_INVALID', '账号数据不是有效文档', error); }
  validateMessageOrder(data, ownerId);
  return data;
}

// Adapters invoke read before publishing either data or revision. The baseline
// is a separate clone: old in-place writers cannot mutate their own validator.
// Failed writes demand an authoritative read; no guessed rollback is published.
export function requireAccountStore(db, ownerId) {
  let committed, ready = false, epoch = 0;
  db._accountStoreContract = {
    read(data, exists) {
      ready = false; epoch++;
      validateRequiredAccount(data, ownerId, exists);
      committed = structuredClone(data); ready = true;
    },
    checkTarget(data, exists) {
      // A read-only preflight never publishes data or grants a new permit.
      try { validateRequiredAccount(data, ownerId, exists); }
      catch (error) { ready = false; epoch++; throw error; }
    },
    beforeWrite(data) {
      if (!ready) throw accountStoreError('ACCOUNT_WRITE_REQUIRES_READ', '写入结果需先权威读取核验');
      assertMessageOrderPreserved(committed, data, ownerId);
      return epoch;
    },
    checkWrite(permit, { afterIo = false } = {}) {
      if (ready && permit === epoch) return;
      ready = false; epoch++;
      throw accountStoreError(afterIo ? 'WRITE_ACK_UNKNOWN' : 'ACCOUNT_WRITE_REQUIRES_READ',
        afterIo ? '旧写入许可已失效，提交结果需权威核验' : '写入许可已失效，请重新读取');
    },
    committed(data) { committed = structuredClone(data); ready = true; epoch++; },
    uncertain() { ready = false; epoch++; }
  };
  return db;
}

export async function createOnlyAccount(db, snapshot, ownerId, { verifyExisting = () => {} } = {}) {
  validateRequiredAccount(snapshot, ownerId);
  // This is a raw read: absence permits only this explicit creation operation.
  await db.read({ force: true });
  if (db._exists === true) {
    validateRequiredAccount(db.data, ownerId); verifyExisting(db.data);
  } else {
    if (db._exists !== false) throw accountStoreError('ACCOUNT_DATA_UNKNOWN', '无法确定账号数据是否存在');
    let createError;
    try { await db.create({ snapshot }); }
    catch (error) {
      if (error.code === 'USER_DB_REPLACED') throw error;
      createError = error;
    }
    // Even an acknowledged create is followed by authoritative readback. A
    // failed/unknown ACK never causes a second INSERT or new generation.
    try { await db.read({ force: true }); }
    catch (error) {
      if (error.code === 'USER_DB_REPLACED') throw error;
      throw accountStoreError('ACCOUNT_CREATION_OUTCOME_UNKNOWN', '账号创建结果待权威核验', error);
    }
    if (db._exists === false) {
      if (createError) {
        if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(createError.code)) throw createError;
        throw accountStoreError('ACCOUNT_CREATION_OUTCOME_UNKNOWN', '创建确认未收到且暂不可读取，请核验原结果', createError);
      }
      throw accountStoreError('ACCOUNT_CREATION_OUTCOME_UNKNOWN', '已确认创建的账号暂不可读取');
    }
    validateRequiredAccount(db.data, ownerId, db._exists);
    if (createError?.code === 'ACCOUNT_DATA_EXISTS') verifyExisting(db.data);
    else if (!isDeepStrictEqual(db.data, snapshot)) {
      throw accountStoreError('ACCOUNT_CREATION_OUTCOME_UNKNOWN', '账号创建结果与原创建意图不一致');
    }
  }
  requireAccountStore(db, ownerId);
  db._accountStoreContract.read(db.data, db._exists);
  return db;
}

// Empty-install validation only. Never call the ledger initializer: it would
// create identities/rows and cannot establish that an installation was empty.
export async function assertEmptyConfiguredPostgresLedger() {
  const configured = ['MEMORY_DELETION_DATABASE_URL', 'MEMORY_DELETION_DATABASE_CA_FILE',
    'MEMORY_DELETION_INSTALLATION_ID', 'MEMORY_DELETION_CONNECTION_MODE'].some(key => process.env[key])
    || (process.env.MEMORY_DELETION_MODE && process.env.MEMORY_DELETION_MODE !== 'legacy');
  if (!configured) return;
  if (!process.env.MEMORY_DELETION_DATABASE_URL || process.env.MEMORY_DELETION_CONNECTION_MODE !== 'session'
    || !/^[0-9a-f-]{36}$/i.test(process.env.MEMORY_DELETION_INSTALLATION_ID || '')
    || (process.env.MEMORY_DELETION_MODE && !['independent', 'legacy'].includes(process.env.MEMORY_DELETION_MODE))) {
    throw accountStoreError('INSTALLATION_STATE_UNKNOWN', '独立删除账本配置不完整，无法证明空安装，请核验迁移或恢复状态');
  }
  const pool = new pg.Pool({ ...buildPostgresTlsConfig(process.env.MEMORY_DELETION_DATABASE_URL,
    process.env.MEMORY_DELETION_DATABASE_CA_FILE), max: 1, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  try {
    const { rows } = await pool.query(`SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','m','f','v')`);
    if (rows.some(table => ['f', 'v'].includes(table.relkind) || table.relrowsecurity)) {
      throw accountStoreError('INSTALLATION_STATE_UNKNOWN', '独立账本含视图、外部表或行级策略，不能安全证明空安装');
    }
    const quote = identifier => '"' + identifier.replaceAll('"', '""') + '"';
    for (const table of rows) {
      const result = await pool.query(`SELECT 1 FROM ${quote(table.nspname)}.${quote(table.relname)} LIMIT 1`);
      if (result.rowCount) throw accountStoreError('INSTALLATION_NOT_EMPTY', '独立删除账本已有记录，请使用迁移或恢复流程');
    }
  } finally { await pool.end(); }
}
