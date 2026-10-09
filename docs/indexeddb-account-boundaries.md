# IndexedDB account and commit boundaries

`frontend/src/utils/indexedDB.ts` binds each cache operation to the storage session
that existed when the helper was called. Switching accounts (including A → B → A)
or clearing the active account retires that session, closes its handle, cancels
pending opens, and aborts unfinished transactions. A late open or handle callback
cannot install itself into the new session. An obsolete upgrade is aborted before
schema writes; a successful but obsolete open is closed immediately.

## Storage and failure semantics

- Databases keep their existing names: `ai-chat-group-<userId>`, with the legacy
  unscoped name reserved for an explicitly unscoped session. No messages are
  migrated between databases or assigned to the next account.
- The no-IndexedDB fallback is memory-only, separately keyed by account/database.
  It copies messages on input and output. It does not provide durable persistence
  or migrate into IndexedDB if browser storage later becomes available.
- Concurrent opens within a session share one request. A failed/blocked open
  reports failure; a late success on that failed request is closed. A subsequent
  explicit helper call may retry. There is no automatic retry loop.
- Save, single-message delete, group clear, retention cleanup and user-database
  clear return `Promise<boolean>`. `true` means the transaction/delete completed
  (or the memory-only fallback operation completed). `false` means unsuccessful
  or superseded work. Calling code must inspect the result before saying data was
  saved or cleared. A user-database clear also returns `false` when IndexedDB
  is unavailable: its fallback is cleared, but removal of an older persistent
  database cannot be verified without the API. Reads retain the existing `Promise<Message[]>` API and return
  an empty cache result on failure or session cancellation.
- Actual errors are emitted through `onStorageError`; session cancellation is
  expected and does not display an old-account failure to a newer account.
- Request success and cursor exhaustion are not commit. Reads and writes wait
  for transaction completion; aborts/errors settle as failure. A synchronous
  failure midway through a batch aborts the whole transaction. Retention deletes
  are queued within the request callback while the transaction is active.
- A transaction error does not invalidate other operations on the same healthy
  connection. `versionchange` releases our connection so other tabs can upgrade
  or delete the database; an unexpected close retires the matching session only.

## Deletion blocked by another tab

A blocked IndexedDB delete request cannot be cancelled. The helper returns
`false` and reports the blocked deletion instead of claiming completion. The
original request remains pending; no retry timer or duplicate deletion is
launched. The named database is fenced against new operations until that exact
request emits success/error, including after logging back into the same account.
This prevents a delayed old deletion from erasing freshly cached messages.
Other accounts can continue to use their own caches. Closing the blocking tab
allows the pending delete to finish; a later cache operation can then reopen the
database. A previously returned `false` never becomes an affirmative receipt.

Explicit cleanup of an inactive account does not close, cancel or clear the
active account's storage. No blanket database deletion is introduced.

## Verification

`npm --prefix frontend test` includes deterministic lifecycle tests against the
bundled production helper, with controllable open/upgrade/blocked/close events,
transaction errors and aborts. The fixture only commits staged writes at
`complete`; it does not stand in for browser-engine validation. Regression tests
initially reproduced stale-handle installation, cross-account fallback reads,
and pre-commit group-clear success on the prior implementation.

`frontend/e2e/indexedDBAccountBoundary.spec.ts` adds native-browser checks for late
open delivery, a real aborted write transaction, and blocked deletion across
accounts. These tests use synthetic data, the real module and native IndexedDB;
they need no model credentials or paid calls. They are intended for the existing
browser CI workflow and were **not executed locally in this change**. Run the
existing authorized `npm --prefix frontend run test:e2e` workflow to establish
browser-engine results. Type checking/build and the brand hash check are separate
checks and are not evidence of native-browser execution.

## Remaining scope

This helper cannot identify an old application callback that invokes it for the
first time after an account switch. Stores, socket handlers and timers must
separately fence their asynchronous continuations before invoking a helper or
publishing results. A completed transaction cannot be undone on a later account
switch. These changes isolate local caches; they do not add encryption at rest,
server authorization, cross-tab auth synchronization, or complete deletion
propagation to backups and derived artifacts.
