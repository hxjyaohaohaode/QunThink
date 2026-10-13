# Account storage lifecycle: F07 local integration checkpoint

This is an unpublished intermediate implementation. The required storage gate is
on. The 14 message appenders and three live group-creation routes now use the
detached commit boundary. Ordered HTTP pagination and explicit restore rotation
have local contract/PG evidence; client integration has local unit/DOM evidence, while final CI/native gates are
still pending. See `message-order-protocol.md` for the exact protocol and
verification boundaries. Do not deploy this checkpoint or relax the gate to make
old fixtures pass. JSON remains single-process. MongoDB live durability and BSON
size acceptance are not verified.

## Existing accounts and startup

`getUserDb` obtains an existing-account handle. A newly loaded account and every
`db.read()` must contain valid message-order metadata before shared data or
revision can be published. No loader patches missing fields, adds preset groups,
repairs previews, retires old members, or salvages concatenated JSON. A valid
`groups: []` stays empty; retained group/order tombstones remain intact.

- No file/row: `ACCOUNT_DATA_MISSING` (503)
- Present null/non-object document: `ACCOUNT_DATA_INVALID` (503)
- Malformed JSON: `ACCOUNT_DATA_CORRUPT` (503), original bytes untouched
- Missing/partial/unknown sidecar: `MESSAGE_ORDER_UNAVAILABLE` (503)
- Filesystem access errors keep their actual cause, never become absence

Cached handles do not make external restore safe. Stop all writers and invalidate
old handles through the maintenance flow. Read and write failures invalidate the
account's write permission until a successful authoritative read. Each write
also holds its own epoch permit: a later read cannot grant an old in-flight write
permission to publish a late acknowledgement. Such acknowledgement is unknown;
it cannot replace newer shared data/revision or trigger an automatic retry.

`initDatabase()` only loads the existing default account. It does not create an
installation or import `db.json`. `initUserDatabase()` is an existing-only alias.

## Explicit empty installation

Run from `backend`, using Node 22.12 and the intended existing storage config:

    node scripts/account-store-maintenance.mjs init-empty

The command requires a genuinely empty target. Local files anywhere in DATA_DIR,
including null auth documents, legacy data, leftover deletion ledgers and files
at AUTH_DB_PATH, block initialization. Empty directories are permitted; access
failures are not treated as empty. PostgreSQL requires empty `kv_store`; MongoDB
checks the configured database's collections for any stored document.

For the existing Compose topology, build the matching image and run the one-off
command before starting the long-lived service, only after confirming the named
volume and every configured cloud/ledger target are genuinely new and empty:

    docker compose build backend
    docker compose run --rm --no-deps backend node scripts/account-store-maintenance.mjs init-empty

This uses the same service environment, non-root identity and named data volume.
Supply the existing deployment configuration through its normal private channel;
never paste production key values into commands, logs or this document. An old
volume needs the stopped-writer migration below, not this initialization command.
Do not use root or recursively change unknown-volume ownership to make it pass.
The Compose sequence is documentation; actual container execution remains a
separate deployment gate. A new installation still needs the normal auth/provider
configuration before real users can sign in or invoke a model.

Only the default business account is created here. The existing auth and
independent deletion-ledger installation flow remains separate. Use the same
storage selection/configuration for maintenance and later startup. Do not point
this command at a restored or existing installation and do not remove evidence
to make it appear empty.

## New registration

Only the three existing server-generated UUID registration branches call
`createNewUserDatabase(userId)`. The client cannot select creation mode. The order
remains auth lock, new business document, independent deletion ledger, then auth
user/session publication. No account-memory lock that requires a not-yet-created
ledger is acquired during business initialization.

Creation is insert-only:

- JSON writes/syncs a private `wx` temporary file and publishes with a same-filesystem
  hard link, which cannot replace a target. It cleans only a temp it opened. This
  does not promise power-loss durability beyond the underlying filesystem.
- PostgreSQL uses INSERT ON CONFLICT DO NOTHING, never UPDATE revision-zero data.
- MongoDB uses insertOne under the existing unique userId index, never updateOne.

Creation participates in the same registry single-flight/lease/write-drain
mechanism. After a create attempt, an authoritative read confirms the original
snapshot. A lost acknowledgement never causes a second insert or a new generation.
An existing valid unchanged preprovisioned result can be reused without rewriting;
unknown, malformed or already-used content cannot be overwritten.

## Explicit legacy migration

Stop and drain every HTTP, scheduler, task, debate, script and old-version writer
before either command. The local registry cannot stop another process; this is
an operational prerequisite. No mixed old/new writers are supported.

For an existing account document, including the default:

    node scripts/account-store-maintenance.mjs migrate-account USER_ID
    node scripts/account-store-maintenance.mjs migrate-account USER_ID --apply SOURCE_HASH

For a legacy local DATA_DIR/db.json import into the configured default account:

    node scripts/account-store-maintenance.mjs import-legacy
    node scripts/account-store-maintenance.mjs import-legacy --apply SOURCE_HASH

The first command is read-only dry-run. It reports the original full-document
SHA-256, message/group/binding counts and sidecar byte count, not message bodies or
private names. Apply requires that exact reviewed hash and strictly legacy input
with no sidecar. Changed input, duplicate/invalid identities, invalid timestamps,
partial new schema and capacity overflow stop without repair or truncation.

Migration adds only `message_order`, preserving original values, ciphertext
strings, arrays, receipts and unrelated fields. It does not call the normal
loader, source projections or deletion filters. In-place cloud migration uses
the original revision CAS. Local JSON rechecks the raw source within the drained
registry; it provides no interprocess CAS. A winning migration is read back and
checked against the original document before reporting success. No automatic
migration retry generates another generation. Legacy import is create-only and
retains the source `db.json` unchanged, rather than renaming or deleting it.

The migration command is not a restore/reopen-deleted-content command. Keep the
independent deletion ledger intact. Stopped-writer generation rotation is described below. It does not replace
backup validation or authorize bringing old writers back online.

## Verification limits

Focused contract tests use synthetic records. Real isolated PostgreSQL tests
exercise independent-process insert and revision-zero CAS races under TLS 1.3,
fsync and synchronous_commit, as well as ordered HTTP and stopped-writer restore.
A committed write followed by an injected lost acknowledgement tests recovery
logic; it does not prove physical network-partition, failover or crash durability.
Local MongoDB contracts use synthetic transports. The CI job has a pinned official
MongoDB fixture and requires live storage tests to execute without skips, but
configuration alone is not an execution result. Consult the exact source-bound
release evidence for backend/frontend, HTTP, live MongoDB and native-browser gates.

The maintenance CLI loads the working directory's `.env` through the same
`dotenv/config` mechanism as the server. Existing process variables retain their
usual precedence; it does not search arbitrary directories for config files.

An explicitly configured external `MEMORY_DELETION_DIR` and `AUTH_DB_PATH` are
included in the empty-install check. Configured PostgreSQL independent-ledger
settings must be complete and use the existing TLS validation. Its separate
database is probed without creating registry/installation records. Any existing
row rejects installation; inaccessible targets and views, foreign tables or
row-level-policy relations make emptiness unknown and block the operation.

Before a required JSON write, a raw check also rejects a target that is already
missing, corrupt, inaccessible or invalid. This check publishes no graph/revision
and grants no new write permit. A failed check requires a new authoritative read
before another write. It does not provide an atomic update-only primitive: an
external replacement/deletion after this check remains outside the supported
single-process, stopped-writer maintenance boundary.

After a successful migration with a lost CLI response, do not blindly apply the
legacy migration again. It accepts strictly legacy input; already-new documents
are rejected by that command. Keep writers stopped and verify the stored new
schema and preserved source values through the documented inspection/recovery
process before startup. No general migration receipt/retry mechanism is added at
this checkpoint.

## Deliberate compatibility changes during integration

These are storage lifecycle changes, not transparent replacements for the old
startup behavior. Existing regression scenarios are retained with explicit
installation/account fixtures and valid ordered seeds; production checks must
never be disabled to run the tests.

- Corrupt account JSON now reports `ACCOUNT_DATA_CORRUPT` and retains the exact
  original bytes. Reading does not attempt a repair or report an automatic
  repair failure. An operator must inspect and restore through maintenance.
- An old single `db.json` is not implicitly claimed when the default account is
  missing. Startup reports `ACCOUNT_DATA_MISSING`; the explicit legacy-import
  dry-run/apply path checks it separately and rejects malformed source without
  altering the original.
- Old `ai_members` and message history remain unchanged when read. The loader
  no longer silently moves identifiers into `retired_ai_members`. Retaining
  historical identifiers does not configure or enable those models: the actual
  account catalog and credential/capability gates still govern selection and
  dispatch. Any future member conversion must be an explicit reviewed migration.

After a lost message-commit acknowledgement, the server rechecks the same
prepared identity inside a new complete account/ledger lock. Confirming an
already-created result does not authorize another model request or social action.
Recovered membership requests return their original system-message identity
with the current group projection, without rebroadcasting an old membership
state that could overwrite a later join or removal.

## Stopped-writer restore generation rotation

This maintenance entry handles an already-restored, complete account snapshot.
It does not choose or copy a backup. First stop and drain every HTTP, scheduler,
task, debate, admin and old-version writer on every instance; preserve current
auth, independent deletion journals, and maintenance receipts separately from
business backups. Restore the intended full business snapshot, then use these
exact commands from `backend` with its existing configuration:

    node scripts/account-store-maintenance.mjs prepare-restore-rotation OWNER PLAN_FILE --writers-stopped
    node scripts/account-store-maintenance.mjs apply-restore-rotation OWNER PLAN_FILE --apply PLAN_FILE_SHA --writers-stopped
    node scripts/account-store-maintenance.mjs verify-restore-rotation OWNER PLAN_FILE --writers-stopped

Review the original immutable plan before selecting its exact file SHA from
prepare output. The plan binds version, owner, request UUID, canonical whole
source/target SHA-256 and all sidecar groups' old/new generation UUIDs. Object
keys are canonicalized; arrays, every value, ciphertext, receipts, sequence/next,
creation/source hashes and historical bindings stay identical. Empty groups and
historical/deleted sidecars rotate too. An account with no sidecars reports zero
groups and confirms no change. JSON formatting is not preserved on replacement.
There is no claim that an unsigned plan authenticates its author.

Prepare and verify perform no business/auth/deletion-journal writes. Prepare
only creates its new plan exclusively, with file and directory fsync. Apply
changes only generations on a detached snapshot and verifies both the target
whole hash and the inverse generation delta back to the original source hash.
No normal writer gate is relaxed; ordinary writes still cannot rotate generation.

Each owner has a fixed `DATA_DIR/account-restore-attempts-v1/OWNER_SHA256/` receipt
directory outside account snapshots. Its request UUID receipt binds exact plan
file SHA, owner, request, source and target. The tool creates it exclusively and
requires file plus directory fsync before any business replacement. Plan aliases
and byte-identical copies reach the same receipt. Symlinks, hard-linked plan or
receipt files, malformed/unknown records and uncertain durable writes fail closed.
Keep incomplete files; the command never removes or reconstructs them.

A matching existing receipt makes every subsequent apply read-only, even if the
source is still visible. Any different request receipt blocks prepare and apply,
including two plans prepared before the first attempt. This initial tool has no
automatic cleanup, archival or retry state machine. A later maintenance session
requires an operator to keep writers stopped, independently verify the original
outcome and deletion boundary, preserve the original plans/receipts for audit,
and explicitly archive the completed owner receipt directory outside the active
root. Never archive an unknown result merely to permit another write. Deleting,
rolling back or switching DATA_DIR without preserving receipts is unsupported.

- `prepared`, exit 0: plan persisted; no business replacement
- `confirmed`, exit 0: complete target read, inverse/source check, current deletion
  registration, local registry completion and final PG lease checks all succeeded
- `unconfirmed`, exit 2: current document is the original source; this is not proof
  a late remote write cannot occur. Keep all writers stopped and inspect manually
- Error, exit 1: malformed/conflicting/unavailable state or unknown outcome. Keep
  writers stopped. A post-write failure never authorizes a second automatic write

Postcommit lost acknowledgement can be confirmed by an authoritative read of the
same fixed target. Confirmation-read or final ledger-lease failure remains unknown.
Only after a confirmed result and operational review should every service restart
using new processes/handles. The registry retires old handles in this process;
`--writers-stopped` is an operator assertion, not detection of remote writers.
The tool cannot detect arbitrary fully self-consistent manual rollbacks.

Supported boundaries:

- Local JSON: read existing raw auth installation marker and existing registry /
  account journals with creation disabled. Revalidate them at confirmation. JSON
  rechecks the source under the existing single-process maintenance boundary; it
  is not cross-process CAS and adds no stronger power-loss claim for business JSON.
- PostgreSQL: dedicated TLS-verified business and independent ledger pools, existing
  structures and strict version-1 business installation marker on every validation,
  including the final lease check. No schema initializer or provisioning runs.
  The actual read revision receives one update-only CAS, including revision zero;
  no insert fallback occurs. Both dedicated pools close after the complete scope.
  Identity, fsync/synchronous_commit, account registration, session and advisory
  lock checks remain required. Ledger/auth preservation means unchanged table rows
  and values, not unchanged physical PostgreSQL storage pages.
- MongoDB and PostgreSQL without configured independent deletion protection are
  unsupported by this restore entry. Ordinary adapter support is unchanged.

No deletion journal is restored, rewritten or truncated. Restored deleted source
records may still exist in business storage; the normal authoritative HTTP/source
filters continue to hide them. The tool does not scrub data or rebuild sources.
Its lock order is the existing owner mutex, then PG deletion lease (if applicable),
then the local registry maintenance/drain. It never uses a cached live handle or
calls the ordinary loader inside maintenance.
