// Account-scoped write locks serialize writers. This separate, non-reentrant
// barrier keeps asynchronous readers from publishing pre-commit snapshots or
// overwriting a newer shared data/CAS revision after a paid-probe commit.
const pendingWrites = new WeakMap();
const generations = new WeakMap();
const generation = db => generations.get(db) || 0;

export function beginUserDbWriteBarrier(db) {
  let finish;
  const barrier = new Promise(resolve => { finish = resolve; });
  const pending = pendingWrites.get(db) || new Set();
  pending.add(barrier); pendingWrites.set(db, pending);
  generations.set(db, generation(db) + 1);
  return () => {
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
