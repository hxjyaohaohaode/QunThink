import { MongoClient } from 'mongodb';
import { readWithWriteBarrier } from './readBarrier.js';

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

export class MongoLow {
  constructor(collection, filter, defaultData) {
    this.collection = collection;
    this.filter = filter;
    this.data = JSON.parse(JSON.stringify(defaultData));
    this.defaultData = defaultData;
    this._lastAccess = Date.now();
    this._revision = 0;
  }

  async read() {
    try {
      await readWithWriteBarrier(this, () => {
        this.assertCurrentLease?.();
        return this.collection.findOne(this.filter);
      }, doc => {
        this._revision = Number(doc?.revision || 0);
        this.data = doc?.data || JSON.parse(JSON.stringify(this.defaultData));
      });
    } catch (err) {
      console.warn('MongoLow read failed:', err.message);
      throw err;
    }
  }

  async write() {
    try {
      const versionFilter = this._revision === 0
        ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
        : { revision: this._revision };
      this.assertCurrentLease?.();
      const updated = await this.collection.updateOne(
        { ...this.filter, ...versionFilter },
        { $set: { data: this.data, updatedAt: new Date() }, $inc: { revision: 1 } }
      );
      if (updated.matchedCount === 1) {
        this._revision += 1;
        return;
      }
      if (this._revision === 0) {
        try {
          this.assertCurrentLease?.();
          await this.collection.insertOne({ ...this.filter, data: this.data, revision: 1, updatedAt: new Date() });
          this._revision = 1;
          return;
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }
      throw Object.assign(new Error('数据已在其他进程更新，请刷新后重试'), { status: 409, code: 'REVISION_CONFLICT' });
    } catch (err) {
      console.warn('MongoLow write failed:', err.message);
      throw err;
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
