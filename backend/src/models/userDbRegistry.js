// One active database instance per account. Retirement is permanent for old
// callers: they must not silently replay a request against a replacement store.
export function createUserDbRegistry({ maxSize = 50, isLocked = () => false, onEvict = () => {} } = {}) {
  const cache = new Map();
  const loading = new Map();
  const leases = new WeakMap();
  const drainingWrites = new Map();

  const changed = cause => Object.assign(new Error('存储状态已改变，结果需重新核对，请刷新后再继续'), {
    code: 'USER_DB_REPLACED', status: 503, statusCode: 503, isOperational: true,
    ...(cause ? { cause } : {})
  });
  const assertCurrent = token => { if (token.retired) throw changed(); };
  const retire = token => {
    if (!token || token.retired) return;
    token.retired = true;
    // An already-started I/O cannot be cancelled safely. Fence the replacement
    // loader until it settles, then read durable truth rather than an old cache.
    for (const write of token.writes) {
      const pending = drainingWrites.get(token.userId) || new Set();
      pending.add(write); drainingWrites.set(token.userId, pending);
      void write.then(() => {
        pending.delete(write);
        if (!pending.size && drainingWrites.get(token.userId) === pending) drainingWrites.delete(token.userId);
      });
    }
  };
  const evict = () => {
    if (cache.size <= maxSize) return;
    const oldest = [...cache].sort((a, b) => (a[1]._lastAccess || 0) - (b[1]._lastAccess || 0));
    let removed = 0;
    for (const [userId, db] of oldest) {
      if (cache.size <= maxSize) break;
      const token = leases.get(db);
      if (isLocked(userId) || loading.has(userId) || token?.writes.size) continue;
      retire(token); cache.delete(userId); removed++;
    }
    if (removed) onEvict(removed);
  };
  const protect = (db, token) => {
    assertCurrent(token);
    leases.set(db, token);
    db.assertCurrentLease = () => assertCurrent(token);
    const read = db.read.bind(db), write = db.write.bind(db);
    db.read = async (...args) => {
      assertCurrent(token);
      try {
        const result = await read(...args);
        assertCurrent(token);
        return result;
      } catch (error) {
        if (token.retired) throw changed(error);
        throw error;
      }
    };
    db.write = async (...args) => {
      assertCurrent(token);
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      token.writes.add(pending);
      try {
        const result = await write(...args);
        assertCurrent(token);
        return result;
      } catch (error) {
        if (token.retired) throw changed(error);
        throw error;
      } finally {
        token.writes.delete(pending); finish();
      }
    };
    return db;
  };

  return {
    cache,
    async get(userId, load) {
      const existing = cache.get(userId);
      if (existing) { existing._lastAccess = Date.now(); return existing; }
      if (loading.has(userId)) return loading.get(userId).promise;
      const token = { userId, retired: false, writes: new Set() };
      const entry = { token, promise: null };
      loading.set(userId, entry);
      entry.promise = (async () => {
        try {
          while (drainingWrites.get(userId)?.size) {
            await Promise.all([...drainingWrites.get(userId)]);
            assertCurrent(token);
          }
          assertCurrent(token);
          const db = await load(candidate => protect(candidate, token));
          assertCurrent(token);
          db._lastAccess = Date.now();
          cache.set(userId, db);
          evict();
          return db;
        } catch (error) {
          retire(token);
          throw error;
        } finally {
          // A cleared old loader may finish after a new flight has started.
          if (loading.get(userId) === entry) loading.delete(userId);
        }
      })();
      return entry.promise;
    },
    clear(userId) {
      const ids = userId ? [userId] : [...new Set([...cache.keys(), ...loading.keys()])];
      for (const id of ids) {
        retire(leases.get(cache.get(id)));
        retire(loading.get(id)?.token);
        cache.delete(id); loading.delete(id);
      }
    }
  };
}
