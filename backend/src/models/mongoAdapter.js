import { MongoClient } from 'mongodb';

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
  }

  async read() {
    try {
      const doc = await this.collection.findOne(this.filter);
      if (doc && doc.data) {
        this.data = doc.data;
      } else {
        this.data = JSON.parse(JSON.stringify(this.defaultData));
      }
    } catch (err) {
      console.warn('MongoLow read failed:', err.message);
      this.data = JSON.parse(JSON.stringify(this.defaultData));
    }
  }

  async write() {
    try {
      await this.collection.updateOne(
        this.filter,
        {
          $set: {
            ...this.filter,
            data: this.data,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
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
