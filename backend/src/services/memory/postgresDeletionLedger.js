import pg from 'pg';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { buildPostgresTlsConfig } from '../../models/postgresTls.js';
import { getPool } from '../../models/supabaseAdapter.js';

const context = new AsyncLocalStorage();
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = () => Object.assign(new Error('独立记忆删除账本不可用，请核验配置、安装注册及恢复状态'), {
  code: 'MEMORY_BARRIER_UNAVAILABLE', statusCode: 503, isOperational: true
});
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export async function postgresMemoryRequired() {
  if (!process.env.SUPABASE_DB_URL) return false;
  if (['MEMORY_DELETION_DATABASE_URL', 'MEMORY_DELETION_DATABASE_CA_FILE',
    'MEMORY_DELETION_INSTALLATION_ID', 'MEMORY_DELETION_CONNECTION_MODE'].some(key => process.env[key]) ||
    process.env.MEMORY_DELETION_MODE === 'independent') return true;
  if (process.env.MEMORY_DELETION_MODE && process.env.MEMORY_DELETION_MODE !== 'legacy') throw fail();
  const result = await (await getPool()).query("SELECT 1 FROM kv_store WHERE key='memory:deletion-installation'");
  return result.rowCount > 0;
}

// Real server identity, not URI/host spelling. The narrowly scoped EXECUTE
// permission for pg_control_system() is an explicit deployment prerequisite.
export async function databaseIdentity(pool) {
  const { rows } = await pool.query(`SELECT s.system_identifier::text AS cluster,
    d.oid::text AS database FROM pg_control_system() s
    JOIN pg_database d ON d.datname=current_database()`);
  if (!/^\d+$/.test(rows[0]?.cluster) || !/^\d+$/.test(rows[0]?.database)) throw fail();
  return `${rows[0].cluster}:${rows[0].database}`;
}

export function createPostgresDeletionLedger({ businessPool, ledgerPool, installationId }) {
  if (!/^[0-9a-f-]{36}$/i.test(installationId || '')) throw fail();
  let identities;
  async function validate(client) {
    // Recheck identity and marker rather than trusting a stale initialization
    // cache across failover, database replacement or restore.
    const business = await databaseIdentity(businessPool);
    const ledger = await databaseIdentity(client);
    if (business === ledger) throw fail();
    const bound = await businessPool.query("SELECT data FROM kv_store WHERE key='memory:deletion-installation'");
    if (bound.rowCount && bound.rows[0].data?.installationId !== installationId) throw fail();
    const { rows } = await client.query(`SELECT business_identity, ledger_identity
      FROM memory_deletion_installation WHERE singleton=true AND installation_id=$1`, [installationId]);
    if (rows.length !== 1 || rows[0].business_identity !== business || rows[0].ledger_identity !== ledger) throw fail();
    identities = { business, ledger };
    return identities;
  }
  async function withAccountLock(ownerId, fn) {
    if (!idPattern.test(ownerId || '')) throw fail();
    const inherited = context.getStore();
    if (inherited?.adapter === api && inherited.ownerId === ownerId) { inherited.check(); return fn(); }
    let client;
    let failed = false;
    let closed = false;
    const cleanups = [];
    const onError = () => { failed = true; };
    try {
      client = await ledgerPool.connect();
      client.on('error', onError);
      await client.query('SET synchronous_commit=on');
      const fsync = await client.query('SHOW fsync');
      if (fsync.rows[0].fsync !== 'on') throw fail();
      const sync = await client.query('SHOW synchronous_commit');
      if (sync.rows[0].synchronous_commit !== 'on') throw fail();
      await validate(client);
      const { rows: session } = await client.query('SELECT pg_backend_pid() AS pid');
      const pid = session[0].pid;
      const lock = digest(`${installationId}:${ownerId}`);
      await client.query('SELECT pg_advisory_lock($1::bigint)', [BigInt.asIntN(64, BigInt(`0x${lock.slice(0, 16)}`)).toString()]);
      const responses = [];
      const state = { adapter: api, ownerId, client, responses, cleanups, check: () => { if (failed || closed) throw fail(); } };
      state.verify = async () => {
        state.check();
        const { rows } = await client.query(`SELECT pg_backend_pid() AS pid, EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND objsubid=1 AND classid=$1::oid AND objid=$2::oid) AS held`, [BigInt(`0x${lock.slice(0, 8)}`).toString(), BigInt(`0x${lock.slice(8, 16)}`).toString()]);
        if (rows[0].pid !== pid || !rows[0].held) throw fail();
        state.check();
      };
      await state.verify();
      const result = await context.run(state, fn);
      state.check();
      await validate(client);
      await state.verify();
      for (const respond of responses) respond();
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [BigInt.asIntN(64, BigInt(`0x${lock.slice(0, 16)}`)).toString()]);
      return result;
    } catch (error) {
      failed = true;
      await Promise.allSettled(cleanups.map(cleanup => cleanup()));
      if (error?.isOperational && error.code !== 'MEMORY_BARRIER_UNAVAILABLE') throw error;
      throw fail();
    } finally {
      closed = true;
      if (client) { client.removeListener('error', onError); client.release(failed); }
    }
  }
  async function access(ownerId, fn) {
    return withAccountLock(ownerId, async () => {
      const state = context.getStore();
      state.check();
      await validate(state.client);
      const ownerHash = digest(ownerId);
      const registered = await state.client.query(`SELECT 1 FROM memory_deletion_accounts
        WHERE installation_id=$1 AND owner_hash=$2`, [installationId, ownerHash]);
      if (registered.rowCount !== 1) throw fail();
      const result = await fn(state.client, ownerHash);
      await state.verify();
      return result;
    });
  }
  const api = {
    withAccountLock,
    async registerNewAccount(ownerId) {
      return withAccountLock(ownerId, async () => {
        const client = context.getStore().client;
        await validate(client);
        // Only the freshly generated UUID account-creation path calls this.
        await client.query(`INSERT INTO memory_deletion_accounts(installation_id, owner_hash)
          VALUES($1,$2) ON CONFLICT DO NOTHING`, [installationId, digest(ownerId)]);
      });
    },
    async deletedIds(ownerId, ids) {
      return access(ownerId, async (client, ownerHash) => {
        const byHash = new Map(ids.map(id => [digest(JSON.stringify([ownerId, String(id)])), id]));
        const { rows } = await client.query(`SELECT identity_hash FROM memory_deletion_tombstones
          WHERE installation_id=$1 AND owner_hash=$2 AND identity_hash=ANY($3::text[])`,
        [installationId, ownerHash, [...byHash.keys()]]);
        return new Set(rows.map(row => byHash.get(row.identity_hash)));
      });
    },
    async markDeleted(ownerId, id) {
      return access(ownerId, async (client, ownerHash) => {
        // Autocommit is deliberate: this durable tombstone must survive a later
        // business mutation failure, rollback, or lost acknowledgement.
        await client.query(`INSERT INTO memory_deletion_tombstones(installation_id,owner_hash,identity_hash)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [installationId, ownerHash, digest(JSON.stringify([ownerId, String(id)]))]);
      });
    }
  };
  return api;
}
let adapter;
let ownedPool;
let configurationDigest;
export async function getPostgresMemoryLedger() {
  if (!process.env.MEMORY_DELETION_DATABASE_URL || process.env.MEMORY_DELETION_CONNECTION_MODE !== 'session') throw fail();
  const fingerprint = digest(JSON.stringify(['SUPABASE_DB_URL', 'MEMORY_DELETION_DATABASE_URL', 'MEMORY_DELETION_DATABASE_CA_FILE', 'MEMORY_DELETION_INSTALLATION_ID', 'MEMORY_DELETION_CONNECTION_MODE'].map(key => process.env[key] || '')));
  if (adapter && configurationDigest !== fingerprint) throw fail();
  if (!adapter) {
    const businessPool = await getPool();
    if (adapter) { if (configurationDigest !== fingerprint) throw fail(); return adapter; }
    // Validate before allocating a pool so bad installation configuration
    // cannot leak a pool on every failed request.
    if (!/^[0-9a-f-]{36}$/i.test(process.env.MEMORY_DELETION_INSTALLATION_ID || '')) throw fail();
    const pool = new pg.Pool({ ...buildPostgresTlsConfig(process.env.MEMORY_DELETION_DATABASE_URL,
      process.env.MEMORY_DELETION_DATABASE_CA_FILE), max: 10, connectionTimeoutMillis: 15000 });
    pool.on('error', () => {});
    ownedPool = pool;
    configurationDigest = fingerprint;
    adapter = createPostgresDeletionLedger({ businessPool, ledgerPool: pool,
      installationId: process.env.MEMORY_DELETION_INSTALLATION_ID });
  }
  return adapter;
}
export async function withPostgresMemoryLock(ownerId, fn) {
  if (!(await postgresMemoryRequired())) return fn();
  return (await getPostgresMemoryLedger()).withAccountLock(ownerId, fn);
}

export function assertPostgresMemoryLease() { context.getStore()?.check(); }

// Existing routes may call res.json inside their locked callback. Stage the
// detached body until the session lease has been verified, before unlocking.
export function deferPostgresMemoryJson(_req, res, next) {
  const json = res.json.bind(res);
  res.json = body => {
    const state = context.getStore();
    if (!state) return json(body);
    state.check();
    if (state.responses.length) throw fail();
    let bytes = 0, values = 0;
    const encoded = JSON.stringify(body, (_key, value) => {
      if (++values > 100000) throw fail();
      if (typeof value === 'string') bytes += Buffer.byteLength(value);
      if (bytes > 8 * 1024 * 1024) throw fail();
      return value;
    });
    if (encoded === undefined || Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw fail();
    const detached = JSON.parse(encoded);
    state.responses.push(() => json(detached));
    return res;
  };
  const sendFile = res.sendFile?.bind(res);
  if (sendFile) res.sendFile = (...args) => {
    const state = context.getStore();
    if (!state) return sendFile(...args);
    state.check();
    if (state.responses.length) throw fail();
    state.responses.push(() => sendFile(...args));
    return res;
  };
  next();
}

export async function closePostgresMemoryLedger() { const pool = ownedPool; adapter = undefined; ownedPool = undefined; if (pool) await pool.end(); }

export function onPostgresMemoryFailure(cleanup) { const state = context.getStore(); if (state) { state.check(); state.cleanups.push(cleanup); } }
