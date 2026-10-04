import pg from 'pg';

const { Pool } = pg;

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

  initializing = (async () => {
    try {
      pool = new Pool({
        connectionString,
        max: 5,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 15000,
        ssl: { rejectUnauthorized: true }
      });

      pool.on('error', (err) => {
        console.error('PostgreSQL pool error:', err.message);
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
      console.error('❌ Supabase/PostgreSQL 连接失败:', err.message);
      console.error('⚠️ 将在 60 秒后自动重试；期间新请求按无云库处理。数据不会静默切换到本地存储。');
      _lastConnectionFailureAt = Date.now();
      if (pool) {
        try { await pool.end(); } catch (e) {}
      }
      pool = null;
      initialized = false;
      initializing = null;
      throw err;
    }
  })();

  return initializing;
}

export class PgLow {
  constructor(key, defaultData, poolOverride = null) {
    this.key = key;
    this.data = JSON.parse(JSON.stringify(defaultData));
    this.defaultData = defaultData;
    this._lastAccess = Date.now();
    this._revision = 0;
    this._poolOverride = poolOverride;
  }

  async read() {
    try {
      const p = this._poolOverride || await getPool();
      if (!p) throw new Error('PostgreSQL连接不可用');
      const result = await p.query(
        'SELECT data, revision FROM kv_store WHERE key = $1',
        [this.key]
      );
      if (result.rows.length > 0 && result.rows[0].data) {
        this.data = result.rows[0].data;
        this._revision = Number(result.rows[0].revision);
      } else {
        this.data = JSON.parse(JSON.stringify(this.defaultData));
        this._revision = 0;
      }
    } catch (err) {
      console.warn('PgLow read failed:', err.message);
      throw err;
    }
  }

  async write() {
    try {
      const p = this._poolOverride || await getPool();
      if (!p) throw new Error('PostgreSQL连接不可用，拒绝丢弃写入');
      const data = JSON.parse(JSON.stringify(this.data));
      const updated = await p.query(
        `UPDATE kv_store SET data=$2, revision=revision+1, updated_at=NOW()
         WHERE key=$1 AND revision=$3 RETURNING revision`,
        [this.key, data, this._revision]
      );
      if (updated.rowCount === 1) {
        this._revision = Number(updated.rows[0].revision);
        return;
      }
      if (this._revision === 0) {
        const inserted = await p.query(
          `INSERT INTO kv_store(key,data,revision,updated_at)
           VALUES($1,$2,1,NOW()) ON CONFLICT (key) DO NOTHING RETURNING revision`,
          [this.key, data]
        );
        if (inserted.rowCount === 1) {
          this._revision = 1;
          return;
        }
      }
      throw Object.assign(new Error('数据已在其他进程更新，请刷新后重试'), { status: 409, code: 'REVISION_CONFLICT' });
    } catch (err) {
      console.warn('PgLow write failed:', err.message);
      throw err;
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
