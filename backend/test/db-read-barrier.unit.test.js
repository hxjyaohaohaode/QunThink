import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomLow } from '../src/models/db.js';
import { PgLow } from '../src/models/supabaseAdapter.js';
import { MongoLow } from '../src/models/mongoAdapter.js';
import { beginUserDbWriteBarrier } from '../src/models/readBarrier.js';

for (const kind of ['LowDB', 'PgLow', 'MongoLow']) {
  test(`${kind} discards a pre-write asynchronous read without regressing shared data or CAS revision`, async () => {
    let releaseRead, markRead, reads = 0;
    const readHold = new Promise(resolve => { releaseRead = resolve; });
    const readStarted = new Promise(resolve => { markRead = resolve; });
    const read = async () => {
      if (++reads === 1) { markRead(); await readHold; return { data: { marker: 'before' }, revision: 1 }; }
      return { data: { marker: 'after' }, revision: 2 };
    };
    const db = kind === 'LowDB' ? new CustomLow({ read: async () => (await read()).data, write: async () => {} }, {})
      : kind === 'PgLow' ? new PgLow('user:test', {}, { query: async () => ({ rows: [await read()] }) })
        : new MongoLow({ findOne: read }, {}, {});
    db.data = { marker: 'before' }; db._revision = 1;
    const pending = db.read(); await readStarted;
    const finishWrite = beginUserDbWriteBarrier(db);
    db.data = { marker: 'after' }; db._revision = 2;
    releaseRead(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(db.data.marker, 'after'); assert.equal(db._revision, 2);
    finishWrite(); await pending;
    assert.equal(reads, 2); assert.equal(db.data.marker, 'after'); assert.equal(db._revision, 2);
  });
}
