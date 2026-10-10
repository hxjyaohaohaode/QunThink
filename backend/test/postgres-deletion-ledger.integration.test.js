import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { createPostgresDeletionLedger, deferPostgresMemoryJson, onPostgresMemoryFailure } from '../src/services/memory/postgresDeletionLedger.js';
import { installPostgresLedger } from '../src/services/memory/postgresLedgerInstallation.js';
import { ensureKvSchema } from '../src/models/supabaseAdapter.js';

const url = process.env.QUNTHINK_TEST_PG_URL;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('independent PostgreSQL ledger: rollback, registry loss, cross-process locks and uncertain commit', { skip: !url }, async t => {
  const adminPool = new pg.Pool({ connectionString: url });
  const businessName = `memory_business_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE DATABASE ${businessName}`);
  const businessUrl = new URL(url); businessUrl.pathname = `/${businessName}`;
  const businessPool = new pg.Pool({ connectionString: businessUrl.toString() });
  const name = `memory_ledger_${randomUUID().replaceAll('-', '')}`;
  const ledgerUrl = new URL(url); ledgerUrl.pathname = `/${name}`;
  await businessPool.query(`CREATE DATABASE ${name}`);
  const ledgerPool = new pg.Pool({ connectionString: ledgerUrl.toString(), max: 10 });
  const installationId = randomUUID();
  const options = { businessPool, ledgerPool, installationId };
  const make = () => createPostgresDeletionLedger(options);
  let adapter = make();
  try {
    await ensureKvSchema(businessPool);
    await businessPool.query('TRUNCATE kv_store');
    await t.test('same physical database rejected even with URL aliases', async () => {
      await assert.rejects(installPostgresLedger({ ...options, ledgerPool: businessPool }), { code: 'MEMORY_MIGRATION_REQUIRED' });
    });
    await t.test('explicit verified historical manifest imports existing tombstones, without blank automatic enrollment', async () => {
      const migrationDb = `memory_migrate_${randomUUID().replaceAll('-', '')}`;
      await businessPool.query(`CREATE DATABASE ${migrationDb}`);
      const migrationUrl = new URL(url); migrationUrl.pathname = `/${migrationDb}`;
      const migrationPool = new pg.Pool({ connectionString: migrationUrl.toString() });
      const migrationId = randomUUID();
      try {
        await businessPool.query(`INSERT INTO kv_store(key,data) VALUES('auth:main','{"users":[{"id":"historical"}]}'),('user:historical','{"memoryRecords":[]}')`);
        const tombstone = createHash('sha256').update(JSON.stringify(['historical','prior-deletion'])).digest('hex');
        await installPostgresLedger({ businessPool, ledgerPool: migrationPool, installationId: migrationId,
          manifest: { version: 1, installationId: migrationId, attestation: 'COMPLETE_VERIFIED_DELETION_HISTORY',
            accounts: [{ ownerId: 'historical', deletedIdentityHashes: [tombstone] }] } });
        const migrated = createPostgresDeletionLedger({ businessPool, ledgerPool: migrationPool, installationId: migrationId });
        assert.deepEqual([...await migrated.deletedIds('historical', ['prior-deletion'])], ['prior-deletion']);
        await assert.rejects(migrated.deletedIds('unknown-history', []), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      } finally {
        await migrationPool.end(); await businessPool.query(`DROP DATABASE ${migrationDb} WITH (FORCE)`);
        await businessPool.query('TRUNCATE kv_store');
      }
    });
    await t.test('unknown installation and unknown account fail closed', async () => {
      await assert.rejects(adapter.deletedIds('alice', []), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      await businessPool.query(`INSERT INTO kv_store(key,data) VALUES('auth:main','{"users":[{"id":"historical"}]}')`);
      await assert.rejects(installPostgresLedger(options), { code: 'MEMORY_MIGRATION_REQUIRED' });
      await assert.rejects(installPostgresLedger({ ...options, manifest: { version: 1, accounts: [] } }), { code: 'MEMORY_MIGRATION_REQUIRED' });
      await businessPool.query('TRUNCATE kv_store');
      await installPostgresLedger(options);
      await assert.rejects(adapter.deletedIds('alice', []), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      await adapter.registerNewAccount('alice');
      await adapter.registerNewAccount('bob');
    });
    await t.test('idempotent tombstone persists before business erase and survives business restore/restart', async () => {
      await businessPool.query(`INSERT INTO kv_store(key,data) VALUES('user:alice','{"memoryRecords":[{"id":"memory1","content":"synthetic"}]}')`);
      const backup = await businessPool.query('SELECT * FROM kv_store');
      await adapter.markDeleted('alice', 'memory1');
      await adapter.markDeleted('alice', 'memory1');
      await businessPool.query('TRUNCATE kv_store');
      for (const row of backup.rows) await businessPool.query('INSERT INTO kv_store(key,data,revision) VALUES($1,$2,$3)', [row.key,row.data,row.revision]);
      adapter = make();
      assert.deepEqual([...await adapter.deletedIds('alice', ['memory1'])], ['memory1']);
      assert.equal((await adapter.deletedIds('bob', ['memory1'])).size, 0);
      assert.equal((await ledgerPool.query('SELECT count(*) FROM memory_deletion_tombstones')).rows[0].count, '1');
    });
    await t.test('separate process cannot pass account read lock until reader completes', async () => {
      let release; const held = new Promise(resolve => { release = resolve; });
      let entered; const acquired = new Promise(resolve => { entered = resolve; });
      const reading = adapter.withAccountLock('alice', async () => { entered(); await held; });
      await acquired;
      const moduleUrl = new URL('../src/services/memory/postgresDeletionLedger.js', import.meta.url).href;
      const childCode = `import pg from 'pg'; import {createPostgresDeletionLedger} from ${JSON.stringify(moduleUrl)};
        const businessPool=new pg.Pool({connectionString:process.env.BUSINESS}); const ledgerPool=new pg.Pool({connectionString:process.env.LEDGER});
        const a=createPostgresDeletionLedger({businessPool,ledgerPool,installationId:process.env.INSTALL});
        if (!(await a.deletedIds('alice',['memory1'])).has('memory1')) throw new Error('persisted tombstone absent after process restart');
        await a.markDeleted('alice','process-mark'); console.log('COMMITTED'); await businessPool.end(); await ledgerPool.end();`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { cwd: new URL('..', import.meta.url), env: { ...process.env, BUSINESS: businessUrl.toString(), LEDGER: ledgerUrl.toString(), INSTALL: installationId } });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
      await delay(350); assert.equal(output.includes('COMMITTED'), false);
      release(); await reading; assert.equal(await exited, 0, output);
      assert.equal((await adapter.deletedIds('alice', ['process-mark'])).size, 1);
    });
    await t.test('lost acknowledgement after committed tombstone fails closed then re-read finds it', async () => {
      const uncertainPool = { connect: async () => {
        const client = await ledgerPool.connect();
        return { on: (...args) => client.on(...args), removeListener: (...args) => client.removeListener(...args), release: value => client.release(value), query: async (...args) => {
          const result = await client.query(...args);
          if (String(args[0]).includes('INSERT INTO memory_deletion_tombstones')) throw new Error('synthetic lost acknowledgement');
          return result;
        } };
      } };
      const uncertain = createPostgresDeletionLedger({ ...options, ledgerPool: uncertainPool });
      await assert.rejects(uncertain.markDeleted('alice', 'uncertain'), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      assert.equal((await adapter.deletedIds('alice', ['uncertain'])).size, 1);
    });
    await t.test('lost lock connection suppresses staged source JSON', async () => {
      let emitted = false;
      const res = { json: () => { emitted = true; } };
      deferPostgresMemoryJson({}, res, () => {});
      await assert.rejects(adapter.withAccountLock('alice', async () => {
        res.json({ content: 'synthetic secret' });
        const locked = await ledgerPool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted");
        await businessPool.query('SELECT pg_terminate_backend($1)', [locked.rows[0].pid]);
        await delay(30);
      }), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      assert.equal(emitted, false);
    });
    await t.test('protected response buffering is bounded and failures clean up acquired resources', async () => {
      let emitted = 0, cleaned = 0;
      const res = { json: () => { emitted++; } };
      deferPostgresMemoryJson({}, res, () => {});
      await adapter.withAccountLock('alice', async () => { res.json({ ok: true }); });
      assert.equal(emitted, 1);
      await assert.rejects(adapter.withAccountLock('alice', async () => {
        onPostgresMemoryFailure(async () => { cleaned++; });
        res.json({ body: 'x'.repeat(8 * 1024 * 1024 + 1) });
      }), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      assert.equal(emitted, 1); assert.equal(cleaned, 1);
    });
    await t.test('an inherited async lease expires after the account callback returns', async () => {
      let runLate;
      let late;
      await adapter.withAccountLock('alice', async () => {
        late = new Promise(resolve => { runLate = resolve; }).then(() => adapter.deletedIds('alice', ['memory1']));
      });
      const rejected = assert.rejects(late, { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      runLate(); await rejected;
    });
    await t.test('least-privilege runtime requires explicit control identity grant and forces synchronous durability', async () => {
      const role = `ledger_role_${randomUUID().replaceAll('-', '')}`;
      await businessPool.query(`CREATE ROLE ${role} LOGIN`);
      const businessRoleUrl = new URL(businessUrl); businessRoleUrl.username = role;
      const ledgerRoleUrl = new URL(ledgerUrl); ledgerRoleUrl.username = role;
      const bp = new pg.Pool({ connectionString: businessRoleUrl.toString() });
      const lp = new pg.Pool({ connectionString: ledgerRoleUrl.toString(), options: '-c synchronous_commit=off' });
      const limited = createPostgresDeletionLedger({ businessPool: bp, ledgerPool: lp, installationId });
      try {
        await businessPool.query(`GRANT SELECT ON kv_store TO ${role}`);
        await ledgerPool.query(`GRANT SELECT ON memory_deletion_installation,memory_deletion_accounts,memory_deletion_tombstones TO ${role}; GRANT INSERT ON memory_deletion_accounts,memory_deletion_tombstones TO ${role}`);
        await businessPool.query('REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC');
        await ledgerPool.query('REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC');
        await assert.rejects(limited.deletedIds('alice', []), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
        await businessPool.query(`GRANT EXECUTE ON FUNCTION pg_control_system() TO ${role}`);
        await ledgerPool.query(`GRANT EXECUTE ON FUNCTION pg_control_system() TO ${role}`);
        await limited.markDeleted('alice', 'limited-role-mark');
        assert.equal((await limited.deletedIds('alice', ['limited-role-mark'])).size, 1);
        assert.equal((await lp.query('SHOW synchronous_commit')).rows[0].synchronous_commit, 'on');
      } finally {
        await bp.end(); await lp.end();
        await businessPool.query('GRANT EXECUTE ON FUNCTION pg_control_system() TO PUBLIC');
        await ledgerPool.query('GRANT EXECUTE ON FUNCTION pg_control_system() TO PUBLIC');
        await businessPool.query(`DROP OWNED BY ${role}`);
        await ledgerPool.query(`DROP OWNED BY ${role}`);
        await businessPool.query(`DROP ROLE ${role}`);
      }
    });
    await t.test('missing registry row and missing ledger table never rebuild', async () => {
      await ledgerPool.query("DELETE FROM memory_deletion_accounts WHERE owner_hash=encode(sha256('bob'::bytea),'hex')");
      await assert.rejects(adapter.deletedIds('bob', []), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      await ledgerPool.query('ALTER TABLE memory_deletion_tombstones RENAME TO preserved_tombstones');
      await assert.rejects(adapter.deletedIds('alice', []), { code: 'MEMORY_BARRIER_UNAVAILABLE' });
      await ledgerPool.query('ALTER TABLE preserved_tombstones RENAME TO memory_deletion_tombstones');
    });
  } finally {
    await ledgerPool.end();
    await businessPool.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await businessPool.end();
    await adminPool.query(`DROP DATABASE ${businessName} WITH (FORCE)`);
    await adminPool.end();
  }
});
