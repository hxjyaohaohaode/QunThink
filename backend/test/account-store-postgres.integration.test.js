import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixtureUrl = process.env.QUNTHINK_TEST_LIFECYCLE_PG_URL;
const fixtureCa = process.env.QUNTHINK_TEST_LIFECYCLE_PG_CA;
if (!fixtureUrl || !fixtureCa) {
  test('real PG lifecycle acceptance requires isolated fixture URL and CA', { skip: 'Run f07-lifecycle-phase2/run-lifecycle-pg.sh; synthetic transport is not acceptance' }, () => {});
} else {
  process.env.SUPABASE_DB_URL = fixtureUrl;
  process.env.SUPABASE_DB_CA_FILE = fixtureCa;
  delete process.env.MONGODB_URI;
  delete process.env.MEMORY_DELETION_DATABASE_URL;
  const { PgLow, ensureKvSchema, closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  const { initializeEmptyInstallation, initDatabase, createNewUserDatabase, getUserDb, migrateLegacyUserDatabase, clearUserDbCache } = await import('../src/models/db.js');
  const { initializeNewAccountOrder } = await import('../src/services/messageOrder.js');
  const pool = new pg.Pool({ connectionString: fixtureUrl, ssl: { ca: await fs.readFile(fixtureCa, 'utf8'), rejectUnauthorized: true } });
  await ensureKvSchema(pool);
  const code = value => error => error.code === value;
  const snapshot = owner => initializeNewAccountOrder({ groups: [{ id: 'synthetic-group' }], messages: [] }, owner, { generationForGroup: () => randomUUID() });
  test.after(async () => { await pool.end(); await closeSupabaseConnection(); });

  test('real PostgreSQL fixture uses TLS1.3, fsync and synchronous commit', async () => {
    const result = await pool.query('SELECT (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl, (SELECT version FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls, current_setting(\'fsync\') AS fsync, current_setting(\'synchronous_commit\') AS commit');
    assert.deepEqual(result.rows[0], { ssl: true, tls: 'TLSv1.3', fsync: 'on', commit: 'on' });
  });
  test('real PostgreSQL empty business storage cannot hide an existing independent deletion ledger', async () => {
    const ledgerUrl = process.env.QUNTHINK_TEST_LIFECYCLE_LEDGER_URL;
    assert.ok(ledgerUrl, 'the isolated second database is required');
    const ledger = new pg.Pool({ connectionString: ledgerUrl, ssl: { ca: await fs.readFile(fixtureCa, 'utf8'), rejectUnauthorized: true } });
    await ledger.query('CREATE TABLE synthetic_existing_deletion_ledger (marker text NOT NULL)');
    await ledger.query("INSERT INTO synthetic_existing_deletion_ledger VALUES ('retained synthetic deletion')");
    process.env.MEMORY_DELETION_DATABASE_URL = ledgerUrl;
    process.env.MEMORY_DELETION_DATABASE_CA_FILE = fixtureCa;
    process.env.MEMORY_DELETION_CONNECTION_MODE = 'session';
    process.env.MEMORY_DELETION_INSTALLATION_ID = randomUUID();
    try {
      await assert.rejects(initializeEmptyInstallation(), code('INSTALLATION_NOT_EMPTY'));
      assert.equal((await pool.query('SELECT key FROM kv_store')).rowCount, 0);
      assert.equal((await ledger.query('SELECT marker FROM synthetic_existing_deletion_ledger')).rows[0].marker, 'retained synthetic deletion');
    } finally {
      for (const name of ['MEMORY_DELETION_DATABASE_URL', 'MEMORY_DELETION_DATABASE_CA_FILE', 'MEMORY_DELETION_CONNECTION_MODE', 'MEMORY_DELETION_INSTALLATION_ID']) delete process.env[name];
      await pool.query("DELETE FROM kv_store WHERE key='user:default'"); clearUserDbCache('default');
      await ledger.end();
    }
  });
  test('real PostgreSQL ledger views are rejected without running their side-effectful functions', async () => {
    const ledgerUrl = process.env.QUNTHINK_TEST_LIFECYCLE_LEDGER_URL;
    const ledger = new pg.Pool({ connectionString: ledgerUrl, ssl: { ca: await fs.readFile(fixtureCa, 'utf8'), rejectUnauthorized: true } });
    await ledger.query('CREATE TABLE synthetic_view_effects (marker integer)');
    await ledger.query(`CREATE FUNCTION synthetic_unsafe_ledger_view() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO synthetic_view_effects VALUES (1); RETURN 1; END $$`);
    await ledger.query('CREATE VIEW synthetic_not_a_persistent_table AS SELECT synthetic_unsafe_ledger_view() AS marker');
    process.env.MEMORY_DELETION_DATABASE_URL = ledgerUrl;
    process.env.MEMORY_DELETION_DATABASE_CA_FILE = fixtureCa;
    process.env.MEMORY_DELETION_CONNECTION_MODE = 'session';
    process.env.MEMORY_DELETION_INSTALLATION_ID = randomUUID();
    try {
      await assert.rejects(initializeEmptyInstallation(), code('INSTALLATION_STATE_UNKNOWN'));
      assert.equal((await pool.query('SELECT key FROM kv_store')).rowCount, 0);
      assert.equal((await ledger.query('SELECT marker FROM synthetic_view_effects')).rowCount, 0);
    } finally {
      for (const name of ['MEMORY_DELETION_DATABASE_URL', 'MEMORY_DELETION_DATABASE_CA_FILE', 'MEMORY_DELETION_CONNECTION_MODE', 'MEMORY_DELETION_INSTALLATION_ID']) delete process.env[name];
      await ledger.end();
    }
  });
  test('real PostgreSQL empty installation is explicit and required startup stays read-only', async () => {
    await assert.rejects(initDatabase(), code('ACCOUNT_DATA_MISSING'));
    assert.equal((await pool.query('SELECT key FROM kv_store')).rowCount, 0);
    assert.equal((await initializeEmptyInstallation()).confirmedByRead, true);
    await initDatabase();
    assert.equal((await pool.query('SELECT revision FROM kv_store WHERE key=$1', ['user:default'])).rows[0].revision, '1');
    await assert.rejects(initializeEmptyInstallation(), code('INSTALLATION_NOT_EMPTY'));
  });
  test('real PostgreSQL missing/null/legacy rows are distinct and read-only', async () => {
    const missing = randomUUID(), nullId = randomUUID(), legacy = randomUUID();
    await pool.query('INSERT INTO kv_store(key,data) VALUES($1, $2::jsonb), ($3, $4::jsonb)', [`user:${nullId}`, 'null', `user:${legacy}`, '{"groups":[],"messages":[]}']);
    await assert.rejects(getUserDb(missing), code('ACCOUNT_DATA_MISSING'));
    await assert.rejects(getUserDb(nullId), code('ACCOUNT_DATA_INVALID'));
    await assert.rejects(getUserDb(legacy), code('MESSAGE_ORDER_UNAVAILABLE'));
    assert.equal((await pool.query('SELECT key FROM kv_store WHERE key=$1', [`user:${missing}`])).rowCount, 0);
    assert.equal((await pool.query('SELECT revision FROM kv_store WHERE key=$1', [`user:${legacy}`])).rows[0].revision, '0');
  });
  test('real PostgreSQL create never updates an existing revision-zero row', async () => {
    const owner = randomUUID(), key = `user:${owner}`, original = { isolated: 'legacy revision zero' };
    await pool.query('INSERT INTO kv_store(key,data,revision) VALUES($1,$2,0)', [key, original]);
    const db = new PgLow(key, {}, pool);
    await assert.rejects(db.create({ snapshot: snapshot(owner) }), code('ACCOUNT_DATA_EXISTS'));
    const row = (await pool.query('SELECT data,revision FROM kv_store WHERE key=$1', [key])).rows[0];
    assert.deepEqual(row, { data: original, revision: '0' });
  });
  test('real PostgreSQL new registration snapshot survives cold registry reload with unchanged generation', async () => {
    const owner = randomUUID(), first = await createNewUserDatabase(owner), original = structuredClone(first.data);
    clearUserDbCache(owner);
    assert.deepEqual((await createNewUserDatabase(owner)).data, original);
    assert.equal((await pool.query('SELECT revision FROM kv_store WHERE key=$1', [`user:${owner}`])).rows[0].revision, '1');
  });
  test('real PostgreSQL raw migration dry-run and explicit apply preserve old JSONB data at revision zero', async () => {
    const owner = randomUUID(), original = { groups: [], messages: [], untouched: { source: 'synthetic' } };
    await pool.query('INSERT INTO kv_store(key,data,revision) VALUES($1,$2,0)', [`user:${owner}`, original]);
    const dry = await migrateLegacyUserDatabase(owner);
    assert.equal(dry.applied, false);
    const applied = await migrateLegacyUserDatabase(owner, { apply: true, expectedSourceHash: dry.sourceHash });
    assert.equal(applied.confirmedByRead, true);
    const db = await getUserDb(owner), { message_order, ...actual } = db.data;
    assert.deepEqual(actual, original); assert.equal(message_order.owner_id, owner); assert.equal(db._revision, 1);
  });

  const childSource = `
    import pg from 'pg'; import fs from 'node:fs/promises'; import { randomUUID } from 'node:crypto';
    import { PgLow } from './src/models/supabaseAdapter.js';
    import { initializeNewAccountOrder, buildLegacyMessageOrder } from './src/services/messageOrder.js';
    const owner=process.env.CONTRACT_OWNER, mode=process.env.CONTRACT_MODE;
    const pool = new pg.Pool({connectionString:process.env.QUNTHINK_TEST_LIFECYCLE_PG_URL, ssl:{ca:await fs.readFile(process.env.QUNTHINK_TEST_LIFECYCLE_PG_CA,'utf8'),rejectUnauthorized:true}});
    const db = new PgLow('user:'+owner,{},pool); await db.read();
    const revision=db._revision;
    const candidate=mode==='create' ? initializeNewAccountOrder({groups:[{id:'race-group'}],messages:[]},owner,{generationForGroup:()=>randomUUID()})
      : {...structuredClone(db.data),message_order:buildLegacyMessageOrder(db.data,owner,{generationForGroup:()=>randomUUID()})};
    process.stdout.write(JSON.stringify({ready:true,pid:process.pid,exists:db._exists,revision,generation:candidate.message_order.groups[0].generation})+'\\n');
    await new Promise(resolve=>process.stdin.once('data',resolve));
    try { if(mode==='create')await db.create({snapshot:candidate}); else await db.write({snapshot:candidate,expectedRevision:revision});
      process.stdout.write(JSON.stringify({result:'committed',generation:candidate.message_order.groups[0].generation})+'\\n');
    } catch(error) { process.stdout.write(JSON.stringify({result:error.code})+'\\n'); }
    await pool.end(); process.stdin.destroy();
  `;
  async function race(owner, mode) {
    const children = [0, 1].map(() => {
      const processChild = spawn(process.execPath, ['--input-type=module', '-e', childSource], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, CONTRACT_OWNER: owner, CONTRACT_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', resolved = false, readyResolve, readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      processChild.stdout.on('data', chunk => { stdout += chunk; const line = stdout.split('\n').find(value => value.startsWith('{"ready":')); if (line && !resolved) { resolved = true; readyResolve(JSON.parse(line)); } });
      processChild.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        processChild.on('error', error => { readyReject(error); reject(error); });
        processChild.on('close', status => { if (!resolved) readyReject(new Error(stderr || stdout)); status === 0 ? resolve(stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse).at(-1)) : reject(new Error(stderr || stdout)); });
      });
      return { processChild, ready, done };
    });
    const readiness = await Promise.all(children.map(child => child.ready));
    assert.notEqual(readiness[0].pid, readiness[1].pid); assert.notEqual(readiness[0].generation, readiness[1].generation);
    assert.ok(readiness.every(row => row.revision === 0 && row.exists === (mode !== 'create')));
    for (const child of children) child.processChild.stdin.end('commit\n');
    const results = await Promise.all(children.map(child => child.done));
    assert.equal(results.filter(row => row.result === 'committed').length, 1);
    assert.equal(results.find(row => row.result !== 'committed').result, mode === 'create' ? 'ACCOUNT_DATA_EXISTS' : 'REVISION_CONFLICT');
    const saved = (await pool.query('SELECT data, revision FROM kv_store WHERE key=$1', [`user:${owner}`])).rows[0];
    assert.equal(saved.revision, '1'); assert.equal(saved.data.message_order.groups[0].generation, results.find(row => row.result === 'committed').generation);
    return saved.data;
  }
  test('real independent PostgreSQL processes read absence then race different creation candidates, only one insert commits', { timeout: 15000 }, async () => {
    await race(randomUUID(), 'create');
  });
  test('real independent PostgreSQL processes read revision zero then race different migration generations, only one CAS commits', { timeout: 15000 }, async () => {
    const owner = randomUUID(), original = { groups: [{ id: 'race-group' }], messages: [], original: 'unchanged' };
    await pool.query('INSERT INTO kv_store(key,data,revision) VALUES($1,$2,0)', [`user:${owner}`, original]);
    const { message_order, ...actual } = await race(owner, 'migrate'); assert.deepEqual(actual, original);
  });
}
