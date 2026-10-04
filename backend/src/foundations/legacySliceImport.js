import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensurePersonalWorkspace, personalSpaceId, stablePersonalId } from './personalWorkspace.js';
import { quoteSchema } from './migrate.js';
import { createLocalAccountRegistry } from '../services/memory/localAccountRegistry.js';

const sqlFile = new URL('../../db/migrations/legacy_slice_001.sql', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const barrierKey = value => sha256(JSON.stringify(value));
const MAX_AUTH_BYTES = 16 * 1024 * 1024;
const MAX_USER_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const journalSequence = bytes => {
  const records = bytes.toString('utf8').split('\n').slice(1, -1);
  return records.length ? JSON.parse(records.at(-1)).sequence : 0;
};

async function regularFile(filename, maxBytes = MAX_JOURNAL_BYTES) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Frozen snapshot contains a non-regular file: ${path.basename(filename)}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`Frozen snapshot file exceeds this import slice limit: ${path.basename(filename)}`);
  }
  return readFile(filename);
}

async function frozenEvidence(snapshotRoot, actorId) {
  if (typeof snapshotRoot !== 'string' || !path.isAbsolute(snapshotRoot)) {
    throw new Error('snapshotRoot must be an absolute frozen-copy directory');
  }
  const root = path.resolve(snapshotRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('snapshotRoot must be a regular directory');
  }
  const authFile = path.join(root, 'auth.json');
  const sourcePath = path.join(root, 'users', `db_${actorId}.json`);
  const barrierRoot = path.join(root, 'memory-deletions');
  const authRaw = await regularFile(authFile, MAX_AUTH_BYTES);
  let auth;
  try { auth = JSON.parse(authRaw.toString('utf8')); }
  catch { throw new Error('Frozen authentication snapshot is not valid JSON'); }
  const installed = auth?.memoryBarrierInstallation;
  if (installed?.version !== 1 || typeof installed.root !== 'string' ||
      !path.isAbsolute(installed.root) || path.basename(installed.root) !== 'memory-deletions' ||
      path.resolve(installed.root) === barrierRoot ||
      !Array.isArray(auth.users) || !auth.users.some(user => user?.id === actorId)) {
    throw new Error('Authentication snapshot does not prove an installed ledger and account');
  }
  const registry = createLocalAccountRegistry({
    directory: path.join(barrierRoot, 'registry'), createIfMissing: false
  });
  await registry.initialize();
  const accountDirectory = path.join(barrierRoot, barrierKey(actorId));
  const { barrier } = await registry.openAccount(actorId, {
    ledgerDirectory: accountDirectory, allowNew: false
  });
  // The registry and account ledger verify their own hash chains and matching
  // receipts. Bind their exact frozen bytes and the auth installation marker
  // to the manifest so a resumed run cannot silently switch evidence.
  const evidenceFiles = [
    authFile,
    path.join(barrierRoot, 'registry', 'deletions.v1.log'),
    path.join(barrierRoot, 'registry', 'deletions.v1.receipts'),
    path.join(accountDirectory, 'deletions.v1.log'),
    path.join(accountDirectory, 'deletions.v1.receipts')
  ];
  const evidenceBytes = await Promise.all(evidenceFiles.map((filename, index) =>
    regularFile(filename, index === 0 ? MAX_AUTH_BYTES : MAX_JOURNAL_BYTES)));
  const evidenceHashes = evidenceBytes.map(sha256);
  // Revalidate after collecting the bytes; a changing "snapshot" must not
  // be accepted as an ordinary copy. External whole-volume rollback still
  // requires an independent backup trust anchor outside this tool.
  await registry.openAccount(actorId, { ledgerDirectory: accountDirectory, allowNew: false });
  return {
    sourcePath, barrier, barrierEvidenceSha256: sha256(JSON.stringify(evidenceHashes)),
    registrySequence: journalSequence(evidenceBytes[1]),
    accountDeletionSequence: journalSequence(evidenceBytes[3])
  };
}

const groupKey = groupId => barrierKey(['source_group', groupId]);
const messageKey = (groupId, messageId) => barrierKey(['source_message', groupId, messageId]);
const revisionKey = message => {
  const sourceHash = barrierKey({
    content: message.content, revision: message.revision || null,
    edited_at: message.edited_at || null, groupId: message.group_id
  });
  return barrierKey(['source_revision', message.group_id, message.id, sourceHash]);
};

function safeGroup(group) {
  if (typeof group.name !== 'string' || !group.name.trim() ||
      (group.type !== undefined && typeof group.type !== 'string') ||
      (group.is_private !== undefined && typeof group.is_private !== 'boolean') ||
      (group.created_at !== undefined && typeof group.created_at !== 'string')) {
    throw new Error(`Group ${group.id} lacks safe identity fields`);
  }
  // Deliberately stage only reviewed identity fields. All previews, summaries,
  // backgrounds, descriptions and unknown fields may derive from removed
  // messages or files, so none of them cross into PostgreSQL.
  return {
    id: group.id, name: group.name,
    ...(group.type === undefined ? {} : { type: group.type }),
    ...(group.is_private === undefined ? {} : { is_private: group.is_private }),
    ...(group.created_at === undefined ? {} : { created_at: group.created_at }),
    last_message_preview: null
  };
}

const allowedMessageFields = new Set([
  'id', 'group_id', 'sender_type', 'sender_id', 'content', 'content_type',
  'reply_to', 'attachments', 'client_message_id', 'metadata', 'created_at',
  'edited_at', 'revision', 'deleted_at', 'is_deleted'
]);
const allowedEncryptionFields = new Set(['encrypted', 'encryption_version', 'encryption_timestamp']);

function requireSimpleTextMessage(message) {
  if (message.content_type && message.content_type !== 'text') {
    throw new Error(`Message ${message.id} is not a text-only migration source`);
  }
  if (typeof message.content !== 'string' ||
      (message.attachments !== undefined &&
       (!Array.isArray(message.attachments) || message.attachments.length)) ||
      Object.keys(message).some(key => !allowedMessageFields.has(key))) {
    throw new Error(`Message ${message.id} contains unsupported attachments, caches or fields`);
  }
  let envelope;
  try { envelope = JSON.parse(message.content); } catch { /* ordinary text */ }
  if ((envelope && typeof envelope === 'object' && !Array.isArray(envelope) &&
       Object.hasOwn(envelope, 'encrypted')) ||
      /\/(?:api\/)?files\/|data:(?:image|audio|video)\/|file:\/\/|blob:/i.test(message.content)) {
    throw new Error(`Message ${message.id} has an opaque body or embedded file reference`);
  }
  const metadata = message.metadata;
  if (metadata != null) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        Object.keys(metadata).some(key => key !== 'encryption')) {
      throw new Error(`Message ${message.id} contains unsupported metadata`);
    }
    const encryption = metadata.encryption;
    if (encryption != null && (!encryption || typeof encryption !== 'object' ||
        Array.isArray(encryption) ||
        Object.keys(encryption).some(key => !allowedEncryptionFields.has(key) ||
          (typeof encryption[key] !== 'string' && typeof encryption[key] !== 'boolean')))) {
      throw new Error(`Message ${message.id} contains unsupported encryption metadata`);
    }
    if (encryption?.encrypted) {
      throw new Error(`Message ${message.id} has an opaque encrypted body`);
    }
  }
}

function requireId(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error(`Invalid ${label}: expected a nonempty string of at most 256 characters`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  return value;
}

// This narrow import accepts a copied, frozen tree, never a live LowDB path.
// It never calls initUserDatabase(), which may modify the original JSON.
export async function readLegacySlice(snapshotRoot, actorId) {
  requireId(actorId, 'account ID');
  if (actorId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(actorId)) {
    throw new Error('Account ID must be a safe LowDB filename component of at most 128 characters');
  }
  const { sourcePath, barrier, barrierEvidenceSha256,
    registrySequence, accountDeletionSequence } = await frozenEvidence(snapshotRoot, actorId);
  const raw = await regularFile(sourcePath, MAX_USER_BYTES);
  let document;
  try { document = JSON.parse(raw.toString('utf8')); }
  catch (error) { throw new Error(`Legacy snapshot is not valid JSON: ${error.message}`); }
  requireRecord(document, 'legacy snapshot');
  if (!Array.isArray(document.groups) || !Array.isArray(document.messages)) {
    throw new Error('Legacy snapshot must contain groups and messages arrays');
  }
  const groups = new Map();
  const messages = new Set();
  const rawGroups = [];
  const rawMessages = [];
  for (const rawGroup of document.groups) {
    const group = requireRecord(rawGroup, 'group');
    const sourceId = requireId(group.id, 'group ID');
    if (groups.has(sourceId)) throw new Error(`Duplicate legacy group ID: ${sourceId}`);
    groups.set(sourceId, true);
    rawGroups.push(group);
  }
  for (const rawMessage of document.messages) {
    const message = requireRecord(rawMessage, 'message');
    const sourceId = requireId(message.id, 'message ID');
    const groupId = requireId(message.group_id, 'message group ID');
    if (!groups.has(groupId)) throw new Error(`Message ${sourceId} refers to missing group ${groupId}`);
    if (messages.has(sourceId)) throw new Error(`Duplicate legacy message ID: ${sourceId}`);
    messages.add(sourceId);
    rawMessages.push(message);
  }
  const keys = [
    ...rawGroups.map(group => groupKey(group.id)),
    ...rawMessages.flatMap(message => [
      groupKey(message.group_id), messageKey(message.group_id, message.id), revisionKey(message)
    ])
  ];
  const deleted = await barrier.deletedIds(actorId, keys);
  const liveGroups = rawGroups.filter(group =>
    !group.deleted_at && !group.is_deleted && !deleted.has(groupKey(group.id)));
  const liveGroupIds = new Set(liveGroups.map(group => group.id));
  const liveMessages = rawMessages.filter(message =>
    liveGroupIds.has(message.group_id) && !message.deleted_at && !message.is_deleted &&
    !deleted.has(messageKey(message.group_id, message.id)) &&
    !deleted.has(revisionKey(message)));
  for (const message of liveMessages) requireSimpleTextMessage(message);
  const liveMessageIds = new Set(liveMessages.map(message => message.id));
  if (liveMessages.some(message => message.reply_to && !liveMessageIds.has(message.reply_to))) {
    throw new Error('A retained message refers to a removed or unavailable reply source');
  }
  const items = [
    ...liveGroups.map(group => ({
      kind: 'group', sourceId: group.id, data: safeGroup(group),
      sourceSha256: sha256(JSON.stringify(group))
    })),
    ...liveMessages.map(message => ({
      kind: 'message', sourceId: message.id, groupId: message.group_id, data: message,
      sourceSha256: sha256(JSON.stringify(message))
    }))
  ];
  const snapshotSha256 = sha256(raw);
  return {
    actorId, spaceId: personalSpaceId(actorId), snapshotSha256, barrierEvidenceSha256,
    registrySequence, accountDeletionSequence,
    sourceGroupCount: groups.size, sourceMessageCount: messages.size,
    groupCount: liveGroups.length, messageCount: liveMessages.length,
    items: items.map(item => ({
      ...item,
      targetId: stablePersonalId(`legacy_${item.kind}`, actorId, item.sourceId),
      sourceCreatedAt: typeof item.data.created_at === 'string' ? item.data.created_at : null,
      groupTargetId: item.groupId ? stablePersonalId('legacy_group', actorId, item.groupId) : null
    }))
  };
}

export async function applyLegacySliceMigration(pool, { schema = 'qunthink_core' } = {}) {
  const q = quoteSchema(schema);
  const sql = await readFile(sqlFile, 'utf8');
  const checksum = sha256(sql);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
      ['qunthink-legacy-slice', schema]);
    await client.query(`SET LOCAL search_path TO ${q}, pg_catalog`);
    const foundation = await client.query('SELECT 1 FROM schema_migrations WHERE version=2');
    if (!foundation.rowCount) throw new Error('Foundation migration version 2 is required');
    const exists = await client.query("SELECT to_regclass('legacy_import_meta') AS name");
    let applied = false;
    if (!exists.rows[0].name) {
      await client.query(sql);
      await client.query('INSERT INTO legacy_import_meta(version,checksum) VALUES (1,$1)', [checksum]);
      applied = true;
    } else {
      const meta = await client.query('SELECT version,checksum FROM legacy_import_meta');
      if (meta.rowCount !== 1 || meta.rows[0].version !== 1 || meta.rows[0].checksum !== checksum) {
        throw new Error('Legacy import schema checksum mismatch');
      }
    }
    await client.query('COMMIT');
    return { schema, applied, checksum };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function scopedTransaction(pool, schema, spaceId, readOnly, fn) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query(`SET LOCAL search_path TO ${quoteSchema(schema)}, pg_catalog`);
    await client.query("SELECT set_config('app.space_id',$1,true)", [spaceId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function manifestFor(client, snapshot, lock = false) {
  const result = await client.query(
    `SELECT snapshot_sha256,barrier_evidence_sha256,registry_sequence,
            account_deletion_sequence,source_group_count,
            source_message_count,group_count,message_count FROM legacy_import_manifests
     WHERE space_id=$1 AND source_account=$2 ${lock ? 'FOR UPDATE' : ''}`,
    [snapshot.spaceId, snapshot.actorId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Legacy import manifest is missing');
  if (row.snapshot_sha256 !== snapshot.snapshotSha256 ||
      row.barrier_evidence_sha256 !== snapshot.barrierEvidenceSha256 ||
      row.registry_sequence !== snapshot.registrySequence ||
      row.account_deletion_sequence !== snapshot.accountDeletionSequence ||
      row.source_group_count !== snapshot.sourceGroupCount ||
      row.source_message_count !== snapshot.sourceMessageCount ||
      row.group_count !== snapshot.groupCount || row.message_count !== snapshot.messageCount) {
    throw new Error('Legacy source or deletion evidence changed; this space is bound to another frozen snapshot');
  }
}

async function importItem(pool, schema, snapshot, item) {
  return scopedTransaction(pool, schema, snapshot.spaceId, false, async client => {
    // This serializes concurrent runs for the same account. A crash only
    // rolls back the current item; earlier item transactions stay durable.
    await manifestFor(client, snapshot, true);
    const owner = await client.query(
      `SELECT s.policy_epoch,p.active AS principal_active,m.active AS member_active,m.role
       FROM spaces s JOIN memberships m ON m.space_id=s.id AND m.actor_id=$2
       JOIN principals p ON p.id=m.actor_id
       WHERE s.id=$1 FOR SHARE OF s,m`, [snapshot.spaceId, snapshot.actorId]
    );
    if (!owner.rows[0]?.principal_active || !owner.rows[0]?.member_active ||
        owner.rows[0]?.role !== 'owner') {
      throw new Error('Legacy account is no longer an active personal-space owner');
    }
    const mapped = await client.query(
      `SELECT target_id,source_sha256 FROM legacy_import_map
       WHERE space_id=$1 AND source_account=$2 AND source_kind=$3 AND source_id=$4`,
      [snapshot.spaceId, snapshot.actorId, item.kind, item.sourceId]
    );
    if (mapped.rowCount) {
      if (mapped.rows[0].target_id !== item.targetId ||
          mapped.rows[0].source_sha256 !== item.sourceSha256) {
        throw new Error(`Legacy mapping conflict: ${item.kind} ${item.sourceId}`);
      }
      return false;
    }
    const created = await client.query(
      'INSERT INTO objects(space_id,id,kind,created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
      [snapshot.spaceId, item.targetId, `legacy_${item.kind}`, snapshot.actorId]
    );
    if (!created.rowCount) throw new Error(`Target object ID collision: ${item.targetId}`);
    const body = {
      legacy: {
        sourceAccount: snapshot.actorId, sourceKind: item.kind, sourceId: item.sourceId,
        snapshotSha256: snapshot.snapshotSha256, sourceSha256: item.sourceSha256,
        groupObjectId: item.groupTargetId
      },
      data: item.data
    };
    await client.query(
      'INSERT INTO object_revisions(space_id,object_id,revision,body) VALUES ($1,$2,0,$3)',
      [snapshot.spaceId, item.targetId, body]
    );
    await client.query(
      `INSERT INTO object_acl(space_id,object_id,actor_id,actions,granted_epoch)
       VALUES ($1,$2,$3,ARRAY['read']::text[],$4)`,
      [snapshot.spaceId, item.targetId, snapshot.actorId, owner.rows[0].policy_epoch]
    );
    await client.query(
      `INSERT INTO legacy_import_map
       (space_id,source_account,source_kind,source_id,target_id,source_sha256,source_created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [snapshot.spaceId, snapshot.actorId, item.kind, item.sourceId,
        item.targetId, item.sourceSha256, item.sourceCreatedAt]
    );
    return true;
  });
}

export async function verifyLegacySlice(pool, { schema = 'qunthink_core', snapshotRoot, actorId }) {
  const snapshot = await readLegacySlice(snapshotRoot, actorId);
  return scopedTransaction(pool, schema, snapshot.spaceId, true, async client => {
    await manifestFor(client, snapshot);
    const result = await client.query(
      `SELECT m.source_kind,m.source_id,m.target_id,m.source_sha256,m.source_created_at,
              o.kind AS target_kind,o.created_by,o.lifecycle,o.revision,r.body,
              a.actions,a.revoked_at
       FROM legacy_import_map m
       LEFT JOIN objects o ON o.space_id=m.space_id AND o.id=m.target_id
       LEFT JOIN object_revisions r ON r.space_id=o.space_id AND r.object_id=o.id AND r.revision=0
       LEFT JOIN object_acl a ON a.space_id=o.space_id AND a.object_id=o.id AND a.actor_id=$2
       WHERE m.space_id=$1 AND m.source_account=$2`,
      [snapshot.spaceId, snapshot.actorId]
    );
    const byKey = new Map(result.rows.map(row => [`${row.source_kind}\0${row.source_id}`, row]));
    if (byKey.size !== result.rowCount) throw new Error('Duplicate imported source mapping');
    const counts = { group: 0, message: 0 };
    for (const item of snapshot.items) {
      const row = byKey.get(`${item.kind}\0${item.sourceId}`);
      if (!row) continue;
      counts[item.kind]++;
      if (row.target_id !== item.targetId || row.source_sha256 !== item.sourceSha256 ||
          row.source_created_at !== item.sourceCreatedAt ||
          row.target_kind !== `legacy_${item.kind}` || row.created_by !== snapshot.actorId ||
          row.lifecycle !== 'active' || Number(row.revision) !== 0 ||
          !row.actions?.includes('read') || row.revoked_at ||
          !isDeepStrictEqual(row.body, {
            legacy: {
              sourceAccount: snapshot.actorId, sourceKind: item.kind, sourceId: item.sourceId,
              snapshotSha256: snapshot.snapshotSha256, sourceSha256: item.sourceSha256,
              groupObjectId: item.groupTargetId
            }, data: item.data
          })) {
        throw new Error(`Imported object does not match source: ${item.kind} ${item.sourceId}`);
      }
      byKey.delete(`${item.kind}\0${item.sourceId}`);
    }
    if (byKey.size) throw new Error('Unexpected source mapping in legacy import');
    return {
      spaceId: snapshot.spaceId, snapshotSha256: snapshot.snapshotSha256,
      barrierEvidenceSha256: snapshot.barrierEvidenceSha256,
      registrySequence: snapshot.registrySequence,
      accountDeletionSequence: snapshot.accountDeletionSequence,
      source: { groups: snapshot.sourceGroupCount, messages: snapshot.sourceMessageCount },
      eligible: { groups: snapshot.groupCount, messages: snapshot.messageCount },
      excluded: {
        groups: snapshot.sourceGroupCount - snapshot.groupCount,
        messages: snapshot.sourceMessageCount - snapshot.messageCount
      },
      imported: { groups: counts.group, messages: counts.message },
      complete: counts.group === snapshot.groupCount && counts.message === snapshot.messageCount
    };
  });
}

export async function importLegacySlice(pool, {
  schema = 'qunthink_core', snapshotRoot, actorId, dryRun = false, maxItems = Infinity
}) {
  if (maxItems !== Infinity && (!Number.isSafeInteger(maxItems) || maxItems < 0)) {
    throw new Error('maxItems must be a nonnegative integer');
  }
  const snapshot = await readLegacySlice(snapshotRoot, actorId);
  if (dryRun) return {
    dryRun: true, spaceId: snapshot.spaceId, snapshotSha256: snapshot.snapshotSha256,
    barrierEvidenceSha256: snapshot.barrierEvidenceSha256,
    registrySequence: snapshot.registrySequence,
    accountDeletionSequence: snapshot.accountDeletionSequence,
    source: { groups: snapshot.sourceGroupCount, messages: snapshot.sourceMessageCount },
    eligible: { groups: snapshot.groupCount, messages: snapshot.messageCount },
    excluded: {
      groups: snapshot.sourceGroupCount - snapshot.groupCount,
      messages: snapshot.sourceMessageCount - snapshot.messageCount
    },
    scope: 'frozen local personal-space, safe text group-message staging only; no attachments'
  };
  await applyLegacySliceMigration(pool, { schema });
  const spaceId = await ensurePersonalWorkspace(pool, schema, actorId);
  if (spaceId !== snapshot.spaceId) throw new Error('Personal space ID mismatch');
  await scopedTransaction(pool, schema, spaceId, false, async client => {
    await client.query(
      `INSERT INTO legacy_import_manifests
       (space_id,source_account,snapshot_sha256,barrier_evidence_sha256,
        registry_sequence,account_deletion_sequence,
        source_group_count,source_message_count,group_count,message_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [spaceId, actorId, snapshot.snapshotSha256, snapshot.barrierEvidenceSha256,
        snapshot.registrySequence, snapshot.accountDeletionSequence,
        snapshot.sourceGroupCount, snapshot.sourceMessageCount,
        snapshot.groupCount, snapshot.messageCount]
    );
    await manifestFor(client, snapshot, true);
  });
  let added = 0;
  for (const item of snapshot.items) {
    if (added >= maxItems) break;
    if (await importItem(pool, schema, snapshot, item)) added++;
  }
  return { ...(await verifyLegacySlice(pool, { schema, snapshotRoot, actorId })), added };
}
