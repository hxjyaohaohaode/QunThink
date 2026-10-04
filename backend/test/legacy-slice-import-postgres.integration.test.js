import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { createLocalAccountRegistry } from '../src/services/memory/localAccountRegistry.js';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import { importLegacySlice, verifyLegacySlice, readLegacySlice } from '../src/foundations/legacySliceImport.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;
const execFileAsync = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const key = value => hash(JSON.stringify(value));
const groupKey = groupId => key(['source_group', groupId]);
const messageKey = (groupId, messageId) => key(['source_message', groupId, messageId]);
const revisionKey = message => key(['source_revision', message.group_id, message.id,
  key({ content: message.content, revision: message.revision || null,
    edited_at: message.edited_at || null, groupId: message.group_id })]);

test('frozen LowDB and deletion ledgers stage only live simple text sources in real PostgreSQL', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required'
}, async () => {
  const schema = `qt_legacy_${randomBytes(5).toString('hex')}`;
  const q = quoteSchema(schema);
  const snapshotRoot = await mkdtemp(path.join(tmpdir(), 'qt-legacy-frozen-'));
  const usersDir = path.join(snapshotRoot, 'users');
  const barrierRoot = path.join(snapshotRoot, 'memory-deletions');
  await mkdir(usersDir);
  const sourcePath = path.join(usersDir, 'db_account-a.json');
  const otherSourcePath = path.join(usersDir, 'db_account-b.json');
  const authPath = path.join(snapshotRoot, 'auth.json');
  const auth = {
    users: [{ id: 'account-a' }, { id: 'account-b' }],
    memoryBarrierInstallation: {
      version: 1, root: path.join(snapshotRoot, 'original-live', 'memory-deletions')
    }
  };
  await writeFile(authPath, JSON.stringify(auth), 'utf8');
  const source = {
    groups: [
      { id: 'g-live', name: '工作组', created_at: '2025-01-01T00:00:00.000Z',
        last_message_preview: '已撤销的旧预览', latest_digest_blob: '非典型缓存里的秘密' },
      { id: 'g-deleted', name: '已删除群', created_at: '2025-02-01T00:00:00.000Z' },
      { id: 'g-inband-deleted', name: '库内标记删除群', is_deleted: true }
    ],
    messages: [
      { id: 'm-live', group_id: 'g-live', content: '保留的旧明文消息',
        content_type: 'text', attachments: [], created_at: '2025-01-02T00:00:00.000Z' },
      { id: 'm-deleted', group_id: 'g-live', content: '删除后从旧 JSON 恢复的秘密',
        content_type: 'text', attachments: [], created_at: '2025-01-03T00:00:00.000Z' },
      { id: 'm-old-revision', group_id: 'g-live', content: '已编辑掉的旧正文',
        content_type: 'text', attachments: [], created_at: '2025-01-04T00:00:00.000Z' },
      { id: 'm-from-deleted-group', group_id: 'g-deleted', content: '已删群的正文',
        content_type: 'text', attachments: [], created_at: '2025-02-02T00:00:00.000Z' },
      { id: 'm-from-inband-group', group_id: 'g-inband-deleted', content: '库内已删群正文',
        content_type: 'text', attachments: [], created_at: '2025-02-03T00:00:00.000Z' }
    ],
    files: [{ id: 'not-imported', group_id: 'g-live' }],
    tasks: [{ id: 'not-imported' }]
  };
  const sourceBytes = Buffer.from(JSON.stringify(source));
  await writeFile(sourcePath, sourceBytes);
  await writeFile(otherSourcePath, sourceBytes);
  const registry = createLocalAccountRegistry({
    directory: path.join(barrierRoot, 'registry'), createIfMissing: true
  });
  await registry.initialize();
  const accountLedger = actorId => path.join(barrierRoot, key(actorId));
  const { barrier } = await registry.openAccount('account-a', {
    ledgerDirectory: accountLedger('account-a'), allowNew: true
  });
  await registry.openAccount('account-b', {
    ledgerDirectory: accountLedger('account-b'), allowNew: true
  });
  await barrier.markDeleted('account-a', groupKey('g-deleted'));
  await barrier.markDeleted('account-a', messageKey('g-live', 'm-deleted'));
  await barrier.markDeleted('account-a', revisionKey(source.messages[2]));

  const pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 10000 });
  try {
    await applyFoundationsMigration(pool, { schema });
    const dryRun = await importLegacySlice(null, {
      snapshotRoot, actorId: 'account-a', schema, dryRun: true
    });
    assert.equal(dryRun.snapshotSha256, hash(sourceBytes));
    assert.deepEqual(dryRun.source, { groups: 3, messages: 5 });
    assert.equal(dryRun.registrySequence, 2);
    assert.equal(dryRun.accountDeletionSequence, 3);
    assert.deepEqual(dryRun.eligible, { groups: 1, messages: 1 });
    assert.deepEqual(dryRun.excluded, { groups: 2, messages: 4 });
    const cli = await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../scripts/import-legacy-slice.mjs', import.meta.url)),
      '--snapshot-root', snapshotRoot, '--user', 'account-a', '--schema', schema, '--dry-run'
    ]);
    assert.deepEqual(JSON.parse(cli.stdout).eligible, { groups: 1, messages: 1 });
    assert.equal((await pool.query(`SELECT to_regclass('${schema}.legacy_import_meta') AS name`)).rows[0].name, null);

    const first = await importLegacySlice(pool, {
      snapshotRoot, actorId: 'account-a', schema, maxItems: 1
    });
    assert.equal(first.added, 1);
    assert.deepEqual(first.imported, { groups: 1, messages: 0 });
    assert.equal(first.complete, false);

    const anotherPool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 });
    try {
      const [a, b] = await Promise.all([
        importLegacySlice(pool, { snapshotRoot, actorId: 'account-a', schema }),
        importLegacySlice(anotherPool, { snapshotRoot, actorId: 'account-a', schema })
      ]);
      assert.deepEqual([a.complete, b.complete], [true, true]);
      assert.equal(a.added + b.added, 1);
      assert.equal((await importLegacySlice(anotherPool, {
        snapshotRoot, actorId: 'account-a', schema
      })).added, 0);
    } finally { await anotherPool.end(); }

    const original = await readLegacySlice(snapshotRoot, 'account-a');
    const verified = await verifyLegacySlice(pool, { snapshotRoot, actorId: 'account-a', schema });
    assert.deepEqual(verified.imported, { groups: 1, messages: 1 });
    assert.equal(verified.spaceId, original.spaceId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.legacy_import_map WHERE space_id=$1`,
      [original.spaceId])).rows[0].n, 2);
    const importedBodies = await pool.query(
      `SELECT r.body FROM ${q}.object_revisions r WHERE r.space_id=$1`, [original.spaceId]
    );
    assert.equal(importedBodies.rowCount, 2);
    assert.equal(importedBodies.rows.some(row => row.body.data.id === 'g-deleted' ||
      row.body.data.id === 'm-deleted' || row.body.data.id === 'm-old-revision' ||
      row.body.data.id === 'm-from-deleted-group' || row.body.data.id === 'm-from-inband-group'), false);
    const stagedGroup = importedBodies.rows.find(row => row.body.data.id === 'g-live').body.data;
    assert.equal(stagedGroup.last_message_preview, null);
    assert.equal(Object.hasOwn(stagedGroup, 'latest_digest_blob'), false);
    const message = importedBodies.rows.find(row => row.body.data.id === 'm-live').body;
    assert.equal(message.data.content, '保留的旧明文消息');
    assert.equal(message.legacy.groupObjectId,
      original.items.find(item => item.sourceId === 'g-live').targetId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.outbox`)).rows[0].n, 0);
    assert.equal(hash(await readFile(sourcePath)), hash(sourceBytes));

    await assert.rejects(readLegacySlice(snapshotRoot, 'unregistered-account'), /installed ledger and account/i);
    const other = await importLegacySlice(pool, { snapshotRoot, actorId: 'account-b', schema });
    assert.equal(other.complete, true);
    assert.deepEqual(other.eligible, { groups: 2, messages: 4 });
    assert.notEqual(other.spaceId, original.spaceId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.legacy_import_map`)).rows[0].n, 8);

    // A restored old JSON carries removed content, but the independent ledger
    // removes it before any insert. A later source or ledger change cannot be
    // silently adopted by a resumable run.
    source.messages[0].content = 'changed after staging';
    await writeFile(sourcePath, JSON.stringify(source), 'utf8');
    await assert.rejects(importLegacySlice(pool, {
      snapshotRoot, actorId: 'account-a', schema
    }), /source or deletion evidence changed/i);
    await writeFile(sourcePath, sourceBytes);
    await barrier.markDeleted('account-a', messageKey('g-live', 'm-live'));
    await assert.rejects(importLegacySlice(pool, {
      snapshotRoot, actorId: 'account-a', schema
    }), /source or deletion evidence changed/i);

    const ledgerReceipt = path.join(accountLedger('account-a'), 'deletions.v1.receipts');
    const receiptBytes = await readFile(ledgerReceipt);
    await writeFile(ledgerReceipt, 'broken');
    await assert.rejects(importLegacySlice(null, {
      snapshotRoot, actorId: 'account-a', schema, dryRun: true
    }), /DELETION_BARRIER|deletion journal|invalid/i);
    await writeFile(ledgerReceipt, receiptBytes);
    await unlink(ledgerReceipt);
    await assert.rejects(importLegacySlice(null, {
      snapshotRoot, actorId: 'account-a', schema, dryRun: true
    }), /unavailable|deletion journal/i);
    await writeFile(ledgerReceipt, receiptBytes);
    const registryReceipt = path.join(barrierRoot, 'registry', 'deletions.v1.receipts');
    const registryBytes = await readFile(registryReceipt);
    await writeFile(registryReceipt, 'broken');
    await assert.rejects(importLegacySlice(null, {
      snapshotRoot, actorId: 'account-b', schema, dryRun: true
    }), /DELETION_BARRIER|deletion journal|invalid/i);
    await writeFile(registryReceipt, registryBytes);

    // An attachment-bearing or cached message is outside this slice; no
    // partial import should accidentally copy its parsed content.
    source.messages[0].attachments = [{ id: 'not-imported', parsed_content: 'private bytes' }];
    await writeFile(otherSourcePath, JSON.stringify(source), 'utf8');
    await assert.rejects(importLegacySlice(null, {
      snapshotRoot, actorId: 'account-b', schema, dryRun: true
    }), /unsupported attachments/i);
    await writeFile(otherSourcePath, sourceBytes);
    source.messages[0].attachments = [];
    source.messages[0].content = '{"encrypted":"opaque"}';
    await writeFile(otherSourcePath, JSON.stringify(source), 'utf8');
    await assert.rejects(importLegacySlice(null, {
      snapshotRoot, actorId: 'account-b', schema, dryRun: true
    }), /opaque body/i);
    source.messages[0].content = '参见 /api/files/old-private-file';
    await writeFile(otherSourcePath, JSON.stringify(source), 'utf8');
    await assert.rejects(importLegacySlice(null, {
      snapshotRoot, actorId: 'account-b', schema, dryRun: true
    }), /file reference/i);
    await writeFile(otherSourcePath, sourceBytes);

    // Verification rejects target corruption rather than reporting a false
    // complete migration.
    const otherSnapshot = await readLegacySlice(snapshotRoot, 'account-b');
    const liveTarget = otherSnapshot.items.find(item => item.sourceId === 'm-live');
    await pool.query(`UPDATE ${q}.object_revisions SET body='{}'::jsonb WHERE space_id=$1 AND object_id=$2 AND revision=0`,
      [other.spaceId, liveTarget.targetId]);
    await assert.rejects(verifyLegacySlice(pool, {
      snapshotRoot, actorId: 'account-b', schema
    }), /does not match source/i);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await pool.end();
    if (!path.resolve(snapshotRoot).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
      throw new Error('Refusing cleanup outside the test temporary directory');
    }
    await rm(snapshotRoot, { recursive: true, force: true });
  }
});
