import pg from 'pg';

const { Pool } = pg;

let pool = null;
let initialized = false;
let initializing = null;

export function isSupabaseEnabled() {
  return !!process.env.SUPABASE_DB_URL;
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
      const sslConfig = connectionString.includes('pooler.supabase.com')
        ? { ssl: { rejectUnauthorized: false } }
        : { ssl: { rejectUnauthorized: false } };

      pool = new Pool({
        connectionString,
        max: 5,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 15000,
        ...sslConfig
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
      console.log('✅ Supabase/PostgreSQL 连接成功');
      initializing = null;
      return pool;
    } catch (err) {
      console.error('❌ Supabase/PostgreSQL 连接失败:', err.message);
      if (pool) {
        try { await pool.end(); } catch (e) {}
      }
      pool = null;
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
      this.data = JSON.parse(JSON.stringify(this.defaultData));
    }
  }

  async write() {
    try {
      const p = await getPool();
      if (!p) return;
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
