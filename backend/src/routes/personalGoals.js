import express from 'express';
import {
  createGoal,createRun,readRun,transitionRun,recordAcceptance,
  finishRun,completeGoal,requestGoalBriefRun,readGoalBriefArtifact
} from '../foundations/agentStore.js';
import { tickInternalGoalRun } from '../foundations/internalGoalWorker.js';
import {
  ensurePersonalWorkspace,getPersonalGoalRuntime,stablePersonalId,
  listPersonalGoals,readPersonalGoal
} from '../foundations/personalWorkspace.js';
import { FoundationError } from '../foundations/store.js';
import { getAuthDb } from '../models/authDb.js';

const fail=(code,status=400)=>{throw new FoundationError(code,status);};
const text=(value,max=2000)=>typeof value==='string' && value.trim().length>0 && value.length<=max;
const keys=(value,allowed)=>value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).every(key=>allowed.includes(key));
const requestKey=req=>{
  const key=req.get('Idempotency-Key');
  if (!text(key,128)) fail('IDEMPOTENCY_KEY_REQUIRED');
  return key;
};

function presentError(error,res,next) {
  if (error instanceof FoundationError) {
    return res.status(error.status).json({success:false,code:error.code,error:error.code});
  }
  if (['42P01','3F000','42501','28P01','3D000','57P01','08006',
    'ECONNREFUSED','ETIMEDOUT','ENOTFOUND','53300'].includes(error?.code)) {
    return res.status(503).json({
      success:false,code:'FOUNDATION_UNAVAILABLE',error:'目标服务暂不可用'
    });
  }
  if (error?.code==='23505') return res.status(409).json({
    success:false,code:'OBJECT_EXISTS',error:'对象已存在'
  });
  if (error?.code==='23503' || error?.code==='23514' || error?.code==='22P02') {
    return res.status(400).json({success:false,code:'INVALID_REQUEST',error:'请求数据无效'});
  }
  return next(error);
}

const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(error=>presentError(error,res,next));

// The router is mounted after authMiddleware. Dev x-user-id is deliberately
// insufficient for this durable endpoint; only a verified session is accepted.
export function createPersonalGoalsRouter(resolveRuntime=getPersonalGoalRuntime) {
  const router=express.Router();
  // Only goal endpoints need the PostgreSQL foundation. Mounting this check
  // for every /api request also blocks chat and files when PG is not set up.
  router.use('/goals',(req,res,next)=>Promise.resolve().then(async()=>{
    if (!req.session || !req.userId || req.session.userId!==req.userId) {
      return res.status(401).json({success:false,code:'SESSION_REQUIRED',error:'需要有效登录会话'});
    }
    const authDb=getAuthDb();
    await authDb.read();
    if (!authDb.data.users.some(user=>user.id===req.userId && user.active!==false)) {
      return res.status(401).json({success:false,code:'SESSION_REQUIRED',error:'账号已不可用'});
    }
    const runtime=resolveRuntime();
    if (!runtime?.pool) {
      return res.status(503).json({success:false,code:'FOUNDATION_UNAVAILABLE',error:'目标服务未配置'});
    }
    req.personalGoalContext={
      ...runtime,
      actorId:req.userId,
      spaceId:await ensurePersonalWorkspace(runtime.pool,runtime.schema,req.userId)
    };
    next();
  }).catch(error=>presentError(error,res,next)));

  router.get('/goals',route(async(req,res)=>{
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    res.set('Cache-Control','no-store').json({
      goals:await listPersonalGoals(pool,schema,spaceId,actorId),executionAvailable:false
    });
  }));
  router.post('/goals',route(async(req,res)=>{
    const body=req.body;
    if (!keys(body,['outcome','constraints','checks','budgetLimitMicros']) ||
      !text(body.outcome,10000) || !Array.isArray(body.checks) ||
      body.checks.length<1 || body.checks.length>50 ||
      !body.checks.some(check=>check?.required===true) ||
      body.checks.some(check=>!keys(check,['key','description','required']) ||
        !text(check.key,128) || !text(check.description,2000) ||
        typeof check.required!=='boolean') ||
      (body.constraints!==undefined && (!Array.isArray(body.constraints) ||
        body.constraints.length>100 || body.constraints.some(c=>!text(c,2000))))) {
      fail('INVALID_GOAL');
    }
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    const key=requestKey(req);
    const goalId=stablePersonalId('goal',actorId,key);
    const result=await createGoal(pool,{
      schema,spaceId,actorId,goalId,requestKey:key,outcome:body.outcome,
      constraints:body.constraints||[],checks:body.checks,
      budgetLimitMicros:body.budgetLimitMicros??'0'
    });
    res.status(result.replayed?200:201).json({...result,executionAvailable:false});
  }));
  router.get('/goals/:goalId',route(async(req,res)=>{
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    res.set('Cache-Control','no-store').json({
      ...await readPersonalGoal(pool,schema,spaceId,actorId,req.params.goalId),
      executionAvailable:false
    });
  }));
  router.post('/goals/:goalId/runs',route(async(req,res)=>{
    const body=req.body;
    if (!keys(body,['steps']) || !Array.isArray(body.steps) ||
      !body.steps.length || body.steps.length>100 ||
      body.steps.some(step=>!keys(step,['key','action','inputRefs','maxAttempts']) ||
        !text(step.key,128) || !text(step.action,2000) ||
        step.action.startsWith('internal.') ||
        !Array.isArray(step.inputRefs) || step.inputRefs.length>100 ||
        step.inputRefs.some(ref=>!text(ref,128)) ||
        !Number.isInteger(step.maxAttempts) || step.maxAttempts<1 || step.maxAttempts>10)) {
      fail('INVALID_STEPS');
    }
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    await readPersonalGoal(pool,schema,spaceId,actorId,req.params.goalId);
    const key=requestKey(req);
    const runId=stablePersonalId('run',actorId,key,req.params.goalId);
    const result=await createRun(pool,{
      schema,spaceId,actorId,goalId:req.params.goalId,runId,requestKey:key,
      steps:body.steps
    });
    res.status(result.replayed?200:201).json({...result,executionAvailable:false});
  }));

  // Explicit, zero-cost permission for one deterministic internal action.
  // The general-purpose Agent/Tool runtime remains unavailable.
  router.post('/goals/:goalId/briefs',route(async(req,res)=>{
    if (!keys(req.body||{},[])) fail('INVALID_REQUEST');
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    await readPersonalGoal(pool,schema,spaceId,actorId,req.params.goalId);
    const key=requestKey(req);
    const workerId=stablePersonalId('worker',actorId,'goal-brief-v1');
    const result=await requestGoalBriefRun(pool,{
      schema,spaceId,actorId,goalId:req.params.goalId,workerId,
      grantId:stablePersonalId('grant',actorId,key,req.params.goalId),
      runId:stablePersonalId('brief-run',actorId,key,req.params.goalId),requestKey:key
    });
    const advancement=await tickInternalGoalRun(pool,{
      schema,spaceId,workerId,runId:result.runId
    });
    const current=await readRun(pool,{schema,spaceId,actorId,runId:result.runId});
    const completed=current.steps.find(step=>step.action==='internal.goal_brief.v1' &&
      step.state==='completed');
    const match=/^artifact:(goal-brief-[0-9a-f]{40}):revision:0$/.exec(completed?.result_ref||'');
    res.set('Cache-Control','no-store').status(result.replayed?200:201).json({
      ...result,advancement:{state:advancement.state,advanced:advancement.advanced},
      runState:current.run.state,artifactId:match?.[1]||null,
      executionAvailable:false,briefExecutionAvailable:true
    });
  }));

  async function scopedRun(req) {
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    const value=await readRun(pool,{schema,spaceId,actorId,runId:req.params.runId});
    if (value.run.goal_id!==req.params.goalId) fail('RUN_NOT_FOUND',404);
    return value;
  }
  router.get('/goals/:goalId/runs/:runId',route(async(req,res)=>{
    const value=await scopedRun(req);
    res.set('Cache-Control','no-store').json({...value,executionAvailable:false});
  }));
  router.get('/goals/:goalId/runs/:runId/brief',route(async(req,res)=>{
    const run=await scopedRun(req);
    const completed=run.steps.find(step=>step.action==='internal.goal_brief.v1' &&
      step.state==='completed');
    const match=/^artifact:(goal-brief-[0-9a-f]{40}):revision:0$/.exec(completed?.result_ref||'');
    if (!match) fail('BRIEF_NOT_READY',404);
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    const artifact=await readGoalBriefArtifact(pool,{
      schema,spaceId,actorId,artifactId:match[1]
    });
    if (artifact.source.runId!==req.params.runId || artifact.source.goalId!==req.params.goalId) {
      fail('BRIEF_NOT_FOUND',404);
    }
    res.set('Cache-Control','no-store').json(artifact);
  }));
  const transition=action=>route(async(req,res)=>{
      if (!keys(req.body||{},[])) fail('INVALID_REQUEST');
      await scopedRun(req);
      const {pool,schema,spaceId,actorId}=req.personalGoalContext;
      res.json(await transitionRun(pool,{
        schema,spaceId,actorId,runId:req.params.runId,requestKey:requestKey(req),action
      }));
    });
  router.post('/goals/:goalId/runs/:runId/pause',transition('pause'));
  router.post('/goals/:goalId/runs/:runId/resume',transition('resume'));
  router.post('/goals/:goalId/runs/:runId/cancel',transition('cancel'));
  router.post('/goals/:goalId/runs/:runId/accept',route(async(req,res)=>{
    const body=req.body;
    if (!keys(body,['checkKey','artifactId','artifactRevision']) ||
      !text(body.checkKey,128) || !text(body.artifactId,128) ||
      !Number.isSafeInteger(body.artifactRevision) || body.artifactRevision<0) {
      fail('INVALID_ACCEPTANCE');
    }
    await scopedRun(req);
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    res.json(await recordAcceptance(pool,{
      schema,spaceId,actorId,runId:req.params.runId,requestKey:requestKey(req),
      checkKey:body.checkKey,artifactId:body.artifactId,artifactRevision:body.artifactRevision
    }));
  }));
  router.post('/goals/:goalId/runs/:runId/complete',route(async(req,res)=>{
    if (!keys(req.body||{},[])) fail('INVALID_REQUEST');
    await scopedRun(req);
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    res.json(await finishRun(pool,{
      schema,spaceId,actorId,runId:req.params.runId,requestKey:requestKey(req)
    }));
  }));
  router.post('/goals/:goalId/complete',route(async(req,res)=>{
    const body=req.body;
    if (!keys(body,['runId']) || !text(body.runId,128)) fail('INVALID_REQUEST');
    const {pool,schema,spaceId,actorId}=req.personalGoalContext;
    await readPersonalGoal(pool,schema,spaceId,actorId,req.params.goalId);
    res.json(await completeGoal(pool,{
      schema,spaceId,actorId,goalId:req.params.goalId,runId:body.runId,requestKey:requestKey(req)
    }));
  }));
  return router;
}

export default createPersonalGoalsRouter();
