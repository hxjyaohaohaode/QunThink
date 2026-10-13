import fs from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { buildPostgresTlsConfig } from '../src/models/postgresTls.js';

export const MONGO_IMAGE = 'mongodb/mongodb-community-server:9.0.2-ubi8-slim@sha256:65ca4eddc5dbeae94350b4a3889f2c1194e2b940f968e0341cccc2a5c98c666c';
export const PG_FIXTURES = Object.freeze([
  ['QUNTHINK_TEST_PG_URL', 'qunthink_ci', 'QUNTHINK_TEST_MEMORY_TLS_CA'],
  ['QUNTHINK_TEST_MEMORY_TLS_URL', 'qunthink_memory', 'QUNTHINK_TEST_MEMORY_TLS_CA'],
  ['QUNTHINK_TEST_MEMORY_LEDGER_TLS_URL', 'qunthink_ledger', 'QUNTHINK_TEST_MEMORY_TLS_CA'],
  ['QUNTHINK_TEST_LIFECYCLE_PG_URL', 'qunthink_lifecycle', 'QUNTHINK_TEST_LIFECYCLE_PG_CA'],
  ['QUNTHINK_TEST_LIFECYCLE_LEDGER_URL', 'qunthink_lifecycle_ledger', 'QUNTHINK_TEST_LIFECYCLE_PG_CA'],
  ['QUNTHINK_TEST_COMMIT_PG_URL', 'qunthink_wrapper', 'QUNTHINK_TEST_COMMIT_PG_CA'],
  ['QUNTHINK_TEST_COMMIT_LEDGER_URL', 'qunthink_wrapper_ledger', 'QUNTHINK_TEST_COMMIT_PG_CA'],
  ['QUNTHINK_TEST_PAGING_PG_URL', 'qunthink_paging', 'QUNTHINK_TEST_PAGING_PG_CA'],
  ['QUNTHINK_TEST_PAGING_LEDGER_URL', 'qunthink_paging_ledger', 'QUNTHINK_TEST_PAGING_PG_CA'],
  ['QUNTHINK_TEST_RESTORE_PG_URL', 'qunthink_restore', 'QUNTHINK_TEST_RESTORE_PG_CA'],
  ['QUNTHINK_TEST_RESTORE_LEDGER_URL', 'qunthink_restore_ledger', 'QUNTHINK_TEST_RESTORE_PG_CA']
]);
export const REQUIRED_STORAGE_TESTS = Object.freeze([
  'account-generation-restore-postgres.integration.test.js',
  'account-snapshot-commit-postgres.integration.test.js',
  'account-store-mongo.integration.test.js',
  'account-store-postgres.integration.test.js',
  'agent-grant-lock-order-postgres.integration.test.js',
  'foundations-agent-postgres.integration.test.js',
  'foundations-postgres.integration.test.js',
  'goal-brief-scheduler-postgres.integration.test.js',
  'internal-goal-brief-postgres.integration.test.js',
  'internal-goal-worker-claim-race-postgres.integration.test.js',
  'internal-goal-worker-postgres.integration.test.js',
  'legacy-slice-import-postgres.integration.test.js',
  'message-order-paging-postgres.integration.test.js',
  'model-probe-recovery-postgres.integration.test.js',
  'personal-goals-api-postgres.integration.test.js',
  'pg-low-concurrency.integration.test.js',
  'postgres-deletion-ledger.integration.test.js',
  'postgres-memory-api.integration.test.js',
  'task-command-closure-postgres.integration.test.js',
  'task-dependencies-postgres.integration.test.js',
  'task-lifecycle-postgres.integration.test.js',
  'task-metadata-postgres.integration.test.js',
  'task-results-postgres.integration.test.js'
]);
const invalid = label => new Error(`Invalid or missing synthetic CI storage fixture: ${label}`);

export function storageFixturesRequired(env = process.env) {
  const flag = env.QUNTHINK_REQUIRE_STORAGE_FIXTURES;
  if (flag !== undefined && flag !== '' && flag !== '0' && flag !== '1') throw invalid('required flag');
  return flag === '1';
}
export function validatePgFixtureUrl(value, database, label = database) {
  // Exact string matching deliberately excludes aliases, URL parser normalization,
  // credentials/options with alternate meanings, and nonfixture destinations.
  const expected = `postgresql://postgres:ci_test_only@127.0.0.1:5432/${database}`;
  if (value !== expected) throw invalid(label);
  return new URL(value);
}
export function validateMongoFixtureUrl(value) {
  if (value !== 'mongodb://127.0.0.1:27017/qunthink_order_ci') throw invalid('QUNTHINK_TEST_MONGO_URL');
  return new URL(value);
}
export async function validateStorageFixtureConfig(env = process.env, read = fs.readFile) {
  if (!storageFixturesRequired(env)) throw invalid('required flag must be 1 for preflight');
  const certificates = new Map();
  for (const [key, database, caKey] of PG_FIXTURES) {
    validatePgFixtureUrl(env[key], database, key);
    if (!env[caKey]) throw invalid(caKey);
    if (!certificates.has(env[caKey])) {
      let pem;
      try {
        pem = await read(env[caKey], 'utf8');
        if (!/^\s*-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(pem)
            || pem.match(/-----BEGIN CERTIFICATE-----/g)?.length !== 1 || !new X509Certificate(pem).ca) throw invalid(caKey);
      } catch { throw invalid(caKey); }
      certificates.set(env[caKey], pem);
    }
  }
  // All five bindings intentionally trust the same new synthetic CA.
  if (certificates.size !== 1) throw invalid('all PG CA bindings must match');
  validateMongoFixtureUrl(env.QUNTHINK_TEST_MONGO_URL);
  return { postgres: PG_FIXTURES.map(([key, database, caKey]) => ({ key, database, url: env[key], caFile: env[caKey] })), mongoUrl: env.QUNTHINK_TEST_MONGO_URL };
}

export async function probePostgres(fixture, Pool = pg.Pool) {
  const pool = new Pool({ ...buildPostgresTlsConfig(fixture.url, fixture.caFile), max: 1,
    connectionTimeoutMillis: 3000, query_timeout: 3000, statement_timeout: 3000 });
  pool.on('error', () => {});
  try {
    const { rows: [row] } = await pool.query(`SELECT current_database() AS database,
      current_setting('server_version') AS version, current_setting('server_version_num') AS version_num,
      current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit,
      ssl, version AS tls FROM pg_stat_ssl WHERE pid=pg_backend_pid()`);
    if (!row || row.database !== fixture.database || Number(row.version_num) < 160000 || Number(row.version_num) >= 170000
        || row.fsync !== 'on' || row.synchronous_commit !== 'on' || row.ssl !== true || row.tls !== 'TLSv1.3') {
      throw invalid(`PG readiness ${fixture.database}`);
    }
    return row;
  } finally { await pool.end(); }
}
export async function probeMongo(url, Client = MongoClient) {
  validateMongoFixtureUrl(url);
  const client = new Client(url, { maxPoolSize: 1, serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000, socketTimeoutMS: 3000, timeoutMS: 3000 });
  try {
    await client.connect();
    const db = client.db('qunthink_order_ci');
    const hello = await db.command({ hello: 1 }, { maxTimeMS: 2000 });
    const build = await db.command({ buildInfo: 1 }, { maxTimeMS: 2000 });
    if (hello.ok !== 1 || hello.isWritablePrimary !== true || hello.maxBsonObjectSize !== 16 * 1024 * 1024 || build.version !== '9.0.2') {
      throw invalid('Mongo readiness/version/BSON limit');
    }
    return { version: build.version, gitVersion: build.gitVersion, maxBsonObjectSize: hello.maxBsonObjectSize,
      writable: hello.isWritablePrimary, topology: hello.setName ? 'replica-set' : 'standalone' };
  } finally { await client.close(); }
}
export async function runStoragePreflight(env = process.env, { postgres = probePostgres, mongo = probeMongo,
  config = validateStorageFixtureConfig, now = Date.now, sleep = delay, timeoutMs = 60000 } = {}) {
  const fixtures = await config(env);
  const deadline = now() + timeoutMs;
  const readiness = { postgres: [], mongo: null };
  // Each connection/query is bounded; the shared deadline is not reset by retries.
  for (const fixture of [...fixtures.postgres, { mongoUrl: fixtures.mongoUrl }]) {
    for (;;) {
      if (now() >= deadline) throw invalid(fixture.mongoUrl ? 'Mongo unavailable before deadline' : `${fixture.database} unavailable before deadline`);
      try {
        const result = fixture.mongoUrl ? await mongo(fixture.mongoUrl) : await postgres(fixture);
        if (fixture.mongoUrl) readiness.mongo = result; else readiness.postgres.push(result);
        break;
      } catch {
        if (now() >= deadline) throw invalid(fixture.mongoUrl ? 'Mongo unavailable before deadline' : `${fixture.database} unavailable before deadline`);
        await sleep(Math.min(500, Math.max(1, deadline - now())));
      }
    }
  }
  return readiness;
}

export function assertRequiredStorageFiles(tests) {
  for (const name of REQUIRED_STORAGE_TESTS) if (!tests.includes(name)) throw new Error(`Required storage test file missing: ${name}`);
}
export function verifyRequiredTap(name, output, status) {
  if (status !== 0) throw new Error(`Required storage test exited unsuccessfully: ${name}`);
  const count = key => {
    const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`Required storage test has no unique TAP ${key} summary: ${name}`);
    return Number(matches[0][1]);
  };
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, count(key)]));
  if (summary.tests < 1 || summary.pass !== summary.tests || summary.fail || summary.cancelled || summary.skipped || summary.todo
      || /^\s*(?:not ok\b|ok\b[^\n]*#\s*(?:SKIP|TODO)\b)/im.test(output)) {
    throw new Error(`Required storage test must execute with zero skips, TODOs, failures or cancellations: ${name}`);
  }
  return summary;
}
