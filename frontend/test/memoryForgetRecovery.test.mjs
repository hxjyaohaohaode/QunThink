import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const built = await build({ entryPoints: [resolve(import.meta.dirname, '../src/utils/memoryForgetRecovery.ts')], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { readMemoryForgetReceipts: read, rememberMemoryForget: remember, confirmMemoryForget: confirm, MEMORY_FORGET_PREFIX: prefix } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
let values;
beforeEach(() => { values = new Map(); globalThis.localStorage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; });
const key = (user, id) => `${prefix}${encodeURIComponent(user)}:${encodeURIComponent(id)}`;

test('only pending receipt metadata fields are durable and repeated intent preserves its original time', () => {
  const first = remember('alice', 'a:b/1'); const second = remember('alice', 'a:b/1');
  assert.deepEqual(first, second); assert.equal(values.size, 1);
  assert.deepEqual(Object.keys(first).sort(), ['accountId', 'memoryId', 'startedAt', 'state', 'version']);
  assert.deepEqual(read('alice'), [first]); assert.deepEqual(read('bob'), []);
});

test('per-object receipts do not overwrite other pending privacy requests', () => {
  remember('alice', 'one'); remember('alice', 'two'); remember('bob', 'one');
  confirm('alice', 'one'); assert.deepEqual(read('alice').filter(x => x.state === 'pending').map(x => x.memoryId), ['two']); assert.equal(read('alice').find(x => x.memoryId === 'one').state, 'confirmed'); assert.equal(read('bob').length, 1);
});

test('owned corruption and content-bearing extra fields fail closed while foreign garbage is not read', () => {
  values.set(key('bob', 'bad'), '{broken'); assert.deepEqual(read('alice'), []);
  values.set(key('alice', 'bad'), '{broken'); assert.throws(() => read('alice'));
  values.delete(key('alice', 'bad'));
  const receipt = remember('alice', 'one'); values.set(key('alice', 'one'), JSON.stringify({ ...receipt, content: 'must never be accepted as recovery data' }));
  assert.throws(() => read('alice')); assert.throws(() => remember('alice', 'another'));
});

test('key identity, ownership, version and timestamps are checked before recovery', () => {
  const receipt = remember('alice', 'one');
  for (const patch of [{ accountId: 'bob' }, { memoryId: 'two' }, { version: 2 }, { startedAt: 'invalid' }]) {
    values.set(key('alice', 'one'), JSON.stringify({ ...receipt, ...patch })); assert.throws(() => read('alice'));
  }
});

test('write failure, missing write acknowledgement and incomplete confirmed-barrier write never report success', () => {
  localStorage.setItem = () => { throw new Error('quota'); }; assert.throws(() => remember('alice', 'one'));
  localStorage.setItem = () => {}; assert.throws(() => remember('alice', 'one'));
  localStorage.setItem = (k, v) => values.set(k, v); remember('alice', 'one');
  localStorage.setItem = () => {}; assert.throws(() => confirm('alice', 'one'), /服务器已确认遗忘/); assert.equal(read('alice')[0].state, 'pending');
});

test('quota blocks a new pending intent without evicting any unresolved ID', () => {
  const at = '2026-10-05T00:00:00.000Z';
  for (let i = 0; i < 512; i++) values.set(key('alice', String(i)), JSON.stringify({ version: 1, accountId: 'alice', memoryId: String(i), startedAt: at, state: 'pending' }));
  assert.throws(() => remember('alice', 'overflow'), /上限/); assert.equal(read('alice').length, 512);
  assert.equal(remember('alice', '1').startedAt, at);
});


test('already admitted entries above the pending limit remain recoverable; confirmed barriers do not consume pending capacity', () => {
  const at = '2026-10-05T00:00:00.000Z';
  for (let i = 0; i < 513; i++) values.set(key('alice', String(i)), JSON.stringify({ version: 1, accountId: 'alice', memoryId: String(i), startedAt: at, state: 'pending' }));
  assert.equal(read('alice').length, 513); assert.equal(remember('alice', '0').memoryId, '0');
  for (let i = 0; i < 513; i++) confirm('alice', String(i));
  assert.equal(read('alice').filter(x => x.state === 'confirmed').length, 513);
  assert.equal(remember('alice', 'new').state, 'pending'); assert.equal(read('alice').length, 514);
});
