import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { SyntheticIndexedDB } from './f07SyntheticStorage.mjs';

// Byte-for-byte historical production source, not the current consumer.
// The source contains no fixed keys or ciphertext. Every call below gets fresh
// WebCrypto randomness and a separate in-memory synthetic IndexedDB instance.
export const LEGACY_PRODUCER_SOURCE = Object.freeze({
  commit: '9e8d42354df401460a619488bb0141c8733fb7e0',
  path: 'frontend/src/utils/crypto.ts',
  gitBlob: '8f630b25bb143f6ddfa423b1865aff3154710fe0',
  sha256: '8c69b9d7f86a16e61d4c3f5b55f997040cfb176df8e5e45d9986df939a2126a0',
});

const source = await readFile(new URL('./f07LegacyCrypto.9e8d423.ts', import.meta.url));
assert.equal(createHash('sha256').update(source).digest('hex'), LEGACY_PRODUCER_SOURCE.sha256,
  'historical producer source must retain its verified SHA-256');
assert.equal(createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex'),
  LEGACY_PRODUCER_SOURCE.gitBlob, 'historical producer source must retain its verified Git blob identity');
const compiled = await transform(source.toString('utf8'), {
  loader: 'ts', format: 'iife', globalName: 'legacyCrypto',
  define: { 'import.meta.env.DEV': 'false' },
});
const instantiateProducer = new Function('window', 'indexedDB', 'localStorage', 'console',
  `${compiled.code}\nreturn legacyCrypto;`);

export async function createLegacyEncryptedDraft() {
  const idb = new SyntheticIndexedDB();
  const opens = [];
  const producer = instantiateProducer(
    { crypto: webcrypto },
    { open(name, version) { opens.push({ name, version }); return idb.open(name, version); } },
    { getItem() { return null; }, removeItem() {} },
    // Do not allow historical error logging to emit runtime cryptographic data.
    { error() {}, log() {} },
  );
  const data = 'Runtime-generated historical-format draft';
  const timestamp = Date.now();
  // Envelope verified against cacheUtils.ts at the same historical commit.
  // Nothing in this helper invokes the current crypto or cache implementation.
  const payload = JSON.stringify({ data, timestamp, version: '1.0' });
  const ciphertext = await producer.encryptData(payload);
  assert.ok(typeof ciphertext === 'string', 'historical producer must encrypt successfully');
  assert.deepEqual(opens, [{ name: 'ai-chat-crypto', version: 1 }]);
  assert.deepEqual([...idb.data.keys()], ['ai-chat-crypto']);
  const stores = idb.data.get('ai-chat-crypto');
  assert.deepEqual([...stores.keys()], ['encryption_keys']);
  const records = stores.get('encryption_keys');
  assert.deepEqual([...records.keys()].sort(), ['master_key', 'wrapping_key_material']);
  assert.ok(records.get('wrapping_key_material') instanceof ArrayBuffer
    && records.get('wrapping_key_material').byteLength === 32, 'historical wrapping material is 32 bytes');
  assert.ok(records.get('master_key') instanceof ArrayBuffer
    && records.get('master_key').byteLength === 40, 'historical AES-KW master record is 40 bytes');
  const encrypted = JSON.parse(ciphertext);
  assert.deepEqual(Object.keys(encrypted).sort(), ['data', 'iv']);
  const isBytes = value => Array.isArray(value)
    && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  assert.ok(isBytes(encrypted.iv) && encrypted.iv.length === 12, 'historical AES-GCM IV is 12 bytes');
  assert.ok(isBytes(encrypted.data)
    && encrypted.data.length === new TextEncoder().encode(payload).byteLength + 16,
  'historical ciphertext includes a 16-byte AES-GCM authentication tag');

  // All generated records and ciphertext stay in the test process. Never write
  // or log them, including when reporting a failed test assertion.
  const keys = Object.fromEntries([...records].map(([key, value]) => [key, [...new Uint8Array(value)]]));
  return { data, timestamp, ciphertext, keys };
}
