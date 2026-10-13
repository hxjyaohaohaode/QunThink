# Ordered group-message protocol (F07 integration candidate)

This document describes the local candidate, not a deployment receipt. Existing
installations require the stopped-writer migration in `account-store-lifecycle.md`.
Deploy matching backend/frontend versions together only after the release gates.
An already-open old page cannot become lossless merely because the server returns
an upgrade error. Preserve/copy its unsent content before refreshing; never replay
an unknown message under a new client ID.

## Scope and retained history

`db.data.messages` creation has an account/group generation and an immutable
positive decimal-string sequence. Use BigInt comparison. Existing IDs, timestamps,
message ciphertext, receipt request hashes and physical history are not rewritten
by the legacy sidecar migration. Creation order is separate from display time.

Sequences are not an edit, reaction or deletion event log. Existing live mutation
handlers remain separate. Agent-specific `agent_messages` are outside this group
creation sequence. This feature does not introduce shared-human group membership,
a cross-process WebSocket bus, or exactly-once model-provider execution.

Every creation channel commits its message and binding as one candidate account
snapshot. HTTP success/durable WebSocket publication follows the complete write
and deletion-lease boundary. A lost acknowledgement is unknown until an exact
original identity is read back; confirming it does not dispatch another model.
Deleted IDs, bindings and consumed sequence holes are retained, never reused.

## HTTP

Use `GET /api/groups/:groupId/messages?order=sequence_v1&limit=50` for a fresh
baseline. Limit is an integer from 1 to 200. Supply at most one `before_cursor` or
`after_cursor` returned by the server. Query fields must be unique; do not mix
legacy `before`/`after` timestamps with the ordered protocol.

The response contains `messages`, `hasMore`, `order`, `generation`,
`high_watermark`, `consumed_through`, `before_cursor`, and `after_cursor`.
Each message keeps its original ID and has
`server_order: { generation, sequence }`. All sequence/watermark numbers are
canonical decimal strings in the signed-64-bit positive range; watermarks allow 0.

- Baseline: latest page in ascending creation order; C equals captured H. A before
  cursor retains the older history boundary. An after cursor starts the next batch.
- Before: reads older visible rows within its fixed H. It never advances C or
  replaces the current after cursor. `consumed_through` and `after_cursor` are null.
- After: reads earliest unconsumed visible rows through fixed H. Continuation
  retains that H even if new messages arrive. Only exhausting the batch, including
  legitimate deletion holes, advances C to H. New arrivals are read next batch.

Cursors are canonical base64url query boundaries, not signed credentials. The
server checks the authenticated owner and requested readable group before parsing
or revealing cursor state; a cursor does not grant access to another account.
Tampered scope/direction/encoding, duplicate parameters and future numeric bounds
are rejected. The boundary row need not still exist.

Errors:

- 400 `INVALID_MESSAGE_CURSOR`: malformed or contradictory query/boundary
- 404: group is absent or unreadable; no generation/high-watermark disclosure
- 409 `CURSOR_RESET_REQUIRED`: valid scoped cursor belongs to a retired generation
- 409 `MESSAGE_ORDER_CAPACITY_EXCEEDED`: sidecar capacity is exceeded; this is not
  a cursor reset. Normal writes already reject capacity overflow without truncation
- 428 `MESSAGE_CURSOR_REQUIRED`: old timestamp pagination needs a matching client
- 503 `MESSAGE_ORDER_UNAVAILABLE`: invalid/missing/unknown ordering metadata
- Storage or deletion-barrier failures suppress the page; an inner successful read
  cannot bypass a failed outer lease check

A legacy unpaged first read remains a bounded compatibility read. It does not
provide consumption proof or make legacy timestamp pagination safe.

## Client consumption and recovery

The client keeps four separate in-memory values: B for older history, C for HTTP
consumption, H for the current batch, and L for highest observed live creation.
WebSocket delivery, timestamps and cached rows never advance C. A malformed page
is rejected as a whole. Confirmed rows sort by sequence; unsent intents and previews
retain their separate status. An ordered page does not remove old disk history merely because the page omits
it; ordinary bounded cache-retention policies still apply. Cached history cannot
prove which range was consumed in this document.

Only the authenticated, visible, online, actual active chat page has a read lease.
Normal catch-up is at most five 100-row pages per round and every 30 seconds. A
remaining batch remains visibly incomplete. Offline/hidden pages stop requests;
focus or reconnect does not reset the deadline. Failure backoff is bounded from
30 to 300 seconds, and a valid Retry-After can only delay it. Authentication errors
stop the owner scope; schema/upgrade errors require explicit recovery. Bootstrap
buffers at most 500 live events, then requires resynchronization instead of
silently dropping events and claiming completeness.

Account, auth generation, group/page lease and server generation are checked after
asynchronous work. Switching A to B to A does not restore a stale response's
eligibility. Unknown sends retain the original client UUID, text, reply references
and attachments; reads never automatically POST/retry them. A newer composer draft
is distinct from the intent acknowledged by a late receipt.

A successful in-memory cache write is not proof of refresh recovery. The new
message/draft durability path checks the committed backing store and existing
key; unavailable storage/key requires a copy warning rather than a success claim.
The existing browser encryption database remains the legacy global key database.
Owner/epoch checks isolate asynchronous cache results; this is not per-account
cryptographic key isolation and introduces no key migration or rotation. Read-only
decryption/proof does not generate a replacement key or remove legacy key bytes.
The ordinary pre-existing encryption path still has its legacy localStorage-key
cleanup behavior; no blanket claim that every historical key operation is read-only
is made here.

## Verification and operational limits

Source-bound local checks cover the complete backend with PostgreSQL 16.15 and
Node 22.12.0, the frontend unit suite and TypeScript/Vite build, actual HTTP
pagination, and independent storage/restore/client reviews. Exact counts, file
hashes and earlier red controls belong to their verification receipts rather than
being inferred from this document. Restoration PG tests use a fixture
administrative role; HTTP paging additionally exercises a restricted runtime role.

The required CI storage preflight checks 11 synthetic PG databases, the five
explicit CA bindings and the pinned official MongoDB service. Its 23 storage test
files must exist, exit successfully and report no skipped/TODO cases. A missing
fixture or an evidence failure must not be reported as a passed storage gate.
Fixtures are disposable and independent of production data. CI setup is not proof
that a service or test actually ran.

Final source freeze, real native-browser execution and exact CI receipts remain
release gates. The new browser fixture uses actual UI/IndexedDB/WebCrypto with
synthetic account/HTTP responses; it complements the separate real-server flows
and must not be described as a real-provider or full production-auth test.
DOM/synthetic-IDB contracts are not native-browser acceptance.
MongoDB live acceptance is not available in this environment: the official binary
could not obtain required CPU system information. No flags or system settings were
changed to bypass that restriction. Mongo historical restore remains unsupported
by the new rotation tool; JSON and independent-ledger PostgreSQL evidence does not
establish it for MongoDB.
