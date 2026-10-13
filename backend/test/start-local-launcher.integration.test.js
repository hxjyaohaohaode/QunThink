// Synthetic isolated fixtures only: never execute repository .env, runtime
// helpers, Docker, browsers, provider calls or an existing user database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { localConfiguration } from '../../scripts/start-local.mjs';

const rootSource = fileURLToPath(new URL('../../', import.meta.url));
const launcher = new URL('../../scripts/start-local.mjs', import.meta.url).href;
const clean = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('actual dotenv preload cannot override validated normal launcher binding or session auth', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'backend/data'));
  await fs.writeFile(path.join(f.root, 'backend/data/auth.json'), JSON.stringify({ users: [], sessions: [] }));
  await fs.writeFile(path.join(f.root, 'backend/.env'), 'HOST=0.0.0.0\nPORT=39999\nAUTH_MODE=none\nNODE_ENV=production\nDOTENV_CONFIG_OVERRIDE=true\n');
  const config = localConfiguration({ root: f.root, args: [], env: {
    ...clean, ENCRYPTION_KEY: randomBytes(32).toString('base64'), DOTENV_CONFIG_OVERRIDE: 'true'
  } });
  config.backendEnv.PORT = '3002';
  assert.equal(config.backendEnv.DOTENV_CONFIG_OVERRIDE, undefined);
  const require = createRequire(path.join(f.root, 'backend/package.json'));
  const code = `import ${JSON.stringify(require.resolve('dotenv/config'))};
    console.log(JSON.stringify(Object.fromEntries(['HOST','PORT','AUTH_MODE','NODE_ENV'].map(key => [key,process.env[key]]))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(f.root, 'backend'), env: config.backendEnv, encoding: 'utf8'
  });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { HOST: '127.0.0.1', PORT: '3002', AUTH_MODE: 'session', NODE_ENV: 'development' });
});
async function fixture(t, { key = true, real = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-local-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['backend', 'frontend/node_modules/vite/bin', '.local-runtime/development']) await fs.mkdir(path.join(root, directory), { recursive: true });
  await fs.writeFile(path.join(root, 'backend/package.json'), '{"type":"module"}');
  await fs.symlink(path.join(rootSource, 'backend/node_modules'), path.join(root, 'backend/node_modules'), 'junction');
  if (key) await fs.writeFile(path.join(root, '.local-runtime/development/backend.env'), `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  if (key && !real) {
    await fs.mkdir(path.join(root, '.local-runtime/development/data'));
    await fs.writeFile(path.join(root, '.local-runtime/development/data/auth.json'), JSON.stringify({ users: [], sessions: [] }));
  }
  if (real) {
    for (const dir of ['src', 'scripts']) await fs.symlink(path.join(rootSource, 'backend', dir), path.join(root, 'backend', dir), 'junction');
  } else {
    await fs.mkdir(path.join(root, 'backend/src')); await fs.mkdir(path.join(root, 'backend/scripts'));
    await fs.writeFile(path.join(root, 'backend/src/index.js'), `import http from 'node:http';
      const server = http.createServer((req,res) => {res.statusCode=process.env.FIXTURE_NOT_READY ? 503 : 200;res.end('synthetic');});
      server.listen(process.env.PORT,process.env.HOST);
      process.on('SIGTERM',()=>{ if (!process.env.FIXTURE_IGNORE_TERM) server.close(()=>process.exit(0)); });`);
    await fs.writeFile(path.join(root, 'backend/scripts/account-store-maintenance.mjs'), `console.log('{"initialized":true,"confirmedByRead":true}');`);
  }
  await fs.writeFile(path.join(root, 'frontend/node_modules/vite/bin/vite.js'), `const http=require('node:http');
    const port=process.argv[process.argv.indexOf('--port')+1];
    const server=http.createServer((req,res)=>res.end('synthetic frontend'));server.listen(port,'127.0.0.1');
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  return { root, data: path.join(root, '.local-runtime/development/data') };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function launch(t, f, args = ['--isolated'], { env = clean, healthTimeoutMs = 4000, stopTimeoutMs = 500 } = {}) {
  const backendPort = await freePort(), frontendPort = await freePort();
  const code = `import {runLocal} from ${JSON.stringify(launcher)}; process.exitCode=await runLocal(${JSON.stringify({ root: f.root, args, backendPort, frontendPort, healthTimeoutMs, stopTimeoutMs })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', exited = false;
  child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }); });
  t.after(async () => { if (!exited) { child.kill('SIGTERM'); await done; } });
  async function ready() {
    const deadline = Date.now() + healthTimeoutMs + 3000;
    while (!exited && Date.now() < deadline) { if (output.includes('群想已就绪')) return; await sleep(25); }
    throw new Error(`Synthetic launcher did not become ready: ${output}`);
  }
  async function finish(signal = 'SIGTERM') { if (!exited) child.kill(signal); return done; }
  async function receipt() { return JSON.parse(await fs.readFile(path.join(f.root, '.local-runtime/processes.json'), 'utf8')); }
  return { child, done, ready, finish, receipt, backendPort, frontendPort, output: () => output };
}
async function assertStopped(run) {
  const receipt = await run.receipt(); assert.equal(receipt.status, 'stopped');
  for (const child of receipt.children) assert.ok(child.exitCode !== null || child.signal !== null);
  for (const port of [run.backendPort, run.frontendPort]) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(300) }));
  }
}

test('existing hardlinked runtime receipt is rejected without altering unrelated source bytes', async t => {
  const f = await fixture(t);
  const original = path.join(f.root, 'synthetic-unrelated-ledger.json');
  const bytes = Buffer.from('{"synthetic":"must remain unchanged"}\n');
  await fs.writeFile(original, bytes);
  await fs.link(original, path.join(f.root, '.local-runtime/processes.json'));
  const run = await launch(t, f);
  assert.equal((await run.done).code, 1);
  assert.match(run.output(), /无外部链接/);
  assert.deepEqual(await fs.readFile(original), bytes);
  assert.deepEqual(await fs.readFile(path.join(f.root, '.local-runtime/processes.json')), bytes);
});

test('isolated config ignores inherited application secrets, dotenv, storage paths and production goals', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'backend/.env'), 'DATA_DIR=/synthetic-original\nENCRYPTION_KEY=DO_NOT_INHERIT\nMEMORY_DELETION_DIR=/synthetic-original-ledger\n');
  const contaminated = { ...clean, DATA_DIR: '/external-data', AUTH_DB_PATH: '/external-auth', ENCRYPTION_KEY: 'DO_NOT_INHERIT',
    MEMORY_DELETION_DIR: '/external-ledger', MEMORY_DELETION_DATABASE_URL: 'postgres://external.invalid/ledger',
    MEMORY_DELETION_DATABASE_CA_FILE: '/external-ca', MEMORY_DELETION_INSTALLATION_ID: 'external', MEMORY_DELETION_MODE: 'legacy', MEMORY_DELETION_CONNECTION_MODE: 'transaction',
    SUPABASE_DB_URL: 'postgres://external.invalid/db', MONGODB_URI: 'mongodb://external.invalid', ALIYUN_ACCESS_KEY_ID: 'synthetic',
    QUNTHINK_FOUNDATIONS_RUNTIME_URL: 'postgres://external.invalid/goals', QUNTHINK_GOAL_BRIEF_SCHEDULER: '1',
    DOTENV_CONFIG_PATH: '/external.env', DOTENV_CONFIG_OVERRIDE: 'true', NODE_OPTIONS: '--require /external.js', VITE_SECRET: 'synthetic' };
  const c = localConfiguration({ root: f.root, args: ['--isolated'], env: contaminated });
  assert.equal(c.backendEnv.DATA_DIR, f.data); assert.equal(c.backendEnv.AUTH_DB_PATH, path.join(f.data, 'auth.json'));
  assert.equal(c.backendEnv.MEMORY_DELETION_DIR, path.join(f.data, 'memory-deletions'));
  for (const key of ['SUPABASE_DB_URL', 'MONGODB_URI', 'MEMORY_DELETION_DATABASE_URL', 'QUNTHINK_FOUNDATIONS_RUNTIME_URL']) assert.equal(c.backendEnv[key], '');
  for (const key of ['MEMORY_DELETION_DATABASE_CA_FILE', 'MEMORY_DELETION_INSTALLATION_ID', 'MEMORY_DELETION_MODE', 'MEMORY_DELETION_CONNECTION_MODE', 'ALIYUN_ACCESS_KEY_ID', 'NODE_OPTIONS']) assert.equal(c.backendEnv[key], undefined);
  assert.equal(c.backendEnv.HOST, '127.0.0.1'); assert.equal(c.backendEnv.QUNTHINK_GOAL_BRIEF_SCHEDULER, '0');
  assert.equal(c.backendEnv.DOTENV_CONFIG_PATH, path.join(f.root, '.local-runtime/development/backend.env'));
  assert.equal(c.backendEnv.DOTENV_CONFIG_OVERRIDE, undefined); assert.notEqual(c.backendEnv.ENCRYPTION_KEY, contaminated.ENCRYPTION_KEY);
  assert.equal(c.frontendEnv.ENCRYPTION_KEY, undefined); assert.equal(c.frontendEnv.VITE_SECRET, undefined);
  const opted = localConfiguration({ root: f.root, args: ['--isolated'], env: { ...contaminated, QUNTHINK_LOCAL_GOALS_URL: 'postgresql://127.0.0.1/synthetic-goals' } });
  assert.equal(opted.backendEnv.QUNTHINK_FOUNDATIONS_RUNTIME_URL, 'postgresql://127.0.0.1/synthetic-goals');
});

test('new and existing installations missing keys fail closed without creating data or keys', async t => {
  const f = await fixture(t, { key: false });
  for (const args of [[], ['--isolated'], ['--isolated', '--init-empty']]) assert.throws(() => localConfiguration({ root: f.root, args, env: { ...clean, ENCRYPTION_KEY: '' } }), /密钥/);
  assert.equal(await fs.stat(f.data).catch(() => null), null);
  await fs.mkdir(f.data); await fs.writeFile(path.join(f.data, 'auth.json'), 'synthetic old account');
  assert.throws(() => localConfiguration({ root: f.root, args: ['--isolated'], env: clean }), /密钥/);
  assert.deepEqual(await fs.readdir(f.data), ['auth.json']); assert.equal(await fs.readFile(path.join(f.data, 'auth.json'), 'utf8'), 'synthetic old account');
});

test('invalid args, unknown isolated config and linked data fail before launching or initializing', async t => {
  const f = await fixture(t);
  for (const args of [['--init-empty'], ['--unknown'], ['--isolated', '--isolated'], ['--help', '--init-empty']]) assert.throws(() => localConfiguration({ root: f.root, args, env: clean }), /用法/);
  await fs.appendFile(path.join(f.root, '.local-runtime/development/backend.env'), 'AUTH_DB_PATH=/synthetic-external\n');
  assert.throws(() => localConfiguration({ root: f.root, args: ['--isolated'], env: clean }), /仅允许/);
  const linked = await fixture(t); await fs.mkdir(linked.data, { recursive: true }); const external = path.join(linked.root, 'original-ledger'); await fs.mkdir(external);
  await fs.symlink(external, path.join(linked.data, 'memory-deletions'), 'junction');
  assert.throws(() => localConfiguration({ root: linked.root, args: ['--isolated'], env: clean }), /外部链接/);
  assert.deepEqual(await fs.readdir(external), []);
});

test('real explicit init, cold start and restart preserve key, default account and generation; both children stop', { timeout: 25000 }, async t => {
  const f = await fixture(t, { real: true });
  const config = await fs.readFile(path.join(f.root, '.local-runtime/development/backend.env'));
  const original = path.join(f.root, 'synthetic-original'); await fs.mkdir(original);
  await fs.writeFile(path.join(original, 'auth.json'), 'unchanged original fixture');
  await fs.writeFile(path.join(f.root, 'backend/.env'), `DATA_DIR=${original}\nAUTH_DB_PATH=${original}/auth.json\nMEMORY_DELETION_DIR=${original}\n`);
  const inherited = { ...clean, DATA_DIR: original, AUTH_DB_PATH: path.join(original, 'auth.json'), MEMORY_DELETION_DIR: original,
    MEMORY_DELETION_DATABASE_URL: 'postgresql://127.0.0.1:9/not-used', MEMORY_DELETION_INSTALLATION_ID: 'not-used',
    SUPABASE_DB_URL: 'postgresql://127.0.0.1:9/not-used', MONGODB_URI: 'mongodb://127.0.0.1:9/not-used',
    QUNTHINK_FOUNDATIONS_RUNTIME_URL: 'postgresql://127.0.0.1:9/not-used', ENCRYPTION_KEY: 'must-not-inherit' };
  let before;
  for (const args of [['--isolated', '--init-empty'], ['--isolated']]) {
    const run = await launch(t, f, args, { env: inherited, stopTimeoutMs: 1500 }); await run.ready();
    assert.equal((await fetch(`http://127.0.0.1:${run.backendPort}/api/health`)).status, 200);
    const separateLoopback = net.createServer();
    await new Promise((resolve, reject) => separateLoopback.once('error', reject).listen(run.backendPort, '127.0.0.2', resolve));
    await new Promise(resolve => separateLoopback.close(resolve));
    const snapshot = await fs.readFile(path.join(f.data, 'users/db_default.json'), 'utf8');
    if (before) assert.equal(snapshot, before); else before = snapshot;
    assert.equal(JSON.parse(snapshot).message_order.groups.length, 3);
    assert.equal((await run.finish()).code, 0); await assertStopped(run);
    assert.equal(run.output().includes(config.toString().trim().split('=')[1]), false);
  }
  assert.deepEqual(await fs.readdir(original), ['auth.json']);
  assert.equal(await fs.readFile(path.join(original, 'auth.json'), 'utf8'), 'unchanged original fixture');
  assert.deepEqual(await fs.readFile(path.join(f.root, '.local-runtime/development/backend.env')), config);
  assert.equal(await fs.stat(path.join(f.data, '.encryption_key')).catch(() => null), null);
  const repeat = await launch(t, f, ['--isolated', '--init-empty']); assert.notEqual((await repeat.done).code, 0);
  assert.match(repeat.output(), /INSTALLATION_NOT_EMPTY/); assert.deepEqual((await repeat.receipt()).children.map(child => child.label), ['init-empty']);
  assert.equal(await fs.readFile(path.join(f.data, 'users/db_default.json'), 'utf8'), before); await assertStopped(repeat);
});

for (const state of ['missing', 'corrupt']) test(`ordinary isolated startup never initializes or repairs a ${state} account`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { real: true });
  await fs.mkdir(f.data, { recursive: true });
  await fs.writeFile(path.join(f.data, 'auth.json'), JSON.stringify({ users: [], sessions: [] }));
  if (state === 'corrupt') { await fs.mkdir(path.join(f.data, 'users'), { recursive: true }); await fs.writeFile(path.join(f.data, 'users/db_default.json'), '{synthetic malformed'); }
  const run = await launch(t, f, ['--isolated'], { healthTimeoutMs: 1500 }); assert.notEqual((await run.done).code, 0);
  assert.equal(await fs.stat(path.join(f.data, '.encryption_key')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(f.data, 'auth.json'), 'utf8'), JSON.stringify({ users: [], sessions: [] }));
  if (state === 'corrupt') assert.equal(await fs.readFile(path.join(f.data, 'users/db_default.json'), 'utf8'), '{synthetic malformed');
  else assert.equal(await fs.stat(path.join(f.data, 'users/db_default.json')).catch(() => null), null);
  await assertStopped(run);
});

test('unexpected backend exit stops frontend and exits nonzero', { timeout: 10000 }, async t => {
  const f = await fixture(t); const run = await launch(t, f); await run.ready();
  const backend = (await run.receipt()).children.find(child => child.label === 'backend'); process.kill(backend.pid, 'SIGKILL');
  assert.notEqual((await run.done).code, 0); await assertStopped(run);
});

test('readiness timeout kills a SIGTERM-resistant child and never starts frontend', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const backend = path.join(f.root, 'backend/src/index.js');
  await fs.writeFile(backend, `import http from 'node:http';http.createServer((req,res)=>{res.statusCode=503;res.end();}).listen(process.env.PORT,process.env.HOST);process.on('SIGTERM',()=>{});`);
  const run = await launch(t, f, ['--isolated'], { healthTimeoutMs: 250, stopTimeoutMs: 100 });
  assert.notEqual((await run.done).code, 0); await assertStopped(run);
  const receipt = await run.receipt(); assert.deepEqual(receipt.children.map(child => child.label), ['backend']);
  assert.equal(receipt.children[0].signal, 'SIGKILL');
});

test('initialization timeout stops its child and never starts services', { timeout: 10000 }, async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'backend/scripts/account-store-maintenance.mjs'), 'setInterval(()=>{},1000);process.on("SIGTERM",()=>{});');
  const run = await launch(t, f, ['--isolated', '--init-empty'], { healthTimeoutMs: 250, stopTimeoutMs: 100 });
  assert.notEqual((await run.done).code, 0); await assertStopped(run);
  assert.deepEqual((await run.receipt()).children.map(child => child.label), ['init-empty']);
});


test('unexpected frontend exit stops backend and records completed shutdown', { timeout: 10000 }, async t => {
  const f = await fixture(t); const run = await launch(t, f); await run.ready();
  const frontend = (await run.receipt()).children.find(child => child.label === 'frontend'); process.kill(frontend.pid, 'SIGKILL');
  assert.notEqual((await run.done).code, 0); await assertStopped(run);
});

test('frontend startup failure stops an already healthy backend', { timeout: 10000 }, async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'frontend/node_modules/vite/bin/vite.js'), 'process.exit(23);');
  const run = await launch(t, f); assert.equal((await run.done).code, 23); await assertStopped(run);
  assert.deepEqual((await run.receipt()).children.map(child => child.label), ['backend', 'frontend']);
});

test('Ctrl+C during readiness stops startup without launching frontend', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'backend/src/index.js'), `import http from 'node:http';http.createServer((req,res)=>{res.statusCode=503;res.end();}).listen(process.env.PORT,process.env.HOST);`);
  const run = await launch(t, f);
  while (!(await run.receipt().catch(() => null))?.children.length) await sleep(20);
  assert.equal((await run.finish('SIGINT')).code, 0); await assertStopped(run);
  assert.deepEqual((await run.receipt()).children.map(child => child.label), ['backend']);
});


for (const state of ['missing', 'corrupt']) test(`normal launcher rejects ${state} auth without creating or repairing it`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { real: true });
  const installed = await launch(t, f, ['--isolated', '--init-empty']); await installed.ready(); await installed.finish();
  const auth = path.join(f.data, 'auth.json');
  const original = await fs.readFile(auth, 'utf8');
  assert.deepEqual(JSON.parse(original).users, []); assert.deepEqual(JSON.parse(original).sessions, []);
  if (state === 'missing') await fs.unlink(auth);
  else await fs.writeFile(auth, original + '{}');
  const before = await fs.readdir(f.data);
  const run = await launch(t, f);
  const result = await Promise.race([run.done, run.ready().then(() => ({ code: 0 })).catch(() => run.done)]);
  if (result.code === 0) await run.finish();
  assert.notEqual(result.code, 0, 'normal startup must not accept missing or corrupt authentication state');
  if (state === 'missing') assert.equal(await fs.stat(auth).catch(() => null), null);
  else assert.equal(await fs.readFile(auth, 'utf8'), original + '{}');
  assert.deepEqual(await fs.readdir(f.data), before, 'no repair backups or replacement files');
});

test('valid empty authentication arrays are accepted; null, array and malformed record shapes are refused intact', async t => {
  const f = await fixture(t), auth = path.join(f.data, 'auth.json');
  assert.doesNotThrow(() => localConfiguration({ root: f.root, args: ['--isolated'], env: clean }));
  for (const value of [null, [], {}, { users: {}, sessions: [] }, { users: [], sessions: null }]) {
    const raw = JSON.stringify(value); await fs.writeFile(auth, raw);
    assert.throws(() => localConfiguration({ root: f.root, args: ['--isolated'], env: clean }), /认证库/);
    assert.equal(await fs.readFile(auth, 'utf8'), raw);
  }
});
