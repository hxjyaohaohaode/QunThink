import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const businessAdminUrl = process.env.QUNTHINK_TEST_COMMIT_PG_URL;
const ledgerAdminUrl = process.env.QUNTHINK_TEST_COMMIT_LEDGER_URL;
const caFile = process.env.QUNTHINK_TEST_COMMIT_PG_CA;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => createHash('sha256').update(value).digest('hex');
const errorCode = code => error => error.code === code;

// Opt-in only. The runner creates two disposable databases on an isolated PG
// instance; no environment fallback, production URL, or legacy ledger mode.
test('account snapshot commit wrapper on real PostgreSQL and independent deletion ledger', {
  skip: !businessAdminUrl || !ledgerAdminUrl || !caFile,
  timeout: 90000
}, async t => {
  const { buildPostgresTlsConfig } = await import('../src/models/postgresTls.js');
  const { PgLow, ensureKvSchema, closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  const { installPostgresLedger } = await import('../src/services/memory/postgresLedgerInstallation.js');
  const { getPostgresMemoryLedger, closePostgresMemoryLedger, createPostgresDeletionLedger, databaseIdentity } = await import('../src/services/memory/postgresDeletionLedger.js');
  const { requireAccountStore } = await import('../src/models/accountStoreLifecycle.js');
  const { createUserDbRegistry } = await import('../src/models/userDbRegistry.js');
  const { readCommittedUserDb } = await import('../src/models/readBarrier.js');
  const { initializeNewAccountOrder, prepareOrderedAppend, validateMessageOrder, projectMessageOrder } = await import('../src/services/messageOrder.js');
  const businessAdmin = new pg.Pool(buildPostgresTlsConfig(businessAdminUrl, caFile));
  const ledgerAdmin = new pg.Pool(buildPostgresTlsConfig(ledgerAdminUrl, caFile));
  const suffix = randomUUID().replaceAll('-', '');
  const businessRole = `wrapper_business_${suffix}`;
  const ledgerRole = `wrapper_ledger_${suffix}`;
  const password = randomBytes(32).toString('hex'); // Disposable fixture only; never logged.
  const installationId = randomUUID();
  const runtimeUrl = (url, role) => { const value = new URL(url); value.username = role; value.password = password; return value.toString(); };
  const businessUrl = runtimeUrl(businessAdminUrl, businessRole);
  const ledgerUrl = runtimeUrl(ledgerAdminUrl, ledgerRole);
  let businessPool, ledgerPool;
  const registry = createUserDbRegistry();
  const evidence = [];
  const record = (name, facts) => { evidence.push({ name, ...facts }); t.diagnostic(JSON.stringify(evidence.at(-1))); };
  async function until(read, predicate, description, timeout = 8000) {
    const end = Date.now() + timeout;
    let value;
    do { value = await read(); if (predicate(value)) return value; await delay(10); } while (Date.now() < end);
    assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
  }
  function lockParts(owner) {
    const value = hash(`${installationId}:${owner}`);
    return [BigInt(`0x${value.slice(0, 8)}`).toString(), BigInt(`0x${value.slice(8, 16)}`).toString()];
  }
  async function accountLocks(owner) {
    const { rows } = await ledgerAdmin.query(`SELECT l.pid,l.granted,a.usename,a.wait_event_type,a.query
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.objsubid=1 AND l.classid=$1::oid AND l.objid=$2::oid
      AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())`, lockParts(owner));
    return rows;
  }
  async function heldPid(owner) {
    const rows = (await accountLocks(owner)).filter(row => row.granted);
    assert.equal(rows.length, 1, 'exactly one real ledger session owns the account lock');
    assert.equal(rows[0].usename, ledgerRole);
    return rows[0].pid;
  }
  async function blockLedgerTail() {
    const client = await ledgerAdmin.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE memory_deletion_installation IN ACCESS EXCLUSIVE MODE');
    let closed = false;
    return async () => { if (closed) return; closed = true; try { await client.query('ROLLBACK'); } finally { client.release(); } };
  }
  async function waitForTail(pid) {
    return until(async () => (await ledgerAdmin.query('SELECT pid,wait_event_type,query FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0],
      row => row?.wait_event_type === 'Lock' && row.query.includes('FROM memory_deletion_installation'), 'real ledger tail validation lock wait');
  }
  try {
    await ensureKvSchema(businessAdmin);
    await installPostgresLedger({ businessPool: businessAdmin, ledgerPool: ledgerAdmin, installationId });
    await businessAdmin.query(`CREATE ROLE ${businessRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
      CREATE ROLE ${ledgerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
      ALTER TABLE kv_store OWNER TO ${businessRole};
      GRANT CREATE ON SCHEMA public TO ${businessRole};
      REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pg_control_system() TO ${businessRole}`);
    await ledgerAdmin.query(`REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pg_control_system() TO ${ledgerRole};
      GRANT SELECT ON memory_deletion_installation,memory_deletion_accounts,memory_deletion_tombstones TO ${ledgerRole};
      GRANT INSERT ON memory_deletion_accounts,memory_deletion_tombstones TO ${ledgerRole}`);
    Object.assign(process.env, { SUPABASE_DB_URL: businessUrl, SUPABASE_DB_CA_FILE: caFile,
      MEMORY_DELETION_DATABASE_URL: ledgerUrl, MEMORY_DELETION_DATABASE_CA_FILE: caFile,
      MEMORY_DELETION_INSTALLATION_ID: installationId, MEMORY_DELETION_CONNECTION_MODE: 'session', MEMORY_DELETION_MODE: 'independent' });
    delete process.env.MONGODB_URI;
    businessPool = new pg.Pool(buildPostgresTlsConfig(businessUrl, caFile));
    ledgerPool = new pg.Pool(buildPostgresTlsConfig(ledgerUrl, caFile));
    const { commitAccountSnapshot } = await import('../src/services/accountSnapshotCommit.js');
    const ledger = await getPostgresMemoryLedger();

    async function fixture(label, { afterUpdate } = {}) {
      const owner = randomUUID(), groupId = `${label}-group`, sourceId = `${label}-source`;
      let original = initializeNewAccountOrder({ groups: [{ id: groupId, owner_user_id: owner, user_members: [owner] }], messages: [], profile: { marker: 'initial' }, messageIdempotency: {} }, owner, { generationForGroup: () => randomUUID() });
      original = prepareOrderedAppend(original, owner, { id: sourceId, group_id: groupId, sender_id: owner, sender_type: 'user', content: 'synthetic authorized source', metadata: {}, created_at: '2026-10-13T00:00:00.000Z' }, { creationIntentHash: hash(`source:${owner}`) }).data;
      await businessPool.query('INSERT INTO kv_store(key,data,revision) VALUES($1,$2,1)', [`user:${owner}`, original]);
      await ledger.registerNewAccount(owner);
      const operations = [];
      const transport = { query: async (...args) => {
        const sql = String(args[0]);
        const kind = sql.startsWith('UPDATE kv_store') ? 'update' : sql.startsWith('SELECT data, revision') ? 'read' : 'other';
        const result = await businessPool.query(...args);
        operations.push({ kind, rowCount: result.rowCount, expectedRevision: kind === 'update' ? args[1][2] : undefined });
        if (kind === 'update' && afterUpdate) await afterUpdate({ result, owner, operations });
        return result;
      } };
      const db = await registry.get(owner, async protect => {
        const value = protect(requireAccountStore(new PgLow(`user:${owner}`, {}, transport), owner));
        await value.read({ force: true }); return value;
      });
      const message = { id: randomUUID(), group_id: groupId, sender_id: owner, sender_type: 'user', content: `synthetic ${label}`, metadata: { label }, created_at: '2026-10-13T00:01:00.000Z' };
      const prepared = { message, intentHash: hash(JSON.stringify(message)), clientKey: randomUUID(), requestHash: hash(`request:${message.id}`), sourceId, owner };
      const authorize = async ({ snapshot, prepared: intent }) => {
        assert.equal(snapshot.groups.find(group => group.id === intent.message.group_id)?.owner_user_id, owner);
        assert.ok(snapshot.messages.find(row => row.id === intent.sourceId), 'original source remains present');
        assert.equal((await ledger.deletedIds(owner, [intent.sourceId])).size, 0, 'real independent ledger authorizes source');
      };
      const confirm = ({ snapshot, prepared: intent }) => {
        const index = validateMessageOrder(snapshot, owner), binding = index.bindings.get(intent.message.id);
        const message = snapshot.messages.find(row => row.id === intent.message.id);
        const receipt = snapshot.messageIdempotency[intent.clientKey];
        if (!binding || !message || binding.groupId !== intent.message.group_id || binding.creationIntentHash !== intent.intentHash
          || receipt?.request_hash !== intent.requestHash || receipt?.message_id !== intent.message.id) return null;
        return { confirmed: true, result: projectMessageOrder(message, index) };
      };
      const compose = ({ snapshot, prepared: intent }) => {
        const existing = confirm({ snapshot, prepared: intent });
        if (existing) return { readOnly: true, result: existing.result };
        const candidate = prepareOrderedAppend(snapshot, owner, intent.message, { creationIntentHash: intent.intentHash }).data;
        candidate.messageIdempotency[intent.clientKey] = { request_hash: intent.requestHash, message_id: intent.message.id };
        return { snapshot: candidate, result: projectMessageOrder(intent.message, validateMessageOrder(candidate, owner)) };
      };
      const durable = async () => (await businessPool.query('SELECT data,revision FROM kv_store WHERE key=$1', [`user:${owner}`])).rows[0];
      return { owner, db, prepared, authorize, compose, confirm, operations, durable, original };
    }

    await t.test('restricted runtime authenticates over TLS1.3 with independent identities and durable settings', async () => {
      const facts = [];
      for (const pool of [businessPool, ledgerPool]) {
        facts.push((await pool.query(`SELECT current_user,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
          (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl,(SELECT version FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
          current_setting('server_version') AS server_version,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit`)).rows[0]);
      }
      assert.deepEqual(facts.map(row => row.current_user), [businessRole, ledgerRole]);
      for (const row of facts) { assert.equal(row.superuser, false); assert.equal(row.ssl, true); assert.equal(row.tls, 'TLSv1.3'); assert.equal(row.fsync, 'on'); assert.equal(row.synchronous_commit, 'on'); assert.equal(row.server_version, '16.15'); }
      const identities = await Promise.all([databaseIdentity(businessPool), databaseIdentity(ledgerPool)]);
      assert.notEqual(...identities);
      assert.equal((await ledgerPool.query("SELECT has_table_privilege(current_user,'memory_deletion_tombstones','DELETE') AS can_delete")).rows[0].can_delete, false);
      assert.equal((await ledgerPool.query("SELECT has_table_privilege(current_user,'memory_deletion_installation','UPDATE') AS can_update")).rows[0].can_update, false);
      await assert.rejects(ledgerPool.query('DELETE FROM memory_deletion_tombstones WHERE false'), errorCode('42501'));
      await assert.rejects(businessPool.query('SELECT pg_terminate_backend($1)', [(await ledgerPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]), errorCode('42501'));
      record('fixture', { runtime: facts, identities, ledgerDeleteDenied: true, runtimeTerminateOtherRoleDenied: true });
    });

    await t.test('real competing process advances CAS; retry rebuilds and preserves its non-message write', { timeout: 15000 }, async () => {
      const f = await fixture('cas');
      const childSource = `import pg from 'pg';
        import {PgLow} from './src/models/supabaseAdapter.js';
        import {requireAccountStore} from './src/models/accountStoreLifecycle.js';
        import {buildPostgresTlsConfig} from './src/models/postgresTls.js';
        const pool = new pg.Pool(buildPostgresTlsConfig(process.env.SUPABASE_DB_URL,process.env.SUPABASE_DB_CA_FILE));
        const db = requireAccountStore(new PgLow('user:'+process.env.COMMIT_OWNER,{},pool),process.env.COMMIT_OWNER);
        await db.read({force:true}); const snapshot=structuredClone(db.data); snapshot.profile={marker:'concurrent-profile',childPid:process.pid};
        await db.write({snapshot,expectedRevision:db._revision});
        console.log(JSON.stringify({pid:process.pid,revision:db._revision})); await pool.end();`;
      let childResult, attempts = 0, composeCalls = 0;
      const result = await commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared,
        authorize: async args => {
          await f.authorize(args); attempts++;
          if (attempts !== 1) return;
          const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], { cwd: new URL('..', import.meta.url), env: { ...process.env, COMMIT_OWNER: f.owner }, stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '', errors = '';
          child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
          await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', status => status === 0 ? resolve() : reject(new Error(errors || output))); });
          childResult = JSON.parse(output.trim());
        }, compose: args => { composeCalls++; return f.compose(args); }, confirm: f.confirm });
      const saved = await f.durable();
      assert.equal(result.disposition, 'committed'); assert.equal(attempts, 2); assert.equal(composeCalls, 2);
      assert.notEqual(childResult.pid, process.pid); assert.equal(childResult.revision, 2);
      assert.equal(saved.revision, '3'); assert.equal(saved.data.profile.marker, 'concurrent-profile');
      assert.equal(saved.data.messages.filter(row => row.id === f.prepared.message.id).length, 1);
      assert.equal(result.result.server_order.sequence, '2');
      assert.deepEqual(f.operations.filter(row => row.kind === 'update').map(row => row.rowCount), [0, 1]);
      record('real-cas-rebuild', { parentPid: process.pid, childPid: childResult.pid, authorizationAttempts: attempts, composeCalls, revision: saved.revision, profilePreserved: true, updates: f.operations.filter(row => row.kind === 'update') });
    });

    await t.test('actual committed UPDATE loses ACK; original intent recovers only after old lock exits and a fresh lock is acquired', { timeout: 15000 }, async () => {
      const contenderEntered = deferred(), releaseContender = deferred();
      const contender = createPostgresDeletionLedger({ businessPool, ledgerPool, installationId });
      let contenderRun, injectionCount = 0, confirmAuthorizations = 0, firstPid, recoveryPid;
      const f = await fixture('ack', { afterUpdate: async ({ result, owner }) => {
        if (result.rowCount !== 1 || injectionCount++) return;
        firstPid = await heldPid(owner);
        contenderRun = contender.withAccountLock(owner, async () => { contenderEntered.resolve(); await releaseContender.promise; });
        await until(() => accountLocks(owner), rows => rows.some(row => !row.granted), 'independent contender queued on the real account advisory lock');
        // Fault injection is exclusively after the actual PG UPDATE returned.
        // The stored row is durable; this simulates transport ACK loss only.
        throw Object.assign(new Error('synthetic transport ACK lost after real UPDATE'), { code: 'SYNTHETIC_ACK_LOST' });
      } });
      let settled = false;
      const operation = commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared,
        authorize: async args => { await f.authorize(args); if (args.confirming) { confirmAuthorizations++; recoveryPid = await heldPid(f.owner); } },
        compose: f.compose, confirm: f.confirm });
      const outcome = operation.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
      try {
        await contenderEntered.promise;
        assert.equal(settled, false); assert.equal(confirmAuthorizations, 0);
        const savedBeforeRecovery = await f.durable(); assert.equal(savedBeforeRecovery.revision, '2');
        releaseContender.resolve(); await contenderRun;
        const { value, error } = await outcome; if (error) throw error;
        assert.equal(value.disposition, 'recovered'); assert.equal(value.result.id, f.prepared.message.id);
        assert.equal(value.result.server_order.sequence, '2'); assert.equal(confirmAuthorizations, 1);
        assert.equal(f.operations.filter(row => row.kind === 'update').length, 1);
        const saved = await f.durable(); assert.equal(saved.revision, '2');
        assert.equal(saved.data.messages.filter(row => row.id === f.prepared.message.id).length, 1);
        assert.equal((await accountLocks(f.owner)).length, 0);
        record('ack-loss-recovery', { firstPid, recoveryPid, competingLockScopeCompletedBeforeConfirmation: true, confirmAuthorizations, writes: 1, revision: saved.revision, disposition: value.disposition });
      } finally { releaseContender.resolve(); await contenderRun?.catch(() => {}); await outcome; }
    });

    await t.test('persisted write cannot release a result or read barrier before failed outer ledger verification', { timeout: 15000 }, async () => {
      let releaseTail, tailPid, injected = false;
      const f = await fixture('tail-failure', { afterUpdate: async ({ result, owner }) => {
        if (result.rowCount !== 1 || injected) return; injected = true;
        tailPid = await heldPid(owner); releaseTail = await blockLedgerTail();
      } });
      let settled = false, readerSettled = false;
      const operation = commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared, authorize: f.authorize, compose: f.compose });
      const outcome = operation.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
      try {
        await until(async () => tailPid, Boolean, 'tail pid publication'); await waitForTail(tailPid);
        const reading = readCommittedUserDb(f.db, data => data.messages.map(row => row.id)).then(value => { readerSettled = true; return value; });
        const saved = await f.durable(); assert.equal(saved.revision, '2');
        await delay(40); assert.equal(settled, false); assert.equal(readerSettled, false);
        assert.equal((await ledgerAdmin.query('SELECT pg_terminate_backend($1) AS terminated', [tailPid])).rows[0].terminated, true);
        await releaseTail();
        const result = await outcome;
        assert.equal(result.value, undefined); assert.equal(result.error?.code, 'MESSAGE_COMMIT_UNKNOWN');
        assert.equal(result.error?.statusCode || result.error?.status, 503);
        assert.ok((await reading).includes(f.prepared.message.id), 'barrier releases into a fresh durable read after failure, without rolling back committed truth');
        assert.equal(f.operations.filter(row => row.kind === 'update').length, 1);
        record('outer-ledger-failure', { terminatedPid: tailPid, businessRevision: saved.revision, wrapperAndReaderBlockedAtTail: true, resultCode: result.error.code, noSuccessResult: true, noRewrite: true });
      } finally { await releaseTail?.(); await outcome; }
    });

    await t.test('read-only prior receipt waits for outer ledger validation and keeps the read barrier', { timeout: 15000 }, async () => {
      const f = await fixture('read-only');
      const first = await commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared, authorize: f.authorize, compose: f.compose, confirm: f.confirm });
      assert.equal(first.disposition, 'committed');
      const writesBefore = f.operations.filter(row => row.kind === 'update').length;
      let releaseTail, pid, settled = false, readerSettled = false;
      const operation = commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared,
        authorize: async args => { await f.authorize(args); pid = await heldPid(f.owner); releaseTail = await blockLedgerTail(); }, compose: f.compose, confirm: f.confirm });
      const outcome = operation.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
      try {
        await until(async () => pid, Boolean, 'read-only tail pid'); await waitForTail(pid);
        const reader = readCommittedUserDb(f.db, data => data.messages.length).then(value => { readerSettled = true; return value; });
        await delay(40); assert.equal(settled, false); assert.equal(readerSettled, false);
        await releaseTail();
        const { value, error } = await outcome; if (error) throw error;
        assert.equal(value.disposition, 'existing'); assert.deepEqual(value.result, first.result);
        assert.equal(await reader, 2); assert.equal(f.operations.filter(row => row.kind === 'update').length, writesBefore);
        assert.equal((await f.durable()).revision, '2');
        record('read-only-tail', { pid, wrapperAndReaderBlockedAtTail: true, additionalWrites: 0, disposition: value.disposition });
      } finally { await releaseTail?.(); await outcome; }
    });

    await t.test('failed old scope recovers only inside a new live session and waits for its own final verification', { timeout: 15000 }, async () => {
      let firstRelease, recoveryRelease, oldPid, newPid, injected = false, settled = false;
      const f = await fixture('tail-recovery', { afterUpdate: async ({ result, owner }) => {
        if (result.rowCount !== 1 || injected) return; injected = true;
        oldPid = await heldPid(owner); firstRelease = await blockLedgerTail();
      } });
      const operation = commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared,
        authorize: async args => {
          await f.authorize(args);
          if (args.confirming) { newPid = await heldPid(f.owner); recoveryRelease = await blockLedgerTail(); }
        }, compose: f.compose, confirm: f.confirm });
      const outcome = operation.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
      try {
        await until(async () => oldPid, Boolean, 'first ledger session'); await waitForTail(oldPid);
        assert.equal(settled, false);
        assert.equal((await ledgerAdmin.query('SELECT pg_terminate_backend($1) AS terminated', [oldPid])).rows[0].terminated, true);
        await firstRelease();
        await until(async () => newPid, Boolean, 'new reconciliation ledger session'); await waitForTail(newPid);
        assert.notEqual(newPid, oldPid, 'the destroyed old session cannot authorize the recovered result');
        assert.equal(settled, false, 'even a valid confirmation must wait for the new scope final verification');
        let readerSettled = false;
        const reading = readCommittedUserDb(f.db, data => data.messages.length).then(value => { readerSettled = true; return value; });
        await delay(40); assert.equal(readerSettled, false);
        await recoveryRelease();
        const { value, error } = await outcome; if (error) throw error;
        assert.equal(value.disposition, 'recovered'); assert.equal(value.result.id, f.prepared.message.id);
        assert.equal(value.result.server_order.sequence, '2'); assert.equal(await reading, 2);
        assert.equal(f.operations.filter(row => row.kind === 'update').length, 1);
        assert.equal((await f.durable()).revision, '2');
        record('fresh-session-tail-recovery', { oldPid, newPid, bothTailScopesBlockedBeforeRelease: true,
          freshConfirmationBarrierHeldUntilVerification: true, writes: 1, disposition: value.disposition });
      } finally { await firstRelease?.(); await recoveryRelease?.(); await outcome; }
    });

    await t.test('read-only prior receipt is suppressed when its outer ledger session fails, without reconciliation or write', { timeout: 15000 }, async () => {
      const f = await fixture('read-only-failure');
      await commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared, authorize: f.authorize, compose: f.compose, confirm: f.confirm });
      let releaseTail, pid, authorizeCalls = 0, confirmingCalls = 0, composeCalls = 0, settled = false;
      const writesBefore = f.operations.filter(row => row.kind === 'update').length;
      const operation = commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared,
        authorize: async args => { authorizeCalls++; if (args.confirming) confirmingCalls++; await f.authorize(args); pid = await heldPid(f.owner); releaseTail = await blockLedgerTail(); },
        compose: args => { composeCalls++; return f.compose(args); }, confirm: f.confirm });
      const outcome = operation.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
      try {
        await until(async () => pid, Boolean, 'read-only failing session'); await waitForTail(pid);
        assert.equal(settled, false);
        assert.equal((await ledgerAdmin.query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows[0].terminated, true);
        await releaseTail();
        const result = await outcome;
        assert.equal(result.value, undefined); assert.equal(result.error?.code, 'MEMORY_BARRIER_UNAVAILABLE');
        assert.equal(authorizeCalls, 1); assert.equal(confirmingCalls, 0); assert.equal(composeCalls, 1);
        assert.equal(f.operations.filter(row => row.kind === 'update').length, writesBefore);
        assert.equal((await f.durable()).revision, '2');
        record('read-only-tail-failure', { terminatedPid: pid, resultCode: result.error.code, priorResultSuppressed: true,
          authorizeCalls, confirmingCalls, additionalWrites: 0 });
      } finally { await releaseTail?.(); await outcome; }
    });

    await t.test('independent source deletion remains enforced during uncertain-commit confirmation', async () => {
      let injected = false;
      const f = await fixture('revoked', { afterUpdate: async ({ result, owner }) => {
        if (result.rowCount !== 1 || injected) return; injected = true;
        await ledger.markDeleted(owner, 'revoked-source');
        throw Object.assign(new Error('synthetic ACK loss after durable write and real source tombstone'), { code: 'SYNTHETIC_ACK_LOST' });
      } });
      const denied = Object.assign(new Error('source is no longer readable'), { code: 'SOURCE_NOT_READABLE', status: 410, statusCode: 410, isOperational: true });
      let confirmationChecks = 0;
      await assert.rejects(commitAccountSnapshot({ userId: f.owner, db: f.db, prepared: f.prepared,
        authorize: async args => {
          const deleted = await ledger.deletedIds(f.owner, [args.prepared.sourceId]);
          if (args.confirming) confirmationChecks++;
          if (deleted.size) throw denied;
          await f.authorize(args);
        }, compose: f.compose, confirm: f.confirm }), errorCode('SOURCE_NOT_READABLE'));
      const saved = await f.durable(); assert.equal(saved.revision, '2');
      assert.equal(confirmationChecks, 1); assert.equal(f.operations.filter(row => row.kind === 'update').length, 1);
      assert.equal((await ledger.deletedIds(f.owner, [f.prepared.sourceId])).size, 1);
      record('revoked-source-confirmation', { confirmationChecks, durableBusinessRevision: saved.revision, durableSourceTombstone: true, originalBodySuppressed: true, writes: 1 });
    });
  } finally {
    registry.clear();
    await closePostgresMemoryLedger(); await closeSupabaseConnection();
    await businessPool?.end(); await ledgerPool?.end();
    await businessAdmin.end(); await ledgerAdmin.end();
  }
});
