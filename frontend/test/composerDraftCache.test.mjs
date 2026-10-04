import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserWindow = new Window({ url: 'http://localhost/' });
globalThis.window = browserWindow;
globalThis.localStorage = browserWindow.localStorage;

let pending = [];
globalThis.__cacheTest = {
  encrypt(payload) {
    return new Promise((resolveEncrypt) => pending.push({ payload, resolveEncrypt }));
  },
  decrypt: async (payload) => payload,
};

const bundled = await build({
  entryPoints: [resolve(frontendRoot, 'src/utils/cacheUtils.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'delayed-crypto',
    setup(build) {
      build.onResolve({ filter: /^\.\/crypto$/ }, () => ({ path: 'crypto', namespace: 'delayed-crypto' }));
      build.onLoad({ filter: /.*/, namespace: 'delayed-crypto' }, () => ({
        contents: `export const encryptData = (value) => globalThis.__cacheTest.encrypt(value);
          export const decryptData = (value) => globalThis.__cacheTest.decrypt(value);`,
        loader: 'js',
      }));
    },
  }],
});
const cache = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

async function nextEncryptedWrite() {
  for (let attempt = 0; attempt < 20 && pending.length === 0; attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  }
  assert.ok(pending.length > 0, 'expected an encryption attempt');
  return pending.shift();
}

test('latest draft wins despite delayed encryption and is isolated by account', async () => {
  cache.setCacheUserId('alice');
  const first = cache.saveCacheAsync('message_draft_alice_room', '旧草稿');
  const last = cache.saveCacheAsync('message_draft_alice_room', '最新草稿');
  (await nextEncryptedWrite()).resolveEncrypt('old');
  (await nextEncryptedWrite()).resolveEncrypt('new');
  await Promise.all([first, last]);
  assert.match(localStorage.getItem('app_cache_alice_message_draft_alice_room'), /new$/);

  cache.setCacheUserId('bob');
  assert.equal(await cache.loadCacheAsync('message_draft_bob_room'), null);
  assert.equal(cache.loadCache('message_draft_alice_room'), null);
  assert.equal(localStorage.getItem('app_cache_bob_message_draft_alice_room'), null);
});

test('an old async write cannot land after account switch or deletion', async () => {
  cache.setCacheUserId('alice');
  const switching = cache.saveCacheAsync('message_draft_alice_switch', 'secret');
  const oldEncrypt = await nextEncryptedWrite();
  cache.setCacheUserId('bob');
  oldEncrypt.resolveEncrypt('secret');
  assert.equal(await switching, false);
  assert.equal(localStorage.getItem('app_cache_bob_message_draft_alice_switch'), null);
  assert.equal(localStorage.getItem('app_cache_alice_message_draft_alice_switch'), null);

  const deleting = cache.saveCacheAsync('message_draft_bob_room', 'to delete');
  const deleteEncrypt = await nextEncryptedWrite();
  cache.removeCache('message_draft_bob_room');
  deleteEncrypt.resolveEncrypt('to delete');
  assert.equal(await deleting, false);
  assert.equal(localStorage.getItem('app_cache_bob_message_draft_bob_room'), null);
});

test('a delayed restore cannot resurrect a draft deleted or replaced meanwhile', async () => {
  cache.setCacheUserId('bob');
  const key = 'message_draft_bob_delayed';
  const storageKey = `app_cache_bob_${key}`;
  localStorage.setItem(storageKey, `enc_v1_${JSON.stringify({
    data: 'old', timestamp: Date.now(), version: '1.0',
  })}`);

  let finishDecrypt;
  globalThis.__cacheTest.decrypt = () => new Promise((resolveDecrypt) => { finishDecrypt = resolveDecrypt; });
  const deleted = cache.loadCacheAsync(key);
  assert.equal(typeof finishDecrypt, 'function');
  cache.removeCache(key);
  finishDecrypt(JSON.stringify({ data: 'old', timestamp: Date.now(), version: '1.0' }));
  assert.equal(await deleted, null);
  assert.equal(cache.loadCache(key), null);

  localStorage.setItem(storageKey, `enc_v1_${JSON.stringify({
    data: 'old', timestamp: Date.now(), version: '1.0',
  })}`);
  const replaced = cache.loadCacheAsync(key);
  const saved = cache.saveCacheAsync(key, 'new');
  (await nextEncryptedWrite()).resolveEncrypt('new');
  await saved;
  finishDecrypt(JSON.stringify({ data: 'old', timestamp: Date.now(), version: '1.0' }));
  assert.equal(await replaced, 'new');
  assert.equal(cache.loadCache(key), 'new');
  globalThis.__cacheTest.decrypt = async (payload) => payload;
});
