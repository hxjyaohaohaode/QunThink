import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureKvSchema, PgLow } from '../src/models/supabaseAdapter.js';

const url = process.env.QUNTHINK_TEST_PG_URL;

test('configured PostgreSQL outage fails startup without creating a local user database', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qunthink-pg-outage-'));
  const source = `import { initDatabase } from './src/models/db.js';
    try { await initDatabase(); process.exit(0); }
    catch { process.exit(27); }`;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir,
        SUPABASE_DB_URL: 'postgres://postgres:invalid@127.0.0.1:1/unavailable' },
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 27);
  assert.equal((await readdir(dataDir)).includes('users'), false);
});

test('real PostgreSQL connections reject stale whole-document writes and preserve legacy rows', { skip: !url }, async () => {
  const schema = `qt_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  let first, second;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    first = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    second = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    const c1 = await first.connect(), c2 = await second.connect();
    try {
      const p1 = (await c1.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const p2 = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      assert.notEqual(p1, p2);
    } finally { c1.release(); c2.release(); }

    await first.query(`CREATE TABLE kv_store (
      key TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await first.query('INSERT INTO kv_store(key,data) VALUES($1,$2)', ['legacy', { messages: ['old'] }]);
    await ensureKvSchema(first);
    assert.equal((await first.query('SELECT revision FROM kv_store WHERE key=$1', ['legacy'])).rows[0].revision, '0');

    const a = new PgLow('legacy', { messages: [] }, first);
    const b = new PgLow('legacy', { messages: [] }, second);
    await Promise.all([a.read(), b.read()]);
    a.data.messages.push('from-a');
    b.data.messages.push('from-b');
    const outcomes = await Promise.allSettled([a.write(), b.write()]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.status, 409);
    const current = new PgLow('legacy', { messages: [] }, first);
    await current.read();
    assert.deepEqual(current.data.messages.length, 2);
    assert.ok(current.data.messages.includes('old'));
    assert.equal(current._revision, 1);
    const loser = rejected === outcomes[0] ? a : b;
    const missing = rejected === outcomes[0] ? 'from-a' : 'from-b';
    await loser.read();
    loser.data.messages.push(missing);
    await loser.write();
    const final = new PgLow('legacy', { messages: [] }, second);
    await final.read();
    assert.deepEqual(new Set(final.data.messages), new Set(['old', 'from-a', 'from-b']));
    assert.equal(final._revision, 2);
  } finally {
    await Promise.allSettled([first?.end(), second?.end()]);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
