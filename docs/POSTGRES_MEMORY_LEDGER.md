# Optional independent PostgreSQL deletion ledger

This is an opt-in adapter, not enabled in existing deployments by this change.
It protects persisted memories and their original messages, revisions, groups,
files, and linked TTS access. It does not configure an AI provider or credentials.

## Modes and recovery boundary

- **Legacy (default):** no independent configuration and no business installation
  marker. Existing PostgreSQL chat/file behavior stays unchanged. Persistent
  memory APIs return 503 because no durable independent deletion history exists.
- **Independent:** `MEMORY_DELETION_MODE=independent`, any nonempty independent
  setting, or the business `memory:deletion-installation` marker requires a valid
  independent ledger. Missing configuration, unknown installation/account,
  inaccessible identity, missing tables or lost connections fail closed.
  Setting mode back to legacy does not override an existing marker/configuration.
- Local JSON and its existing single-process deletion ledger are unchanged.

Preserve the ledger database **and** independent deployment configuration outside
business backup/restore operations. Restore the business database in place while
retaining the independently committed ledger. Restored deleted content stays
hidden, and memory records are scrubbed during reconciliation. Database identity
is the actual PostgreSQL cluster system identifier plus database OID; alternate
host names, ports or URI spellings cannot turn the same database into an
independent store. New database OIDs / replaced clusters require an audited
recovery/rebinding procedure; they are deliberately rejected, not automatically
trusted.

Two databases in one cluster are independent for database-level logical restore,
**not** for whole-cluster PITR, physical snapshots or simultaneous rollback.
Use separately managed restore boundaries in production. If both the business
and ledger are rolled back, the lost deletion history cannot be reconstructed.
Likewise, restoring a pre-enablement business backup **and losing every external
independent setting** is indistinguishable from a legacy installation and is not
covered. The adapter cannot detect privileged destruction of all proof/history.
Do not describe it as unconditional deletion across every backup.

## Connection and minimum capabilities

Use a direct PostgreSQL connection or a **session** pooler, never a transaction
pooler. Set `MEMORY_DELETION_CONNECTION_MODE=session` only after verifying this
with the provider. Runtime verifies backend PID and the exact advisory lock,
but a successful probe cannot certify a misdeclared pooler's future behavior.
The connection must retain session state. Supabase supports distinct direct,
session and transaction modes: [official connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).

Both databases require EXECUTE on `pg_catalog.pg_control_system()` and readable
`pg_database` identities. PostgreSQL 16's default grants can already allow this;
managed services may restrict it. If restricted, an administrator may grant just
EXECUTE on that function to the application role in each database, subject to
provider policy. No superuser role is required by this adapter. If the provider
cannot expose verified identity, this adapter remains unavailable; local fixture
success does not certify a particular hosted Supabase project. See
[PostgreSQL system information functions](https://www.postgresql.org/docs/16/functions-info.html).

The business role needs its existing kv_store access. The separate ledger runtime
role needs SELECT on all three ledger tables and INSERT on accounts/tombstones;
it should have **no UPDATE, DELETE, TRUNCATE or DDL** privileges on them. Use a
separate offline installation owner for table creation. Keep backups/access
controls independent. Runtime forces `synchronous_commit=on`, verifies it and
requires `fsync=on`; installation does likewise. PostgreSQL/storage must honor
those durability settings. No claim is made for broken storage or lossy failover.

TLS is mandatory and hostname verified using the same strict configuration as
the business adapter. A custom CA file must be a valid CA certificate. There is
no localhost, NODE_ENV, or production TLS-bypass switch in this feature.

Required configuration:

- `SUPABASE_DB_URL` and optional `SUPABASE_DB_CA_FILE`: existing business database
- `MEMORY_DELETION_MODE=independent`
- `MEMORY_DELETION_DATABASE_URL`: separately restored database
- `MEMORY_DELETION_DATABASE_CA_FILE`: optional trusted CA certificate path
- `MEMORY_DELETION_INSTALLATION_ID`: stable installation UUID, not a secret
- `MEMORY_DELETION_CONNECTION_MODE=session`

Do not put real connection credentials in source control. Changed configuration
requires a process restart; a running process rejects changing its ledger identity.

## First installation and explicit legacy migration

Stop **all** application instances and preserve existing data/keys/backups first.
Provision databases and privileges through your normal approved deployment
process; the application does not create databases or external resources.
The business kv_store schema must already exist.

For a verified brand-new store with no accounts or historical user data:

`cd backend && node scripts/install-postgres-memory-ledger.mjs --fresh`

This rejects existing users, orphan user documents and default-account history.
Runtime never creates missing installation tables. Account registration adds its
freshly generated account ID to the installed registry **before** exposing the
account/session. An empty restored memoryRecords array is not evidence of a new
account.

For an existing installation, obtain and verify the **complete** independently
preserved deletion history for every existing account, then import offline:

`node scripts/install-postgres-memory-ledger.mjs --import-verified-history manifest.json`

Manifest format:

```json
{
  "version": 1,
  "installationId": "the configured installation UUID",
  "attestation": "COMPLETE_VERIFIED_DELETION_HISTORY",
  "accounts": [{ "ownerId": "existing account ID", "deletedIdentityHashes": [] }]
}
```

The complete account set must match business auth users; orphan user documents
are refused. Hashes are SHA-256 of `JSON.stringify([ownerId, identity])`, matching
the verified local deletion journal's `key` field. Identities include memory IDs
and the existing source-group/message/revision/file identity keys. For local
migration, validate both journal hash chains and matching durable receipt files
with the existing deletion-barrier validator before copying any `key` values;
also verify registry membership and preserve the original files. Do not infer
history from the currently visible business rows. An empty list is acceptable
only when independently audited as genuinely complete, never as a workaround
for missing history. The attestation is an operator assertion, not a cryptographic
proof; the software cannot manufacture or verify forgotten external history.
If complete history is unavailable, remain in legacy mode with memory disabled
or recover the trusted history; do not fabricate an empty migration.

Installer writes ledger installation/accounts/tombstones in one transaction,
then writes the business enablement marker. A crash or uncertain acknowledgement
can leave an installed ledger without the marker: preserve it and recover the
marker under an offline audited procedure after verifying the exact installation
and identities. Rerunning initialization refuses existing tables; never drop the
ledger to make the command pass. There is no automatic reset/rebind command.

## Concurrency and visibility

An account-scoped PostgreSQL session advisory lock wraps existing application
write/read critical sections across Node processes. Reads refresh the business
snapshot within that lock. Tombstones are individually committed durably before
business source erasure; business failure or unknown commit never rolls them back.
Retries are idempotent and account hashes isolate matching IDs across accounts.

Unknown ledger commits return 503. Re-read after recovery establishes outcome.
Lost/expired async lock leases cannot reuse returned pooled connections. Protected
JSON and sendFile responses are staged until the lease is verified; buffering is
limited to one response, 100,000 visited JSON values and 8 MiB per lock. Oversized
protected responses fail closed. Legacy/SSE/WebSocket/Range streaming behavior
is not buffered. Ordinary file authorization and response initiation occur under the account
lock; Express may open the file asynchronously afterward. TTS handles are opened
under the lock. Already-authorized in-flight requests cannot be recalled by a
later deletion.
Failures close a TTS handle opened before final lease verification.

## Local verification

`QUNTHINK_TEST_PG_URL=... node test/postgres-deletion-ledger.integration.test.js`
uses disposable synthetic databases and requires CREATE DATABASE/ROLE privileges
for the fixture only. It covers physical same-DB rejection, unknown installation
and account, migration refusal, idempotency/account isolation, business restore,
separate-process locks, unknown commits, connection loss, expired async leases,
least-privilege grants, synchronous durability and missing tables/registry.

`QUNTHINK_TEST_MEMORY_TLS_URL=... QUNTHINK_TEST_MEMORY_LEDGER_TLS_URL=... QUNTHINK_TEST_MEMORY_TLS_CA=... node test/postgres-memory-api.integration.test.js`
requires empty disposable TLS databases and tests real HTTP memory APIs, source
messages after complete kv_store restore, missing configuration and legacy mode.
Both files skip explicitly when their dedicated fixture variables are absent.
