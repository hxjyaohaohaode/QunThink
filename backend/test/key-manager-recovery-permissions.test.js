import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../src/utils/keyManager.js', import.meta.url).href;
const recoveryCode = 'ENCRYPTION_KEY_RECOVERY_REQUIRED';
const timestamp = '2026-10-12T10:20:30.000Z';
const secret = 'SYNTHETIC_PRIVATE_VALUE_DO_NOT_LOG';
const key = version => Buffer.alloc(32, version).toString('base64');
const metadata = (version = 3) => ({ version, createdAt: timestamp,
  ...(version > 1 ? { previousKeyVersion: version - 1, rotatedAt: timestamp } : {}) });

function fixture(t, version = 3, history = [1, 2]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qunthink-recovery-'));
  const dataDir = path.join(root, secret);
  fs.mkdirSync(dataDir, { mode: 0o700 });
  t.after(() => {
    // Tests deliberately remove traversal rights; restore them before cleanup.
    function unlock(directory) {
      try { fs.chmodSync(directory, 0o700); } catch {}
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) unlock(path.join(directory, entry.name));
    }
    unlock(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = { root, dataDir, keyPath: path.join(dataDir, '.encryption_key'),
    metaPath: path.join(dataDir, '.encryption_key.meta'), historyDir: path.join(dataDir, '.key_history') };
  if (version !== null) {
    fs.writeFileSync(f.keyPath, key(version), { mode: 0o600 });
    fs.writeFileSync(f.metaPath, JSON.stringify(metadata(version)), { mode: 0o600 });
    fs.mkdirSync(f.historyDir, { mode: 0o700 });
    for (const previous of history) fs.writeFileSync(path.join(f.historyDir, `${previous}.key`), key(previous), { mode: 0o600 });
  }
  return f;
}

function snapshot(directory) {
  const result = {};
  function visit(name) {
    const absolute = path.join(directory, name);
    const stat = fs.lstatSync(absolute);
    result[name] = { mode: stat.mode & 0o777,
      content: stat.isSymbolicLink() ? fs.readlinkSync(absolute) : stat.isFile() ? fs.readFileSync(absolute).toString('base64') : null };
    if (stat.isDirectory()) for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(name, entry));
  }
  visit('.');
  return result;
}

function run(f, { operation = 'await m.initializeKeyManager()', before = '', after = '', env = {} } = {}) {
  const script = `import fs from 'node:fs';
    ${before}
    const m = await import(${JSON.stringify(moduleUrl)});
    try {
      ${operation};
      ${after}
      console.log('RESULT:' + JSON.stringify({ version: m.getKeyMetadata().version,
        available: Array.from({length: 12}, (_, i) => i + 1).filter(v => m.getKeyByVersion(v) !== null) }));
    } catch (error) {
      console.error('RESULT:' + JSON.stringify({ code: error.code, message: error.message,
        published: [1,2,3,4,5,6,7,8,9].some(v => m.getKeyByVersion(v) !== null) }));
      process.exitCode = 23;
    }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', DATA_DIR: f.dataDir, ...env },
    encoding: 'utf8', timeout: 15000
  });
}

function resultJson(result) {
  const line = (result.stdout + result.stderr).split('\n').find(line => line.startsWith('RESULT:'));
  assert.ok(line, result.stderr || result.error?.message);
  return JSON.parse(line.slice(7));
}

function assertDenied(result, permissionCode) {
  assert.equal(result.status, 23, result.stderr);
  const output = resultJson(result);
  assert.equal(output.code, recoveryCode);
  assert.equal(output.published, false, 'failed recovery must not publish current or historical keys');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  for (const version of [1, 2, 3]) assert.equal((result.stdout + result.stderr).includes(key(version)), false);
  if (permissionCode) {
    assert.match(output.message, new RegExp(permissionCode));
    assert.match(output.message, /UID=\d+ GID=\d+/);
  }
}

function deniedUnchanged(f, options) {
  const before = snapshot(f.root);
  const result = run(f, options);
  assertDenied(result);
  assert.deepEqual(snapshot(f.root), before, 'failed recovery must leave every fixture byte and permission untouched');
  return result;
}

for (const operation of ['await m.initializeKeyManager()', 'm.getKey()', 'await m.getKeyAsync()',
  'm.getKeyMetadata()', 'await m.getKeyMetadataAsync()', 'await m.loadOrGenerateEncryptionKey()']) {
  test(`${operation}: valid existing volume is read-only and versioned`, t => {
    const f = fixture(t); const before = snapshot(f.root);
    const result = run(f, { operation });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(resultJson(result), { version: 3, available: [1, 2, 3] });
    assert.deepEqual(snapshot(f.root), before);
  });
  test(`${operation}: damaged metadata fails closed before publishing`, t => {
    const f = fixture(t); fs.writeFileSync(f.metaPath, `{"${secret}":`);
    deniedUnchanged(f, { operation });
  });
}

test('fresh empty directory creates a 0600 key and reuses it without writing on restart', t => {
  const f = fixture(t, null); const result = run(f);
  t.diagnostic(`Host UID=${process.getuid?.() ?? 'unknown'} GID=${process.getgid?.() ?? 'unknown'}; Docker is not exercised by this test.`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(resultJson(result).version, 1);
  assert.equal(fs.readFileSync(f.keyPath, 'utf8').length, 44);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.keyPath).mode & 0o777, 0o600);
  const before = snapshot(f.root);
  assert.equal(run(f).status, 0);
  assert.deepEqual(snapshot(f.root), before);
});

test('absent fresh data directory is created without existing volume repair', t => {
  const f = fixture(t, null); fs.rmdirSync(f.dataDir);
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(f.keyPath).isFile(), true);
});

test('legacy current key without metadata or history remains readable and unchanged', t => {
  const f = fixture(t, 1, []); fs.unlinkSync(f.metaPath); fs.rmdirSync(f.historyDir);
  const before = snapshot(f.root); const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(resultJson(result), { version: 1, available: [1] });
  assert.deepEqual(snapshot(f.root), before);
});

test('pruned version 9 with only versions 4 through 8 is valid', t => {
  const f = fixture(t, 9, [4, 5, 6, 7, 8]); const before = snapshot(f.root);
  const result = run(f); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(resultJson(result), { version: 9, available: [4, 5, 6, 7, 8, 9] });
  assert.deepEqual(snapshot(f.root), before);
});

for (const [label, value] of [
  ['empty', ''], ['short', Buffer.alloc(31).toString('base64')], ['long', Buffer.alloc(33).toString('base64')],
  ['garbage', secret], ['suffix junk', key(2) + '!'], ['missing padding', key(2).slice(0, -1)],
  ['extra padding', key(2) + '='], ['internal whitespace', key(2).slice(0, 10) + ' ' + key(2).slice(10)],
  ['url alphabet', Buffer.alloc(32, 255).toString('base64').replaceAll('/', '_')],
  ['nonzero pad bits', key(2).slice(0, -2) + 'J=']
]) {
  test(`history rejects ${label} base64 without modifying the volume`, t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.historyDir, '2.key'), value);
    deniedUnchanged(f);
  });
}

for (const filename of ['0.key', '-1.key', '+1.key', '01.key', '1.0.key', '1e2.key', '1junk.key',
  '1.key.extra', 'key.txt', '9007199254740992.key', `${secret}.key`]) {
  test(`history rejects noncanonical filename ${filename}`, t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.historyDir, filename), key(1)); deniedUnchanged(f);
  });
}

const invalidMetadata = [
  ['null', null], ['array', []], ['string', secret], ['number', 3], ['boolean', true], ['empty object', {}],
  ...[0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1].map(version => [`invalid version ${version}`, { ...metadata(), version }]),
  ['unknown field', { ...metadata(), unexpected: secret }],
  ['prototype field', JSON.parse(`{"version":3,"createdAt":"${timestamp}","previousKeyVersion":2,"__proto__":{}}`)],
  ['missing creation date', { version: 3, previousKeyVersion: 2 }],
  ...[null, 123, 'invalid', '2026-02-30T10:20:30.000Z', '2026-10-12'].map(createdAt => [`invalid creation date ${createdAt}`, { ...metadata(), createdAt }]),
  ['invalid rotation date', { ...metadata(), rotatedAt: secret }],
  ['null rotation date', { ...metadata(), rotatedAt: null }],
  ['missing previous version', { version: 3, createdAt: timestamp }],
  ...[0, -1, 1, 3, 4, '2', 2.5, null].map(previousKeyVersion => [`invalid previous version ${previousKeyVersion}`, { ...metadata(), previousKeyVersion }]),
  ['first version with previous', { ...metadata(1), previousKeyVersion: 1 }],
  ['first version with rotation timestamp', { ...metadata(1), rotatedAt: timestamp }]
];
for (const [label, value] of invalidMetadata) {
  test(`metadata rejects ${label} without resetting to version 1`, t => {
    const f = fixture(t); fs.writeFileSync(f.metaPath, JSON.stringify(value)); deniedUnchanged(f);
  });
}

for (const change of ['missing metadata', 'missing previous history', 'history equals current', 'history exceeds current', 'missing current key']) {
  test(`${change} fails closed without creating a replacement`, t => {
    const f = fixture(t);
    if (change === 'missing metadata') fs.unlinkSync(f.metaPath);
    if (change === 'missing previous history') fs.unlinkSync(path.join(f.historyDir, '2.key'));
    if (change === 'history equals current') fs.writeFileSync(path.join(f.historyDir, '3.key'), key(3));
    if (change === 'history exceeds current') fs.writeFileSync(path.join(f.historyDir, '4.key'), key(4));
    if (change === 'missing current key') fs.unlinkSync(f.keyPath);
    deniedUnchanged(f);
  });
}

for (const resource of ['keyPath', 'metaPath', 'historyDir', 'historyKey', 'dataDir']) {
  for (const kind of ['symlink', 'wrong type']) {
    test(`${resource} rejects ${kind} without changing the target`, t => {
      const f = fixture(t);
      const filePath = resource === 'historyKey' ? path.join(f.historyDir, '2.key') : f[resource];
      const wasDirectory = fs.lstatSync(filePath).isDirectory();
      const target = path.join(f.root, `target-${resource}`);
      fs.renameSync(filePath, target);
      if (kind === 'symlink') fs.symlinkSync(target, filePath, wasDirectory ? 'dir' : 'file');
      else if (wasDirectory) fs.writeFileSync(filePath, secret);
      else fs.mkdirSync(filePath);
      deniedUnchanged(f);
    });
  }
}

for (const resource of ['keyPath', 'metaPath', 'historyDir', 'historyKey', 'dataDir']) {
  test(`${resource} real POSIX access denial reports UID/GID without changing stored bytes`, {
    skip: process.platform === 'win32' || process.getuid?.() === 0
  }, t => {
    const f = fixture(t); const target = resource === 'historyKey' ? path.join(f.historyDir, '2.key') : f[resource];
    const before = snapshot(f.root); const oldMode = fs.statSync(target).mode & 0o777;
    fs.chmodSync(target, 0);
    let result;
    try { result = run(f); } finally { fs.chmodSync(target, oldMode); }
    assertDenied(result, 'EACCES');
    assert.deepEqual(snapshot(f.root), before);
  });
}

for (const code of ['EACCES', 'EPERM', 'EROFS']) {
  for (const method of ['lstatSync', 'readdirSync', 'openSync', 'readFileSync']) {
    test(`${method} ${code} is sanitized and never mistaken for absent history`, t => {
      const f = fixture(t);
      const before = `const original = fs.${method}; fs.${method} = function (...args) {
        if (${method === 'readFileSync' ? "typeof args[0] === 'number'" : "String(args[0]).includes('.key_history')"})
          throw Object.assign(new Error(${JSON.stringify(secret)}), { code: ${JSON.stringify(code)}, path: ${JSON.stringify(secret)} });
        return original.apply(this, args);
      };`;
      const result = deniedUnchanged(f, { before }); assertDenied(result, code);
    });
  }
}

for (const code of ['EACCES', 'EPERM', 'EROFS']) {
  test(`fresh creation ${code} remains fail-closed with safe UID/GID advice`, t => {
    const f = fixture(t, null);
    const before = `const original = fs.openSync; fs.openSync = function (target, ...args) {
      if (String(target).includes('.encryption_key.initializing-'))
        throw Object.assign(new Error(${JSON.stringify(secret)}), { code: ${JSON.stringify(code)} });
      return original.call(this, target, ...args);
    };`;
    const result = deniedUnchanged(f, { before }); assertDenied(result, code);
    assert.equal(fs.existsSync(f.keyPath), false);
  });
}

test('unexpected history I/O errors fail closed without exposing provider error messages', t => {
  const f = fixture(t);
  const before = `const original = fs.readdirSync; fs.readdirSync = function(target, ...args) {
    if (String(target).includes('.key_history')) throw Object.assign(new Error(${JSON.stringify(secret)}), {code:'EIO'});
    return original.call(this, target, ...args);
  };`;
  deniedUnchanged(f, { before });
});

test('history disappearance after listing is a recovery error, not a fresh install', t => {
  const f = fixture(t);
  const before = `const original = fs.lstatSync; fs.lstatSync = function(target, ...args) {
    if (String(target).endsWith('/2.key')) throw Object.assign(new Error(${JSON.stringify(secret)}), {code:'ENOENT'});
    return original.call(this, target, ...args);
  };`;
  deniedUnchanged(f, { before });
});

test('a file swapped between lstat and open is rejected before state publication', t => {
  const f = fixture(t);
  const before = `const original = fs.fstatSync; fs.fstatSync = function(...args) {
    const stat = original.apply(this, args); stat.ino += 1; return stat;
  };`;
  deniedUnchanged(f, { before });
});

test('configured environment key cannot bypass damaged history or metadata', t => {
  const f = fixture(t); fs.writeFileSync(f.metaPath, secret);
  deniedUnchanged(f, { env: { NODE_ENV: 'production', ENCRYPTION_KEY: key(3) } });
});

test('valid environment key with no recovery files does not write a local key', t => {
  const f = fixture(t, null); const before = snapshot(f.root);
  const result = run(f, { env: { NODE_ENV: 'production', ENCRYPTION_KEY: key(3) } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.root), before);
});

test('successful existing-volume recovery still decrypts a synthetic historical payload', t => {
  const f = fixture(t); const before = snapshot(f.root);
  const after = `const crypto = await import('node:crypto'); const iv = Buffer.alloc(12, 9);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), iv);
    const encrypted = Buffer.concat([cipher.update('synthetic old conversation'), cipher.final()]);
    const decipher = crypto.createDecipheriv('aes-256-gcm', m.getKeyByVersion(1), iv);
    decipher.setAuthTag(cipher.getAuthTag());
    if (Buffer.concat([decipher.update(encrypted), decipher.final()]).toString() !== 'synthetic old conversation') throw Error('fixture decryption failed');`;
  const result = run(f, { after }); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.root), before);
});

test('rotation retains existing version increment, history pruning, and restart recovery', t => {
  const f = fixture(t, 9, [4, 5, 6, 7, 8]);
  const result = run(f, { operation: 'await m.initializeKeyManager(); await m.generateNewKey()' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(resultJson(result), { version: 10, available: [5, 6, 7, 8, 9, 10] });
  assert.deepEqual(fs.readdirSync(f.historyDir).sort(), ['5.key', '6.key', '7.key', '8.key', '9.key']);
  assert.equal(fs.readFileSync(path.join(f.historyDir, '9.key'), 'utf8'), key(9));
  const before = snapshot(f.root); const restarted = run(f);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(resultJson(restarted), resultJson(result));
  assert.deepEqual(snapshot(f.root), before);
});

test('backend image prepares only its new directories and runs as node', () => {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /mkdir -p \/app\/data \/app\/uploads/);
  assert.match(dockerfile, /chown node:node \/app\/data \/app\/uploads/);
  assert.match(dockerfile, /chmod 0700 \/app\/data \/app\/uploads/);
  assert.match(dockerfile, /^USER node$/m);
  assert.doesNotMatch(dockerfile, /(?:chown|chmod)\s+[^\n]*-R/);
  assert.ok(dockerfile.indexOf('USER node') > dockerfile.indexOf('chmod 0700'));
});

for (const code of ['EACCES', 'EPERM', 'EROFS']) {
  test(`new-key chmod ${code} fails safely and preserves permission diagnostics`, t => {
    const f = fixture(t, null);
    const before = `const original = fs.chmodSync; fs.chmodSync = function(target, ...args) {
      if (String(target).includes('.encryption_key.initializing-'))
        throw Object.assign(new Error(${JSON.stringify(secret)}), {code: ${JSON.stringify(code)}});
      return original.call(this, target, ...args);
    };`;
    const result = deniedUnchanged(f, { before }); assertDenied(result, code);
  });
}

test('fresh non-writable directory fails without generating or leaking a key', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
}, t => {
  const f = fixture(t, null); const before = snapshot(f.root);
  fs.chmodSync(f.dataDir, 0o500);
  let result;
  try { result = run(f); } finally { fs.chmodSync(f.dataDir, 0o700); }
  assertDenied(result, 'EACCES'); assert.deepEqual(snapshot(f.root), before);
});

test('readable existing volume can recover without write access or permission repair', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
}, t => {
  const f = fixture(t);
  fs.chmodSync(f.keyPath, 0o400); fs.chmodSync(f.metaPath, 0o400);
  fs.chmodSync(f.historyDir, 0o500); fs.chmodSync(f.dataDir, 0o500);
  const before = snapshot(f.root); const result = run(f);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(snapshot(f.root), before);
});

test('empty history without metadata remains a valid unrotated legacy key', t => {
  const f = fixture(t, 1, []); fs.unlinkSync(f.metaPath);
  const before = snapshot(f.root); const result = run(f);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(snapshot(f.root), before);
});

test('failed reinitialization never partially replaces an already validated snapshot', t => {
  const f = fixture(t);
  const operation = `await m.initializeKeyManager();
    const original = Buffer.from(m.getKey());
    fs.writeFileSync(process.env.DATA_DIR + '/.encryption_key', Buffer.alloc(32, 19).toString('base64'));
    fs.writeFileSync(process.env.DATA_DIR + '/.encryption_key.meta', '${secret}');
    let failure;
    try { await m.initializeKeyManager(); } catch (error) { failure = error; }
    if (failure?.code !== '${recoveryCode}' || !m.getKey().equals(original)
      || m.getKeyMetadata().version !== 3 || !m.getKeyByVersion(1)?.equals(Buffer.alloc(32, 1))) {
      throw Error('failed snapshot replaced validated state');
    }`;
  const result = run(f, { operation }); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(resultJson(result), { version: 3, available: [1, 2, 3] });
});
