import { types } from 'node:util';

// Account-scoped write locks serialize writers. This separate read fence may
// nest across a caller, registry, and adapter without blocking the writer.
// Every write/create holds it before capture through ACK and final lease checks.
// Reads already in flight may fail and revoke authority, but cannot publish a
// stale success; new reads wait until all enclosing write fences are released.
const pendingWrites = new WeakMap();
const generations = new WeakMap();
const generation = db => generations.get(db) || 0;

export function beginUserDbWriteBarrier(db) {
  let finish;
  const barrier = new Promise(resolve => { finish = resolve; });
  const pending = pendingWrites.get(db) || new Set();
  pending.add(barrier); pendingWrites.set(db, pending);
  generations.set(db, generation(db) + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    generations.set(db, generation(db) + 1);
    pending.delete(barrier); finish();
  };
}
async function waitForWrites(db) {
  while (pendingWrites.get(db)?.size) await Promise.all([...pendingWrites.get(db)]);
}

// Read into a local value. Only publish it if it did not cross a writer's
// generation; discarded reads never touch shared data or the CAS revision.
export async function readWithWriteBarrier(db, read, publish) {
  for (;;) {
    await waitForWrites(db);
    const started = generation(db);
    const value = await read();
    if (started !== generation(db) || pendingWrites.get(db)?.size) continue;
    // No await is allowed between lease verification, publication, and the
    // adapter's synchronous onPublished hook. A hook can capture the committed
    // pair and put its release function in a caller-owned finally slot.
    db.assertCurrentLease?.();
    publish(value);
    return;
  }
}

export async function readCommittedUserDb(db, project) {
  for (;;) {
    await waitForWrites(db);
    const started = generation(db);
    await db.read();
    if (started !== generation(db) || pendingWrites.get(db)?.size) continue;
    // Project synchronously and detach before an await lets a writer mutate
    // the shared instance. This copies only the small model/catalog result.
    return structuredClone(project(db.data));
  }
}

// These hooks are internal synchronous commit-fence hooks, not an asynchronous
// callback API. Reject obvious async functions before starting storage I/O.
const asyncPublishHook = () => Object.assign(new TypeError('onPublished hook must complete synchronously, not return a promise or thenable'), { code: 'ASYNC_PUBLISH_HOOK' });
export function assertSynchronousPublishHook(hook) {
  if (hook === undefined) return;
  if (typeof hook !== 'function') throw new TypeError('onPublished must be a synchronous function');
  if (types.isAsyncFunction(hook) || types.isGeneratorFunction(hook)) throw asyncPublishHook();
}
export function runSynchronousPublishHook(hook, snapshot) {
  if (hook === undefined) return;
  const result = hook(snapshot);
  if (types.isPromise(result)) {
    // The unsupported callback has already returned. Observe a native promise
    // rejection to avoid an unhandled rejection, but never await or run an
    // arbitrary thenable, and never acknowledge the read as successful.
    Promise.prototype.then.call(result, undefined, () => {});
    throw asyncPublishHook();
  }
  if (result != null && typeof result.then === 'function') throw asyncPublishHook();
}

export function assertExplicitDbSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(snapshot))) {
    throw Object.assign(new TypeError('Explicit database snapshot must be a non-null plain object'), { code: 'INVALID_DB_SNAPSHOT' });
  }
}
