import type { Message } from '../types';

const BASE_DB_NAME = 'ai-chat-group';
const DB_VERSION = 1;
const MESSAGE_STORE = 'messages';
const MAX_MESSAGES_PER_GROUP = 1000;

let currentDbUserId: string | null = null;
let dbInstance: IDBDatabase | null = null;
let dbClosed = false;
let dbFallback: Map<string, any> | null = null;

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB.open;
  } catch {
    return false;
  }
}

type StorageErrorListener = (operation: string, error: unknown) => void;
const errorListeners: Set<StorageErrorListener> = new Set();

export function onStorageError(listener: StorageErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

function notifyStorageError(operation: string, error: unknown): void {
  errorListeners.forEach(listener => {
    try { listener(operation, error); } catch {}
  });
}

export function setIndexedDBUserId(userId: string | null): void {
  if (currentDbUserId !== userId) {
    closeDB();
    currentDbUserId = userId;
  }
}

function closeDB(): void {
  if (dbInstance) {
    dbClosed = true;
    try {
      dbInstance.close();
    } catch {}
    dbInstance = null;
  }
}

function getDbName(): string {
  if (currentDbUserId) {
    return `${BASE_DB_NAME}-${currentDbUserId}`;
  }
  return BASE_DB_NAME;
}

async function openDB(): Promise<IDBDatabase | { fallback: Map<string, any> }> {
  if (!isIndexedDBAvailable()) {
    console.warn('[IndexedDB] Not available, using in-memory fallback');
    if (!dbFallback) dbFallback = new Map();
    return { fallback: dbFallback };
  }

  if (dbInstance && !dbClosed) {
    return dbInstance;
  }
  return new Promise((resolve, reject) => {
    const dbName = getDbName();
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        const store = db.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });
        store.createIndex('group_id', 'group_id', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      dbClosed = false;
      dbInstance.onclose = () => {
        dbInstance = null;
        dbClosed = true;
      };
      dbInstance.onerror = () => {
        dbInstance = null;
        dbClosed = true;
      };
      resolve(dbInstance);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveMessagesToIndexedDB(messages: Message[]): Promise<boolean> {
  if (messages.length === 0) return true;
  let db: IDBDatabase | null = null;
  try {
    const result = await openDB();
    if ('fallback' in result) {
      const fallback = result.fallback;
      for (const msg of messages) {
        fallback.set(msg.id, msg);
      }
      return true;
    }
    db = result;
    const tx = db.transaction(MESSAGE_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE);
    for (const msg of messages) {
      store.put(msg);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (error) {
    console.warn('IndexedDB保存失败:', error);
    notifyStorageError('save', error);
    return false;
  }
}

export async function loadMessagesFromIndexedDB(groupId: string): Promise<Message[]> {
  let db: IDBDatabase | null = null;
  try {
    const result = await openDB();
    if ('fallback' in result) {
      const fallback = result.fallback;
      const messages: Message[] = [];
      fallback.forEach((msg) => {
        if (msg.group_id === groupId) {
          messages.push(msg);
        }
      });
      messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      return messages.slice(-MAX_MESSAGES_PER_GROUP);
    }
    db = result;
    const tx = db.transaction(MESSAGE_STORE, 'readonly');
    const store = tx.objectStore(MESSAGE_STORE);
    const index = store.index('group_id');
    const request = index.getAll(groupId);
    const messages = await new Promise<Message[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return messages.slice(-MAX_MESSAGES_PER_GROUP);
  } catch (error) {
    console.warn('IndexedDB加载失败:', error);
    notifyStorageError('load', error);
    return [];
  }
}

export async function clearOldMessagesFromIndexedDB(groupId: string, keepCount: number = MAX_MESSAGES_PER_GROUP): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    const result = await openDB();
    if ('fallback' in result) {
      const fallback = result.fallback;
      const messages: Message[] = [];
      fallback.forEach((msg) => {
        if (msg.group_id === groupId) {
          messages.push(msg);
        }
      });
      if (messages.length > keepCount) {
        messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        const toDelete = messages.slice(0, messages.length - keepCount);
        for (const msg of toDelete) {
          fallback.delete(msg.id);
        }
      }
      return;
    }
    db = result;
    const tx = db.transaction(MESSAGE_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE);
    const index = store.index('group_id');
    const request = index.getAll(groupId);
    const messages = await new Promise<Message[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (messages.length > keepCount) {
      messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const toDelete = messages.slice(0, messages.length - keepCount);
      for (const msg of toDelete) {
        store.delete(msg.id);
      }
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn('IndexedDB清理失败:', error);
    notifyStorageError('clear_old', error);
  }
}

export async function clearAllMessagesFromIndexedDB(groupId: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    const result = await openDB();
    if ('fallback' in result) {
      const fallback = result.fallback;
      const toDelete: string[] = [];
      fallback.forEach((msg, id) => {
        if (msg.group_id === groupId) {
          toDelete.push(id);
        }
      });
      for (const id of toDelete) {
        fallback.delete(id);
      }
      return;
    }
    db = result;
    const tx = db.transaction(MESSAGE_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGE_STORE);
    const index = store.index('group_id');
    const request = index.openCursor(groupId);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('IndexedDB清空失败:', error);
    notifyStorageError('clear_all', error);
  }
}

export async function clearAllIndexedDBForUser(userId?: string): Promise<void> {
  closeDB();
  try {
    if (!isIndexedDBAvailable()) {
      if (dbFallback) {
        dbFallback.clear();
      }
      return;
    }

    const dbName = userId ? `${BASE_DB_NAME}-${userId}` : getDbName();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        console.warn('IndexedDB deletion blocked, will retry');
        setTimeout(() => {
          indexedDB.deleteDatabase(dbName);
        }, 1000);
        resolve();
      };
    });
    if (import.meta.env.DEV) {
      console.log(`[IndexedDB] Cleared database: ${dbName}`);
    }
  } catch (error) {
    console.warn('IndexedDB清理失败:', error);
    notifyStorageError('clear_user', error);
  }
}
