// Synthetic committed-storage event driver only. It is not browser IndexedDB.
// Real WebCrypto is supplied separately by the tests using node:crypto.webcrypto.
export class SyntheticIndexedDB {
  data = new Map(); opens = []; writes = []; held = new Map(); failOpen = false; failWrite = false;
  holdOpen(name) { this.held.set(name, []); }
  releaseOpen(name) { const callbacks = this.held.get(name) || []; this.held.delete(name); callbacks.forEach(fn => fn()); }
  open(name) {
    const request = { result: null, error: null, transaction: null };
    this.opens.push(name);
    const run = () => setTimeout(() => {
      if (this.failOpen) { request.error = new Error('synthetic open failure'); request.onerror?.(); return; }
      const exists = this.data.has(name); if (!exists) this.data.set(name, new Map());
      const db = this.connection(name); request.result = db;
      if (!exists) {
        let aborted = false;
        request.transaction = { abort: () => { aborted = true; } };
        request.onupgradeneeded?.();
        if (aborted) { this.data.delete(name); request.error = new Error('synthetic upgrade aborted'); request.onerror?.(); return; }
      }
      request.onsuccess?.();
    }, 0);
    if (this.held.has(name)) this.held.get(name).push(run); else run();
    return request;
  }
  connection(name) {
    const factory = this; let closed = false;
    return { name, objectStoreNames: { contains: key => factory.data.get(name)?.has(key) || false },
      createObjectStore(key) { factory.data.get(name).set(key, new Map()); return { createIndex() {} }; },
      close() { closed = true; },
      transaction(storeName, mode) {
        if (closed) throw new Error('synthetic connection closed');
        const persisted = factory.data.get(name)?.get(storeName); if (!persisted) throw new Error('missing synthetic store');
        let pending = 0, aborted = false, settled = false, completeTimer;
        const staged = new Map(persisted);
        const tx = { error: null, db: this, mode,
          abort() { if (settled) return; aborted = true; clearTimeout(completeTimer); setTimeout(() => { tx.onabort?.(); }, 0); },
          objectStore() {
            const request = (read, write = false) => {
              const req = { result: undefined, error: null }; pending++; clearTimeout(completeTimer);
              setTimeout(() => {
                if (aborted) return;
                if (write && factory.failWrite) { req.error = tx.error = new Error('synthetic quota failure'); req.onerror?.(); tx.onerror?.(); tx.abort(); return; }
                req.result = read(); req.onsuccess?.(); pending--; finish();
              }, 0); return req;
            };
            return {
              get(key) { return request(() => structuredClone(staged.get(key))); },
              put(value, key = value.id) { return request(() => { staged.set(key, structuredClone(value)); factory.writes.push({ name, storeName, key }); return key; }, true); },
              delete(key) { return request(() => staged.delete(key), true); },
              index() { return { getAll(group) { return request(() => [...staged.values()].filter(row => row.group_id === group).map(row => structuredClone(row))); } }; },
            };
          },
        };
        function finish() { if (pending || aborted || settled) return; completeTimer = setTimeout(() => { if (pending || aborted || settled) return; settled = true; if (mode === 'readwrite') { persisted.clear(); for (const [key,value] of staged) persisted.set(key,value); } tx.oncomplete?.(); }, 0); }
        finish(); return tx;
      },
    };
  }
}
