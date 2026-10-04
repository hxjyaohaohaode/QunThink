import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();
export const currentUserId = () => scope.getStore()?.userId || null;
export const runAsUser = (userId, fn) => scope.run({ userId }, fn);

// Background work inherits the authenticated request scope, including timers.
// Identical legacy group IDs in two user databases must never share a job.
export class UserScopedMap extends Map {
  scopedKey(key) { return JSON.stringify([currentUserId(), key]); }
  get(key) { return super.get(this.scopedKey(key)); }
  has(key) { return super.has(this.scopedKey(key)); }
  set(key, value) { return super.set(this.scopedKey(key), value); }
  delete(key) { return super.delete(this.scopedKey(key)); }
  deleteRaw(key) { return super.delete(key); }
}
