import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import { disableMember } from '../src/foundations/store.js';
import {
  createGoal, grantTool, createRun, claimRun, startStep, admitEffect,
  markEffectInflight, markEffectUnknown, verifyEffect, settleStep,
  recordArtifact, recordAcceptance, finishRun, completeGoal, transitionRun, readRun
} from '../src/foundations/agentStore.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;
const hash = 'a'.repeat(64);
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('real PostgreSQL durable Goal/Run/Step/Effect/Artifact, unknown reconciliation and cancellation', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required'
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 10000 });
  const schema = `qt_agent_${randomBytes(5).toString('hex')}`;
  const q = quoteSchema(schema);
  try {
    await applyFoundationsMigration(pool, { schema });
    assert.equal((await applyFoundationsMigration(pool, { schema })).applied, false);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.schema_migrations`)).rows[0].n, 2);
    const rls = await pool.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE relnamespace=$1::regnamespace AND relname IN
       ('goals','goal_checks','execution_grants','runs','steps','effects','artifacts','run_checks')`, [schema]);
    assert.equal(rls.rowCount, 8);
    assert.ok(rls.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
    await pool.query(`INSERT INTO ${q}.principals(id,kind) VALUES
      ('owner','human'),('worker','service'),('outsider','human')`);
    await pool.query(`INSERT INTO ${q}.spaces(id,kind,owner_id) VALUES
      ('team-a','team','owner'),('team-b','team','owner')`);
    await pool.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role) VALUES
      ('team-a','owner','owner'),('team-a','worker','member'),('team-b','owner','owner'),
      ('team-b','outsider','member')`);

    const goal = {
      schema, spaceId:'team-a', actorId:'owner', goalId:'goal-1', requestKey:'create-goal',
      outcome:'交付有证据的报告', constraints:['不外发原始明细'],
      checks:[{key:'file',description:'可打开且与源数据一致',required:true}],
      budgetLimitMicros:'100'
    };
    const created = await Promise.all([createGoal(pool,goal),createGoal(pool,goal)]);
    assert.deepEqual(created.map(x => x.replayed).sort(),[false,true]);
    assert.equal(new Set(created.map(x => x.eventId)).size,1);
    await rejects(createGoal(pool,{...goal,outcome:'不同结果'}),'IDEMPOTENCY_CONFLICT');
    await rejects(createGoal(pool,{
      ...goal,goalId:'unreachable-goal',requestKey:'invalid-validator',
      checks:[{key:'file',description:'外部账号不能验收',required:true,validatorId:'outsider'}]
    }),'ACCESS_REVOKED');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.goals
      WHERE space_id='team-a' AND id='unreachable-goal'`)).rows[0].n,0);
    await rejects(createRun(pool,{
      schema,spaceId:'team-a',actorId:'outsider',goalId:'goal-1',runId:'bad',
      requestKey:'bad',steps:[{key:'s',action:'生成',inputRefs:[],maxAttempts:2}]
    }),'ACCESS_REVOKED');
    const grant = await grantTool(pool,{
      schema,spaceId:'team-a',actorId:'owner',goalId:'goal-1',grantId:'tool-grant',
      workerId:'worker',toolId:'report.write',maxQuoteMicros:'60',
      expiresAt:new Date(Date.now()+3600000).toISOString(),requestKey:'grant-tool'
    });
    assert.equal(grant.revision,1);

    const runInput = {
      schema,spaceId:'team-a',actorId:'owner',goalId:'goal-1',runId:'run-1',
      requestKey:'run-create',steps:[{key:'draft',action:'生成报告',inputRefs:[],maxAttempts:2}]
    };
    const made = await Promise.all([createRun(pool,runInput),createRun(pool,runInput)]);
    assert.deepEqual(made.map(x => x.replayed).sort(),[false,true]);
    assert.equal(new Set(made.map(x => x.eventId)).size,1);
    const [claimA,claimB] = await Promise.all([
      claimRun(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1'}),
      claimRun(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1'})
    ]);
    assert.equal([claimA,claimB].filter(Boolean).length,1);
    const first = claimA || claimB;
    await startStep(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1',stepKey:'draft',fence:first.fence});
    await rejects(admitEffect(pool,{
      schema,spaceId:'team-a',actorId:'worker',runId:'run-1',stepKey:'draft',fence:first.fence,
      toolId:'ungranted',input:{},idempotencyKey:'bad-tool',grantId:'tool-grant',quoteMicros:'10'
    }),'TOOL_GRANT_DENIED');
    const effectInput = {
      schema,spaceId:'team-a',actorId:'worker',runId:'run-1',stepKey:'draft',fence:first.fence,
      toolId:'report.write',input:{target:'report'},idempotencyKey:'effect-1',
      grantId:'tool-grant',quoteMicros:'40'
    };
    const admitted = await admitEffect(pool,effectInput);
    assert.equal(admitted.state,'prepared');
    assert.equal((await admitEffect(pool,effectInput)).replayed,true);
    await rejects(admitEffect(pool,{...effectInput,input:{target:'else'}}),'IDEMPOTENCY_CONFLICT');
    await rejects(admitEffect(pool,{...effectInput,stepKey:'other',idempotencyKey:'effect-1'}),'STEP_NOT_RUNNING');
    await rejects(finishRun(pool,{
      schema,spaceId:'team-a',actorId:'owner',runId:'run-1',requestKey:'too-early'
    }),'STEPS_INCOMPLETE');
    await markEffectInflight(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1',
      stepKey:'draft',fence:first.fence});
    await markEffectUnknown(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1',
      stepKey:'draft',fence:first.fence});
    await rejects(markEffectInflight(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1',
      stepKey:'draft',fence:first.fence}),'STALE_LEASE');
    const reconciling = await claimRun(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1'});
    assert.equal(reconciling.state,'reconciling');
    await rejects(admitEffect(pool,{...effectInput,fence:reconciling.fence}),'EFFECT_RECONCILING');
    await rejects(verifyEffect(pool,{
      schema,spaceId:'team-a',actorId:'worker',runId:'run-1',stepKey:'draft',
      fence:reconciling.fence,outcome:'succeeded',receipt:{remoteId:'receipt-1'},
      actualMicros:'41'
    }),'SETTLEMENT_REQUIRES_REVIEW');
    assert.equal((await pool.query(`SELECT state FROM ${q}.effects
      WHERE space_id='team-a' AND run_id='run-1' AND step_key='draft'`)).rows[0].state,'unknown');
    const beforeReview = await pool.query(`SELECT budget_reserved_micros,budget_spent_micros
      FROM ${q}.goals WHERE space_id='team-a' AND id='goal-1'`);
    assert.equal(beforeReview.rows[0].budget_reserved_micros,'40');
    assert.equal(beforeReview.rows[0].budget_spent_micros,'0');
    const verified = await verifyEffect(pool,{
      schema,spaceId:'team-a',actorId:'worker',runId:'run-1',stepKey:'draft',
      fence:reconciling.fence,outcome:'succeeded',receipt:{remoteId:'receipt-1'},
      actualMicros:'35'
    });
    assert.equal(verified.state,'queued');
    await rejects(verifyEffect(pool,{
      schema,spaceId:'team-a',actorId:'worker',runId:'run-1',stepKey:'draft',
      fence:reconciling.fence,outcome:'succeeded',receipt:{remoteId:'receipt-1'}
    }),'STALE_LEASE');
    const resumed = await claimRun(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1'});
    await settleStep(pool,{
      schema,spaceId:'team-a',actorId:'worker',runId:'run-1',stepKey:'draft',
      fence:resumed.fence,outcome:'completed',resultRef:'artifact:report-1'
    });
    await recordArtifact(pool,{
      schema,spaceId:'team-a',actorId:'owner',runId:'run-1',artifactId:'report-1',
      requestKey:'artifact-1',contentRef:'object-storage:report-1',contentHash:hash
    });
    await rejects(finishRun(pool,{
      schema,spaceId:'team-a',actorId:'owner',runId:'run-1',requestKey:'no-check'
    }),'ACCEPTANCE_INCOMPLETE');
    await recordAcceptance(pool,{
      schema,spaceId:'team-a',actorId:'owner',runId:'run-1',checkKey:'file',
      artifactId:'report-1',artifactRevision:0,requestKey:'accept-1'
    });
    const finished = await finishRun(pool,{
      schema,spaceId:'team-a',actorId:'owner',runId:'run-1',requestKey:'finish-1'
    });
    assert.equal(finished.state,'completed');
    assert.equal((await readRun(pool,{schema,spaceId:'team-a',actorId:'owner',runId:'run-1'})).run.state,'completed');
    await pool.query(`UPDATE ${q}.artifacts SET lifecycle='deleted'
      WHERE space_id='team-a' AND id='report-1'`);
    await rejects(completeGoal(pool,{
      schema,spaceId:'team-a',actorId:'owner',goalId:'goal-1',runId:'run-1',
      requestKey:'stale-completion'
    }),'ACCEPTANCE_INCOMPLETE');
    assert.equal((await pool.query(`SELECT state FROM ${q}.goals
      WHERE space_id='team-a' AND id='goal-1'`)).rows[0].state,'active');
    await pool.query(`UPDATE ${q}.artifacts SET lifecycle='active'
      WHERE space_id='team-a' AND id='report-1'`);
    await pool.query(`UPDATE ${q}.object_acl SET actions=ARRAY['write']
      WHERE space_id='team-a' AND object_id='goal-1' AND actor_id='owner'`);
    await rejects(readRun(pool,{schema,spaceId:'team-a',actorId:'owner',runId:'run-1'}),
      'ACCESS_DENIED');
    await pool.query(`UPDATE ${q}.object_acl SET actions=ARRAY['read','write','share']
      WHERE space_id='team-a' AND object_id='goal-1' AND actor_id='owner'`);
    const budget = await pool.query(`SELECT budget_reserved_micros,budget_spent_micros FROM ${q}.goals
      WHERE space_id='team-a' AND id='goal-1'`);
    assert.equal(budget.rows[0].budget_reserved_micros,'0');
    assert.equal(budget.rows[0].budget_spent_micros,'35');

    await createRun(pool,{...runInput,runId:'run-2',requestKey:'run-create-2'});
    const second = await claimRun(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-2'});
    await startStep(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-2',
      stepKey:'draft',fence:second.fence});
    const cancelled = await transitionRun(pool,{
      schema,spaceId:'team-a',actorId:'owner',runId:'run-2',requestKey:'cancel-2',action:'cancel'
    });
    assert.equal(cancelled.state,'cancelled');
    assert.equal((await transitionRun(pool,{
      schema,spaceId:'team-a',actorId:'owner',runId:'run-2',requestKey:'cancel-2',action:'cancel'
    })).replayed,true);
    await rejects(admitEffect(pool,{...effectInput,runId:'run-2',fence:second.fence,
      idempotencyKey:'effect-2'}),'STALE_LEASE');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.effects WHERE run_id='run-2'`)).rows[0].n,0);
    await disableMember(pool,{schema,spaceId:'team-a',actorId:'owner',targetId:'worker',
      requestKey:'revoke-worker'});
    await rejects(claimRun(pool,{schema,spaceId:'team-a',actorId:'worker',runId:'run-1'}),'ACCESS_REVOKED');
    const goalDone = await completeGoal(pool,{
      schema,spaceId:'team-a',actorId:'owner',goalId:'goal-1',runId:'run-1',requestKey:'finish-goal'
    });
    assert.equal(goalDone.state,'completed');
    assert.equal((await completeGoal(pool,{
      schema,spaceId:'team-a',actorId:'owner',goalId:'goal-1',runId:'run-1',requestKey:'finish-goal'
    })).replayed,true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events`)).rows[0].n,
      (await pool.query(`SELECT count(*)::int AS n FROM ${q}.outbox`)).rows[0].n);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await pool.end();
  }
});

test('v1 schema with existing object upgrades to v2 once without replacing old rows', {
  skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required'
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const schema = `qt_agent_upgrade_${randomBytes(5).toString('hex')}`;
  const q = quoteSchema(schema);
  const sql = await readFile(new URL('../db/migrations/001_foundations.sql', import.meta.url),'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${q}`);
      await client.query(`SET LOCAL search_path TO ${q}, pg_catalog`);
      await client.query(`CREATE TABLE schema_migrations
        (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES (1,$1)',[checksum]);
      await client.query("INSERT INTO principals(id,kind) VALUES ('legacy-owner','human')");
      await client.query("INSERT INTO spaces(id,kind,owner_id) VALUES ('legacy-space','personal','legacy-owner')");
      await client.query("INSERT INTO objects(space_id,id,kind,created_by) VALUES ('legacy-space','legacy-object','note','legacy-owner')");
      await client.query('COMMIT');
    } catch(error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    assert.equal((await applyFoundationsMigration(pool,{schema})).applied,true);
    assert.equal((await applyFoundationsMigration(pool,{schema})).applied,false);
    assert.deepEqual((await pool.query(`SELECT version FROM ${q}.schema_migrations ORDER BY version`)).rows.map(x=>x.version),[1,2]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.objects
      WHERE space_id='legacy-space' AND id='legacy-object'`)).rows[0].n,1);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
    await pool.end();
  }
});
