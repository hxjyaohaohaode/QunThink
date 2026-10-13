import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rootCertificates } from 'node:tls';
import YAML from 'yaml';
import { MONGO_IMAGE, PG_FIXTURES, REQUIRED_STORAGE_TESTS, storageFixturesRequired, validatePgFixtureUrl,
  validateMongoFixtureUrl, validateStorageFixtureConfig, probeMongo, probePostgres, runStoragePreflight,
  assertRequiredStorageFiles, verifyRequiredTap } from '../scripts/ci-storage-fixtures.mjs';
import { sourceManifest, writeStorageEvidence, sanitizeStorageOutput } from '../scripts/ci-storage-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeEnv = () => ({ QUNTHINK_REQUIRE_STORAGE_FIXTURES: '1',
  QUNTHINK_TEST_MONGO_URL: 'mongodb://127.0.0.1:27017/qunthink_order_ci',
  ...Object.fromEntries(PG_FIXTURES.flatMap(([key, db, ca]) => [[key, `postgresql://postgres:ci_test_only@127.0.0.1:5432/${db}`], [ca, '/synthetic/ca.crt']])) });
const fakeRead = async () => rootCertificates[0]; // Pure config test; never a network fixture.
const greenTap = '# tests 8\n# pass 8\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';

test('pure contract: exact 11 named databases and 16 PG URL/CA variables are distinct', async () => {
  assert.equal(PG_FIXTURES.length, 11);
  assert.equal(new Set(PG_FIXTURES.map(row => row[1])).size, 11);
  assert.equal(new Set(PG_FIXTURES.flatMap(([key, , ca]) => [key, ca])).size, 16);
  const cfg = await validateStorageFixtureConfig(fakeEnv(), fakeRead);
  assert.equal(cfg.postgres.length, 11);
  assert.equal(cfg.mongoUrl, fakeEnv().QUNTHINK_TEST_MONGO_URL);
});
for (const key of [...new Set(PG_FIXTURES.flatMap(([key, , ca]) => [key, ca])), 'QUNTHINK_TEST_MONGO_URL', 'QUNTHINK_REQUIRE_STORAGE_FIXTURES']) {
  test(`pure negative contract: required ${key} cannot be omitted`, async () => {
    const env = fakeEnv(); delete env[key];
    await assert.rejects(validateStorageFixtureConfig(env, fakeRead), /Invalid or missing/);
  });
}
test('pure contract: ordinary local omission remains optional; malformed required flags fail closed', () => {
  assert.equal(storageFixturesRequired({}), false);
  assert.equal(storageFixturesRequired({ QUNTHINK_REQUIRE_STORAGE_FIXTURES: '0' }), false);
  assert.equal(storageFixturesRequired(fakeEnv()), true);
  for (const flag of ['true', 'yes', ' 1', '2']) assert.throws(() => storageFixturesRequired({ QUNTHINK_REQUIRE_STORAGE_FIXTURES: flag }));
});
for (const value of [undefined, 'postgresql://postgres:ci_test_only@localhost:5432/qunthink_ci',
  'postgresql://postgres:ci_test_only@127.1:5432/qunthink_ci',
  'postgresql://postgres:secret-canary@127.0.0.1:5432/qunthink_ci',
  'postgresql://postgres:ci_test_only@127.0.0.1:5432/other',
  'postgresql://postgres:ci_test_only@127.0.0.1:5432/qunthink_ci?sslmode=disable']) {
  test(`pure negative contract: unsafe PG fixture ${value?.replace('secret-canary', '[redacted]')}`, () => {
    assert.throws(() => validatePgFixtureUrl(value, 'qunthink_ci'), error => !error.message.includes('secret-canary'));
  });
}
for (const value of [undefined, 'mongodb://localhost:27017/qunthink_order_ci',
  'mongodb://127.0.0.1:27017/production', 'mongodb://user:secret-canary@127.0.0.1:27017/qunthink_order_ci',
  'mongodb://127.0.0.1:27017/qunthink_order_ci?directConnection=true', 'mongodb+srv://127.0.0.1/qunthink_order_ci']) {
  test(`pure negative contract: unsafe Mongo fixture ${value?.replace('secret-canary', '[redacted]')}`, () => {
    assert.throws(() => validateMongoFixtureUrl(value), error => !error.message.includes('secret-canary'));
  });
}
test('pure negative contract: unreadable, malformed, private-key and mixed CA bindings fail closed', async () => {
  await assert.rejects(validateStorageFixtureConfig(fakeEnv(), async () => { throw new Error('secret-canary'); }), error => !error.message.includes('secret-canary'));
  for (const pem of ['', 'malformed', '-----BEGIN PRIVATE KEY-----\nsecret-canary\n-----END PRIVATE KEY-----', rootCertificates[0] + rootCertificates[1]]) {
    await assert.rejects(validateStorageFixtureConfig(fakeEnv(), async () => pem));
  }
  const env = fakeEnv(); env.QUNTHINK_TEST_RESTORE_PG_CA = '/synthetic/other-ca.crt';
  await assert.rejects(validateStorageFixtureConfig(env, fakeRead), /CA bindings must match/);
});
test('pure fake-driver contract: successful Mongo readiness and close are bounded and versioned', async () => {
  let closed = 0, options;
  class FakeClient {
    constructor(url, opts) { assert.equal(url, fakeEnv().QUNTHINK_TEST_MONGO_URL); options = opts; }
    async connect() {}
    db(name) { assert.equal(name, 'qunthink_order_ci'); return { command: async cmd => cmd.hello
      ? { ok: 1, isWritablePrimary: true, maxBsonObjectSize: 16777216 }
      : { version: '9.0.2', gitVersion: 'synthetic-test-only' } }; }
    async close() { closed++; }
  }
  assert.equal((await probeMongo(fakeEnv().QUNTHINK_TEST_MONGO_URL, FakeClient)).version, '9.0.2');
  assert.equal(closed, 1); assert.equal(options.timeoutMS, 3000);
  for (const failure of ['connect', 'version']) {
    class Failed extends FakeClient {
      async connect() { if (failure === 'connect') throw new Error('fake unavailable'); }
      db() { return { command: async () => ({ version: 'unreviewed', ok: 1 }) }; }
    }
    await assert.rejects(probeMongo(fakeEnv().QUNTHINK_TEST_MONGO_URL, Failed));
  }
  assert.equal(closed, 3);
});
test('pure fake-pool contract: PostgreSQL verifies CA, exact host, TLS1.3 and durable state then always ends', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-ci-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const caFile = path.join(directory, 'public-test-ca.crt'); await fs.writeFile(caFile, rootCertificates[0]);
  let ended = 0, config, row = { database: 'qunthink_ci', version: '16.synthetic', version_num: '160015', fsync: 'on', synchronous_commit: 'on', ssl: true, tls: 'TLSv1.3' };
  class FakePool {
    constructor(value) { config = value; }
    on() {}
    async query() { return { rows: [row] }; }
    async end() { ended++; }
  }
  const fixture = { url: fakeEnv().QUNTHINK_TEST_PG_URL, database: 'qunthink_ci', caFile };
  await probePostgres(fixture, FakePool);
  assert.equal(config.ssl.rejectUnauthorized, true); assert.equal(config.ssl.ca, rootCertificates[0]);
  assert.equal(config.ssl.checkServerIdentity('localhost', { subjectaltname: 'DNS:localhost' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(config.query_timeout, 3000); assert.equal(config.connectionTimeoutMillis, 3000);
  for (const bad of [{ ssl: false }, { fsync: 'off' }, { synchronous_commit: 'off' }, { tls: 'TLSv1.2' }, { database: 'other' }, { version_num: '170000' }]) {
    const original = row; row = { ...row, ...bad };
    await assert.rejects(probePostgres(fixture, FakePool)); row = original;
  }
  assert.equal(ended, 7);
});
test('pure fake-readiness contract: unavailable Mongo/PG exhaust one bounded deadline and cannot pass', async () => {
  for (const unavailable of ['postgres', 'mongo']) {
    let time = 0, attempts = 0;
    const config = async () => ({ postgres: [{ database: 'synthetic' }], mongoUrl: fakeEnv().QUNTHINK_TEST_MONGO_URL });
    const success = async () => ({ synthetic: true });
    await assert.rejects(runStoragePreflight(fakeEnv(), { config, now: () => time,
      sleep: async ms => { time += ms; }, timeoutMs: 10, postgres: success, mongo: success,
      [unavailable]: async () => { attempts++; throw new Error('synthetic unavailable'); } }), /unavailable before deadline/);
    assert.ok(attempts <= 2); assert.equal(time, 10);
  }
});
test('pure TAP gate: all designated files must exist; 8/8 cannot conceal one skipped specialty', () => {
  assertRequiredStorageFiles(REQUIRED_STORAGE_TESTS);
  assert.throws(() => assertRequiredStorageFiles(REQUIRED_STORAGE_TESTS.filter(name => !name.includes('mongo'))), /missing/);
  assert.equal(verifyRequiredTap('synthetic-only', greenTap, 0).tests, 8);
  for (const output of [greenTap.replace('# skipped 0', '# skipped 1'), greenTap.replace('# todo 0', '# todo 1'),
    greenTap.replace('# cancelled 0', '# cancelled 1'), greenTap.replace('# fail 0', '# fail 1'),
    greenTap.replace('# pass 8', '# pass 7'), greenTap.replaceAll('8', '0'), '', greenTap + greenTap,
    'ok 1 - skip hidden in otherwise clean summary # SKIP\n' + greenTap]) {
    assert.throws(() => verifyRequiredTap('synthetic-only', output, 0));
  }
  for (const status of [null, 1, 2]) assert.throws(() => verifyRequiredTap('synthetic-only', greenTap, status));
});
test('pure workflow contract: exact vendor digest/platform, existing PG, required gate and bounded one-day evidence', async () => {
  const workflow = YAML.parse(await fs.readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs['backend-check'];
  assert.equal(job.services.postgres.image, 'postgres:16-alpine');
  assert.equal(job.services.postgres.env.POSTGRES_DB, 'qunthink_ci');
  assert.deepEqual(job.services.postgres.ports, ['5432:5432']);
  assert.equal(job.services.mongo.image, MONGO_IMAGE);
  assert.equal(job.services.mongo.options, '--platform linux/amd64');
  assert.deepEqual(job.services.mongo.ports, ['127.0.0.1:27017:27017']);
  assert.equal(job.env.QUNTHINK_REQUIRE_STORAGE_FIXTURES, '1');
  for (const [key, db] of PG_FIXTURES) validatePgFixtureUrl(job.env[key], db);
  validateMongoFixtureUrl(job.env.QUNTHINK_TEST_MONGO_URL);
  assert.equal(job.steps.find(step => step.uses === 'actions/setup-node@v4').with['node-version'], '22.12.0');
  const setup = job.steps.find(step => step.name === 'Prepare disposable verified storage fixtures');
  assert.match(setup.run, /timeout 120s bash scripts\/setup-ci-storage.sh/);
  assert.match(setup.run, /exit "\$status"/);
  const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.if, 'always()'); assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with.path, '${{ runner.temp }}/qunthink-storage-evidence/');
  const script = await fs.readFile(new URL('../scripts/setup-ci-storage.sh', import.meta.url), 'utf8');
  assert.match(script, /GITHUB_ACTIONS/); assert.match(script, /RUNNER_ARCH/);
  assert.match(script, /chmod 600/); assert.match(script, /chown -R postgres:postgres "\$container_tls"/);
  assert.match(script, /SELECT pg_reload_conf\(\)/);
  assert.match(script, /subjectAltName=IP:127\.0\.0\.1,DNS:localhost/);
  assert.doesNotMatch(script, /mongosh|rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|--privileged|--cap-add|sysctl|docker run|docker pull/);
});
function assertFrontendStartupDependencies(workflow) {
  const steps = workflow.jobs?.['frontend-check']?.steps;
  assert.ok(Array.isArray(steps), 'frontend-check must have its own steps');
  const testsIndex = steps.findIndex(step => step.name === 'Frontend tests');
  assert.ok(testsIndex >= 0, 'frontend-check must retain Frontend tests');
  assert.equal(steps[testsIndex].run, 'npm test');
  assert.equal(steps[testsIndex]['working-directory'], './frontend');
  const setupIndex = steps.findIndex(step => step.uses === 'actions/setup-node@v4');
  assert.ok(setupIndex >= 0, 'frontend-check must configure Node and npm cache');
  assert.equal(steps[setupIndex].with.cache, 'npm');
  assert.deepEqual(steps[setupIndex].with['cache-dependency-path'].trim().split(/\s+/).sort(),
    ['./backend/package-lock.json', './frontend/package-lock.json']);
  for (const directory of ['frontend', 'backend']) {
    const installIndex = steps.findIndex(step => step.run === 'npm ci' && step['working-directory'] === `./${directory}`);
    assert.ok(installIndex > setupIndex && installIndex < testsIndex,
      `frontend-check must install ${directory} with npm ci after setup-node and before Frontend tests`);
    for (const key of ['if', 'continue-on-error']) assert.equal(steps[installIndex][key], undefined,
      `${directory} dependency installation must be unconditional and required`);
  }
}

test('pure workflow contract: frontend startup tests install both locked dependency trees in their own job', async () => {
  assertFrontendStartupDependencies(YAML.parse(await fs.readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')));
});

test('pure negative workflow contract: frontend startup dependency preconditions cannot be misplaced or bypassed', async t => {
  // A synthetic valid workflow keeps the mutation checks independent of the real workflow's current state.
  const valid = { jobs: { 'frontend-check': { steps: [
    { uses: 'actions/setup-node@v4', with: { cache: 'npm',
      'cache-dependency-path': './frontend/package-lock.json\n./backend/package-lock.json' } },
    { run: 'npm ci', 'working-directory': './frontend' },
    { run: 'npm ci', 'working-directory': './backend' },
    { name: 'Frontend tests', run: 'npm test', 'working-directory': './frontend' }
  ] }, 'backend-check': { steps: [] } } };
  assertFrontendStartupDependencies(valid);
  for (const [label, mutate] of [
    ['deleted backend installation', workflow => workflow.jobs['frontend-check'].steps.splice(2, 1)],
    ['wrong backend installation directory', workflow => { workflow.jobs['frontend-check'].steps[2]['working-directory'] = './frontend'; }],
    ['installation in another job', workflow => { workflow.jobs['backend-check'].steps.push(...workflow.jobs['frontend-check'].steps.splice(2, 1)); }],
    ['installation after frontend tests', workflow => { const steps = workflow.jobs['frontend-check'].steps; steps.push(...steps.splice(2, 1)); }],
    ['unlocked npm install', workflow => { workflow.jobs['frontend-check'].steps[2].run = 'npm install'; }],
    ['conditional backend installation', workflow => { workflow.jobs['frontend-check'].steps[2].if = 'false'; }],
    ['ignored backend installation failure', workflow => { workflow.jobs['frontend-check'].steps[2]['continue-on-error'] = true; }],
    ['missing backend cache lock', workflow => { workflow.jobs['frontend-check'].steps[0].with['cache-dependency-path'] = './frontend/package-lock.json'; }],
    ['missing frontend cache lock', workflow => { workflow.jobs['frontend-check'].steps[0].with['cache-dependency-path'] = './backend/package-lock.json'; }]
  ]) await t.test(label, () => {
    const workflow = structuredClone(valid); mutate(workflow);
    assert.throws(() => assertFrontendStartupDependencies(workflow), assert.AssertionError);
  });
});

test('real subprocess negative: required absent fixture exits before any old suite can produce green', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-ci-negative-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, QUNTHINK_REQUIRE_STORAGE_FIXTURES: '1', QUNTHINK_STORAGE_EVIDENCE_DIR: directory };
  for (const key of Object.keys(env)) if (key.startsWith('QUNTHINK_TEST_')) delete env[key];
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, /\[tests\]/);
  assert.match(result.stderr, /QUNTHINK_TEST_PG_URL/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'backend-exit.json'))).phase, 'preflight');
});
test('evidence manifest covers source and tests, without dependencies, data or synthetic private keys', async t => {
  const manifest = await sourceManifest();
  assert.match(manifest.manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.files.some(row => row.path === 'backend/src/models/mongoAdapter.js'));
  assert.ok(manifest.files.some(row => row.path === 'backend/test/account-store-mongo.integration.test.js'));
  assert.ok(manifest.files.every(row => !/node_modules|\.key$|\/data\//.test(row.path)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-ci-evidence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeStorageEvidence('synthetic-test.json', { status: 1 }, { QUNTHINK_STORAGE_EVIDENCE_DIR: directory });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'synthetic-test.json'))), { status: 1 });
  await assert.rejects(writeStorageEvidence('../unsafe', {}, { QUNTHINK_STORAGE_EVIDENCE_DIR: directory }));
});

test('pure fake-command setup: exactly new TLS files, ten new DBs, five CA exports and no alternate image path', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-setup-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'); await fs.mkdir(bin);
  const log = path.join(directory, 'fake-docker.jsonl');
  // Pure orchestration contract: these executables never contact Docker or a DB.
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  await fs.writeFile(path.join(bin, 'openssl'), `#!${process.execPath}\nimport fs from 'node:fs';\nfor (const flag of ['-keyout','-out']) { const i=process.argv.indexOf(flag); if(i>=0)fs.writeFileSync(process.argv[i+1],'synthetic stub, not a certificate'); }\n`, { mode: 0o700 });
  const docker = `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2); fs.appendFileSync(process.env.FAKE_DOCKER_LOG,JSON.stringify(args)+'\\n');
if(process.env.FAKE_DOCKER_FAIL && args.some(value=>value.includes('CREATE DATABASE qunthink_wrapper')))process.exit(37);
if(args[0]==='inspect')console.log(args.at(-1)==='aaaaaaaaaaaa'?'pg-image':'mongo-image');
if(args[0]==='image')console.log(JSON.stringify({id:args.at(-1),repoDigests:args.at(-1)==='mongo-image'?[${JSON.stringify(MONGO_IMAGE.replace(':9.0.2-ubi8-slim', ''))}]:['postgres@sha256:synthetic'],architecture:'amd64',os:'linux'}));
`;
  await fs.writeFile(path.join(bin, 'docker'), docker, { mode: 0o700 });
  const evidence = path.join(directory, 'evidence'), githubEnv = path.join(directory, 'github-env');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    RUNNER_TEMP: directory, GITHUB_ENV: githubEnv, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', CI_POSTGRES_CONTAINER: 'aaaaaaaaaaaa',
    CI_MONGO_CONTAINER: 'bbbbbbbbbbbb', QUNTHINK_STORAGE_EVIDENCE_DIR: evidence, FAKE_DOCKER_LOG: log };
  const setup = fileURLToPath(new URL('../scripts/setup-ci-storage.sh', import.meta.url));
  const result = spawnSync('bash', [setup], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const sql = calls.filter(args => args.includes('psql')).map(args => args.at(-1));
  assert.deepEqual(sql.filter(value => value.startsWith('CREATE DATABASE ')).map(value => value.slice('CREATE DATABASE '.length)), PG_FIXTURES.slice(1).map(row => row[1]));
  assert.equal(sql.filter(value => value === 'SELECT pg_reload_conf()').length, 1);
  assert.equal(calls.filter(args => args[0] === 'cp').length, 2);
  assert.ok(calls.filter(args => args[0] === 'cp').every(args => /server\.(?:key|crt)$/.test(args[1])));
  assert.ok(calls.every(args => !['pull', 'run', 'rm'].includes(args[0])));
  const exported = (await fs.readFile(githubEnv, 'utf8')).trim().split('\n');
  assert.equal(exported.length, 5);
  assert.deepEqual(exported.map(row => row.split('=')[0]), [...new Set(PG_FIXTURES.map(row => row[2]))]);
  const tlsDir = path.dirname(exported[0].slice(exported[0].indexOf('=') + 1));
  for (const file of await fs.readdir(tlsDir)) assert.equal((await fs.stat(path.join(tlsDir, file))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(evidence)).sort(), ['mongo-image.json', 'postgres-image.json']);
  const failed = spawnSync('bash', [setup], { env: { ...env, FAKE_DOCKER_FAIL: '1' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(failed.status, 37, 'setup preserves a failed DB command status');
  const forbidden = spawnSync('bash', [setup], { env: { ...env, GITHUB_ACTIONS: '' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(forbidden.status, 1, 'a local invocation fails before fake docker is invoked');
});

test('real child TAP samples: declared skip and checked nonzero exit cannot masquerade as required fixture success', () => {
  const invoke = source => spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 });
  const pass = invoke("import test from 'node:test';test('synthetic pure sample',()=>{});");
  assert.equal(verifyRequiredTap('synthetic pure sample', pass.stdout, pass.status).tests, 1);
  const skipped = invoke("import test from 'node:test';test('synthetic skip sample',{skip:true},()=>{});");
  assert.equal(skipped.status, 0); assert.throws(() => verifyRequiredTap('synthetic skip sample', skipped.stdout, skipped.status));
  const failed = invoke("import test from 'node:test';test('synthetic passing assertion',()=>{});process.exitCode=37;");
  assert.equal(failed.status, 37); assert.throws(() => verifyRequiredTap('synthetic failed exit', failed.stdout, failed.status));
});

test('report sanitizer removes URI credentials and complete/truncated PEM before UTF-8 byte limits', () => {
  const password = 'SYNTHETIC_PASSWORD_CANARY', privateKey = 'SYNTHETIC_PRIVATE_KEY_CANARY';
  for (const prefix of ['', '# ']) for (const keyType of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    for (const end of ['', `${prefix}-----END ${keyType}-----\n`]) {
      const input = `# mongodb://review:${password}@example.invalid/db\n${prefix}-----BEGIN ${keyType}-----\n${prefix}${privateKey}\n${end}`;
      const safe = sanitizeStorageOutput(input);
      assert.ok(!safe.includes(password)); assert.ok(!safe.includes(privateKey));
      assert.match(safe, /REDACTED USERINFO/); assert.match(safe, /REDACTED PRIVATE KEY/);
    }
  }
  const source = '前'.repeat(200) + ` postgresql://review:${password}@example.invalid/db ` + '后'.repeat(200);
  const safe = sanitizeStorageOutput(source, 128);
  assert.ok(Buffer.byteLength(safe) <= 128); assert.ok(!safe.includes(password)); assert.ok(!safe.includes('\ufffd'));
  assert.match(safe, /bounded output/);
});

async function runSyntheticRunner(t, { child, writeFailure, preflightFailure, manifestFailure } = {}) {
  // Execute the unchanged runner body with explicit fake dependencies. No server,
  // Docker or network connection is made; actual fs evidence formatting is used.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-runner-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const body = (await fs.readFile(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\n/gm, '');
  const names = ['spawnSync', 'readdirSync', 'path', 'storageFixturesRequired', 'assertRequiredStorageFiles', 'REQUIRED_STORAGE_TESTS',
    'runStoragePreflight', 'verifyRequiredTap', 'writeStorageEvidence', 'sourceManifest', 'sanitizeStorageOutput', 'process'];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(...names, body);
  const tests = [...REQUIRED_STORAGE_TESTS, 'platform.integration.test.js'].sort(), attempted = [];
  const env = { QUNTHINK_REQUIRE_STORAGE_FIXTURES: '1', QUNTHINK_STORAGE_EVIDENCE_DIR: directory };
  const captured = { stdout: '', stderr: '' };
  const proc = { env, execPath: process.execPath, cwd: () => root,
    stdout: { write: value => { captured.stdout += value; } }, stderr: { write: value => { captured.stderr += value; } } };
  await execute((_, args) => {
    attempted.push(path.basename(args[0]));
    return child?.(attempted.length) || { status: 0, signal: null, stdout: greenTap, stderr: '' };
  }, () => tests, path, () => storageFixturesRequired(env), assertRequiredStorageFiles, REQUIRED_STORAGE_TESTS,
  async () => { if (preflightFailure) throw new Error(preflightFailure); return { synthetic: true }; }, verifyRequiredTap,
  async (name, value) => { const fail = writeFailure?.(name); if (fail) throw Object.assign(new Error(`SYNTHETIC ${fail} writing ${name}`), { code: fail }); await writeStorageEvidence(name, value, env); },
  async () => { if (manifestFailure) throw new Error(manifestFailure); return { synthetic: true }; }, sanitizeStorageOutput, proc);
  let receipt = null;
  try { receipt = JSON.parse(await fs.readFile(path.join(directory, 'backend-exit.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { directory, attempted, tests, receipt, status: proc.exitCode, ...captured };
}

test('pure runner fault injection: report channels redact canaries; raw TAP still decides acceptance', async t => {
  const password = 'SYNTHETIC_RUNNER_PASSWORD_8ef1', privateKey = 'SYNTHETIC_RUNNER_PRIVATE_KEY_9f52';
  const canaries = `# postgresql://review:${password}@example.invalid/db\n# -----BEGIN PRIVATE KEY-----\n# ${privateKey}\n# -----END PRIVATE KEY-----\n`;
  const result = await runSyntheticRunner(t, { child: () => ({ status: 0, signal: null, stdout: canaries + greenTap, stderr: canaries }) });
  assert.equal(result.status, 0); assert.equal(result.attempted.length, result.tests.length);
  const log = await fs.readFile(path.join(result.directory, REQUIRED_STORAGE_TESTS[0] + '.log'), 'utf8');
  for (const report of [result.stdout, result.stderr, log]) {
    assert.ok(!report.includes(password)); assert.ok(!report.includes(privateKey)); assert.match(report, /REDACTED/);
  }
  const skipped = await runSyntheticRunner(t, { child: () => ({ status: 0, stdout: greenTap.replace('# skipped 0', '# skipped 1'), stderr: '' }) });
  assert.equal(skipped.status, 1); assert.ok(skipped.receipt.results.some(row => row.gateError));
});

test('pure runner fault injection: failed log writes preserve exit37, continue all files and record both failures', async t => {
  const result = await runSyntheticRunner(t, {
    child: index => ({ status: index === 1 ? 37 : 0, signal: null, stdout: greenTap, stderr: 'synthetic child output' }),
    writeFailure: name => name.endsWith('.log') && 'ENOSPC'
  });
  assert.equal(result.status, 1); assert.equal(result.attempted.length, result.tests.length);
  assert.equal(result.receipt.results[0].exitStatus, 37); assert.equal(result.receipt.results.length, result.tests.length);
  assert.ok(result.receipt.evidenceErrors.some(row => row.code === 'ENOSPC'));
  assert.match(result.stderr, /ENOSPC/); assert.equal(result.receipt.status, 1);
});

test('pure runner fault injection: EACCES cannot replace original preflight failure', async t => {
  const result = await runSyntheticRunner(t, { preflightFailure: 'SYNTHETIC original readiness failure',
    writeFailure: name => name === 'preflight.json' && 'EACCES' });
  assert.equal(result.status, 1); assert.equal(result.attempted.length, 0);
  assert.equal(result.receipt.primaryError, 'SYNTHETIC original readiness failure');
  assert.equal(result.receipt.phase, 'preflight'); assert.equal(result.receipt.evidenceErrors[0].code, 'EACCES');
  assert.match(result.stderr, /original readiness failure/); assert.match(result.stderr, /EACCES/);
});

test('pure runner fault injection: final-receipt failure falls back to console with original statuses and nonzero outcome', async t => {
  const result = await runSyntheticRunner(t, { child: index => ({ status: index === 1 ? 37 : 0, stdout: greenTap, stderr: '' }),
    writeFailure: name => name === 'backend-exit.json' && 'ENOSPC' });
  assert.equal(result.status, 1); assert.equal(result.receipt, null); assert.equal(result.attempted.length, result.tests.length);
  assert.match(result.stderr, /storage receipt fallback/); assert.match(result.stderr, /"exitStatus":37/); assert.match(result.stderr, /ENOSPC/);
  const greenButNoReceipt = await runSyntheticRunner(t, { writeFailure: name => name === 'backend-exit.json' && 'EACCES' });
  assert.equal(greenButNoReceipt.status, 1); assert.match(greenButNoReceipt.stderr, /storage receipt fallback/);
});

test('pure runner fault injection: source evidence and child buffer errors remain explicit without stopping subsequent files', async t => {
  const result = await runSyntheticRunner(t, { manifestFailure: 'SYNTHETIC source manifest unreadable',
    child: index => index === 1 ? { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: Object.assign(new Error('SYNTHETIC output buffer exceeded'), { code: 'ENOBUFS' }) } : null });
  assert.equal(result.status, 1); assert.equal(result.attempted.length, result.tests.length);
  assert.equal(result.receipt.results[0].exitStatus, null); assert.equal(result.receipt.results[0].errorCode, 'ENOBUFS');
  assert.match(result.receipt.evidenceErrors[0].error, /source manifest unreadable/);
});

test('real setup-log report subprocess redacts raw file before artifact/console delivery and removes raw temporary file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-setup-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const raw = path.join(directory, 'raw.log'), evidence = path.join(directory, 'evidence');
  await fs.writeFile(raw, 'mongodb://review:SYNTHETIC_SETUP_PASSWORD@127.0.0.1/db\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_SETUP_KEY\n-----END PRIVATE KEY-----\n');
  const result = spawnSync(process.execPath, ['scripts/ci-storage-evidence.mjs', 'sanitize-setup', raw], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, QUNTHINK_STORAGE_EVIDENCE_DIR: evidence }
  });
  assert.equal(result.status, 0, result.stderr);
  const artifact = await fs.readFile(path.join(evidence, 'setup.log'), 'utf8');
  assert.equal(result.stdout, artifact); assert.doesNotMatch(artifact, /SYNTHETIC_SETUP_(?:KEY|PASSWORD)/);
  await assert.rejects(fs.stat(raw), { code: 'ENOENT' });
});

// GitHub validates job.env before a runner exists. This deliberately scoped
// checker covers dotted context references used in this repository, not the
// complete Actions expression grammar.
function assertJobEnvironmentContexts(workflow) {
  const allowed = new Set(['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs']);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const [key, value] of Object.entries(job.env ?? {})) {
      for (const expression of String(value).matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
        for (const reference of expression[1].matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\./g)) {
          assert.ok(allowed.has(reference[1]), `Unavailable job.env context ${reference[1]} at ${jobName}.${key}`);
        }
      }
    }
  }
}

test('workflow job environment uses only contexts available before runner assignment', async () => {
  const workflow = YAML.parse(await fs.readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assertJobEnvironmentContexts(workflow);
  for (const context of ['runner', 'job', 'steps', 'env']) {
    assert.throws(() => assertJobEnvironmentContexts({ jobs: { synthetic: { env: { VALUE: '${{ ' + context + '.temp }}' } } } }), /Unavailable job.env context/);
  }
  for (const context of ['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs']) {
    assertJobEnvironmentContexts({ jobs: { synthetic: { env: { VALUE: '${{ ' + context + '.value }}' } } } });
  }
});

test('real runner-step contract: evidence path is initialized before every consumer and survives a spaced temporary path', async t => {
  const workflow = YAML.parse(await fs.readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs['backend-check'];
  assert.equal(Object.hasOwn(job.env, 'QUNTHINK_STORAGE_EVIDENCE_DIR'), false);
  const name = 'Initialize runner storage evidence directory';
  const index = job.steps.findIndex(step => step.name === name);
  assert.ok(index >= 0, 'runner initialization step is required');
  const init = job.steps[index];
  assert.equal(init.shell, 'bash');
  for (const name of ['Record exact backend storage source manifest', 'Prepare disposable verified storage fixtures', 'Backend tests with required real-storage preflight and zero-skip gate']) {
    assert.ok(index < job.steps.findIndex(step => step.name === name), `initialization precedes ${name}`);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-ci-env path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const githubEnv = path.join(directory, 'github-env');
  const env = { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_ENV: githubEnv };
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', init.run], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const expected = path.join(directory, 'qunthink-storage-evidence');
  assert.equal(await fs.readFile(githubEnv, 'utf8'), `QUNTHINK_STORAGE_EVIDENCE_DIR=${expected}\n`);
  const manifest = spawnSync(process.execPath, ['scripts/ci-storage-evidence.mjs'], { cwd: root,
    env: { ...env, QUNTHINK_STORAGE_EVIDENCE_DIR: expected }, encoding: 'utf8', timeout: 10000 });
  assert.equal(manifest.status, 0, manifest.stderr);
  const files = await fs.readdir(expected);
  assert.ok(files.length > 0, 'following source-manifest step writes the initialized directory');
  for (const missing of ['RUNNER_TEMP', 'GITHUB_ENV']) {
    const failedEnv = { ...env }; delete failedEnv[missing];
    const failed = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', init.run], { env: failedEnv, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(failed.status, 0, `missing ${missing} fails explicitly`);
  }
});
