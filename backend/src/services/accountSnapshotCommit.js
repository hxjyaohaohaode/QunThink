import { types } from 'node:util';
import { getUserDb, withWriteLock } from '../models/db.js';
import { beginUserDbWriteBarrier, assertExplicitDbSnapshot } from '../models/readBarrier.js';

const MAX_CAS_REBUILDS = 2;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const unknown = cause => Object.assign(new Error('消息提交结果暂无法确认，请保留原请求并核验，勿重新生成', { cause }), {
  code: 'MESSAGE_COMMIT_UNKNOWN', status: 503, statusCode: 503, isOperational: true
});
const asyncCallback = () => Object.assign(new TypeError('Account commit compose/confirm callbacks must be synchronous'), { code: 'ASYNC_COMMIT_CALLBACK' });

function freezeIntent(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('PreparedIntent must contain only plain data');
  }
  seen.add(value);
  for (const child of Object.values(value)) freezeIntent(child, seen);
  return Object.freeze(value);
}
function requireSync(callback) {
  if (typeof callback !== 'function') throw new TypeError('A synchronous account commit callback is required');
  if (types.isAsyncFunction(callback) || types.isGeneratorFunction(callback)) throw asyncCallback();
}
function callSync(callback, input) {
  const result = callback(input);
  if (types.isPromise(result)) {
    Promise.prototype.then.call(result, undefined, () => {});
    throw asyncCallback();
  }
  if (result != null && typeof result.then === 'function') throw asyncCallback();
  return result;
}

/**
 * Commit one already-prepared account change. No model calls, broadcasts,
 * responses, UUID generation or encryption belong inside these callbacks.
 *
 * prepared: plain data copied/frozen before the first await (IDs, timestamps,
 * ciphertext and original request hashes must already be final).
 * authorize({snapshot, prepared, attempt, confirming}): optional async current
 * permission/source/cancellation check. Its snapshot is disposable: mutating
 * attachment projections cannot affect the committed baseline or candidate.
 * Existing ledger-aware source helpers need the real adapter prototype. Use
 * Object.assign(Object.create(db), {data: snapshot}) as their read-only view so
 * implicit files and explicit groups/messages all come from this detached copy.
 * Never invoke read/write on that view or read db again inside the fence.
 * compose({snapshot, prepared, authorization, attempt}): synchronous pure
 * builder returning {snapshot, result}, or {readOnly: true, result} for an
 * already-existing verified receipt. Each CAS rebuild receives a fresh clone.
 * confirm({snapshot, prepared, authorization, attempt, confirming: true}):
 * synchronous proof of the same original ID/hash/receipt, returning
 * {confirmed: true, result} or null. Throw the domain's 409/410/404 for a
 * mismatched intent, consumed ID or revoked source. Absence is never a retry.
 *
 * Returns {result, disposition: 'committed'|'existing'|'recovered'} only after
 * the entire account lock, including its final PostgreSQL lease verification,
 * succeeds. Callers may dispatch creation side effects only for 'committed'.
 * Only explicit REVISION_CONFLICT rebuilds (at most twice); unknown outcomes
 * get one authoritative reconciliation in a new full lock, never another write.
 */
export async function commitAccountSnapshot({ userId, db: suppliedDb, prepared, authorize, compose, confirm }) {
  // This capture intentionally precedes getUserDb, lock acquisition and every
  // other await. The caller cannot change a paid/prepared intent while queued.
  assertExplicitDbSnapshot(prepared);
  const fixed = freezeIntent(structuredClone(prepared));
  requireSync(compose);
  if (confirm !== undefined) requireSync(confirm);
  if (authorize !== undefined && typeof authorize !== 'function') throw new TypeError('authorize must be a function');
  if (typeof userId !== 'string' || !userId) throw new TypeError('userId is required');
  const db = suppliedDb || await getUserDb(userId);
  const releaseLease = db.holdCurrentLease?.();
  let releaseBarrier;
  let attemptedWrite = false;
  let attempt = 0;
  const releaseFence = () => { const release = releaseBarrier; releaseBarrier = undefined; release?.(); };
  const invalidate = () => { db.invalidateReadCache?.(); };

  async function readFenced() {
    let captured;
    // The local slot remains visible to the outer finally even when a registry
    // post-read lease check fails after the hook has established the fence.
    await db.read({ force: true, onPublished: published => {
      releaseBarrier = beginUserDbWriteBarrier(db);
      captured = { snapshot: structuredClone(published.data), revision: published.revision };
    } });
    if (!captured) throw new TypeError('Account adapter did not publish a synchronous snapshot');
    return captured;
  }
  async function authorized(snapshot, confirming) {
    db.assertCurrentLease?.();
    const value = authorize ? await authorize({ snapshot: structuredClone(snapshot), prepared: fixed, attempt, confirming }) : undefined;
    db.assertCurrentLease?.();
    return structuredClone(value);
  }

  try {
    let outcome, uncertainCause;
    try {
      outcome = await withWriteLock(userId, async () => {
        for (;;) {
          let baseline, authorization, composed, result;
          try {
            baseline = await readFenced();
            authorization = await authorized(baseline.snapshot, false);
            composed = callSync(compose, { snapshot: structuredClone(baseline.snapshot), prepared: fixed, authorization, attempt });
            if (!composed || typeof composed !== 'object' || !own(composed, 'result')) throw new TypeError('compose must return an explicit result');
            result = structuredClone(composed.result);
            if (composed.readOnly === true) {
              if (own(composed, 'snapshot')) throw new TypeError('Read-only composition cannot include a write snapshot');
              return { value: { result, disposition: 'existing' } };
            }
            assertExplicitDbSnapshot(composed.snapshot);
          } catch (error) {
            // Keep domain failures inside the callback until the outer lease
            // succeeds; the PG ledger otherwise relabels non-operational errors.
            return { error };
          }
          try {
            db.assertCurrentLease?.();
            attemptedWrite = true;
            await db.write({ snapshot: composed.snapshot, expectedRevision: baseline.revision });
            return { value: { result, disposition: 'committed' } };
          } catch (error) {
            if (error?.code !== 'REVISION_CONFLICT') return { uncertain: error };
            if (attempt >= MAX_CAS_REBUILDS) return { error };
            attempt++;
            invalidate(); releaseFence();
            // Still in the same complete account/ledger lock. Only the failed
            // fence is gone; readFenced will establish a new qualified attempt.
          }
        }
      });
      db.assertCurrentLease?.();
    } catch (error) {
      // A write ACK inside the callback is not success when the surrounding
      // deletion-ledger session fails its final validation. Never roll back
      // already-committed shared data/revision to the old baseline.
      if (!attemptedWrite) throw error;
      uncertainCause = error;
    } finally {
      releaseFence();
    }
    if (outcome?.error) throw outcome.error;
    if (outcome?.value) return outcome.value;
    uncertainCause ||= outcome?.uncertain;
    invalidate();
    db.assertCurrentLease?.();

    let reconciliation;
    try {
      reconciliation = await withWriteLock(userId, async () => {
        let baseline;
        try { baseline = await readFenced(); }
        catch (error) { return { unreadable: error }; }
        try {
          const authorization = await authorized(baseline.snapshot, true);
          const proof = confirm ? callSync(confirm, { snapshot: structuredClone(baseline.snapshot), prepared: fixed, authorization, attempt, confirming: true }) : null;
          if (!proof || proof.confirmed !== true) return { unconfirmed: true };
          if (!own(proof, 'result')) throw new TypeError('confirm must return an explicit result');
          return { value: { result: structuredClone(proof.result), disposition: 'recovered' } };
        } catch (error) { return { error }; }
      });
      db.assertCurrentLease?.();
    } catch (error) { throw unknown(error); }
    finally { releaseFence(); }
    if (reconciliation.error) throw reconciliation.error;
    if (reconciliation.value) return reconciliation.value;
    throw unknown(reconciliation.unreadable || uncertainCause);
  } finally {
    releaseFence(); releaseLease?.();
  }
}
