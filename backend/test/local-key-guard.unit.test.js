import test from 'node:test';
import * as awaitCrypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadLocalEncryptionKey } from '../src/utils/localKeyGuard.js';
const keyManager = new URL('../src/utils/keyManager.js', import.meta.url).href;
const guard = new URL('../src/utils/localKeyGuard.js', import.meta.url).href;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qunthink-keyguard-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, keyPath: path.join(dataDir, '.encryption_key'), env: {} };
}
const denied = { code: 'ENCRYPTION_KEY_RECOVERY_REQUIRED' };
function childEnv(dataDir, extras = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', DATA_DIR: dataDir, ...extras };
}
for (const mode of ['sync', 'async']) {
  function run(options, extras = {}) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(keyManager)}); ${mode === 'sync' ? 'm.getKey()' : 'await m.loadOrGenerateEncryptionKey()'};`], { env: childEnv(options.dataDir, extras), encoding: 'utf8' });
  }
  test(`${mode}: only fresh empty local installation generates, reuses key`, t => {
    const f = fixture(t); fs.mkdirSync(path.join(f.dataDir, 'users'));
    assert.equal(run(f).status, 0);
    const before = fs.readFileSync(f.keyPath);
    assert.equal(run(f).status, 0); assert.deepEqual(fs.readFileSync(f.keyPath), before);
  });
  for (const old of ['ciphertext', 'auth.json', '.encryption_key.meta', 'backup.json']) {
    test(`${mode}: missing key with ${old} does not create replacement`, t => {
      const f = fixture(t); fs.writeFileSync(path.join(f.dataDir, old), 'synthetic old data');
      const result = run(f); assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ENCRYPTION_KEY_RECOVERY_REQUIRED/); assert.equal(fs.existsSync(f.keyPath), false);
    });
  }
  test(`${mode}: malformed key remains byte-for-byte intact`, t => {
    const f = fixture(t); fs.writeFileSync(f.keyPath, 'invalid-key');
    assert.notEqual(run(f).status, 0); assert.equal(fs.readFileSync(f.keyPath, 'utf8'), 'invalid-key');
  });
  for (const remote of ['SUPABASE_DB_URL', 'MONGODB_URI']) {
    test(`${mode}: remote configuration cannot generate local key`, t => {
      const f = fixture(t); assert.notEqual(run(f, { [remote]: 'synthetic-not-a-connection' }).status, 0);
      assert.equal(fs.existsSync(f.keyPath), false);
    });
  }
  test(`${mode}: production still requires configured key`, t => {
    const f = fixture(t); assert.notEqual(run(f, { NODE_ENV: 'production' }).status, 0);
    assert.equal(fs.existsSync(f.keyPath), false);
  });
}
test('unreadable key and unreadable directory fail closed without a write', t => {
  for (const method of ['lstatSync', 'readFileSync', 'readdirSync']) {
    const f = fixture(t);
    if (method === 'readFileSync') fs.writeFileSync(f.keyPath, Buffer.alloc(32, 7).toString('base64'));
    let writes = 0;
    const io = { ...fs, [method]() { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); }, writeFileSync() { writes++; } };
    assert.throws(() => loadLocalEncryptionKey({ ...f, io }), denied); assert.equal(writes, 0);
  }
});
test('symlink and external auth data do not permit regeneration', t => {
  const f = fixture(t); const target = path.join(f.dataDir, 'synthetic'); fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, f.keyPath); assert.throws(() => loadLocalEncryptionKey(f), denied);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
  const empty = fixture(t); assert.throws(() => loadLocalEncryptionKey({ ...empty, env: { AUTH_DB_PATH: target } }), denied);
  assert.throws(() => loadLocalEncryptionKey({ ...empty, env: { MEMORY_DELETION_DIR: f.dataDir } }), denied);
  assert.equal(fs.existsSync(empty.keyPath), false);
});
test('concurrent fresh processes share one complete key without overwriting', async t => {
  const f = fixture(t);
  const code = `import {loadLocalEncryptionKey} from ${JSON.stringify(guard)}; import {createHash} from 'node:crypto'; const k=loadLocalEncryptionKey({dataDir:process.env.DATA_DIR,keyPath:process.env.DATA_DIR+'/.encryption_key',env:{}}); console.log(createHash('sha256').update(k).digest('hex'));`;
  const outputs = await Promise.all(Array.from({ length: 16 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(f.dataDir) });
    let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.on('error', reject); child.on('close', status => status === 0 ? resolve(out.trim()) : reject(new Error(err)));
  })));
  assert.equal(new Set(outputs).size, 1, JSON.stringify(outputs)); assert.equal(Buffer.from(fs.readFileSync(f.keyPath, 'utf8'), 'base64').length, 32);
  assert.deepEqual(fs.readdirSync(f.dataDir), ['.encryption_key']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.keyPath).mode & 0o777, 0o600);
});
test('new key preserves permission preparation before publication, existing key untouched', t => {
  const f = fixture(t); let prepared = 0;
  const prepareNewFile = temporary => {
    prepared++; assert.equal(fs.existsSync(f.keyPath), false);
    assert.equal(Buffer.from(fs.readFileSync(temporary, 'utf8'), 'base64').length, 32);
  };
  const first = loadLocalEncryptionKey({ ...f, prepareNewFile });
  assert.deepEqual(loadLocalEncryptionKey({ ...f, prepareNewFile }), first);
  assert.equal(prepared, 1);
});
test('restoring original fixture key recovers ciphertext after missing-key refusal', t => {
  const f = fixture(t); const original = loadLocalEncryptionKey(f);
  const iv = Buffer.alloc(12, 1);
  const { createCipheriv, createDecipheriv } = awaitCrypto;
  const cipher = createCipheriv('aes-256-gcm', original, iv);
  const ciphertext = Buffer.concat([cipher.update('synthetic conversation', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(path.join(f.dataDir, 'message.json'), JSON.stringify({ encrypted: ciphertext.toString('base64') }));
  fs.unlinkSync(f.keyPath); assert.throws(() => loadLocalEncryptionKey(f), denied);
  assert.equal(fs.existsSync(f.keyPath), false);
  fs.writeFileSync(f.keyPath, original.toString('base64'), { mode: 0o600 });
  const decipher = createDecipheriv('aes-256-gcm', loadLocalEncryptionKey(f), iv); decipher.setAuthTag(tag);
  assert.equal(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'), 'synthetic conversation');
});
