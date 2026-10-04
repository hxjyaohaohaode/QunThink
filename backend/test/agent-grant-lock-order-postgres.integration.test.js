import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import { disableMember } from '../src/foundations/store.js';
import {
  claimRun, createGoal, createRun, grantTool, readRun,
  settleGoalPreflight, startStep
} from '../src/foundations/agentStore.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`did not reach ${label}`);
}

test('grant and internal preflight do not deadlock on Worker ACL and goal locks', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required'
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 10000 });
  const schema = `qt_grant_locks_${randomBytes(5).toString('hex')}`;
  const q = quoteSchema(schema);
  const owner = { schema, spaceId: 'space', actorId: 'owner', goalId: 'goal' };
  const worker = { schema, spaceId: 'space', actorId: 'worker', runId: 'run', stepKey: 'preflight' };
  let holder;
  let membershipHolder;
  try {
    await applyFoundationsMigration(pool, { schema });
    await pool.query(`INSERT INTO ${q}.principals(id,kind) VALUES
      ('owner','human'),('worker','service'),('worker2','service')`);
    await pool.query(`INSERT INTO ${q}.spaces(id,kind,owner_id) VALUES ('space','personal','owner')`);
    await pool.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role) VALUES
      ('space','owner','owner'),('space','worker','member'),('space','worker2','member')`);
    await createGoal(pool, {
      ...owner, requestKey: 'create-goal', outcome: '检查锁顺序',
      checks: [{ key: 'human-check', description: '人工验证', required: true }]
    });
    const grant = (grantId, workerId, requestKey) => grantTool(pool, {
      ...owner, grantId, workerId, requestKey,
      toolId: 'internal.goal_preflight.v1', maxQuoteMicros: '0',
      expiresAt: new Date(Date.now() + 3600000).toISOString()
    });
    await grant('first', 'worker', 'grant-first');
    await createRun(pool, {
      ...owner, runId: 'run', requestKey: 'create-run',
      steps: [{ key: 'preflight', action: 'internal.goal_preflight.v1', inputRefs: [], maxAttempts: 1 }]
    });
    const claim = await claimRun(pool, worker);
    await startStep(pool, { ...worker, fence: claim.fence });

    // Hold a compatible SHARE lock on the existing Worker ACL. A concurrent
    // grant must wait to update that ACL. Preflight must still be able to lock
    // the goal and finish before this holder is released.
    holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${q}.object_acl WHERE space_id='space'
      AND object_id='goal' AND actor_id='worker' FOR SHARE`);
    const lateGrant = grant('second', 'worker', 'grant-second').then(
      value => ({ value }), error => ({ error })
    );
    await eventually(async () => {
      const activity = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%INSERT INTO object_acl%' LIMIT 1`);
      return activity.rowCount > 0;
    }, 'grant waiting for Worker ACL');
    const settled = settleGoalPreflight(pool, { ...worker, fence: claim.fence }).then(
      value => ({ value }), error => ({ error })
    );
    const first = await Promise.race([
      settled,
      delay(1500).then(() => ({ timeout: true }))
    ]);
    assert.equal(first.timeout, undefined, 'preflight must finish while grant waits on ACL');
    assert.equal(first.error, undefined, first.error?.message);
    assert.equal(first.value.state, 'queued');
    await holder.query('COMMIT');
    holder.release(); holder = null;
    const granted = await lateGrant;
    assert.equal(granted.error, undefined, granted.error?.message);
    assert.equal(granted.value.revision, 2);
    const state = await readRun(pool, { ...owner, runId: 'run' });
    assert.equal(state.steps[0].state, 'completed');

    await createRun(pool, {
      ...owner, runId: 'revoke-race', requestKey: 'create-revoke-race',
      steps: [{ key: 'preflight', action: 'internal.goal_preflight.v1', inputRefs: [], maxAttempts: 1 }]
    });
    const revokeClaim = await claimRun(pool, { ...worker, runId: 'revoke-race' });
    await startStep(pool, { ...worker, runId: 'revoke-race', fence: revokeClaim.fence });
    holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${q}.object_acl WHERE space_id='space'
      AND object_id='goal' AND actor_id='worker' FOR SHARE`);
    membershipHolder = await pool.connect();
    await membershipHolder.query('BEGIN');
    await membershipHolder.query(`SELECT 1 FROM ${q}.memberships
      WHERE space_id='space' AND actor_id='worker' FOR SHARE`);
    const beforeRevoke = grant('third', 'worker', 'grant-third').then(
      value => ({ value }), error => ({ error })
    );
    await eventually(async () => {
      const activity = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%INSERT INTO object_acl%' LIMIT 1`);
      return activity.rowCount > 0;
    }, 'grant waiting before revocation');
    const revoked = disableMember(pool, {
      schema, spaceId: 'space', actorId: 'owner', targetId: 'worker', requestKey: 'disable-worker'
    });
    await holder.query('COMMIT');
    holder.release(); holder = null;
    assert.equal((await beforeRevoke).error, undefined);
    await eventually(async () => {
      const activity = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%SELECT active FROM memberships WHERE space_id=%FOR UPDATE%' LIMIT 1`);
      return activity.rowCount > 0;
    }, 'revocation holding space lock and waiting on membership');
    const afterRevocation = settleGoalPreflight(pool, {
      ...worker, runId: 'revoke-race', fence: revokeClaim.fence
    }).then(value => ({ value }), error => ({ error }));
    await eventually(async () => {
      const activity = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%SELECT policy_epoch FROM spaces WHERE id=%FOR SHARE%' LIMIT 1`);
      return activity.rowCount > 0;
    }, 'preflight waiting behind revocation');
    await membershipHolder.query('COMMIT');
    membershipHolder.release(); membershipHolder = null;
    await revoked;
    assert.equal((await afterRevocation).error?.code, 'ACCESS_REVOKED');
    assert.equal((await readRun(pool, { ...owner, runId: 'revoke-race' })).steps[0].state, 'running');

    // A goal transition that commits while another grant is waiting must
    // cause the grant transaction (including its new ACL) to roll back.
    holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`UPDATE ${q}.goals SET state='completed' WHERE space_id='space' AND id='goal'`);
    const denied = grant('never', 'worker2', 'grant-after-complete').then(
      value => ({ value }), error => ({ error })
    );
    await eventually(async () => {
      const activity = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%SELECT state FROM goals WHERE space_id=%FOR UPDATE%' LIMIT 1`);
      return activity.rowCount > 0;
    }, 'grant waiting on completed goal');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.object_acl
      WHERE space_id='space' AND object_id='goal' AND actor_id='worker2'`)).rows[0].n, 0);
    await holder.query('COMMIT');
    holder.release(); holder = null;
    const rejected = await denied;
    assert.equal(rejected.error?.code, 'GOAL_NOT_ACTIVE');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.object_acl
      WHERE space_id='space' AND object_id='goal' AND actor_id='worker2'`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.execution_grants
      WHERE space_id='space' AND id='never'`)).rows[0].n, 0);
  } finally {
    if (holder) {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    if (membershipHolder) {
      await membershipHolder.query('ROLLBACK').catch(() => {});
      membershipHolder.release();
    }
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await pool.end();
  }
});
