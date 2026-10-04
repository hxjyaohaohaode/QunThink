import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import {
  executeObjectRevisionCommand, disableMember, readCommandReceipt,
  claimOutbox, markOutboxDelivered, consumeEventOnce
} from '../src/foundations/store.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;

test('real PostgreSQL foundation transactions, revocation and inbox/outbox replay', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required for the real PostgreSQL test'
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000 });
  const suffix = randomBytes(5).toString('hex');
  const schema = `qt_foundations_${suffix}`;
  const runtimeRole = `qt_foundations_runtime_${suffix}`;
  const q = quoteSchema(schema);
  const role = quoteSchema(runtimeRole);
  try {
    const migrated = await Promise.all([
      applyFoundationsMigration(pool, { schema }),
      applyFoundationsMigration(pool, { schema })
    ]);
    assert.deepEqual(migrated.map(result => result.applied).sort(), [false, true]);
    assert.equal((await applyFoundationsMigration(pool, { schema })).applied, false);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.schema_migrations`)).rows[0].n, 2);
    const rls = await pool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace=$1::regnamespace AND relname IN ('spaces','memberships','objects','object_acl','commands','domain_events','outbox','consumer_inbox')`,
      [schema]
    );
    assert.equal(rls.rowCount, 8);
    assert.ok(rls.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));

    await pool.query(`INSERT INTO ${q}.principals(id,kind) VALUES
      ('owner','human'),('member','human'),('outsider','human'),('worker','service')`);
    await pool.query(`INSERT INTO ${q}.spaces(id,kind,owner_id) VALUES ('team-a','team','owner'),('team-b','team','owner')`);
    await pool.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role) VALUES
      ('team-a','owner','owner'),('team-a','member','member'),('team-b','owner','owner'),('team-b','outsider','member')`);
    await pool.query(`INSERT INTO ${q}.objects(space_id,id,kind,created_by) VALUES
      ('team-a','doc-1','document','owner'),('team-b','doc-1','document','owner')`);
    await pool.query(`INSERT INTO ${q}.object_revisions(space_id,object_id,revision,body) VALUES
      ('team-a','doc-1',0,'{}'::jsonb),('team-b','doc-1',0,'{}'::jsonb)`);
    await pool.query(`INSERT INTO ${q}.object_acl(space_id,object_id,actor_id,actions,granted_epoch) VALUES
      ('team-a','doc-1','member',ARRAY['read','write'],0)`);

    // PostgreSQL's own RLS behavior must be tested as a non-owner role; the
    // migration/superuser connection itself bypasses RLS.
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    await pool.query(`GRANT USAGE ON SCHEMA ${q} TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${q} TO ${role}`);
    const restricted = await pool.connect();
    try {
      await restricted.query('BEGIN');
      await restricted.query(`SET LOCAL ROLE ${role}`);
      assert.equal((await restricted.query(`SELECT count(*)::int AS n FROM ${q}.objects`)).rows[0].n, 0);
      await restricted.query("SELECT set_config('app.space_id', 'team-a', true)");
      assert.deepEqual((await restricted.query(`SELECT space_id,id FROM ${q}.objects`)).rows.map(row => row.space_id), ['team-a']);
      await restricted.query('COMMIT');
    } finally {
      await restricted.query('ROLLBACK').catch(() => {});
      restricted.release();
    }

    const command = { schema, spaceId: 'team-a', actorId: 'member', objectId: 'doc-1',
      requestKey: 'same-click', expectedRevision: 0, body: { title: '唯一一次修改' } };
    const concurrent = await Promise.all([
      executeObjectRevisionCommand(pool, command),
      executeObjectRevisionCommand(pool, command)
    ]);
    assert.equal(new Set(concurrent.map(result => result.eventId)).size, 1);
    assert.deepEqual(concurrent.map(result => result.replayed).sort(), [false, true]);
    assert.equal((await pool.query(`SELECT revision FROM ${q}.objects WHERE space_id='team-a' AND id='doc-1'`)).rows[0].revision, '1');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.object_revisions WHERE space_id='team-a' AND object_id='doc-1'`)).rows[0].n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events WHERE space_id='team-a'`)).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.outbox WHERE space_id='team-a'`)).rows[0].n, 1);
    assert.equal((await readCommandReceipt(pool, { schema, spaceId: 'team-a', actorId: 'member', requestKey: 'same-click' })).response.eventId, concurrent[0].eventId);
    await assert.rejects(executeObjectRevisionCommand(pool, { ...command, body: { title: '另一内容' } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(executeObjectRevisionCommand(pool, { ...command, requestKey: 'stale', body: { title: '过时写入' } }), error => error.code === 'REVISION_CONFLICT');
    assert.equal((await readCommandReceipt(pool, { schema, spaceId: 'team-a', actorId: 'member', requestKey: 'stale' })), null);
    await assert.rejects(executeObjectRevisionCommand(pool, { ...command, spaceId: 'team-b', actorId: 'outsider', requestKey: 'cross-space' }), error => error.code === 'ACCESS_DENIED');

    // An event/outbox failure after the aggregate UPDATE must roll back the
    // revision and command receipt together. The original key can then retry.
    await pool.query(`CREATE FUNCTION ${q}.test_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$`);
    await pool.query(`CREATE TRIGGER test_reject_outbox BEFORE INSERT ON ${q}.outbox
      FOR EACH ROW EXECUTE FUNCTION ${q}.test_reject_outbox()`);
    const recoveryCommand = { ...command, requestKey: 'outbox-recovery', expectedRevision: 1, body: { title: '写后事件' } };
    await assert.rejects(executeObjectRevisionCommand(pool, recoveryCommand), /injected outbox failure/);
    assert.equal((await pool.query(`SELECT revision FROM ${q}.objects WHERE space_id='team-a' AND id='doc-1'`)).rows[0].revision, '1');
    assert.equal((await readCommandReceipt(pool, { schema, spaceId: 'team-a', actorId: 'member', requestKey: 'outbox-recovery' })), null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events WHERE space_id='team-a'`)).rows[0].n, 1);
    await pool.query(`DROP TRIGGER test_reject_outbox ON ${q}.outbox`);
    await pool.query(`DROP FUNCTION ${q}.test_reject_outbox()`);
    const recovered = await executeObjectRevisionCommand(pool, recoveryCommand);
    assert.equal(recovered.revision, 2);
    // Isolate the first event for the lease/replay scenario below.
    await pool.query(`UPDATE ${q}.outbox SET delivered_at=now() WHERE space_id='team-a' AND event_id=$1`, [recovered.eventId]);

    const [firstClaim, secondClaim] = await Promise.all([
      claimOutbox(pool, { schema, spaceId: 'team-a', workerId: 'worker-a' }),
      claimOutbox(pool, { schema, spaceId: 'team-a', workerId: 'worker-b' })
    ]);
    const claimed = firstClaim || secondClaim;
    assert.ok(claimed);
    assert.equal([firstClaim, secondClaim].filter(Boolean).length, 1);
    const ownerWorker = firstClaim ? 'worker-a' : 'worker-b';
    assert.equal(await markOutboxDelivered(pool, { schema, spaceId: 'team-a', workerId: 'wrong-worker', eventId: claimed.eventId, attempts: claimed.attempts }), false);

    await pool.query(`CREATE TABLE ${q}.test_projection(event_id text PRIMARY KEY, applied_count integer NOT NULL)`);
    const apply = async client => {
      await client.query(`INSERT INTO ${q}.test_projection(event_id,applied_count) VALUES ($1,1)
        ON CONFLICT(event_id) DO UPDATE SET applied_count=${q}.test_projection.applied_count+1`, [claimed.eventId]);
    };
    await assert.rejects(consumeEventOnce(pool, { schema, spaceId: 'team-a', consumer: 'projection-v1', eventId: claimed.eventId,
      apply: async client => { await apply(client); throw new Error('projection failure'); }
    }), /projection failure/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.consumer_inbox`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.test_projection`)).rows[0].n, 0);
    const consumed = await Promise.all(Array.from({ length: 2 }, () => consumeEventOnce(pool, {
      schema, spaceId: 'team-a', consumer: 'projection-v1', eventId: claimed.eventId, apply
    })));
    assert.deepEqual(consumed.sort(), [false, true]);
    assert.equal((await pool.query(`SELECT applied_count FROM ${q}.test_projection WHERE event_id=$1`, [claimed.eventId])).rows[0].applied_count, 1);
    // Simulate delivery succeeding but acknowledgement being lost. The lease
    // expires, another worker claims it, and Inbox prevents a second effect.
    await pool.query(`UPDATE ${q}.outbox SET lease_until=now()-interval '1 second' WHERE space_id='team-a' AND event_id=$1`, [claimed.eventId]);
    const redelivered = await claimOutbox(pool, { schema, spaceId: 'team-a', workerId: ownerWorker });
    assert.equal(redelivered.eventId, claimed.eventId);
    assert.equal(redelivered.attempts, 2);
    assert.equal(await consumeEventOnce(pool, { schema, spaceId: 'team-a', consumer: 'projection-v1', eventId: claimed.eventId, apply }), false);
    assert.equal((await pool.query(`SELECT applied_count FROM ${q}.test_projection WHERE event_id=$1`, [claimed.eventId])).rows[0].applied_count, 1);
    // Reclaim under the same worker identity: an old callback still cannot
    // acknowledge the newer lease because the claim generation changed.
    assert.equal(await markOutboxDelivered(pool, { schema, spaceId: 'team-a', workerId: ownerWorker, eventId: claimed.eventId, attempts: claimed.attempts }), false);
    assert.equal(await markOutboxDelivered(pool, { schema, spaceId: 'team-a', workerId: ownerWorker, eventId: claimed.eventId, attempts: redelivered.attempts }), true);
    assert.equal(await markOutboxDelivered(pool, { schema, spaceId: 'team-a', workerId: ownerWorker, eventId: claimed.eventId, attempts: redelivered.attempts }), false);

    // A held command policy lock delays revocation. After it commits, a new
    // command must see the new membership state and cannot create an event.
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query(`SELECT policy_epoch FROM ${q}.spaces WHERE id='team-a' FOR SHARE`);
      let finished = false;
      const revoking = disableMember(pool, { schema, spaceId: 'team-a', actorId: 'owner', targetId: 'member', requestKey: 'disable-member' })
        .finally(() => { finished = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(finished, false);
      await held.query('COMMIT');
      const revoked = await revoking;
      assert.equal(revoked.policyEpoch, 1);
      assert.equal((await pool.query(`SELECT active FROM ${q}.memberships WHERE space_id='team-a' AND actor_id='member'`)).rows[0].active, false);
      await assert.rejects(executeObjectRevisionCommand(pool, { ...command, requestKey: 'after-revoke', expectedRevision: 2 }), error => error.code === 'ACCESS_REVOKED');
      assert.equal((await readCommandReceipt(pool, { schema, spaceId: 'team-a', actorId: 'member', requestKey: 'after-revoke' })), null);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events WHERE space_id='team-a'`)).rows[0].n, 3);
    } finally {
      await held.query('ROLLBACK').catch(() => {});
      held.release();
    }

    // Execute the store through a database role that does not own the tables
    // or bypass RLS. A privileged migration connection passing is insufficient.
    await pool.query(`INSERT INTO ${q}.object_acl(space_id,object_id,actor_id,actions,granted_epoch)
      VALUES ('team-b','doc-1','outsider',ARRAY['read','write'],0)`);
    const runtimePool = {
      async connect() {
        const client = await pool.connect();
        try {
          await client.query(`SET ROLE ${role}`);
          return { query: client.query.bind(client), release: () => client.release(true) };
        } catch (error) {
          client.release(true);
          throw error;
        }
      }
    };
    const runtimeResult = await executeObjectRevisionCommand(runtimePool, {
      schema, spaceId: 'team-b', actorId: 'outsider', objectId: 'doc-1',
      requestKey: 'runtime-role-write', expectedRevision: 0, body: { title: '受限角色写入' }
    });
    assert.equal(runtimeResult.revision, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events WHERE space_id='team-b'`)).rows[0].n, 1);
    await assert.rejects(executeObjectRevisionCommand(runtimePool, {
      schema, spaceId: 'team-a', actorId: 'outsider', objectId: 'doc-1',
      requestKey: 'runtime-role-cross-space', expectedRevision: 2, body: { title: '越权' }
    }), error => error.code === 'ACCESS_REVOKED');
  } finally {
    // The random schema is created solely in the supplied test database.
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await pool.end();
  }
});
