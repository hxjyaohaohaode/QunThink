import type { Message } from '../types';

const BASE_DB_NAME = 'ai-chat-group';
const DB_VERSION = 1;
const MESSAGE_STORE = 'messages';
const MAX_MESSAGES_PER_GROUP = 1000;

type Connection = IDBDatabase | { fallback: Map<string, Message> };
interface StorageSession {
  userId: string | null;
  dbName: string;
  obsolete: boolean;
  db?: IDBDatabase;
  opening?: Promise<Connection>;
  cancel: Set<() => void>;
}

function dbNameFor(userId: string | null): string {
  return userId ? `${BASE_DB_NAME}-${userId}` : BASE_DB_NAME;
}

function createSession(userId: string | null): StorageSession {
  return { userId, dbName: dbNameFor(userId), obsolete: false, cancel: new Set() };
}

let session = createSession(null);
const fallbacks = new Map<string, Map<string, Message>>();
// A blocked delete cannot be cancelled. Keep its DB fenced until the actual
// terminal event, even when the caller has already received a failure result.
const deletions = new Map<string, Promise<boolean>>();

class StaleStorageOperation extends Error {
  constructor() { super('The storage session changed'); this.name = 'StaleStorageOperation'; }
}

function isCurrent(owner: StorageSession): boolean {
  return session === owner && !owner.obsolete;
}

function assertCurrent(owner: StorageSession): void {
  if (!isCurrent(owner)) throw new StaleStorageOperation();
  if (deletions.has(owner.dbName)) throw new Error('The database is still being deleted');
}

function retire(owner: StorageSession): void {
  owner.obsolete = true;
  for (const cancel of [...owner.cancel]) cancel();
  owner.cancel.clear();
  owner.db?.close();
  owner.db = undefined;
}

function replaceSession(userId: string | null): void {
  const previous = session;
  session = createSession(userId);
  retire(previous);
}

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
  // Account changes intentionally cancel old work. Do not surface its errors in
  // a newer account, but callers still receive false / an empty cache result.
  if (error instanceof StaleStorageOperation) return;
  console.warn(`[IndexedDB] ${operation} failed`);
  errorListeners.forEach(listener => {
    try { listener(operation, error); } catch {}
  });
}

export function setIndexedDBUserId(userId: string | null): void {
  if (session.userId !== userId) replaceSession(userId);
}

function openDB(owner: StorageSession): Promise<Connection> {
  assertCurrent(owner);
  if (!isIndexedDBAvailable()) {
    let fallback = fallbacks.get(owner.dbName);
    if (!fallback) { fallback = new Map(); fallbacks.set(owner.dbName, fallback); }
    return Promise.resolve({ fallback });
  }
  if (owner.db) return Promise.resolve(owner.db);
  if (owner.opening) return owner.opening;

  const opening = new Promise<Connection>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      owner.cancel.delete(cancel);
      reject(error);
    };
    const cancel = () => fail(new StaleStorageOperation());
    owner.cancel.add(cancel);
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(owner.dbName, DB_VERSION); }
    catch (error) { fail(error); return; }

    request.onupgradeneeded = () => {
      if (settled || !isCurrent(owner) || deletions.has(owner.dbName)) {
        request.transaction?.abort();
        cancel();
        return;
      }
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
          const store = db.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });
          store.createIndex('group_id', 'group_id', { unique: false });
          store.createIndex('created_at', 'created_at', { unique: false });
        }
      } catch (error) {
        request.transaction?.abort();
        fail(error);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled || !isCurrent(owner) || deletions.has(owner.dbName)) {
        db.close();
        cancel();
        return;
      }
      owner.db = db;
      const release = () => {
        // A delayed close/versionchange on an old handle cannot retire a newer
        // connection, even after A -> B -> A or a same-account cache clear.
        if (owner.db === db && isCurrent(owner)) replaceSession(owner.userId);
        else db.close();
      };
      db.onclose = release;
      db.onversionchange = release;
      // Database error events bubble from transactions. Do not discard a healthy
      // shared handle because one operation failed; its transaction reports it.
      settled = true;
      owner.cancel.delete(cancel);
      resolve(db);
    };
    request.onerror = () => fail(request.error || new Error('Could not open the database'));
    request.onblocked = () => fail(new Error('Opening the database is blocked by another connection'));
  });
  owner.opening = opening;
  const clearOpening = () => { if (owner.opening === opening) owner.opening = undefined; };
  void opening.then(clearOpening, clearOpening);
  return opening;
}

function transact<T>(owner: StorageSession, db: IDBDatabase, mode: IDBTransactionMode,
  initial: T, run: (store: IDBObjectStore, value: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  assertCurrent(owner);
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(MESSAGE_STORE, mode);
    let value = initial;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      owner.cancel.delete(cancel);
      // This also prevents a synchronous put/cursor error from partially
      // committing an earlier successful write in the same batch.
      try { tx.abort(); } catch {}
      reject(error);
    };
    const cancel = () => fail(new StaleStorageOperation());
    owner.cancel.add(cancel);
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      owner.cancel.delete(cancel);
      if (isCurrent(owner)) resolve(value);
      else reject(new StaleStorageOperation());
    };
    tx.onerror = () => fail(tx.error || new Error('The database transaction failed'));
    tx.onabort = () => fail(tx.error || new Error('The database transaction was aborted'));
    try { run(tx.objectStore(MESSAGE_STORE), result => { value = result; }, fail); }
    catch (error) { fail(error); }
  });
}

function unconfirmed(message: Message): boolean {
  return message.status === 'failed' || message.status === 'sending';
}

function sorted(messages: Message[]): Message[] {
  return messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

export async function saveMessagesToIndexedDB(messages: Message[]): Promise<boolean> {
  if (messages.length === 0) return true;
  const owner = session;
  try {
    // Freeze values before opening the database yields to another edit/session.
    const copies = structuredClone(messages);
    const result = await openDB(owner);
    assertCurrent(owner);
    if ('fallback' in result) {
      for (const msg of copies) result.fallback.set(msg.id, msg);
    } else {
      await transact(owner, result, 'readwrite', undefined, store => {
        for (const msg of copies) store.put(msg);
      });
      assertCurrent(owner);
    }
    return true;
  } catch (error) {
    notifyStorageError('save', error);
    return false;
  }
}

export async function deleteMessageFromIndexedDB(messageId: string): Promise<boolean> {
  const owner = session;
  try {
    const result = await openDB(owner);
    assertCurrent(owner);
    if ('fallback' in result) result.fallback.delete(messageId);
    else {
      await transact(owner, result, 'readwrite', undefined, store => { store.delete(messageId); });
      assertCurrent(owner);
    }
    return true;
  } catch (error) {
    notifyStorageError('delete_one', error);
    return false;
  }
}

export async function loadMessagesFromIndexedDB(groupId: string): Promise<Message[]> {
  const owner = session;
  try {
    const result = await openDB(owner);
    assertCurrent(owner);
    let messages: Message[];
    if ('fallback' in result) {
      messages = structuredClone([...result.fallback.values()].filter(msg => msg.group_id === groupId));
    } else {
      messages = await transact<Message[]>(owner, result, 'readonly', [], (store, value, fail) => {
        const request = store.index('group_id').getAll(groupId);
        request.onsuccess = () => { value(request.result); };
        request.onerror = () => fail(request.error || new Error('Could not read messages'));
      });
      assertCurrent(owner);
    }
    const drafts = messages.filter(unconfirmed);
    const recent = sorted(messages.filter(message => !unconfirmed(message))).slice(-MAX_MESSAGES_PER_GROUP);
    return sorted([...drafts, ...recent]);
  } catch (error) {
    notifyStorageError('load', error);
    return [];
  }
}

export async function clearOldMessagesFromIndexedDB(groupId: string, keepCount: number = MAX_MESSAGES_PER_GROUP): Promise<boolean> {
  const owner = session;
  try {
    if (!Number.isSafeInteger(keepCount) || keepCount < 0) throw new Error('keepCount must be a nonnegative integer');
    const result = await openDB(owner);
    assertCurrent(owner);
    const oldMessages = (messages: Message[]) => {
      const confirmed = sorted(messages.filter(message => !unconfirmed(message)));
      return confirmed.slice(0, Math.max(0, confirmed.length - keepCount));
    };
    if ('fallback' in result) {
      for (const msg of oldMessages([...result.fallback.values()].filter(msg => msg.group_id === groupId))) result.fallback.delete(msg.id);
    } else {
      await transact(owner, result, 'readwrite', undefined, (store, _value, fail) => {
        const request = store.index('group_id').getAll(groupId);
        request.onsuccess = () => {
          try {
            assertCurrent(owner);
            // Enqueue deletes inside the request event while the transaction is
            // active, rather than after an await/microtask in strict engines.
            for (const msg of oldMessages(request.result)) store.delete(msg.id);
          } catch (error) { fail(error); }
        };
        request.onerror = () => fail(request.error || new Error('Could not read old messages'));
      });
      assertCurrent(owner);
    }
    return true;
  } catch (error) {
    notifyStorageError('clear_old', error);
    return false;
  }
}

export async function clearAllMessagesFromIndexedDB(groupId: string): Promise<boolean> {
  const owner = session;
  try {
    const result = await openDB(owner);
    assertCurrent(owner);
    if ('fallback' in result) {
      for (const [id, msg] of result.fallback) if (msg.group_id === groupId) result.fallback.delete(id);
    } else {
      await transact(owner, result, 'readwrite', undefined, (store, _value, fail) => {
        const request = store.index('group_id').openCursor(groupId);
        request.onsuccess = () => {
          try {
            assertCurrent(owner);
            const cursor = request.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
          } catch (error) { fail(error); }
        };
        request.onerror = () => fail(request.error || new Error('Could not clear messages'));
      });
      assertCurrent(owner);
    }
    return true;
  } catch (error) {
    notifyStorageError('clear_all', error);
    return false;
  }
}

export async function clearAllIndexedDBForUser(userId?: string): Promise<boolean> {
  const dbName = userId === undefined ? session.dbName : dbNameFor(userId);
  if (session.dbName === dbName) replaceSession(session.userId);
  fallbacks.delete(dbName);
  const existing = deletions.get(dbName);
  if (existing) return existing;
  if (!isIndexedDBAvailable()) {
    // The in-memory copy is gone, but without the API we cannot attest that an
    // older persistent database (for example from another visit) was removed.
    notifyStorageError('clear_user', new Error('IndexedDB is unavailable; persistent database deletion could not be verified'));
    return false;
  }

  let finish!: (result: boolean) => void;
  const outcome = new Promise<boolean>(resolve => { finish = resolve; });
  deletions.set(dbName, outcome);
  const release = () => { if (deletions.get(dbName) === outcome) deletions.delete(dbName); };
  const fail = (error: unknown) => { notifyStorageError('clear_user', error); finish(false); };
  try {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => { release(); finish(true); };
    request.onerror = () => { release(); fail(request.error || new Error('Could not delete the database')); };
    request.onblocked = () => {
      fail(new Error('Database deletion is blocked by another connection; close other tabs before retrying'));
      // No retry timer: this exact request remains pending in the browser. Its
      // eventual success/error releases the fence, never mutating other sessions.
    };
  } catch (error) { release(); fail(error); }
  return outcome;
}
