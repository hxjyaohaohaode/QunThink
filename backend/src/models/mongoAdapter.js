import { accountDataExists } from './accountStoreLifecycle.js';
import { MongoClient } from 'mongodb';
import { beginUserDbWriteBarrier, readWithWriteBarrier, assertSynchronousPublishHook, runSynchronousPublishHook, assertExplicitDbSnapshot } from './readBarrier.js';

let client = null;
let db = null;
let connecting = null;

export async function getMongoClient() {
  if (client) return client;
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) return null;

  connecting = (async () => {
    try {
      client = new MongoClient(uri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 60000,
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });

      await client.connect();
      const dbName = process.env.MONGODB_DB_NAME || 'qunthink';
      db = client.db(dbName);

      await db.collection('users_data').createIndex({ userId: 1 }, { unique: true });
      await db.collection('auth_data').createIndex({ id: 1 }, { unique: true });

      console.log(`✅ MongoDB 连接成功: ${dbName}`);
      connecting = null;
      return client;
    } catch (err) {
      console.error('❌ MongoDB 连接失败:', err.message);
      client = null;
      db = null;
      connecting = null;
      throw err;
    }
  })();

  return connecting;
}

export async function getMongoDb() {
  if (db) return db;
  await getMongoClient();
  return db;
}

export function isMongoEnabled() {
  return !!process.env.MONGODB_URI;
}

function mongoRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error('Invalid database revision'), { code: 'INVALID_DB_REVISION', status: 503 });
  }
  return value;
}

export class MongoLow {
  constructor(collection, filter, defaultData) {
    this.collection = collection;
    this.filter = filter;
    this.data = JSON.parse(JSON.stringify(defaultData));
    this.defaultData = defaultData;
    this._lastAccess = Date.now();
    this._revision = 0;
    this._exists = null;
  }

  async read({ onPublished } = {}) {
    assertSynchronousPublishHook(onPublished);
    try {
      await readWithWriteBarrier(this, () => {
        this.assertCurrentLease?.();
        return this.collection.findOne(this.filter);
      }, doc => {
        const exists = doc !== null && doc !== undefined;
        // Legacy Mongo documents genuinely lacking the field start at zero;
        // a present null/unsafe revision is corruption, not a missing field.
        const revision = mongoRevision(exists && Object.hasOwn(doc, 'revision') ? doc.revision : 0);
        const data = exists ? doc.data : JSON.parse(JSON.stringify(this.defaultData));
        this._accountStoreContract?.read(data, exists);
        this.data = data;
        this._revision = revision;
        this._exists = exists;
        runSynchronousPublishHook(onPublished, { data, revision, exists, supportsRevisionCas: true });
      });
    } catch (err) {
      this._accountStoreContract?.uncertain();
      console.warn('MongoLow read failed:', err.message);
      throw err;
    }
  }

  async create({ snapshot }) {
    const releaseBarrier = beginUserDbWriteBarrier(this);
    try {
      assertExplicitDbSnapshot(snapshot);
      const data = structuredClone(snapshot); assertExplicitDbSnapshot(data);
      this.assertCurrentLease?.();
      let result;
      try { result = await this.collection.insertOne({ ...this.filter, data, revision: 1, updatedAt: new Date() }); }
      catch (error) { if (error.code === 11000) throw accountDataExists(); throw error; }
      this.assertCurrentLease?.();
      if (result?.acknowledged !== true || result?.insertedId == null) {
        throw Object.assign(new Error('Unconfirmed database create'), { code: 'WRITE_ACK_UNKNOWN', status: 503 });
      }
      this.data = data; this._revision = 1; this._exists = true;
    } finally {
      releaseBarrier();
    }
  }

  async write(options) {
    const releaseBarrier = beginUserDbWriteBarrier(this);
    try {
      const explicit = options !== undefined;
      if (explicit && (!options || !Object.hasOwn(options, 'snapshot'))) throw new TypeError('write options must include snapshot');
      if (explicit) assertExplicitDbSnapshot(options.snapshot);
      const data = structuredClone(explicit ? options.snapshot : this.data);
      if (explicit) assertExplicitDbSnapshot(data);
      const permit = this._accountStoreContract?.beforeWrite(data);
      const expectedRevision = mongoRevision(explicit && Object.hasOwn(options, 'expectedRevision') ? options.expectedRevision : this._revision);
      if (expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw Object.assign(new Error('Database revision exhausted'), { code: 'DB_REVISION_EXHAUSTED', status: 503 });
      }
      const nextRevision = expectedRevision + 1;
      const versionFilter = expectedRevision === 0
        ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
        : { revision: expectedRevision };
      const publish = () => {
        this.assertCurrentLease?.();
        this._accountStoreContract?.checkWrite(permit, { afterIo: true });
        if (explicit) this.data = data;
        this._revision = nextRevision;
        this._exists = true;
        this._accountStoreContract?.committed(data);
      };
      const unknown = () => Object.assign(new Error('Unconfirmed database write'), { code: 'WRITE_ACK_UNKNOWN', status: 503 });
      this.assertCurrentLease?.();
      this._accountStoreContract?.checkWrite(permit);
      const updated = await this.collection.updateOne(
        { ...this.filter, ...versionFilter },
        { $set: { data, updatedAt: new Date() }, $inc: { revision: 1 } }
      );
      this._accountStoreContract?.checkWrite(permit, { afterIo: true });
      if (updated.acknowledged !== true) throw unknown();
      if (updated.matchedCount === 1) { publish(); return; }
      if (updated.matchedCount !== 0) throw unknown();
      if (expectedRevision === 0 && !this._accountStoreContract) {
        try {
          this.assertCurrentLease?.();
          const inserted = await this.collection.insertOne({ ...this.filter, data, revision: 1, updatedAt: new Date() });
          if (inserted?.acknowledged !== true || inserted?.insertedId == null) throw unknown();
          publish(); return;
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }
      throw Object.assign(new Error('数据已在其他进程更新，请刷新后重试'), { status: 409, code: 'REVISION_CONFLICT' });
    } catch (err) {
      this._accountStoreContract?.uncertain();
      console.warn('MongoLow write failed:', err.message);
      throw err;
    } finally {
      releaseBarrier();
    }
  }
}

export async function closeMongoConnection() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('✅ MongoDB 连接已关闭');
  }
}
