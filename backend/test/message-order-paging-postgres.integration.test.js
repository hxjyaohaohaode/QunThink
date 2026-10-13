// Opt-in, real TLS PostgreSQL + separate deletion-ledger database. The parent
// runner owns startup/teardown. This test never starts a database service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const businessAdminUrl = process.env.QUNTHINK_TEST_PAGING_PG_URL;
const ledgerAdminUrl = process.env.QUNTHINK_TEST_PAGING_LEDGER_URL;
const caFile = process.env.QUNTHINK_TEST_PAGING_PG_CA;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => createHash('sha256').update(value).digest('hex');
test('message HTTP paging on real PostgreSQL with full independent-ledger response boundary', {
  skip: ![businessAdminUrl, ledgerAdminUrl, caFile].some(Boolean), timeout: 90000
}, async t => {
  assert.ok(businessAdminUrl && ledgerAdminUrl && caFile, 'all three explicit paging fixture variables are required');
  for (const [url, database] of [[businessAdminUrl, 'qunthink_paging'], [ledgerAdminUrl, 'qunthink_paging_ledger']]) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'postgresql:'); assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname)); assert.equal(parsed.pathname, `/${database}`);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-page-pg-'));
  for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'test', AUTH_MODE: 'session', DATA_DIR: root,
    AUTH_DB_PATH: path.join(root, 'auth.json'), ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SUPABASE_DB_URL: businessAdminUrl, SUPABASE_DB_CA_FILE: caFile });
  const { buildPostgresTlsConfig } = await import('../src/models/postgresTls.js');
  const { ensureKvSchema, getPool, closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  const { installPostgresLedger } = await import('../src/services/memory/postgresLedgerInstallation.js');
  const { getPostgresMemoryLedger, closePostgresMemoryLedger, databaseIdentity } = await import('../src/services/memory/postgresDeletionLedger.js');
  const { initializeEmptyInstallation, initDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
  const { readCommittedUserDb } = await import('../src/models/readBarrier.js');
  const { markMessageDeleted, markFileDeleted } = await import('../src/services/memory/persistentMemory.js');
  const businessAdmin = new pg.Pool(buildPostgresTlsConfig(businessAdminUrl, caFile));
  const ledgerAdmin = new pg.Pool(buildPostgresTlsConfig(ledgerAdminUrl, caFile));
  const suffix = randomUUID().replaceAll('-', ''), businessRole = `paging_business_${suffix}`, ledgerRole = `paging_ledger_${suffix}`;
  const password = randomBytes(32).toString('hex'), installationId = randomUUID();
  const runtimeUrl = (url, role) => { const value = new URL(url); value.username = role; value.password = password; return value.toString(); };
  const businessUrl = runtimeUrl(businessAdminUrl, businessRole), ledgerUrl = runtimeUrl(ledgerAdminUrl, ledgerRole);
  let businessPool, ledgerPool, server;
  const attempts = [];
  async function until(read, predicate, description) {
    const deadline = Date.now() + 8000;
    do { const value = await read(); if (predicate(value)) return value; await delay(10); } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}`);
  }
  const record = (name, facts) => t.diagnostic(JSON.stringify({ name, ...facts }));
  function lockParts(owner) { const value = hash(`${installationId}:${owner}`); return [BigInt(`0x${value.slice(0, 8)}`).toString(), BigInt(`0x${value.slice(8, 16)}`).toString()]; }
  async function locks(owner) {
    return (await ledgerAdmin.query(`SELECT l.pid,l.granted,a.usename,a.wait_event_type,a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.objsubid=1 AND l.classid=$1::oid AND l.objid=$2::oid
      AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())`, lockParts(owner))).rows;
  }
  async function holdTail(ledger, owner) {
    const original = ledger.deletedIds, reached = deferred(); let calls = 0, release, pid;
    ledger.deletedIds = async (...args) => {
      const result = await original(...args);
      if (args[0] !== owner || ++calls !== 2) return result;
      const held = (await locks(owner)).filter(row => row.granted); assert.equal(held.length, 1); assert.equal(held[0].usename, ledgerRole); pid = held[0].pid;
      const client = await ledgerAdmin.connect(); await client.query('BEGIN'); await client.query('LOCK TABLE memory_deletion_installation IN ACCESS EXCLUSIVE MODE');
      let closed = false;
      release = async () => { if (closed) return; closed = true; try { await client.query('ROLLBACK'); } finally { client.release(); } };
      reached.resolve(pid); return result;
    };
    return {
      reached: reached.promise,
      async wait() {
        const value = await reached.promise;
        await until(async () => (await ledgerAdmin.query('SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1', [value])).rows[0],
          row => row?.wait_event_type === 'Lock' && row.query.includes('FROM memory_deletion_installation'), 'real page outer ledger tail');
        return value;
      },
      async release() { await release?.(); },
      async cleanup() { ledger.deletedIds = original; await release?.(); }
    };
  }
  function childProfile(owner) {
    const source = `import {getUserDb,withWriteLock} from './src/models/db.js';
      import {closeSupabaseConnection} from './src/models/supabaseAdapter.js';
      import {closePostgresMemoryLedger} from './src/services/memory/postgresDeletionLedger.js';
      const owner=process.env.PAGING_OWNER; const db=await getUserDb(owner);
      await withWriteLock(owner,async()=>{await db.read({force:true}); const data=structuredClone(db.data); data.profile={...data.profile,pagingMarker:'independent-profile',pagingProcess:process.pid}; await db.write({snapshot:data,expectedRevision:db._revision});});
      console.log('PAGING_CHILD_RESULT '+JSON.stringify({pid:process.pid,revision:db._revision}));
      await closePostgresMemoryLedger(); await closeSupabaseConnection();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, PAGING_OWNER: owner }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', status => {
        if (status !== 0) return reject(new Error(`Independent profile fixture failed (${status}): ${errors}`));
        const line = output.split('\n').find(value => value.startsWith('PAGING_CHILD_RESULT '));
        if (!line) return reject(new Error('Independent profile fixture did not confirm result'));
        resolve(JSON.parse(line.slice('PAGING_CHILD_RESULT '.length)));
      });
    });
    return { child, completion };
  }
  try {
    await ensureKvSchema(businessAdmin);
    await initializeEmptyInstallation(); await closeSupabaseConnection();
    await installPostgresLedger({ businessPool: businessAdmin, ledgerPool: ledgerAdmin, installationId });
    await businessAdmin.query(`CREATE ROLE ${businessRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
      CREATE ROLE ${ledgerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
      ALTER TABLE kv_store OWNER TO ${businessRole}; GRANT CREATE ON SCHEMA public TO ${businessRole};
      REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC; GRANT EXECUTE ON FUNCTION pg_control_system() TO ${businessRole}`);
    await ledgerAdmin.query(`REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC; GRANT EXECUTE ON FUNCTION pg_control_system() TO ${ledgerRole};
      GRANT SELECT ON memory_deletion_installation,memory_deletion_accounts,memory_deletion_tombstones TO ${ledgerRole};
      GRANT INSERT ON memory_deletion_accounts,memory_deletion_tombstones TO ${ledgerRole}`);
    Object.assign(process.env, { SUPABASE_DB_URL: businessUrl, SUPABASE_DB_CA_FILE: caFile,
      MEMORY_DELETION_DATABASE_URL: ledgerUrl, MEMORY_DELETION_DATABASE_CA_FILE: caFile, MEMORY_DELETION_INSTALLATION_ID: installationId,
      MEMORY_DELETION_CONNECTION_MODE: 'session', MEMORY_DELETION_MODE: 'independent' });
    businessPool = await getPool(); ledgerPool = new pg.Pool(buildPostgresTlsConfig(ledgerUrl, caFile));
    await initDatabase(); const { initAuthDb } = await import('../src/models/authDb.js'); await initAuthDb();
    const express = (await import('express')).default, cookieParser = (await import('cookie-parser')).default;
    const authRouter = (await import('../src/routes/auth.js')).default, messagesRouter = (await import('../src/routes/messages.js')).default;
    const authMiddleware = (await import('../src/middleware/auth.js')).default;
    const { injectUserDb } = await import('../src/middleware/userDb.js'); const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const app = express(); app.use(cookieParser()); app.use(express.json());
    // Intentionally omit deferPostgresMemoryJson. The actual GET must itself
    // wait for the lock promise, rather than depending on an HTTP staging shim.
    app.use((req, res, next) => { const json = res.json; res.json = function(body) {
      if (req.method === 'GET' && req.path.endsWith('/messages')) attempts.push({ status: res.statusCode, body: structuredClone(body) });
      return json.call(this, body);
    }; next(); });
    app.use('/api', authRouter); app.use(authMiddleware); app.use(injectUserDb); app.use('/api', messagesRouter); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, ledger = await getPostgresMemoryLedger();
    async function http(method, endpoint, body, cookie) {
      const response = await fetch(base + endpoint, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
    }
    async function fixture() {
      const r = await http('POST', '/api/auth/register', { username: `paging_pg_${randomUUID()}`, password: 'SyntheticFixtureOnly2026!' }); assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = r.body.user.id, db = await getUserDb(id), groupId = db.data.groups[0].id;
      const endpoint = `/api/groups/${groupId}/messages`, cookie = r.cookie;
      return { id, db, groupId, endpoint, cookie, get: query => http('GET', `${endpoint}?order=sequence_v1${query ? '&' + query : ''}`, null, cookie),
        post: () => http('POST', endpoint, { content: 'Synthetic PG private page sentinel', clientMessageId: randomUUID() }, cookie),
        durable: async () => (await businessPool.query('SELECT data,revision FROM kv_store WHERE key=$1', [`user:${id}`])).rows[0] };
    }

    await t.test('runtime connections use distinct databases, restricted roles and verified TLS with durable settings', async () => {
      const facts = [];
      for (const pool of [businessPool, ledgerPool]) facts.push((await pool.query(`SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl,(SELECT version FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
        current_setting('server_version') AS server_version,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit`)).rows[0]);
      for (const row of facts) { assert.equal(row.superuser, false); assert.equal(row.ssl, true); assert.equal(row.tls, 'TLSv1.3'); assert.equal(row.fsync, 'on'); assert.equal(row.synchronous_commit, 'on'); }
      assert.notEqual(await databaseIdentity(businessPool), await databaseIdentity(ledgerPool));
      assert.equal((await ledgerPool.query("SELECT has_table_privilege(current_user,'memory_deletion_tombstones','DELETE') AS allowed")).rows[0].allowed, false);
      record('fixture', { facts, independentLedger: true, privilegedRuntime: false });
    });

    await t.test('real HTTP encrypted writes page forward and backward and only GETs preserve PG revision and business hashes', async () => {
      const f = await fixture(), empty = await f.get(); assert.equal(empty.status, 200); assert.equal(empty.body.consumed_through, '0');
      const sent = [];
      for (let i = 0; i < 51; i++) { const r = await f.post(); assert.equal(r.status, 201, JSON.stringify(r.body)); sent.push(r.body.id); }
      const stored = await f.durable(), first = await f.get('limit=50'), second = await f.get(`limit=50&before_cursor=${first.body.before_cursor}`);
      assert.equal(first.status, 200); assert.equal(second.status, 200); assert.deepEqual([...second.body.messages, ...first.body.messages].map(m => m.id), sent);
      const a = await f.get(`limit=50&after_cursor=${empty.body.after_cursor}`), b = await f.get(`limit=50&after_cursor=${a.body.after_cursor}`);
      assert.deepEqual([...a.body.messages, ...b.body.messages].map(m => m.id), sent); assert.equal(a.body.consumed_through, '50'); assert.equal(b.body.consumed_through, '51');
      assert.deepEqual(await f.durable(), stored); assert.ok(stored.data.messages.every(m => m.metadata.encryption.encrypted && m.content !== 'Synthetic PG private page sentinel'));
      record('http-paging', { realHttpWrites: 51, history: [50, 1], increment: [50, 1], unchangedRevisionAndBusinessSnapshot: true });
    });

    await t.test('HTTP never calls res.json while final ledger verification and its read fence are blocked', async () => {
      const f = await fixture(); assert.equal((await f.post()).status, 201); const before = await f.durable(), index = attempts.length;
      const hold = await holdTail(ledger, f.id); let done = false, readerDone = false;
      const result = f.get().then(value => { done = true; return value; });
      try {
        const pid = await hold.wait(); const reader = readCommittedUserDb(f.db, data => data.messages.length).then(value => { readerDone = true; return value; });
        await delay(40); assert.equal(done, false); assert.equal(readerDone, false); assert.equal(attempts.length, index, 'no res.json invocation before full outer lock');
        await hold.release(); const response = await result; assert.equal(response.status, 200); assert.equal(await reader, 1); assert.equal(attempts.length, index + 1);
        assert.equal(response.body.high_watermark, '1'); assert.deepEqual(await f.durable(), before);
        record('http-tail-success', { pid, directResJsonCallsBeforeRelease: 0, readFenceHeldThroughTail: true, status: response.status, businessWrites: 0 });
      } finally { await hold.cleanup(); await result; }
    });

    await t.test('terminated real outer ledger session suppresses a fully composed page and returns only safe 503', async () => {
      const f = await fixture(); assert.equal((await f.post()).status, 201); const stored = await f.durable(), index = attempts.length;
      const hold = await holdTail(ledger, f.id); const result = f.get();
      try {
        const pid = await hold.wait(); assert.equal(attempts.length, index);
        assert.equal((await ledgerAdmin.query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows[0].terminated, true);
        await hold.release(); const response = await result;
        assert.equal(response.status, 503); assert.equal(response.body.code, 'MEMORY_BARRIER_UNAVAILABLE'); assert.equal(response.body.messages, undefined);
        assert.equal(JSON.stringify(response.body).includes('Synthetic PG private page sentinel'), false); assert.equal(response.body.generation, undefined); assert.equal(response.body.high_watermark, undefined);
        assert.equal(attempts.length, index + 1); assert.equal(attempts[index].status, 503); assert.deepEqual(await f.durable(), stored);
        const fresh = await f.get(); assert.equal(fresh.status, 200); assert.equal(fresh.body.messages.length, 1);
        record('http-tail-failure', { terminatedPid: pid, earlySuccessCalls: 0, returnedStatus: response.status, privatePageSuppressed: true, unchangedBusiness: true, laterFreshRead: fresh.status });
      } finally { await hold.cleanup(); await result; }
    });

    await t.test('independent Node process non-message write waits for the complete page scope and preserves messages and sequence', async () => {
      const f = await fixture(); assert.equal((await f.post()).status, 201); const before = await f.durable(), hold = await holdTail(ledger, f.id);
      const reading = f.get(); let spawned;
      try {
        await hold.wait(); spawned = childProfile(f.id); let written = false; const writing = spawned.completion.then(value => { written = true; return value; });
        // The table lock may block its initial ledger validation before it can
        // queue for the advisory lock. Either observed PG lock proves waiting.
        await until(async () => (await ledgerAdmin.query(`SELECT pid,wait_event_type,query FROM pg_stat_activity WHERE usename=$1 AND pid<>ALL($2::int[])`,
          [ledgerRole, (await locks(f.id)).filter(row => row.granted).map(row => row.pid)])).rows,
          rows => rows.some(row => row.wait_event_type === 'Lock'), 'independent profile process blocked by active page ledger scope');
        await delay(40); assert.equal(written, false); assert.deepEqual(await f.durable(), before);
        await hold.release(); const response = await reading, child = await writing; assert.equal(response.status, 200); assert.notEqual(child.pid, process.pid);
        const saved = await f.durable(); assert.equal(saved.data.profile.pagingMarker, 'independent-profile');
        assert.deepEqual(saved.data.messages, before.data.messages); assert.deepEqual(saved.data.message_order, before.data.message_order);
        assert.equal(BigInt(saved.revision), BigInt(before.revision) + 1n);
        const next = await f.get(`after_cursor=${response.body.after_cursor}`); assert.equal(next.status, 200); assert.deepEqual(next.body.messages, []); assert.equal(next.body.consumed_through, '1');
        record('independent-profile', { parentPid: process.pid, childPid: child.pid, waitedForCompleteScope: true, preservedOrderAndMessages: true, revisionAdvancedExactlyOnce: true });
      } finally { await hold.cleanup(); await reading; if (spawned) await spawned.completion; }
    });

    await t.test('independent real source revocations filter before counting and never mutate PG message attachment projection', async () => {
      const f = await fixture(), empty = await f.get(), created = await f.post(); assert.equal(created.status, 201);
      await f.db.read({ force: true }); const snapshot = structuredClone(f.db.data);
      snapshot.files.push({ id: 'paging-file', group_id: f.groupId, owner_user_id: f.id, uploader_id: f.id });
      snapshot.messages[0].attachments = [{ id: 'paging-file', parsed_content: 'Synthetic cached file secret', url: '/api/files/paging-file/download' }];
      await f.db.write({ snapshot, expectedRevision: f.db._revision }); const before = await f.durable();
      await markFileDeleted(f.id, f.db, f.groupId, 'paging-file');
      const page = await f.get(`limit=1&after_cursor=${empty.body.after_cursor}`); assert.equal(page.status, 200); assert.deepEqual(page.body.messages[0].attachments, []);
      assert.deepEqual(await f.durable(), before); assert.deepEqual(f.db.data.messages, before.data.messages);
      await markMessageDeleted(f.id, f.db, f.groupId, [created.body.id]);
      const revoked = await f.get(`limit=1&after_cursor=${empty.body.after_cursor}`); assert.equal(revoked.status, 200); assert.deepEqual(revoked.body.messages, []); assert.equal(revoked.body.consumed_through, '1'); assert.equal(revoked.body.hasMore, false);
      record('pg-source-revocation', { attachmentProjectionDetached: true, revokedRowExcludedBeforeCount: true, consumedTombstoneH: '1', noBusinessWrites: true });
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    clearUserDbCache(); await closePostgresMemoryLedger(); await closeSupabaseConnection();
    await ledgerPool?.end(); await businessAdmin.end(); await ledgerAdmin.end();
    await fs.rm(root, { recursive: true, force: true });
  }
});
