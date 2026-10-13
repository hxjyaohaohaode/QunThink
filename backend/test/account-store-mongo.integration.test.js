import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient, MongoServerError, BSON } from 'mongodb';
import { MongoLow } from '../src/models/mongoAdapter.js';
import { requireAccountStore, createOnlyAccount } from '../src/models/accountStoreLifecycle.js';
import { initializeNewAccountOrder } from '../src/services/messageOrder.js';
import { storageFixturesRequired, validateMongoFixtureUrl } from '../scripts/ci-storage-fixtures.mjs';

const url = process.env.QUNTHINK_TEST_MONGO_URL;
if (storageFixturesRequired() || url) validateMongoFixtureUrl(url);
const code = value => error => error.code === value;
const snapshot = owner => initializeNewAccountOrder({ groups: [{ id: 'synthetic-group' }], messages: [], marker: 'original' }, owner,
  { generationForGroup: () => randomUUID() });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const options = { maxPoolSize: 4, serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000, timeoutMS: 8000 };

// This is actual MongoDB driver acceptance. The ACK-loss tests deliberately
// inject a post-commit exception; they do not claim a real network partition.
// Local omission is optional; the required CI runner rejects omission before TAP.
test('real MongoDB account adapter: unique create, detached ACK, authoritative recovery and independent-process CAS', {
  skip: !url && 'Requires the disposable exact-loopback MongoDB fixture; fake transports are not acceptance', timeout: 120000
}, async t => {
  const client = new MongoClient(url, options);
  const collectionName = `synthetic_order_${randomUUID().replaceAll('-', '')}`;
  let collection;
  try {
    await client.connect();
    const database = client.db('qunthink_order_ci');
    const build = await database.command({ buildInfo: 1 }, { maxTimeMS: 2000 });
    const hello = await database.command({ hello: 1 }, { maxTimeMS: 2000 });
    assert.equal(build.version, '9.0.2'); assert.equal(hello.maxBsonObjectSize, 16777216);
    t.diagnostic(JSON.stringify({ fixture: 'real MongoDB driver', version: build.version, bsonLimit: hello.maxBsonObjectSize,
      scope: 'standalone adapter acceptance; synthetic post-commit ACK exceptions' }));
    collection = database.collection(collectionName);
    await collection.createIndex({ userId: 1 }, { unique: true });
    assert.ok((await collection.listIndexes().toArray()).some(index => index.unique && index.key.userId === 1));
    const raw = owner => new MongoLow(collection, { userId: owner }, {});
    async function existing(owner, { revision = 1 } = {}) {
      const data = snapshot(owner);
      await collection.insertOne({ userId: owner, data, revision });
      const db = requireAccountStore(raw(owner), owner); await db.read();
      return { db, data };
    }

    await t.test('real insert-only create preserves an occupied revision-zero source and concurrent unique account has one winner', async () => {
      const occupied = randomUUID(), old = { synthetic: 'existing revision zero' };
      await collection.insertOne({ userId: occupied, data: old, revision: 0 });
      await assert.rejects(raw(occupied).create({ snapshot: snapshot(occupied) }), code('ACCOUNT_DATA_EXISTS'));
      const saved = await collection.findOne({ userId: occupied });
      assert.deepEqual(saved.data, old); assert.equal(saved.revision, 0);
      const owner = randomUUID(), candidates = [snapshot(owner), snapshot(owner)];
      const results = await Promise.allSettled(candidates.map(candidate => raw(owner).create({ snapshot: candidate })));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
      assert.equal(results.find(row => row.status === 'rejected').reason.code, 'ACCOUNT_DATA_EXISTS');
      assert.equal(await collection.countDocuments({ userId: owner }), 1);
      const winner = results.findIndex(row => row.status === 'fulfilled');
      const row = await collection.findOne({ userId: owner });
      assert.equal(row.revision, 1); assert.deepEqual(row.data, candidates[winner]);
    });

    await t.test('detached candidate remains unpublished while a real successful update ACK is deliberately held', async () => {
      const owner = randomUUID(), { data } = await existing(owner), committed = deferred(), release = deferred();
      const transport = { findOne: filter => collection.findOne(filter), updateOne: async (...args) => {
        const acknowledged = await collection.updateOne(...args); committed.resolve(acknowledged); await release.promise; return acknowledged;
      } };
      const db = requireAccountStore(new MongoLow(transport, { userId: owner }, {}), owner); await db.read();
      const before = db.data, candidate = { ...structuredClone(data), marker: 'detached committed candidate' };
      const writing = db.write({ snapshot: candidate, expectedRevision: 1 });
      try {
        const acknowledged = await Promise.race([committed.promise, writing.then(() => { throw new Error('Unexpected early ACK publication'); })]);
        assert.equal(acknowledged.acknowledged, true); assert.equal(acknowledged.matchedCount, 1);
        candidate.marker = 'mutation after write started';
        assert.equal(db.data, before); assert.equal(db._revision, 1);
        const stored = await collection.findOne({ userId: owner });
        assert.equal(stored.revision, 2); assert.equal(stored.data.marker, 'detached committed candidate');
      } finally { release.resolve(); await writing; }
      assert.notEqual(db.data, candidate); assert.equal(db.data.marker, 'detached committed candidate'); assert.equal(db._revision, 2);
    });

    await t.test('real committed update with synthetic lost ACK stays unpublished until authoritative read; no blind retry', async () => {
      const owner = randomUUID(), { data } = await existing(owner); let writes = 0;
      const transport = { findOne: filter => collection.findOne(filter), updateOne: async (...args) => {
        const result = await collection.updateOne(...args); assert.equal(result.matchedCount, 1); writes++;
        throw Object.assign(new Error('synthetic lost ACK after observed real Mongo commit'), { code: 'ETIMEDOUT' });
      } };
      const db = requireAccountStore(new MongoLow(transport, { userId: owner }, {}), owner); await db.read();
      const candidate = { ...structuredClone(data), marker: 'actually committed before synthetic ACK loss' };
      await assert.rejects(db.write({ snapshot: candidate, expectedRevision: 1 }), code('ETIMEDOUT'));
      assert.deepEqual(db.data, data); assert.equal(db._revision, 1);
      assert.deepEqual((await collection.findOne({ userId: owner })).data, candidate);
      await assert.rejects(db.write({ snapshot: candidate, expectedRevision: 1 }), code('ACCOUNT_WRITE_REQUIRES_READ'));
      await db.read(); assert.deepEqual(db.data, candidate); assert.equal(db._revision, 2); assert.equal(writes, 1);
    });

    await t.test('real insert with synthetic lost ACK is reconciled by exact authoritative read without second insertion', async () => {
      const owner = randomUUID(), candidate = snapshot(owner); let inserts = 0;
      const transport = { findOne: filter => collection.findOne(filter), insertOne: async doc => {
        const result = await collection.insertOne(doc); assert.equal(result.acknowledged, true); inserts++;
        throw Object.assign(new Error('synthetic lost create ACK after real insertion'), { code: 'ETIMEDOUT' });
      } };
      const db = new MongoLow(transport, { userId: owner }, {});
      await createOnlyAccount(db, candidate, owner);
      assert.deepEqual(db.data, candidate); assert.equal(db._revision, 1); assert.equal(inserts, 1);
      assert.equal(await collection.countDocuments({ userId: owner }), 1);
    });

    const childSource = `
      import { MongoClient } from 'mongodb';
      import { MongoLow } from './src/models/mongoAdapter.js';
      import { requireAccountStore } from './src/models/accountStoreLifecycle.js';
      import { validateMongoFixtureUrl } from './scripts/ci-storage-fixtures.mjs';
      validateMongoFixtureUrl(process.env.QUNTHINK_TEST_MONGO_URL);
      const client = new MongoClient(process.env.QUNTHINK_TEST_MONGO_URL, ${JSON.stringify(options)});
      try {
        await client.connect();
        const collection = client.db('qunthink_order_ci').collection(process.env.QUNTHINK_MONGO_COLLECTION);
        const owner = process.env.QUNTHINK_MONGO_OWNER;
        const db = requireAccountStore(new MongoLow(collection, {userId: owner}, {}), owner);
        await db.read();
        const candidate = {...structuredClone(db.data), marker: process.env.QUNTHINK_MONGO_MARKER};
        const proceed = new Promise(resolve => process.once('message', resolve));
        process.send({ready: true, pid: process.pid, revision: db._revision, exists: db._exists});
        await proceed;
        try { await db.write({snapshot: candidate, expectedRevision: 0}); process.send({outcome: 'committed', marker: candidate.marker}); }
        catch(error) { process.send({outcome: error.code || error.name}); }
      } finally { await client.close(); process.disconnect(); }
    `;
    function participant(owner) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, QUNTHINK_MONGO_COLLECTION: collectionName, QUNTHINK_MONGO_OWNER: owner, QUNTHINK_MONGO_MARKER: randomUUID() },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      let readyResolve, readyReject, result, stderr = '', timedOut = false;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      ready.catch(() => {});
      child.stdout.resume();
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
      child.on('message', message => { if (message.ready) readyResolve(message); else result = message; });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
      const done = new Promise((resolve, reject) => {
        child.once('error', error => { readyReject(error); reject(error); });
        child.once('close', status => {
          clearTimeout(timer);
          const error = new Error(`Mongo fixture child ${timedOut ? 'timed out' : `exit ${status}`}: ${stderr}`);
          if (status === 0 && result) resolve(result); else { readyReject(error); reject(error); }
        });
      });
      done.catch(() => {});
      return { child, ready, done, release: () => child.send({ commit: true }), close: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await done.catch(() => {}); clearTimeout(timer);
      } };
    }
    await t.test('two independent Node processes read revision zero; only one actual Mongo CAS commits', { timeout: 20000 }, async () => {
      const owner = randomUUID(), original = snapshot(owner);
      await collection.insertOne({ userId: owner, data: original, revision: 0 });
      const children = [participant(owner), participant(owner)];
      try {
        const ready = await Promise.all(children.map(row => row.ready));
        assert.notEqual(ready[0].pid, ready[1].pid); assert.ok(ready.every(row => row.exists === true && row.revision === 0));
        for (const child of children) child.release();
        const outcomes = await Promise.all(children.map(row => row.done));
        assert.equal(outcomes.filter(row => row.outcome === 'committed').length, 1);
        assert.equal(outcomes.find(row => row.outcome !== 'committed').outcome, 'REVISION_CONFLICT');
        const saved = await collection.findOne({ userId: owner });
        assert.equal(saved.revision, 1); assert.equal(saved.data.marker, outcomes.find(row => row.outcome === 'committed').marker);
        assert.deepEqual(saved.data.message_order, original.message_order); assert.equal(await collection.countDocuments({ userId: owner }), 1);
      } finally { await Promise.all(children.map(row => row.close())); }
    });

    await t.test('independent Node required writer cannot insert a phantom when its revision-zero source is deleted', { timeout: 20000 }, async () => {
      const owner = randomUUID(); await collection.insertOne({ userId: owner, data: snapshot(owner), revision: 0 });
      const child = participant(owner);
      try {
        const ready = await child.ready; assert.equal(ready.revision, 0); assert.equal(ready.exists, true);
        assert.equal((await collection.deleteOne({ userId: owner })).deletedCount, 1);
        child.release(); assert.equal((await child.done).outcome, 'REVISION_CONFLICT');
        assert.equal(await collection.countDocuments({ userId: owner }), 0);
      } finally { await child.close(); }
    });

    await t.test('required missing/null/bad-order source fails closed without publishing or inserting', async () => {
      const missing = randomUUID(), absent = requireAccountStore(raw(missing), missing);
      await assert.rejects(absent.read(), code('ACCOUNT_DATA_MISSING'));
      await assert.rejects(absent.write({ snapshot: snapshot(missing), expectedRevision: 0 }), code('ACCOUNT_WRITE_REQUIRES_READ'));
      assert.equal(await collection.countDocuments({ userId: missing }), 0);
      for (const corrupt of [null, { groups: [], messages: [] }, { groups: [], messages: [], message_order: { version: 999 } }]) {
        const owner = randomUUID(), { db, data } = await existing(owner);
        await collection.updateOne({ userId: owner }, { $set: { data: corrupt } });
        await assert.rejects(db.read(), error => ['ACCOUNT_DATA_INVALID', 'MESSAGE_ORDER_UNAVAILABLE'].includes(error.code));
        assert.deepEqual(db.data, data); assert.equal(db._revision, 1);
        await assert.rejects(db.write({ snapshot: data, expectedRevision: 1 }), code('ACCOUNT_WRITE_REQUIRES_READ'));
        const actual = await collection.findOne({ userId: owner }); assert.deepEqual(actual.data, corrupt); assert.equal(actual.revision, 1);
      }
    });

    await t.test('actual MongoDB BSON limit rejects oversized detached update and preserves the old record', async () => {
      const owner = randomUUID(), { db, data } = await existing(owner);
      const original = await collection.findOne({ userId: owner });
      const oversized = { ...structuredClone(data), syntheticPadding: 'x'.repeat(16 * 1024 * 1024) };
      assert.ok(BSON.calculateObjectSize(oversized) > hello.maxBsonObjectSize);
      // No mocked transport or fabricated rejection: require the live server's size error.
      await assert.rejects(db.write({ snapshot: oversized, expectedRevision: 1 }), error => {
        assert.ok(error instanceof MongoServerError); assert.match(error.message, /BSON|size|larg/i); return true;
      });
      assert.deepEqual(db.data, data); assert.equal(db._revision, 1);
      assert.deepEqual(await collection.findOne({ userId: owner }), original);
      await assert.rejects(db.write({ snapshot: data, expectedRevision: 1 }), code('ACCOUNT_WRITE_REQUIRES_READ'));
      await db.read(); assert.deepEqual(db.data, data); assert.equal(db._revision, 1);
    });
  } finally {
    try { if (collection) await collection.drop(); }
    finally { await client.close(); }
  }
});
