import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import { disableMember } from '../src/foundations/store.js';
import {
  claimRun, createGoal, createRun, finishRun, grantTool, readRun,
  settleGoalPreflight, startStep, transitionRun
} from '../src/foundations/agentStore.js';
import { tickInternalGoalRun } from '../src/foundations/internalGoalWorker.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('internal Goal worker uses real PostgreSQL leases, stops on revocation and never self-accepts', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required'
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 10000 });
  const schema = `qt_internal_worker_${randomBytes(5).toString('hex')}`;
  const q = quoteSchema(schema);
  const scope = { schema, spaceId: 'personal-owner', actorId: 'owner' };
  const worker = { schema, spaceId: scope.spaceId, actorId: 'worker' };
  const tick = runId => tickInternalGoalRun(pool, {
    schema, spaceId: scope.spaceId, workerId: 'worker', runId
  });
  try {
    await applyFoundationsMigration(pool, { schema });
    await pool.query(`INSERT INTO ${q}.principals(id,kind) VALUES
      ('owner','human'),('worker','service'),('other','human')`);
    await pool.query(`INSERT INTO ${q}.spaces(id,kind,owner_id) VALUES
      ('personal-owner','personal','owner'),('other-space','personal','other')`);
    await pool.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role) VALUES
      ('personal-owner','owner','owner'),('personal-owner','worker','member'),
      ('other-space','other','owner')`);
    await createGoal(pool, {
      ...scope, goalId: 'goal', requestKey: 'goal-create', outcome: '核对目标状态',
      checks: [{ key: 'human-review', description: '人工检查真实成果', required: true }]
    });
    await grantTool(pool, {
      ...scope, goalId: 'goal', grantId: 'internal-worker-access', workerId: 'worker',
      toolId: 'internal.goal_preflight.v1', maxQuoteMicros: '0',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), requestKey: 'grant-worker'
    });
    const create = async (runId, action = 'internal.goal_preflight.v1') => createRun(pool, {
      ...scope, goalId: 'goal', runId, requestKey: `create-${runId}`,
      steps: [{ key: 'preflight', action, inputRefs: [], maxAttempts: 2 }]
    });

    await create('concurrent');
    const [a, b] = await Promise.all([tick('concurrent'), tick('concurrent')]);
    assert.equal([a, b].filter(result => result.advanced).length, 1);
    const done = await readRun(pool, { ...scope, runId: 'concurrent' });
    assert.equal(done.run.state, 'queued');
    assert.equal(done.steps[0].state, 'completed');
    assert.equal(done.steps[0].attempts, 1);
    assert.equal(done.steps[0].result_ref, 'goal:goal:revision:1');
    assert.equal(done.effects.length, 0);
    assert.equal(done.checks[0].state, 'pending');
    await rejects(finishRun(pool, {
      ...scope, runId: 'concurrent', requestKey: 'finish-without-evidence'
    }), 'ACCEPTANCE_INCOMPLETE');

    await create('unsupported', 'send_email');
    const unsupported = await tick('unsupported');
    assert.equal(unsupported.state, 'unsupported_step');
    assert.equal((await readRun(pool, { ...scope, runId: 'unsupported' })).run.state, 'queued');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.effects`)).rows[0].n, 0);

    await create('cancel-race');
    const claimed = await claimRun(pool, { ...worker, runId: 'cancel-race' });
    await startStep(pool, { ...worker, runId: 'cancel-race', stepKey: 'preflight', fence: claimed.fence });
    await transitionRun(pool, {
      ...scope, runId: 'cancel-race', action: 'cancel', requestKey: 'cancel-race-key'
    });
    await rejects(settleGoalPreflight(pool, {
      ...worker, runId: 'cancel-race', stepKey: 'preflight', fence: claimed.fence
    }), 'STALE_LEASE');
    assert.equal((await readRun(pool, { ...scope, runId: 'cancel-race' })).run.state, 'cancelled');

    await create('pause-resume');
    const pausedClaim = await claimRun(pool, { ...worker, runId: 'pause-resume' });
    await startStep(pool, { ...worker, runId: 'pause-resume', stepKey: 'preflight', fence: pausedClaim.fence });
    await transitionRun(pool, {
      ...scope, runId: 'pause-resume', action: 'pause', requestKey: 'pause-key'
    });
    await rejects(settleGoalPreflight(pool, {
      ...worker, runId: 'pause-resume', stepKey: 'preflight', fence: pausedClaim.fence
    }), 'STALE_LEASE');
    assert.equal((await tick('pause-resume')).state, 'paused');
    await transitionRun(pool, {
      ...scope, runId: 'pause-resume', action: 'resume', requestKey: 'resume-key'
    });
    assert.equal((await tick('pause-resume')).advanced, true);

    await create('lease-takeover');
    const old = await claimRun(pool, { ...worker, runId: 'lease-takeover', leaseSeconds: 1 });
    await startStep(pool, { ...worker, runId: 'lease-takeover', stepKey: 'preflight', fence: old.fence });
    await pool.query(`UPDATE ${q}.runs SET lease_until=now()-interval '1 second'
      WHERE space_id='personal-owner' AND id='lease-takeover'`);
    assert.equal((await tick('lease-takeover')).advanced, true);
    await rejects(settleGoalPreflight(pool, {
      ...worker, runId: 'lease-takeover', stepKey: 'preflight', fence: old.fence
    }), 'STALE_LEASE');
    assert.equal((await readRun(pool, { ...scope, runId: 'lease-takeover' })).steps[0].attempts, 1);

    await create('goal-changed');
    await grantTool(pool, {
      ...scope, goalId: 'goal', grantId: 'later-grant', workerId: 'worker',
      toolId: 'internal.goal_preflight.v1', maxQuoteMicros: '0',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), requestKey: 'later-grant-key'
    });
    const changed = await tick('goal-changed');
    assert.equal(changed.state, 'waiting');
    const changedRun = await readRun(pool, { ...scope, runId: 'goal-changed' });
    assert.equal(changedRun.run.wait_reason, 'goal_changed_requires_new_run');
    assert.equal(changedRun.steps[0].state, 'waiting');
    assert.equal(changedRun.effects.length, 0);
    await rejects(transitionRun(pool, {
      ...scope, runId: 'goal-changed', action: 'resume', requestKey: 'stale-resume'
    }), 'GOAL_CHANGED');

    await create('grant-revoked');
    await pool.query(`UPDATE ${q}.execution_grants SET revoked_at=now()
      WHERE space_id='personal-owner' AND actor_id='worker'`);
    const grantRevoked = await tick('grant-revoked');
    assert.equal(grantRevoked.state, 'waiting');
    const deniedRun = await readRun(pool, { ...scope, runId: 'grant-revoked' });
    assert.equal(deniedRun.run.wait_reason, 'internal_grant_required');
    assert.equal(deniedRun.steps[0].state, 'waiting');
    assert.equal(deniedRun.effects.length, 0);

    await create('revoked');
    const revokedClaim = await claimRun(pool, { ...worker, runId: 'revoked' });
    await startStep(pool, { ...worker, runId: 'revoked', stepKey: 'preflight', fence: revokedClaim.fence });
    await disableMember(pool, {
      ...scope, targetId: 'worker', requestKey: 'disable-worker'
    });
    await rejects(settleGoalPreflight(pool, {
      ...worker, runId: 'revoked', stepKey: 'preflight', fence: revokedClaim.fence
    }), 'ACCESS_REVOKED');
    await rejects(tick('revoked'), 'ACCESS_REVOKED');
    assert.equal((await readRun(pool, { ...scope, runId: 'revoked' })).steps[0].state, 'running');
    await transitionRun(pool, {
      ...scope, runId: 'revoked', action: 'cancel', requestKey: 'owner-cancel-revoked'
    });
    assert.equal((await readRun(pool, { ...scope, runId: 'revoked' })).run.state, 'cancelled');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await pool.end();
  }
});
