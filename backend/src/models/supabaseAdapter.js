import pg from 'pg';

const { Pool } = pg;

let pool = null;
let initialized = false;
let _lastConnectionFailureAt = 0;
const CONNECTION_RETRY_COOLDOWN_MS = 60 * 1000;
let initializing = null;

export function isSupabaseEnabled() {
  if (!process.env.SUPABASE_DB_URL) return false;
  if (_lastConnectionFailureAt === 0) return true;
  if (Date.now() - _lastConnectionFailureAt >= CONNECTION_RETRY_COOLDOWN_MS) {
    console.warn('🔁 Supabase 冷却期结束，下次访问将重试连接');
    _lastConnectionFailureAt = 0;
    return true;
  }
  return false;
}

export function isCloudDbEnabled() {
  return !!process.env.SUPABASE_DB_URL || !!process.env.MONGODB_URI;
}

export async function getPool() {
  if (pool) return pool;
  if (initializing) return initializing;

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) return null;

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
      await client.query(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      client.release();

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
  constructor(key, defaultData) {
    this.key = key;
    this.data = JSON.parse(JSON.stringify(defaultData));
    this.defaultData = defaultData;
    this._lastAccess = Date.now();
  }

  async read() {
    try {
      const p = await getPool();
      if (!p) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('PostgreSQL连接不可用');
        }
        this.data = JSON.parse(JSON.stringify(this.defaultData));
        return;
      }
      const result = await p.query(
        'SELECT data FROM kv_store WHERE key = $1',
        [this.key]
      );
      if (result.rows.length > 0 && result.rows[0].data) {
        this.data = result.rows[0].data;
      } else {
        this.data = JSON.parse(JSON.stringify(this.defaultData));
      }
    } catch (err) {
      console.warn('PgLow read failed:', err.message);
      if (process.env.NODE_ENV === 'production') throw err;
      this.data = JSON.parse(JSON.stringify(this.defaultData));
    }
  }

  async write() {
    try {
      const p = await getPool();
      if (!p) throw new Error('PostgreSQL连接不可用，拒绝丢弃写入');
      await p.query(
        `INSERT INTO kv_store (key, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key)
         DO UPDATE SET data = $2, updated_at = NOW()`,
        [this.key, JSON.parse(JSON.stringify(this.data))]
      );
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
