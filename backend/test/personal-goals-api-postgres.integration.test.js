import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import { claimRun,startStep,settleStep,recordArtifact } from '../src/foundations/agentStore.js';

const url=process.env.QUNTHINK_TEST_PG_URL;
const token1='a'.repeat(48);
const token2='b'.repeat(48);
const cookie1=`session_token=${token1}`;
const cookie2=`session_token=${token2}`;
const goalBody={
  outcome:'交付有验收证据的周报',
  constraints:['不得发送原始明细'],
  checks:[{key:'file',description:'本人确认可打开',required:true}],
  budgetLimitMicros:'100'
};
const runBody={steps:[{key:'draft',action:'整理周报',inputRefs:[],maxAttempts:2}]};

test('session-only personal Goal API with real PostgreSQL and restricted runtime role', {
  skip:!url && 'QUNTHINK_TEST_PG_URL is required'
},async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'qt-goals-api-'));
  process.env.AUTH_MODE='session';
  process.env.AUTH_DB_PATH=path.join(tmp,'auth.json');
  const [{default:authMiddleware},{initAuthDb,getAuthDb},
    {createPersonalGoalsRouter},{errorHandler}] = await Promise.all([
    import('../src/middleware/auth.js'),
    import('../src/models/authDb.js'),
    import('../src/routes/personalGoals.js'),
    import('../src/middleware/errorHandler.js')
  ]);
  const admin=new pg.Pool({connectionString:url,max:6,connectionTimeoutMillis:10000});
  const suffix=randomBytes(5).toString('hex');
  const schema=`qt_goals_api_${suffix}`;
  const role=`qt_goals_runtime_${suffix}`;
  const q=quoteSchema(schema);
  const r=quoteSchema(role);
  try {
    await applyFoundationsMigration(admin,{schema});
    await admin.query(`CREATE ROLE ${r} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA ${q} TO ${r}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${q} TO ${r}`);
    const runtime={
      async connect(){
        const client=await admin.connect();
        try {
          await client.query(`SET ROLE ${r}`);
          return {query:client.query.bind(client),release:()=>client.release(true)};
        } catch(error){client.release(true);throw error;}
      }
    };
    await initAuthDb();
    const auth=getAuthDb();
    auth.data.users.push({id:'user-one',username:'one',role:'user'},
      {id:'user-two',username:'two',role:'user'});
    auth.data.sessions.push(
      {token:token1,userId:'user-one',expires_at:new Date(Date.now()+3600000).toISOString()},
      {token:token2,userId:'user-two',expires_at:new Date(Date.now()+3600000).toISOString()});
    await auth.write();
    const app=express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(authMiddleware);
    app.use('/api',createPersonalGoalsRouter(()=>({pool:runtime,schema})));
    app.use(errorHandler);

    assert.equal((await request(app).get('/api/goals').set('x-user-id','user-one')).status,401);
    assert.equal((await request(app).get('/api/goals').set('Cookie',cookie1)).status,200);
    const unavailable=express();
    unavailable.use(cookieParser());
    unavailable.use(authMiddleware);
    unavailable.use('/api',createPersonalGoalsRouter(()=>null));
    assert.equal((await request(unavailable).get('/api/goals').set('Cookie',cookie1)).status,503);
    const spoof=await request(app).post('/api/goals').set('Cookie',cookie1)
      .set('Idempotency-Key','spoof').send({...goalBody,actorId:'user-two',spaceId:'team'});
    assert.equal(spoof.status,400);
    const noRequiredCheck=await request(app).post('/api/goals').set('Cookie',cookie1)
      .set('Idempotency-Key','optional-only').send({
        ...goalBody,checks:[{key:'file',description:'只作为提示',required:false}]
      });
    assert.equal(noRequiredCheck.status,400);
    const created=await request(app).post('/api/goals').set('Cookie',cookie1)
      .set('Idempotency-Key','goal-1').send(goalBody);
    assert.equal(created.status,201);
    assert.equal(created.body.executionAvailable,false);
    const goalId=created.body.goalId;
    const replay=await request(app).post('/api/goals').set('Cookie',cookie1)
      .set('Idempotency-Key','goal-1').send(goalBody);
    assert.equal(replay.status,200);
    assert.equal(replay.body.goalId,goalId);
    const conflict=await request(app).post('/api/goals').set('Cookie',cookie1)
      .set('Idempotency-Key','goal-1').send({...goalBody,outcome:'不同的结果'});
    assert.equal(conflict.status,409);
    assert.equal(conflict.body.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await request(app).get(`/api/goals/${goalId}`).set('Cookie',cookie2)).status,404);
    assert.equal((await request(app).get(`/api/goals/${goalId}`).set('Cookie',cookie1)).body.goal.outcome,goalBody.outcome);
    const noBriefKey=await request(app).post(`/api/goals/${goalId}/briefs`)
      .set('Cookie',cookie1).send({});
    assert.equal(noBriefKey.status,400);
    assert.equal(noBriefKey.body.code,'IDEMPOTENCY_KEY_REQUIRED');
    const forgedBrief=await request(app).post(`/api/goals/${goalId}/briefs`)
      .set('Cookie',cookie1).set('Idempotency-Key','forged-brief')
      .send({toolId:'send_email',workerId:'user-two'});
    assert.equal(forgedBrief.status,400);
    const brief=await request(app).post(`/api/goals/${goalId}/briefs`)
      .set('Cookie',cookie1).set('Idempotency-Key','brief-one').send({});
    assert.equal(brief.status,201);
    assert.equal(brief.body.advancement.advanced,true);
    assert.equal(brief.body.briefExecutionAvailable,true);
    assert.equal(brief.body.executionAvailable,false);
    assert.ok(brief.body.artifactId);
    const briefRunId=brief.body.runId;
    const briefRead=await request(app).get(`/api/goals/${goalId}/runs/${briefRunId}/brief`)
      .set('Cookie',cookie1);
    assert.equal(briefRead.status,200);
    assert.match(briefRead.body.content,/交付有验收证据的周报/);
    assert.match(briefRead.body.content,/不得发送原始明细/);
    assert.equal(briefRead.body.source.runId,briefRunId);
    assert.equal(briefRead.headers['cache-control'],'no-store');
    assert.equal((await request(app).get(`/api/goals/${goalId}/runs/${briefRunId}/brief`)
      .set('Cookie',cookie2)).status,404);
    const duplicateBrief=await request(app).post(`/api/goals/${goalId}/briefs`)
      .set('Cookie',cookie1).set('Idempotency-Key','brief-one').send({});
    assert.equal(duplicateBrief.status,200);
    assert.equal(duplicateBrief.body.replayed,true);
    assert.equal(duplicateBrief.body.artifactId,brief.body.artifactId);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.artifacts
      WHERE space_id=$1 AND run_id=$2`,[created.body.spaceId,briefRunId])).rows[0].n,1);
    assert.equal((await admin.query(`SELECT budget_spent_micros FROM ${q}.goals
      WHERE space_id=$1 AND id=$2`,[created.body.spaceId,goalId])).rows[0].budget_spent_micros,'0');
    const rejectBriefAsEvidence=await request(app)
      .post(`/api/goals/${goalId}/runs/${briefRunId}/accept`)
      .set('Cookie',cookie1).set('Idempotency-Key','brief-false-evidence')
      .send({checkKey:'file',artifactId:brief.body.artifactId,artifactRevision:0});
    assert.equal(rejectBriefAsEvidence.status,409);
    assert.equal(rejectBriefAsEvidence.body.code,'BRIEF_NOT_ACCEPTANCE_EVIDENCE');
    const briefCannotComplete=await request(app)
      .post(`/api/goals/${goalId}/runs/${briefRunId}/complete`)
      .set('Cookie',cookie1).set('Idempotency-Key','brief-too-early').send({});
    assert.equal(briefCannotComplete.status,409);
    assert.equal(briefCannotComplete.body.code,'ACCEPTANCE_INCOMPLETE');
    const reservedRun=await request(app).post(`/api/goals/${goalId}/runs`)
      .set('Cookie',cookie1).set('Idempotency-Key','reserved-action').send({
        steps:[{key:'brief',action:'internal.goal_brief.v1',inputRefs:[],maxAttempts:2}]
      });
    assert.equal(reservedRun.status,400);
    assert.equal(reservedRun.body.code,'INVALID_STEPS');
    const run=await request(app).post(`/api/goals/${goalId}/runs`).set('Cookie',cookie1)
      .set('Idempotency-Key','run-1').send(runBody);
    assert.equal(run.status,201);
    const runId=run.body.runId;
    assert.equal(run.body.state,'queued');
    const paused=await request(app).post(`/api/goals/${goalId}/runs/${runId}/pause`)
      .set('Cookie',cookie1).set('Idempotency-Key','pause-1').send({});
    assert.equal(paused.status,200);
    assert.equal(paused.body.state,'paused');
    const resumed=await request(app).post(`/api/goals/${goalId}/runs/${runId}/resume`)
      .set('Cookie',cookie1).set('Idempotency-Key','resume-1').send({});
    assert.equal(resumed.status,200);
    assert.equal(resumed.body.state,'queued');
    const premature=await request(app).post(`/api/goals/${goalId}/runs/${runId}/complete`)
      .set('Cookie',cookie1).set('Idempotency-Key','too-early').send({});
    assert.equal(premature.status,409);
    assert.equal(premature.body.code,'STEPS_INCOMPLETE');
    const badAcceptance=await request(app).post(`/api/goals/${goalId}/runs/${runId}/accept`)
      .set('Cookie',cookie1).set('Idempotency-Key','bad-accept')
      .send({checkKey:'file',artifactId:'missing',artifactRevision:0});
    assert.equal(badAcceptance.status,409);
    assert.equal(badAcceptance.body.code,'STALE_ARTIFACT');

    // A real server-side worker fixture advances one step. The public API
    // itself has no endpoint for tool admission or fabricated results.
    const personalSpace=created.body.spaceId;
    await admin.query(`INSERT INTO ${q}.principals(id,kind) VALUES ('test-worker','service')`);
    await admin.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role)
      VALUES ($1,'test-worker','member')`,[personalSpace]);
    await admin.query(`INSERT INTO ${q}.object_acl
      (space_id,object_id,actor_id,actions,granted_epoch)
      VALUES ($1,$2,'test-worker',ARRAY['read','write'],0)`,[personalSpace,goalId]);
    const claim=await claimRun(runtime,{schema,spaceId:personalSpace,actorId:'test-worker',runId});
    await startStep(runtime,{schema,spaceId:personalSpace,actorId:'test-worker',
      runId,stepKey:'draft',fence:claim.fence});
    await settleStep(runtime,{schema,spaceId:personalSpace,actorId:'test-worker',
      runId,stepKey:'draft',fence:claim.fence,outcome:'completed'});
    await recordArtifact(runtime,{schema,spaceId:personalSpace,actorId:'user-one',
      runId,artifactId:'weekly-report',requestKey:'artifact-1',
      contentRef:'test:weekly-report',contentHash:'c'.repeat(64)});
    const accepted=await request(app).post(`/api/goals/${goalId}/runs/${runId}/accept`)
      .set('Cookie',cookie1).set('Idempotency-Key','accept-1')
      .send({checkKey:'file',artifactId:'weekly-report',artifactRevision:0});
    assert.equal(accepted.status,200);
    assert.equal((await request(app).get(`/api/goals/${goalId}/runs/${runId}`)
      .set('Cookie',cookie1)).body.checks[0].state,'passed');
    // Run metadata inherits the parent Goal's read ACL, including for its owner.
    await admin.query(`UPDATE ${q}.object_acl SET actions=ARRAY['write']
      WHERE space_id=$1 AND object_id=$2 AND actor_id='user-one'`,[personalSpace,goalId]);
    const deniedRun=await request(app).get(`/api/goals/${goalId}/runs/${runId}`)
      .set('Cookie',cookie1);
    assert.equal(deniedRun.status,403);
    assert.equal(deniedRun.body.code,'ACCESS_DENIED');
    await admin.query(`UPDATE ${q}.object_acl SET actions=ARRAY['read','write','share']
      WHERE space_id=$1 AND object_id=$2 AND actor_id='user-one'`,[personalSpace,goalId]);
    const completed=await request(app).post(`/api/goals/${goalId}/runs/${runId}/complete`)
      .set('Cookie',cookie1).set('Idempotency-Key','complete-1').send({});
    assert.equal(completed.status,200);
    assert.equal(completed.body.state,'completed');
    const goalDone=await request(app).post(`/api/goals/${goalId}/complete`)
      .set('Cookie',cookie1).set('Idempotency-Key','goal-done').send({runId});
    assert.equal(goalDone.status,200);
    assert.equal(goalDone.body.state,'completed');
    assert.equal((await request(app).get(`/api/goals/${goalId}`).set('Cookie',cookie1)).body.goal.state,'completed');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${q}.domain_events`)).rows[0].n,
      (await admin.query(`SELECT count(*)::int AS n FROM ${q}.outbox`)).rows[0].n);
    await admin.query(`UPDATE ${q}.memberships SET active=false,disabled_at=now(),revision=revision+1
      WHERE space_id=$1 AND actor_id='user-one'`,[personalSpace]);
    const revokedRead=await request(app).get(`/api/goals/${goalId}`).set('Cookie',cookie1);
    assert.equal(revokedRead.status,403);
    assert.equal(revokedRead.body.code,'ACCESS_REVOKED');
    auth.data.users=auth.data.users.filter(user=>user.id!=='user-one');
    await auth.write();
    const deletedAccount=await request(app).get('/api/goals').set('Cookie',cookie1);
    assert.equal(deletedAccount.status,401);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(()=>{});
    await admin.query(`DROP ROLE IF EXISTS ${r}`).catch(()=>{});
    await admin.end();
    await rm(tmp,{recursive:true,force:true});
  }
});
