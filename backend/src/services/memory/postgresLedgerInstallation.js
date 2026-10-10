import { createHash } from 'node:crypto';
import { databaseIdentity } from './postgresDeletionLedger.js';
const hash = id => createHash('sha256').update(id).digest('hex');
const invalid = () => Object.assign(new Error('Ledger initialization requires a verified fresh installation or complete audited deletion history'), { code: 'MEMORY_MIGRATION_REQUIRED' });

/** Offline only. No runtime request may initialize or replace these tables. */
export async function installPostgresLedger({ businessPool, ledgerPool, installationId, manifest = null }) {
  if (!/^[0-9a-f-]{36}$/i.test(installationId || '')) throw invalid();
  const business = await databaseIdentity(businessPool);
  const ledger = await databaseIdentity(ledgerPool);
  if (business === ledger) throw invalid();
  const snapshot = await businessPool.query("SELECT key,data FROM kv_store WHERE key='auth:main' OR key='memory:deletion-installation' OR key LIKE 'user:%'");
  if (snapshot.rows.some(row => row.key === 'memory:deletion-installation')) throw invalid();
  const auth = snapshot.rows.find(row => row.key === 'auth:main')?.data;
  const userIds = (auth?.users || []).map(user => user.id).sort();
  if (auth && !Array.isArray(auth.users)) throw invalid();
  const existingData = snapshot.rows.some(row => row.key !== 'auth:main' && row.key !== 'user:default');
  const defaultData = snapshot.rows.find(row => row.key === 'user:default')?.data;
  const hasDefaultHistory = (defaultData?.messages?.length || defaultData?.memoryRecords?.length || defaultData?.files?.length);
  if (hasDefaultHistory) throw invalid();
  if (!manifest && (userIds.length || existingData)) throw invalid();
  if (manifest) {
    if (manifest.version !== 1 || manifest.attestation !== 'COMPLETE_VERIFIED_DELETION_HISTORY' ||
        manifest.installationId !== installationId || !Array.isArray(manifest.accounts)) throw invalid();
    const ids = manifest.accounts.map(account => account.ownerId).sort();
    if (JSON.stringify(ids) !== JSON.stringify(userIds)) throw invalid();
    for (const account of manifest.accounts) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(account.ownerId) || !Array.isArray(account.deletedIdentityHashes) ||
          account.deletedIdentityHashes.some(id => !/^[0-9a-f]{64}$/.test(id))) throw invalid();
    }
    const orphan = snapshot.rows.some(row => row.key.startsWith('user:') && row.key !== 'user:default' && !userIds.includes(row.key.slice(5)));
    if (orphan) throw invalid();
  }
  const client = await ledgerPool.connect();
  try {
    const fsync = await client.query('SHOW fsync');
    if (fsync.rows[0].fsync !== 'on') throw invalid();
    await client.query('BEGIN');
    await client.query('SET LOCAL synchronous_commit=on');
    // Deliberately no IF NOT EXISTS: a lost or partial ledger is never reset.
    await client.query(`CREATE TABLE memory_deletion_installation (
      singleton boolean PRIMARY KEY CHECK(singleton), installation_id uuid NOT NULL UNIQUE,
      business_identity text NOT NULL, ledger_identity text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE memory_deletion_accounts (
      installation_id uuid NOT NULL REFERENCES memory_deletion_installation(installation_id),
      owner_hash text NOT NULL CHECK(owner_hash ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY(installation_id,owner_hash));
      CREATE TABLE memory_deletion_tombstones (
      installation_id uuid NOT NULL, owner_hash text NOT NULL,
      identity_hash text NOT NULL CHECK(identity_hash ~ '^[0-9a-f]{64}$'),
      deleted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(installation_id,owner_hash,identity_hash),
      FOREIGN KEY(installation_id,owner_hash) REFERENCES memory_deletion_accounts(installation_id,owner_hash));`);
    await client.query('INSERT INTO memory_deletion_installation VALUES(true,$1,$2,$3,now())', [installationId, business, ledger]);
    for (const account of manifest?.accounts || []) {
      const ownerHash = hash(account.ownerId);
      await client.query('INSERT INTO memory_deletion_accounts VALUES($1,$2)', [installationId, ownerHash]);
      for (const identity of new Set(account.deletedIdentityHashes)) {
        await client.query('INSERT INTO memory_deletion_tombstones(installation_id,owner_hash,identity_hash) VALUES($1,$2,$3)', [installationId, ownerHash, identity]);
      }
    }
    await client.query('COMMIT');
    // Persist the enabled marker independently of application environment. A
    // lost URL must not silently downgrade an already protected installation.
    await businessPool.query("INSERT INTO kv_store(key,data,revision) VALUES('memory:deletion-installation',$1,1)", [{ version: 1, installationId }]);
    return { installed: true, migratedAccounts: userIds.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
