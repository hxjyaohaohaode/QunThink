import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserDbRegistry } from '../src/models/userDbRegistry.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const replaced = promise => assert.rejects(promise, error => error.code === 'USER_DB_REPLACED' && error.status === 503);
const fixture = (disk, hooks = {}) => ({
  data: structuredClone(disk.value),
  async read() { const value = structuredClone(disk.value); await hooks.read?.(); this.data = value; },
  async write() { await hooks.write?.(); disk.value = structuredClone(this.data); await hooks.ack?.(); }
});
const loader = (disk, hooks) => async protect => { const db = protect(fixture(disk, hooks)); await db.read(); return db; };

test('concurrent account cache misses share exactly one active loading instance', async () => {
  const registry = createUserDbRegistry(), gate = deferred(), entered = deferred();
  const disk = { value: { rows: [] } }; let loads = 0;
  const load = async protect => { loads++; entered.resolve(); await gate.promise; return loader(disk)(protect); };
  const requests = Array.from({ length: 30 }, () => registry.get('account', load));
  await entered.promise; assert.equal(loads, 1); gate.resolve();
  const instances = await Promise.all(requests);
  assert.ok(instances.every(db => db === instances[0])); assert.equal(registry.cache.size, 1);
});

test('a cleared loader cannot register itself or delete a newer in-flight load', async () => {
  const registry = createUserDbRegistry(), oldGate = deferred(), freshGate = deferred(), entered = deferred();
  const disk = { value: { source: 'initial' } }; let freshLoads = 0;
  const old = registry.get('account', async protect => { const db = protect(fixture(disk)); entered.resolve(); await oldGate.promise; return db; });
  const oldRejected = replaced(old); await entered.promise; registry.clear('account');
  disk.value = { source: 'replacement' };
  const freshLoader = async protect => { freshLoads++; await freshGate.promise; return loader(disk)(protect); };
  const fresh = registry.get('account', freshLoader);
  oldGate.resolve(); await oldRejected;
  const shared = registry.get('account', freshLoader); assert.equal(freshLoads, 1);
  freshGate.resolve(); assert.equal(await fresh, await shared);
  assert.equal((await fresh).data.source, 'replacement');
});

test('clear all retires pending loads even when no database has reached the cache', async () => {
  const registry = createUserDbRegistry(), gate = deferred();
  const disk = { value: { rows: [] } };
  const first = registry.get('a', async protect => { await gate.promise; return loader(disk)(protect); });
  const second = registry.get('b', async protect => { await gate.promise; return loader(disk)(protect); });
  const rejected = [replaced(first), replaced(second)];
  registry.clear(); gate.resolve(); await Promise.all(rejected); assert.equal(registry.cache.size, 0);
  assert.ok(await registry.get('a', loader(disk)));
});

test('mid-read retirement rejects the old caller and leaves replacement source untouched', async () => {
  const registry = createUserDbRegistry(), disk = { value: { source: 'old' } };
  const entered = deferred(), gate = deferred(); let hold = false;
  const db = await registry.get('account', loader(disk, { read: async () => { if (hold) { entered.resolve(); await gate.promise; } } }));
  hold = true; const pending = db.read(); const rejected = replaced(pending); await entered.promise;
  registry.clear('account'); disk.value = { source: 'restored backup' };
  const fresh = await registry.get('account', loader(disk));
  gate.resolve(); await rejected;
  db.data = { source: 'late old response' }; await replaced(db.write());
  assert.equal(fresh.data.source, 'restored backup'); assert.equal(disk.value.source, 'restored backup');
});

for (const commit of [false, true]) for (const loseAck of [false, true]) {
  test(`replacement load drains an already-started old write (commit=${commit}, lostAck=${loseAck})`, async () => {
    const registry = createUserDbRegistry(), disk = { value: { rows: [] } };
    const entered = deferred(), release = deferred(); let writes = 0, freshLoads = 0;
    const db = await registry.get('account', loader(disk, {
      write: async () => { writes++; entered.resolve(); await release.promise; if (!commit) throw new Error('not committed'); },
      ack: () => { if (loseAck) throw new Error('lost acknowledgement'); }
    }));
    db.data.rows.push('accepted before retirement');
    const pending = db.write(); const rejected = replaced(pending); await entered.promise;
    registry.clear('account');
    const fresh = registry.get('account', async protect => { freshLoads++; return loader(disk)(protect); });
    await turn(); assert.equal(freshLoads, 0, 'new generation cannot read or initialize before old I/O settles');
    const other = await registry.get('other', loader({ value: { independent: true } }));
    assert.equal(other.data.independent, true, 'draining one account must not block another');
    release.resolve(); await rejected;
    const current = await fresh;
    assert.deepEqual(current.data.rows, commit ? ['accepted before retirement'] : []);
    current.data.marker = 'fresh write'; await current.write();
    db.data.rows.push('must never revive'); await replaced(db.write()); await replaced(db.read());
    assert.equal(writes, 1); assert.equal(disk.value.marker, 'fresh write');
    assert.ok(!disk.value.rows.includes('must never revive'));
  });
}

test('LRU retirement rejects an in-flight read but pins already-started writes until settled', async () => {
  const registry = createUserDbRegistry({ maxSize: 1 }), disk = { value: { rows: [] } };
  const readStarted = deferred(), releaseRead = deferred(); let holdRead = false;
  const first = await registry.get('a', loader(disk, { read: async () => { if (holdRead) { readStarted.resolve(); await releaseRead.promise; } } }));
  holdRead = true; const read = first.read(); const rejected = replaced(read); await readStarted.promise;
  await registry.get('b', loader({ value: { rows: [] } }));
  assert.ok(!registry.cache.has('a')); releaseRead.resolve(); await rejected;
  const writeStarted = deferred(), releaseWrite = deferred();
  const second = await registry.get('a', loader(disk, { write: async () => { writeStarted.resolve(); await releaseWrite.promise; } }));
  second.data.rows.push('committed'); const write = second.write(); await writeStarted.promise;
  await registry.get('c', loader({ value: { rows: [] } })); assert.ok(registry.cache.has('a'));
  releaseWrite.resolve(); await write; assert.deepEqual(disk.value.rows, ['committed']);
  await registry.get('d', loader({ value: { rows: [] } })); assert.equal(registry.cache.size, 1);
  await replaced(second.write());
});

test('queued account lock users cannot alternate writes with a retired instance', async () => {
  const registry = createUserDbRegistry(), disk = { value: { rows: ['seed'] } };
  const old = await registry.get('a', loader(disk));
  registry.clear('a'); const current = await registry.get('a', loader(disk));
  for (let round = 0; round < 3; round++) {
    current.data.rows.push(`new-${round}`); await current.write();
    old.data.rows.push(`old-${round}`); await replaced(old.write());
    await current.read(); assert.deepEqual(current.data, disk.value);
  }
  assert.deepEqual(disk.value.rows, ['seed', 'new-0', 'new-1', 'new-2']);
});

// Production adapter classes with explicit synthetic pool/collection responses.
// These prove dispatch counts and CAS behavior, not live PostgreSQL/Mongo access.
for (const backend of ['PgLow', 'MongoLow']) {
  for (const outcome of ['retired before insert', 'insert succeeds', 'update succeeds', 'revision conflict']) {
    test(`${backend}: ${outcome} preserves the CAS boundary without an implicit retry`, async () => {
      const { PgLow } = await import('../src/models/supabaseAdapter.js');
      const { MongoLow } = await import('../src/models/mongoAdapter.js');
      const registry = createUserDbRegistry(), entered = deferred(), release = deferred();
      let updates = 0, inserts = 0;
      const update = async () => { updates++; entered.resolve(); await release.promise; };
      const pool = { query: async sql => {
        if (sql.startsWith('UPDATE')) { await update(); return outcome === 'update succeeds' ? { rowCount: 1, rows: [{ revision: 2 }] } : { rowCount: 0, rows: [] }; }
        if (sql.startsWith('INSERT')) { inserts++; return { rowCount: 1, rows: [{ revision: 1 }] }; }
        throw new Error('Unexpected synthetic query');
      } };
      const collection = {
        updateOne: async () => { await update(); return { matchedCount: outcome === 'update succeeds' ? 1 : 0 }; },
        insertOne: async () => { inserts++; return { insertedId: 'synthetic' }; }
      };
      const db = await registry.get('synthetic', protect => protect(backend === 'PgLow'
        ? new PgLow('user:synthetic', { marker: 'synthetic source' }, pool)
        : new MongoLow(collection, { userId: 'synthetic' }, { marker: 'synthetic source' })));
      if (outcome === 'revision conflict' || outcome === 'update succeeds') db._revision = 1;
      const writing = db.write().then(() => null, error => error);
      await entered.promise;
      if (outcome === 'retired before insert') registry.clear('synthetic');
      release.resolve(); const error = await writing;
      assert.equal(updates, 1);
      assert.equal(inserts, outcome === 'insert succeeds' ? 1 : 0);
      if (outcome === 'retired before insert') assert.equal(error?.code, 'USER_DB_REPLACED');
      else if (outcome === 'revision conflict') assert.equal(error?.code, 'REVISION_CONFLICT');
      else { assert.equal(error, null); assert.equal(db._revision, outcome === 'update succeeds' ? 2 : 1); }
    });
  }
}
