import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import {
  claimRun, createGoal, createRun, readRun, requestGoalBriefRun,
  settleGoalBrief, startStep, transitionRun
} from '../src/foundations/agentStore.js';
import { ensurePersonalWorkspace, stablePersonalId } from '../src/foundations/personalWorkspace.js';
import { scanPersonalGoalBriefs, startGoalBriefScheduler } from '../src/foundations/goalBriefScheduler.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;
const waitFor = async (predicate, maxMs = 5000) => {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for scheduler');
};

test('two restricted schedulers compete once, skip manual runs, and recover queued brief after restart', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required'
}, async () => {
  const admin = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 10000 });
  const suffix = randomBytes(5).toString('hex');
  const schema = `qt_brief_scheduler_${suffix}`;
  const role = `qt_brief_scheduler_role_${suffix}`;
  const q = quoteSchema(schema);
  const roleSql = quoteSchema(role);
  const owner = { schema, actorId: 'person', goalId: 'goal' };
  const workerId = stablePersonalId('worker', owner.actorId, 'goal-brief-v1');
  const runtimePool = () => {
    const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000 });
    return {
      async connect() {
        const client = await pool.connect();
        await client.query(`SET ROLE ${roleSql}`);
        return { query: client.query.bind(client), release: () => client.release(true) };
      },
      end: () => pool.end()
    };
  };
  let runtimeA;
  let runtimeB;
  let runtimeRestart;
  let schedulerA;
  let schedulerB;
  let schedulerRestart;
  try {
    await applyFoundationsMigration(admin, { schema });
    await admin.query(`CREATE ROLE ${roleSql} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA ${q} TO ${roleSql}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${q} TO ${roleSql}`);
    runtimeA = runtimePool();
    runtimeB = runtimePool();
    owner.spaceId = await ensurePersonalWorkspace(runtimeA, schema, owner.actorId);
    await createGoal(runtimeA, {
      ...owner, requestKey: 'goal-create', outcome: '准备个人交付资料',
      constraints: ['不可外发'],
      checks: [{ key: 'review', description: '本人检查完成的资料', required: true }]
    });
    const requestBrief = (pool, key) => requestGoalBriefRun(pool, {
      ...owner, workerId,
      grantId: stablePersonalId('grant', owner.actorId, key, owner.goalId),
      runId: stablePersonalId('brief-run', owner.actorId, key, owner.goalId),
      requestKey: key
    });
    const first = await requestBrief(runtimeA, 'first-brief');
    assert.equal((await readRun(runtimeA, { ...owner, runId: first.runId })).run.state, 'queued');
    schedulerA = startGoalBriefScheduler({
      pool: runtimeA, schema, listUserIds: async () => [owner.actorId], intervalMs: 1000
    });
    schedulerB = startGoalBriefScheduler({
      pool: runtimeB, schema, listUserIds: async () => [owner.actorId], intervalMs: 1000
    });
    await waitFor(async () => (await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1 AND run_id=$2`, [owner.spaceId, first.runId])).rows[0].n === 1);
    await schedulerA.stop();
    await schedulerB.stop();
    const firstRun = await readRun(runtimeA, { ...owner, runId: first.runId });
    assert.equal(firstRun.steps[0].state, 'completed');
    assert.equal(firstRun.checks[0].state, 'pending');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.domain_events
      WHERE space_id=$1 AND aggregate_kind='artifact'`, [owner.spaceId])).rows[0].n, 1);
    const manual = await createRun(runtimeA, {
      ...owner, runId: 'manual-run', requestKey: 'manual-run-create',
      steps: [{ key: 'manual', action: 'manual.review', inputRefs: [], maxAttempts: 2 }]
    });
    assert.equal(manual.state, 'queued');
    const manualScan = await scanPersonalGoalBriefs(runtimeA, {
      schema, userIds: [owner.actorId]
    });
    assert.equal(manualScan.candidates, 0);
    assert.equal((await readRun(runtimeA, { ...owner, runId: 'manual-run' })).steps[0].state, 'pending');

    // Simulate the process stopping just after the durable request commits.
    const second = await requestBrief(runtimeA, 'after-restart');
    assert.equal((await readRun(runtimeA, { ...owner, runId: second.runId })).run.state, 'queued');
    await runtimeA.end();
    runtimeA = null;
    await runtimeB.end();
    runtimeB = null;
    runtimeRestart = runtimePool();
    schedulerRestart = startGoalBriefScheduler({
      pool: runtimeRestart, schema, listUserIds: async () => [owner.actorId], intervalMs: 1000
    });
    await waitFor(async () => (await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1 AND run_id=$2`, [owner.spaceId, second.runId])).rows[0].n === 1);
    await schedulerRestart.stop();
    assert.equal((await readRun(runtimeRestart, { ...owner, runId: second.runId })).steps[0].state,
      'completed');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1 AND run_id='manual-run'`, [owner.spaceId])).rows[0].n, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1`, [owner.spaceId])).rows[0].n, 2);

    const paused = await requestBrief(runtimeRestart, 'paused');
    await transitionRun(runtimeRestart, {
      ...owner, runId: paused.runId, action: 'pause', requestKey: 'pause-brief'
    });
    assert.equal((await scanPersonalGoalBriefs(runtimeRestart, {
      schema, userIds: [owner.actorId]
    })).candidates, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1 AND run_id=$2`, [owner.spaceId, paused.runId])).rows[0].n, 0);

    const revoked = await requestBrief(runtimeRestart, 'revoked');
    await admin.query(`UPDATE ${q}.execution_grants SET revoked_at=now()
      WHERE space_id=$1 AND id=$2`, [owner.spaceId, revoked.grantId]);
    const revokedScan = await scanPersonalGoalBriefs(runtimeRestart, {
      schema, userIds: [owner.actorId]
    });
    assert.equal(revokedScan.waiting, 1);
    assert.equal((await readRun(runtimeRestart, { ...owner, runId: revoked.runId })).run.wait_reason,
      'internal_grant_required');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1 AND run_id=$2`, [owner.spaceId, revoked.runId])).rows[0].n, 0);

    const leased = await requestBrief(runtimeRestart, 'expired-lease');
    const claim = await claimRun(runtimeRestart, {
      schema, spaceId: owner.spaceId, actorId: workerId,
      runId: leased.runId, leaseSeconds: 1
    });
    await startStep(runtimeRestart, {
      schema, spaceId: owner.spaceId, actorId: workerId,
      runId: leased.runId, stepKey: 'brief', fence: claim.fence
    });
    await admin.query(`UPDATE ${q}.runs SET lease_until=now()-interval '1 second'
      WHERE space_id=$1 AND id=$2`, [owner.spaceId, leased.runId]);
    assert.equal((await scanPersonalGoalBriefs(runtimeRestart, {
      schema, userIds: [owner.actorId]
    })).advanced, 1);
    await assert.rejects(settleGoalBrief(runtimeRestart, {
      schema, spaceId: owner.spaceId, actorId: workerId,
      runId: leased.runId, stepKey: 'brief', fence: claim.fence
    }), error => error.code === 'STALE_LEASE');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1 AND run_id=$2`, [owner.spaceId, leased.runId])).rows[0].n, 1);

    // A permanent internal write failure consumes the bounded retry budget.
    // Neither failed attempt may create a content object, artifact, or receipt.
    const unwritable = await requestBrief(runtimeRestart, 'permanent-write-failure');
    await admin.query(`CREATE FUNCTION ${q}.reject_artifact() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected permanent artifact failure'; END
      $$ LANGUAGE plpgsql`);
    await admin.query(`CREATE TRIGGER reject_artifact BEFORE INSERT ON ${q}.artifacts
      FOR EACH ROW EXECUTE FUNCTION ${q}.reject_artifact()`);
    const firstFailure = await scanPersonalGoalBriefs(runtimeRestart, {
      schema, userIds: [owner.actorId]
    });
    assert.equal(firstFailure.candidates, 1);
    assert.equal(firstFailure.advanced, 0);
    const afterFirst = await readRun(runtimeRestart, { ...owner, runId: unwritable.runId });
    assert.equal(afterFirst.run.state, 'queued');
    assert.equal(afterFirst.steps[0].state, 'pending');
    assert.equal(afterFirst.steps[0].attempts, 1);
    assert.equal(afterFirst.steps[0].result_ref, 'internal:goal_brief:write_failed');
    const secondFailure = await scanPersonalGoalBriefs(runtimeRestart, {
      schema, userIds: [owner.actorId]
    });
    assert.equal(secondFailure.candidates, 1);
    assert.equal(secondFailure.advanced, 0);
    const afterSecond = await readRun(runtimeRestart, { ...owner, runId: unwritable.runId });
    assert.equal(afterSecond.run.state, 'failed');
    assert.equal(afterSecond.steps[0].state, 'failed');
    assert.equal(afterSecond.steps[0].attempts, 2);
    assert.equal((await scanPersonalGoalBriefs(runtimeRestart, {
      schema, userIds: [owner.actorId]
    })).candidates, 0);
    const failedArtifactId = `goal-brief-${createHash('sha256')
      .update(JSON.stringify([owner.spaceId, unwritable.runId, 'brief']))
      .digest('hex').slice(0, 40)}`;
    const noFalseOutput = await admin.query(`SELECT
      (SELECT count(*)::int FROM ${q}.artifacts WHERE space_id=$1 AND run_id=$2) AS artifacts,
      (SELECT count(*)::int FROM ${q}.objects WHERE space_id=$1 AND id=$3) AS objects,
      (SELECT count(*)::int FROM ${q}.object_revisions
        WHERE space_id=$1 AND object_id=$3) AS revisions,
      (SELECT count(*)::int FROM ${q}.effects WHERE space_id=$1 AND run_id=$2) AS effects,
      (SELECT count(*)::int FROM ${q}.domain_events WHERE space_id=$1
        AND aggregate_kind='artifact' AND aggregate_id=$3) AS artifact_events,
      (SELECT count(*)::int FROM ${q}.domain_events WHERE space_id=$1
        AND aggregate_kind='run' AND aggregate_id=$2 AND event_type='run.failed') AS failed_events`,
    [owner.spaceId, unwritable.runId, failedArtifactId]);
    assert.deepEqual(noFalseOutput.rows[0], {
      artifacts: 0, objects: 0, revisions: 0, effects: 0, artifact_events: 0, failed_events: 1
    });
    await admin.query(`DROP TRIGGER reject_artifact ON ${q}.artifacts`);
  } finally {
    await schedulerA?.stop().catch(() => {});
    await schedulerB?.stop().catch(() => {});
    await schedulerRestart?.stop().catch(() => {});
    await runtimeA?.end().catch(() => {});
    await runtimeB?.end().catch(() => {});
    await runtimeRestart?.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${roleSql}`).catch(() => {});
    await admin.end();
  }
});
