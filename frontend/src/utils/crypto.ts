const ALGORITHM = 'AES-GCM';
const KEY_STORE_NAME = 'encryption_keys';
const KEY_DB_NAME_PREFIX = 'ai-chat-crypto';
const KEY_DB_VERSION = 1;

let keyDb: IDBDatabase | null = null;
let currentUserId: string | null = null;
let memoryKey: CryptoKey | null = null;

function getKeyDbName(): string {
  return currentUserId ? `${KEY_DB_NAME_PREFIX}-${currentUserId}` : KEY_DB_NAME_PREFIX;
}

function setCryptoUserId(userId: string | null): void {
  if (currentUserId !== userId) {
    if (keyDb) {
      try { keyDb.close(); } catch {}
      keyDb = null;
    }
    memoryKey = null;
    currentUserId = userId;
  }
}

async function openKeyDB(): Promise<IDBDatabase> {
  if (keyDb) return keyDb;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(getKeyDbName(), KEY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      keyDb = request.result;
      keyDb.onclose = () => { keyDb = null; memoryKey = null; };
      keyDb.onerror = () => { keyDb = null; memoryKey = null; };
      resolve(keyDb);
    };
    request.onerror = () => reject(request.error);
  });
}

async function storeWrappedKey(wrappedKey: ArrayBuffer): Promise<void> {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(KEY_STORE_NAME);
    store.put(wrappedKey, 'master_key');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadWrappedKey(): Promise<ArrayBuffer | null> {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readonly');
    const store = tx.objectStore(KEY_STORE_NAME);
    const request = store.get('master_key');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readonly');
    const store = tx.objectStore(KEY_STORE_NAME);
    const request = store.get('wrapping_key_material');
    request.onsuccess = async () => {
      try {
        let material: Uint8Array;
        if (request.result) {
          material = new Uint8Array(request.result);
        } else {
          material = window.crypto.getRandomValues(new Uint8Array(32));
          const writeTx = db.transaction(KEY_STORE_NAME, 'readwrite');
          const writeStore = writeTx.objectStore(KEY_STORE_NAME);
          writeStore.put(material.buffer as ArrayBuffer, 'wrapping_key_material');
          await new Promise<void>((res, rej) => {
            writeTx.oncomplete = () => res();
            writeTx.onerror = () => rej(writeTx.error);
          });
        }
        const wrappingKey = await window.crypto.subtle.importKey(
          'raw',
          material.buffer as ArrayBuffer,
          { name: 'AES-KW' },
          false,
          ['wrapKey', 'unwrapKey']
        );
        resolve(wrappingKey);
      } catch (e) {
        reject(e);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

async function getKey(): Promise<CryptoKey | null> {
  if (memoryKey) return memoryKey;

  try {
    const wrappedKey = await loadWrappedKey();
    if (wrappedKey) {
      const wrappingKey = await getOrCreateWrappingKey();
      const key = await window.crypto.subtle.unwrapKey(
        'raw',
        wrappedKey,
        wrappingKey,
        { name: 'AES-KW' },
        { name: ALGORITHM, length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      memoryKey = key;
      return key;
    }

    const newKey = await window.crypto.subtle.generateKey(
      { name: ALGORITHM, length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const wrappingKey = await getOrCreateWrappingKey();
    const wrapped = await window.crypto.subtle.wrapKey(
      'raw',
      newKey,
      wrappingKey,
      { name: 'AES-KW' }
    );
    await storeWrappedKey(wrapped);

    const nonExtractableKey = await window.crypto.subtle.unwrapKey(
      'raw',
      wrapped,
      wrappingKey,
      { name: 'AES-KW' },
      { name: ALGORITHM, length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    memoryKey = nonExtractableKey;
    return nonExtractableKey;
  } catch (e) {
    console.error('密钥获取失败:', e);
    return null;
  }
}

function migrateOldLocalStorageKey(): void {
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
  const key = await getKey();
  if (!key) return null;

  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);

  const encrypted = await window.crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoded
  );

  const result = {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted))
  };

  return JSON.stringify(result);
}

export async function decryptData(encrypted: string): Promise<string | null> {
  migrateOldLocalStorageKey();
  const key = await getKey();
  if (!key) return null;

  try {
    const { iv, data } = JSON.parse(encrypted);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: ALGORITHM, iv: new Uint8Array(iv) },
      key,
      new Uint8Array(data)
    );

    return new TextDecoder().decode(decrypted);
  } catch (e) {
    console.error('解密失败:', e);
    return null;
  }
}

export { setCryptoUserId };
