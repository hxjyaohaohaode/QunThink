import { accountDataExists } from './accountStoreLifecycle.js';
import { assertPostgresMemoryLease } from '../services/memory/postgresDeletionLedger.js';
import pg from 'pg';
import { buildPostgresTlsConfig } from './postgresTls.js';
import { beginUserDbWriteBarrier, readWithWriteBarrier, assertSynchronousPublishHook, runSynchronousPublishHook, assertExplicitDbSnapshot } from './readBarrier.js';

const { Pool } = pg;

function safePostgresErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code : 'POSTGRES_CONNECTION_FAILED';
}

let pool = null;
let initialized = false;
let _lastConnectionFailureAt = 0;
const CONNECTION_RETRY_COOLDOWN_MS = 60 * 1000;
let initializing = null;

export async function ensureKvSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      revision BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Existing installations have kv_store without a revision. This additive
  // migration preserves their JSON documents and starts CAS at revision zero.
  await client.query('ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0');
}

export function isSupabaseEnabled() {
  // Backend choice is configuration, never an availability decision. Falling
  // back to a local JSON file during an outage would create a divergent user.
  return Boolean(process.env.SUPABASE_DB_URL);
}

export function isCloudDbEnabled() {
  return !!process.env.SUPABASE_DB_URL || !!process.env.MONGODB_URI;
}

export async function getPool() {
  if (pool) return pool;
  if (initializing) return initializing;

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) return null;
  if (_lastConnectionFailureAt && Date.now() - _lastConnectionFailureAt < CONNECTION_RETRY_COOLDOWN_MS) {
    throw Object.assign(new Error('PostgreSQL 暂不可用，请稍后重试'), { status: 503 });
  }

  const tlsConfig = buildPostgresTlsConfig(connectionString, process.env.SUPABASE_DB_CA_FILE);
  initializing = (async () => {
    try {
      pool = new Pool({
        ...tlsConfig,
        max: 5,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 15000
      });

      pool.on('error', (err) => {
        console.error('PostgreSQL pool error:', safePostgresErrorCode(err));
      });

      const client = await pool.connect();
      try {
        await ensureKvSchema(client);
      } finally {
        client.release();
      }

      initialized = true;
      _lastConnectionFailureAt = 0;
      console.log('✅ Supabase/PostgreSQL 连接成功');
      initializing = null;
      return pool;
    } catch (err) {
      console.error('❌ Supabase/PostgreSQL 连接失败:', safePostgresErrorCode(err));
      console.error('⚠️ 将在 60 秒后自动重试；期间新请求按无云库处理。数据不会静默切换到本地存储。');
      _lastConnectionFailureAt = Date.now();
      if (pool) {
        try { await pool.end(); } catch (e) {}
      }
      pool = null;
      initialized = false;
      initializing = null;
      throw Object.assign(new Error('PostgreSQL connection failed'), { code: safePostgresErrorCode(err) });
    }
  })();

  return initializing;
}

function postgresRevision(value) {
  // pg returns BIGINT as decimal text by default. Do not silently round it or
  // coerce null, booleans, exponent notation, or malformed legacy revisions.
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) {
    throw Object.assign(new Error('Invalid database revision'), { code: 'INVALID_DB_REVISION', status: 503 });
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw Object.assign(new Error('Invalid database revision'), { code: 'INVALID_DB_REVISION', status: 503 });
  }
  return revision;
}

export class PgLow {
  constructor(key, defaultData, poolOverride = null, { existingOnly = false } = {}) {
    this.key = key;
    this.data = JSON.parse(JSON.stringify(defaultData));
    this.defaultData = defaultData;
    this._lastAccess = Date.now();
    this._revision = 0;
    this._exists = null;
    this._poolOverride = poolOverride;
    this._existingOnly = existingOnly;
  }

  async read({ onPublished } = {}) {
    assertSynchronousPublishHook(onPublished);
    try {
      const p = this._poolOverride || await getPool();
      this.assertCurrentLease?.();
      assertPostgresMemoryLease();
      if (!p) throw new Error('PostgreSQL连接不可用');
      await readWithWriteBarrier(this, () => {
        this.assertCurrentLease?.();
        assertPostgresMemoryLease();
        return p.query('SELECT data, revision FROM kv_store WHERE key = $1', [this.key]);
      }, result => {
        assertPostgresMemoryLease();
        const exists = result.rows.length > 0;
        const revision = exists ? postgresRevision(result.rows[0].revision) : 0;
        const data = exists ? result.rows[0].data : JSON.parse(JSON.stringify(this.defaultData));
        this._accountStoreContract?.read(data, exists);
        this.data = data;
        this._revision = revision;
        this._exists = exists;
        runSynchronousPublishHook(onPublished, { data, revision, exists, supportsRevisionCas: true });
      });
    } catch (err) {
      this._accountStoreContract?.uncertain();
      console.warn('PgLow read failed:', err.message);
      throw err;
    }
  }

  async create({ snapshot }) {
    const releaseBarrier = beginUserDbWriteBarrier(this);
    try {
      assertExplicitDbSnapshot(snapshot);
      const data = JSON.parse(JSON.stringify(snapshot));
      assertExplicitDbSnapshot(data);
      const p = this._poolOverride || await getPool();
      this.assertCurrentLease?.(); assertPostgresMemoryLease();
      if (!p) throw new Error('PostgreSQL连接不可用');
      const result = await p.query(
        `INSERT INTO kv_store(key,data,revision,updated_at)
         VALUES($1,$2,1,NOW()) ON CONFLICT (key) DO NOTHING RETURNING revision`, [this.key, data]);
      this.assertCurrentLease?.(); assertPostgresMemoryLease();
      if (result?.rowCount === 0) throw accountDataExists();
      if (result?.rowCount !== 1 || ![1, '1'].includes(result.rows?.[0]?.revision)) {
        throw Object.assign(new Error('Unconfirmed database create'), { code: 'WRITE_ACK_UNKNOWN', status: 503 });
      }
      this.data = data; this._revision = 1; this._exists = true;
    } finally {
      releaseBarrier();
    }
  }

  async write(options) {
    const releaseBarrier = beginUserDbWriteBarrier(this);
    try {
      const explicit = options !== undefined;
      if (explicit && (!options || !Object.hasOwn(options, 'snapshot'))) throw new TypeError('write options must include snapshot');
      if (explicit) assertExplicitDbSnapshot(options.snapshot);
      const data = JSON.parse(JSON.stringify(explicit ? options.snapshot : this.data));
      if (explicit) assertExplicitDbSnapshot(data);
      const permit = this._accountStoreContract?.beforeWrite(data);
      const expectedRevision = postgresRevision(explicit && Object.hasOwn(options, 'expectedRevision') ? options.expectedRevision : this._revision);
      if (expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw Object.assign(new Error('Database revision exhausted'), { code: 'DB_REVISION_EXHAUSTED', status: 503 });
      }
      const nextRevision = expectedRevision + 1;
      const p = this._poolOverride || await getPool();
      this.assertCurrentLease?.();
      assertPostgresMemoryLease();
      if (!p) throw new Error('PostgreSQL连接不可用，拒绝丢弃写入');
      this._accountStoreContract?.checkWrite(permit);
      const publish = result => {
        const revision = postgresRevision(result.rows?.[0]?.revision);
        if (revision !== nextRevision) throw Object.assign(new Error('Unconfirmed database write revision'), { code: 'WRITE_ACK_UNKNOWN', status: 503 });
        this.assertCurrentLease?.();
        assertPostgresMemoryLease();
        this._accountStoreContract?.checkWrite(permit, { afterIo: true });
        if (explicit) this.data = data;
        this._revision = revision;
        this._exists = true;
        this._accountStoreContract?.committed(data);
      };
      const updated = await p.query(
        `UPDATE kv_store SET data=$2, revision=revision+1, updated_at=NOW()
         WHERE key=$1 AND revision=$3 RETURNING revision`,
        [this.key, data, expectedRevision]
      );
      if (updated.rowCount === 1) { publish(updated); return; }
      this._accountStoreContract?.checkWrite(permit, { afterIo: true });
      if (updated.rowCount !== 0) throw Object.assign(new Error('Unconfirmed database write'), { code: 'WRITE_ACK_UNKNOWN', status: 503 });
      if (expectedRevision === 0 && !this._accountStoreContract && !this._existingOnly) {
        this.assertCurrentLease?.();
        assertPostgresMemoryLease();
        const inserted = await p.query(
          `INSERT INTO kv_store(key,data,revision,updated_at)
           VALUES($1,$2,1,NOW()) ON CONFLICT (key) DO NOTHING RETURNING revision`,
          [this.key, data]
        );
        if (inserted.rowCount === 1) { publish(inserted); return; }
        if (inserted.rowCount !== 0) throw Object.assign(new Error('Unconfirmed database insert'), { code: 'WRITE_ACK_UNKNOWN', status: 503 });
      }
      throw Object.assign(new Error('数据已在其他进程更新，请刷新后重试'), { status: 409, code: 'REVISION_CONFLICT' });
    } catch (err) {
      this._accountStoreContract?.uncertain();
      console.warn('PgLow write failed:', err.message);
      throw err;
    } finally {
      releaseBarrier();
    }
  }
}

export async function closeSupabaseConnection() {
  if (pool) {
    await pool.end();
    pool = null;
    initialized = false;
    console.log('✅ Supabase/PostgreSQL 连接已关闭');
  }
}

export async function listAllKeys(prefix) {
  const p = await getPool();
  if (!p) return [];
  const result = await p.query(
    'SELECT key FROM kv_store WHERE key LIKE $1',
    [prefix + '%']
  );
  return result.rows.map(r => r.key.replace(prefix, ''));
}
