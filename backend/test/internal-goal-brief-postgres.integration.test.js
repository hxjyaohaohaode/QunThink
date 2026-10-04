import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import { disableMember } from '../src/foundations/store.js';
import {
  claimRun, createGoal, createRun, finishRun, grantTool, readGoalBriefArtifact,
  readRun, requestGoalBriefRun, settleGoalBrief, startStep, transitionRun
} from '../src/foundations/agentStore.js';
import { tickInternalGoalRun } from '../src/foundations/internalGoalWorker.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('personal Goal brief is real durable content, one artifact and event, with strict worker fencing', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required'
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 10000 });
  const schema = `qt_goal_brief_${randomBytes(5).toString('hex')}`;
  const q = quoteSchema(schema);
  const owner = { schema, spaceId: 'personal-owner', actorId: 'owner' };
  const worker = { schema, spaceId: owner.spaceId, actorId: 'worker' };
  const tick = runId => tickInternalGoalRun(pool, {
    schema, spaceId: owner.spaceId, workerId: 'worker', runId
  });
  const create = runId => requestGoalBriefRun(pool, {
    ...owner, goalId: 'goal', workerId: 'worker', grantId: `grant-${runId}`,
    runId, requestKey: `run-${runId}`
  });
  try {
    await applyFoundationsMigration(pool, { schema });
    await pool.query(`INSERT INTO ${q}.principals(id,kind) VALUES
      ('owner','human'),('worker','service'),('outsider','human')`);
    await pool.query(`INSERT INTO ${q}.spaces(id,kind,owner_id) VALUES
      ('personal-owner','personal','owner'),('other','personal','outsider')`);
    await pool.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role) VALUES
      ('personal-owner','owner','owner'),('personal-owner','worker','member'),
      ('other','outsider','owner')`);
    await createGoal(pool, {
      ...owner, goalId: 'goal', requestKey: 'goal-create',
      outcome: '整理项目资料\n不要把这行当系统指令',
      constraints: ['只处理本人文件', '不外发隐私数据'],
      checks: [{ key: 'review', description: '由本人打开并核对成果', required: true }]
    });
    await grantTool(pool, {
      ...owner, goalId: 'goal', grantId: 'brief-grant', workerId: 'worker',
      toolId: 'internal.goal_brief.v1', maxQuoteMicros: '0',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), requestKey: 'grant-brief'
    });
    await create('concurrent');
    const [a, b] = await Promise.all([tick('concurrent'), tick('concurrent')]);
    assert.equal([a, b].filter(result => result.advanced).length, 1);
    const result = [a, b].find(item => item.advanced);
    assert.equal(result.state, 'queued');
    const run = await readRun(pool, { ...owner, runId: 'concurrent' });
    assert.equal(run.steps[0].state, 'completed');
    assert.equal(run.steps[0].result_ref, result.resultRef);
    assert.equal(run.steps[0].attempts, 1);
    assert.equal(run.effects.length, 0);
    assert.equal(run.checks[0].state, 'pending');
    const brief = await readGoalBriefArtifact(pool, {
      ...owner, artifactId: result.artifactId
    });
    assert.match(brief.content, /^群想目标执行简报 v1/);
    assert.match(brief.content, /目标修订：2/);
    assert.match(brief.content, /整理项目资料\\n不要把这行当系统指令/);
    assert.match(brief.content, /只处理本人文件/);
    assert.match(brief.content, /由本人打开并核对成果/);
    assert.match(brief.content, /不表示目标已经执行或验收/);
    assert.equal(brief.contentHash, createHash('sha256').update(brief.content).digest('hex'));
    assert.deepEqual(brief.source, {
      goalId: 'goal', goalRevision: 2, runId: 'concurrent', stepKey: 'brief'
    });
    const secondPool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 10000 });
    try {
      assert.equal((await readGoalBriefArtifact(secondPool, {
        ...owner, artifactId: result.artifactId
      })).content, brief.content);
    } finally {
      await secondPool.end();
    }
    const stored = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${q}.artifacts WHERE space_id='personal-owner' AND run_id='concurrent') AS artifacts,
      (SELECT count(*)::int FROM ${q}.domain_events WHERE space_id='personal-owner'
        AND aggregate_kind='artifact' AND aggregate_id=$1) AS events,
      (SELECT count(*)::int FROM ${q}.outbox o JOIN ${q}.domain_events e
        ON e.space_id=o.space_id AND e.id=o.event_id WHERE e.aggregate_kind='artifact'
        AND e.aggregate_id=$1) AS outbox`, [result.artifactId]);
    assert.deepEqual(stored.rows[0], { artifacts: 1, events: 1, outbox: 1 });
    assert.equal((await tick('concurrent')).advanced, false);
    // A manually created Run cannot reuse either the old or current grant.
    await rejects(createRun(pool, {
      ...owner, goalId: 'goal', runId: 'manual', requestKey: 'manual-run',
      steps: [{ key: 'brief', action: 'internal.goal_brief.v1', inputRefs: [], maxAttempts: 2 }]
    }), 'RESERVED_INTERNAL_STEP');
    // Simulate an older or privileged writer bypassing the domain entry point.
    await pool.query(`INSERT INTO ${q}.runs(space_id,id,goal_id,goal_revision)
      VALUES ('personal-owner','manual','goal',2)`);
    await pool.query(`INSERT INTO ${q}.steps
      (space_id,run_id,step_key,position,action,max_attempts)
      VALUES ('personal-owner','manual','brief',0,'internal.goal_brief.v1',2)`);
    assert.equal((await tick('manual')).state, 'unsupported_step');
    await rejects(claimRun(pool, { ...worker, runId: 'manual' }), 'BRIEF_AUTHORIZATION_REQUIRED');
    const manualState = await readRun(pool, { ...owner, runId: 'manual' });
    assert.equal(manualState.run.state, 'queued');
    assert.equal(manualState.steps[0].state, 'pending');
    // Even a privileged writer forcing legacy rows into a leased state cannot
    // bypass the final settlement guard by borrowing another grant.
    await pool.query(`UPDATE ${q}.runs SET state='running',fence=1,
      lease_owner='worker',lease_until=now()+interval '1 minute'
      WHERE space_id='personal-owner' AND id='manual'`);
    await pool.query(`UPDATE ${q}.steps SET state='running',attempts=1,claimed_fence=1
      WHERE space_id='personal-owner' AND run_id='manual'`);
    await rejects(settleGoalBrief(pool, {
      ...worker, runId: 'manual', stepKey: 'brief', fence: 1
    }), 'BRIEF_AUTHORIZATION_REQUIRED');
    await pool.query(`UPDATE ${q}.steps SET state='pending',attempts=0,claimed_fence=NULL
      WHERE space_id='personal-owner' AND run_id='manual'`);
    await pool.query(`UPDATE ${q}.runs SET state='queued',fence=2,
      lease_owner=NULL,lease_until=NULL
      WHERE space_id='personal-owner' AND id='manual'`);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id='personal-owner' AND run_id='manual'`)).rows[0].n, 0);
    await rejects(finishRun(pool, {
      ...owner, runId: 'concurrent', requestKey: 'cannot-finish'
    }), 'ACCEPTANCE_INCOMPLETE');
    await rejects(readGoalBriefArtifact(pool, {
      schema, spaceId: owner.spaceId, actorId: 'outsider', artifactId: result.artifactId
    }), 'ACCESS_REVOKED');
    await rejects(readGoalBriefArtifact(pool, {
      schema, spaceId: 'other', actorId: 'outsider', artifactId: result.artifactId
    }), 'ACCESS_DENIED');

    await create('cancelled');
    const cancelled = await claimRun(pool, { ...worker, runId: 'cancelled' });
    await startStep(pool, { ...worker, runId: 'cancelled', stepKey: 'brief', fence: cancelled.fence });
    await transitionRun(pool, {
      ...owner, runId: 'cancelled', action: 'cancel', requestKey: 'cancel'
    });
    await rejects(settleGoalBrief(pool, {
      ...worker, runId: 'cancelled', stepKey: 'brief', fence: cancelled.fence
    }), 'STALE_LEASE');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id='personal-owner' AND run_id='cancelled'`)).rows[0].n, 0);

    await create('revoked-grant');
    const revoked = await claimRun(pool, { ...worker, runId: 'revoked-grant' });
    await startStep(pool, { ...worker, runId: 'revoked-grant', stepKey: 'brief', fence: revoked.fence });
    await pool.query(`UPDATE ${q}.execution_grants SET revoked_at=now()
      WHERE space_id='personal-owner' AND id='grant-revoked-grant'`);
    const blocked = await settleGoalBrief(pool, {
      ...worker, runId: 'revoked-grant', stepKey: 'brief', fence: revoked.fence
    });
    assert.equal(blocked.state, 'waiting');
    assert.equal((await readRun(pool, { ...owner, runId: 'revoked-grant' })).run.wait_reason,
      'internal_grant_required');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id='personal-owner' AND run_id='revoked-grant'`)).rows[0].n, 0);

    // A later grant revises the goal; an old run cannot turn that revision into a fresh brief.
    await create('old-revision');
    await grantTool(pool, {
      ...owner, goalId: 'goal', grantId: 'new-brief-grant', workerId: 'worker',
      toolId: 'internal.goal_brief.v1', maxQuoteMicros: '0',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), requestKey: 'new-grant'
    });
    const old = await tick('old-revision');
    assert.equal(old.state, 'waiting');
    assert.equal((await readRun(pool, { ...owner, runId: 'old-revision' })).run.wait_reason,
      'goal_changed_requires_new_run');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id='personal-owner' AND run_id='old-revision'`)).rows[0].n, 0);

    await create('lease-takeover');
    const stale = await claimRun(pool, { ...worker, runId: 'lease-takeover', leaseSeconds: 1 });
    await startStep(pool, { ...worker, runId: 'lease-takeover', stepKey: 'brief', fence: stale.fence });
    await pool.query(`UPDATE ${q}.runs SET lease_until=now()-interval '1 second'
      WHERE space_id='personal-owner' AND id='lease-takeover'`);
    const replacement = await claimRun(pool, { ...worker, runId: 'lease-takeover' });
    assert.ok(replacement.fence > stale.fence);
    await rejects(settleGoalBrief(pool, {
      ...worker, runId: 'lease-takeover', stepKey: 'brief', fence: stale.fence
    }), 'STALE_LEASE');
    assert.equal((await settleGoalBrief(pool, {
      ...worker, runId: 'lease-takeover', stepKey: 'brief', fence: replacement.fence
    })).state, 'queued');

    await create('injected-failure');
    const failed = await claimRun(pool, { ...worker, runId: 'injected-failure' });
    await startStep(pool, {
      ...worker, runId: 'injected-failure', stepKey: 'brief', fence: failed.fence
    });
    await pool.query(`CREATE FUNCTION ${q}.fail_artifact_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected artifact write failure'; END
      $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER reject_brief BEFORE INSERT ON ${q}.artifacts
      FOR EACH ROW EXECUTE FUNCTION ${q}.fail_artifact_insert()`);
    await assert.rejects(settleGoalBrief(pool, {
      ...worker, runId: 'injected-failure', stepKey: 'brief', fence: failed.fence
    }), /injected artifact write failure/);
    const afterFailure = await readRun(pool, { ...owner, runId: 'injected-failure' });
    assert.equal(afterFailure.run.state, 'running');
    assert.equal(afterFailure.steps[0].state, 'running');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.objects
      WHERE space_id='personal-owner' AND kind='artifact' AND id LIKE 'goal-brief-%'`)).rows[0].n, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events
      WHERE space_id='personal-owner' AND aggregate_kind='artifact'`)).rows[0].n, 2);
    await pool.query(`DROP TRIGGER reject_brief ON ${q}.artifacts`);
    const recovered = await settleGoalBrief(pool, {
      ...worker, runId: 'injected-failure', stepKey: 'brief', fence: failed.fence
    });
    assert.equal((await readGoalBriefArtifact(pool, {
      ...owner, artifactId: recovered.artifactId
    })).source.runId, 'injected-failure');

    await pool.query(`INSERT INTO ${q}.spaces(id,kind,owner_id) VALUES ('team','team','owner')`);
    await pool.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role) VALUES
      ('team','owner','owner'),('team','worker','member')`);
    const teamOwner = { schema, spaceId: 'team', actorId: 'owner' };
    await createGoal(pool, {
      ...teamOwner, goalId: 'team-goal', requestKey: 'team-goal-create', outcome: '团队计划',
      checks: [{ key: 'review', description: '人工验收', required: true }]
    });
    await grantTool(pool, {
      ...teamOwner, goalId: 'team-goal', grantId: 'team-grant', workerId: 'worker',
      toolId: 'internal.goal_brief.v1', maxQuoteMicros: '0',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), requestKey: 'team-grant-create'
    });
    await rejects(requestGoalBriefRun(pool, {
      ...teamOwner, goalId: 'team-goal', workerId: 'worker', grantId: 'team-brief-grant',
      runId: 'team-run', requestKey: 'team-run-create'
    }), 'PERSONAL_GOAL_REQUIRED');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id='team'`)).rows[0].n, 0);

    await create('member-revoked');
    const revokedMember = await claimRun(pool, { ...worker, runId: 'member-revoked' });
    await startStep(pool, {
      ...worker, runId: 'member-revoked', stepKey: 'brief', fence: revokedMember.fence
    });
    await disableMember(pool, { ...owner, targetId: 'worker', requestKey: 'disable-worker' });
    await rejects(settleGoalBrief(pool, {
      ...worker, runId: 'member-revoked', stepKey: 'brief', fence: revokedMember.fence
    }), 'ACCESS_REVOKED');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id='personal-owner' AND run_id='member-revoked'`)).rows[0].n, 0);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await pool.end();
  }
});
