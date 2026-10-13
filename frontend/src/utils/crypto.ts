const ALGORITHM = 'AES-GCM';
const KEY_STORE_NAME = 'encryption_keys';
const KEY_DB_NAME_PREFIX = 'ai-chat-crypto';
const KEY_DB_VERSION = 1;

let keyDb: IDBDatabase | null = null;
let currentUserId: string | null = null;
// Cache ownership fences asynchronous work independently of the legacy key DB.
// Production has always used the global key DB; preserve its existing bytes.
let cacheOwnerId: string | null = null;
const activeKeyWrites = new Set<IDBTransaction>();
let memoryKey: CryptoKey | null = null;
let keyEpoch = 0;
let opening: Promise<IDBDatabase> | null = null;
let keyFlight: { epoch: number; promise: Promise<CryptoKey | null> } | null = null;

function getKeyDbName(): string {
  return currentUserId ? `${KEY_DB_NAME_PREFIX}-${currentUserId}` : KEY_DB_NAME_PREFIX;
}

function assertEpoch(epoch: number): void {
  if (epoch !== keyEpoch) throw new Error('Crypto account changed');
}

function retireKeySession(): void {
  keyEpoch++;
  for (const tx of activeKeyWrites) { try { tx.abort(); } catch {} }
  activeKeyWrites.clear();
  if (keyDb) { try { keyDb.close(); } catch {} }
  keyDb = null;
  opening = null;
  keyFlight = null;
  memoryKey = null;
}

function setCryptoUserId(userId: string | null): void {
  if (currentUserId !== userId) { retireKeySession(); currentUserId = userId; }
}

export function bindCryptoCacheOwner(userId: string | null): void {
  if (cacheOwnerId !== userId) { retireKeySession(); cacheOwnerId = userId; }
}

// A read-only recovery/proof never creates a replacement key database.
function openKeyDB(epoch: number, allowCreate: boolean, independent = false): Promise<IDBDatabase> {
  assertEpoch(epoch);
  if (!independent && keyDb) return Promise.resolve(keyDb);
  if (!independent && opening) return opening;
  const name = getKeyDbName();
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    const request = indexedDB.open(name, KEY_DB_VERSION);
    request.onupgradeneeded = () => {
      if (settled || epoch !== keyEpoch || !allowCreate) { request.transaction?.abort(); return; }
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) db.createObjectStore(KEY_STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled || epoch !== keyEpoch) { db.close(); fail(new Error('Crypto account changed')); return; }
      if (!independent) {
        keyDb = db;
        const release = () => { if (keyDb === db) { keyDb = null; memoryKey = null; } };
        db.onclose = release;
        db.onversionchange = () => { db.close(); release(); };
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => fail(request.error || new Error('Key database unavailable'));
    request.onblocked = () => fail(new Error('Key database blocked'));
  });
  if (!independent) {
    opening = promise;
    const clear = () => { if (opening === promise) opening = null; };
    void promise.then(clear, clear);
  }
  return promise;
}

interface KeyRecord { wrapped: ArrayBuffer | null; material: ArrayBuffer | null }
function readKeyRecord(db: IDBDatabase, epoch: number): Promise<KeyRecord> {
  assertEpoch(epoch);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readonly');
    const store = tx.objectStore(KEY_STORE_NAME);
    const record: KeyRecord = { wrapped: null, material: null };
    const master = store.get('master_key');
    const material = store.get('wrapping_key_material');
    master.onsuccess = () => { record.wrapped = master.result || null; };
    material.onsuccess = () => { record.material = material.result || null; };
    tx.oncomplete = () => { try { assertEpoch(epoch); resolve(record); } catch (error) { reject(error); } };
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Key read failed'));
  });
}

async function importWrappingKey(material: ArrayBuffer): Promise<CryptoKey> {
  return window.crypto.subtle.importKey('raw', material, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
}

async function unwrap(record: KeyRecord): Promise<CryptoKey> {
  if (!record.wrapped || !record.material) throw new Error('Existing encryption key unavailable');
  const wrappingKey = await importWrappingKey(record.material);
  return window.crypto.subtle.unwrapKey('raw', record.wrapped, wrappingKey,
    { name: 'AES-KW' }, { name: ALGORITHM, length: 256 }, false, ['encrypt', 'decrypt']);
}

async function getKey(allowCreate: boolean): Promise<CryptoKey | null> {
  const epoch = keyEpoch;
  if (memoryKey) return memoryKey;
  // Read-only decryption has no key-creation authority, including through a
  // concurrent encryption flight. Inspect only an already committed key pair.
  if (!allowCreate) {
    let db: IDBDatabase | null = null;
    try {
      db = await openKeyDB(epoch, false, true);
      const key = await unwrap(await readKeyRecord(db, epoch));
      assertEpoch(epoch);
      memoryKey = key;
      return key;
    } catch { return null; }
    finally { db?.close(); }
  }
  if (keyFlight?.epoch === epoch) return keyFlight.promise;
  const promise = (async () => {
    try {
      const db = await openKeyDB(epoch, allowCreate);
      assertEpoch(epoch);
      let record = await readKeyRecord(db, epoch);
      assertEpoch(epoch);
      if (!record.wrapped) {
        if (!allowCreate || record.material) return null;
        const newKey = await window.crypto.subtle.generateKey({ name: ALGORITHM, length: 256 }, true, ['encrypt', 'decrypt']);
        assertEpoch(epoch);
        const material = record.material || window.crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer;
        const wrappingKey = await importWrappingKey(material);
        assertEpoch(epoch);
        const wrapped = await window.crypto.subtle.wrapKey('raw', newKey, wrappingKey, { name: 'AES-KW' });
        assertEpoch(epoch);
        // The existing on-disk AES format and key names are unchanged. Only a
        // deliberate first encryption may create keys, in a committed transaction.
        record = await new Promise<KeyRecord>((resolve, reject) => {
          const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
          activeKeyWrites.add(tx);
          const store = tx.objectStore(KEY_STORE_NAME);
          let chosen: KeyRecord = { wrapped: null, material: null };
          const masterRequest = store.get('master_key');
          const materialRequest = store.get('wrapping_key_material');
          masterRequest.onsuccess = () => { chosen.wrapped = masterRequest.result || null; };
          materialRequest.onsuccess = () => {
            try {
              assertEpoch(epoch);
              chosen.material = materialRequest.result || null;
              // IndexedDB serializes readwrite transactions across tabs. Recheck
              // within this same transaction, before any put, so a late first
              // creator uses the existing pair instead of rotating it.
              if (chosen.wrapped && chosen.material) return;
              if (chosen.wrapped || chosen.material) { tx.abort(); return; }
              chosen = { wrapped, material };
              store.put(material, 'wrapping_key_material');
              store.put(wrapped, 'master_key');
            } catch { tx.abort(); }
          };
          tx.oncomplete = () => { activeKeyWrites.delete(tx); try { assertEpoch(epoch); resolve(chosen); } catch (error) { reject(error); } };
          tx.onerror = tx.onabort = () => { activeKeyWrites.delete(tx); reject(tx.error || new Error('Key write failed')); };
        });
        assertEpoch(epoch);
      }
      const key = await unwrap(record);
      assertEpoch(epoch);
      memoryKey = key;
      return key;
    } catch { return null; }
  })();
  keyFlight = { epoch, promise };
  const clear = () => { if (keyFlight?.promise === promise) keyFlight = null; };
  void promise.then(clear, clear);
  return promise;
}

let legacyKeyMigrationDone = false;

function migrateOldLocalStorageKey(): void {
  if (legacyKeyMigrationDone) {
    return;
  }
  legacyKeyMigrationDone = true;

  const OLD_GLOBAL_KEY = 'app_cache_key';
  const userId = typeof window !== 'undefined' ? localStorage.getItem('app_current_user_id') : null;
  const storageKey = userId ? `app_cache_key_${userId}` : OLD_GLOBAL_KEY;

  try {
    const oldKey = localStorage.getItem(storageKey);
    if (oldKey) {
      localStorage.removeItem(storageKey);
      localStorage.removeItem(OLD_GLOBAL_KEY);
      if (import.meta.env.DEV) {
        console.log('[Crypto] Removed legacy localStorage key, new key stored in IndexedDB');
      }
    }
  } catch {}
}

export async function encryptData(data: string): Promise<string | null> {
  migrateOldLocalStorageKey();
  const epoch = keyEpoch;
  const key = await getKey(true);
  if (!key || epoch !== keyEpoch) return null;

  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);

  const encrypted = await window.crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoded
  );

  if (epoch !== keyEpoch) return null;
  const result = {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted))
  };

  return JSON.stringify(result);
}

export async function decryptData(encrypted: string): Promise<string | null> {
  const epoch = keyEpoch;
  const key = await getKey(false);
  if (!key || epoch !== keyEpoch) return null;

  try {
    const { iv, data } = JSON.parse(encrypted);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: ALGORITHM, iv: new Uint8Array(iv) },
      key,
      new Uint8Array(data)
    );

    if (epoch !== keyEpoch) return null;
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    console.error('解密失败:', e);
    return null;
  }
}

// Cold proof: bypass both the memory key and the ordinary cache mirror. This
// reads the actual existing key DB and never generates/exports/replaces keys.
// Ownership is the cache namespace/session, not a claim of per-owner key isolation.
export async function decryptDataWithPersistedKey(encrypted: string, owner: string): Promise<string | null> {
  if (!owner || owner !== cacheOwnerId) return null;
  const epoch = keyEpoch;
  let db: IDBDatabase | null = null;
  try {
    db = await openKeyDB(epoch, false, true);
    const record = await readKeyRecord(db, epoch);
    const key = await unwrap(record);
    assertEpoch(epoch);
    const { iv, data } = JSON.parse(encrypted);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: ALGORITHM, iv: new Uint8Array(iv) }, key, new Uint8Array(data));
    assertEpoch(epoch);
    return new TextDecoder().decode(decrypted);
  } catch { return null; }
  finally { db?.close(); }
}

export { setCryptoUserId };
