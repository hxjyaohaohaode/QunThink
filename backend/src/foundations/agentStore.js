// Narrow, persistent execution contract. Callers must supply actorId from an
// authenticated server context; model output and request bodies are not actors.
import { createHash, randomUUID } from 'node:crypto';
import {
  FoundationError, appendEvent, hashRequest, inSpaceTransaction, requiredId,
  reserveCommand, saveCommandResponse
} from './store.js';

const schemaDefault = 'qunthink_core';
const fail = (code, status = 409) => { throw new FoundationError(code, status); };
const id = (value, label) => requiredId(value, label);
const list = (value, max = 100) => Array.isArray(value) && value.length <= max;
const money = value => {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^(0|[1-9]\d{0,19})$/.test(text) || BigInt(text) > 99999999999999999999n) fail('INVALID_MONEY', 400);
  return text;
};

async function access(client, spaceId, actorId, objectId = null, action = 'write') {
  const space = await client.query('SELECT policy_epoch FROM spaces WHERE id=$1 FOR SHARE', [spaceId]);
  if (!space.rowCount) fail('SPACE_NOT_FOUND', 404);
  const member = await client.query(
    `SELECT m.active,m.role,p.kind FROM memberships m JOIN principals p ON p.id=m.actor_id
     WHERE m.space_id=$1 AND m.actor_id=$2 AND p.active FOR SHARE OF m`,
    [spaceId, actorId]
  );
  if (!member.rows[0]?.active) fail('ACCESS_REVOKED', 403);
  if (objectId) {
    const acl = await client.query(
      `SELECT a.actions,o.lifecycle FROM object_acl a JOIN objects o
       ON o.space_id=a.space_id AND o.id=a.object_id
       WHERE a.space_id=$1 AND a.object_id=$2 AND a.actor_id=$3
         AND a.revoked_at IS NULL FOR SHARE OF a,o`,
      [spaceId, objectId, actorId]
    );
    if (acl.rows[0]?.lifecycle !== 'active' || !acl.rows[0]?.actions.includes(action)) fail('ACCESS_DENIED', 403);
  }
  return { epoch: Number(space.rows[0].policy_epoch), role: member.rows[0].role, kind: member.rows[0].kind };
}

async function once(client, { spaceId, actorId, requestKey, body }, perform) {
  id(requestKey, 'REQUEST_KEY');
  const requestHash = hashRequest(body);
  const prior = await reserveCommand(client, { spaceId, actorId, requestKey, requestHash });
  if (prior) return { ...prior, replayed: true };
  const response = await perform();
  await saveCommandResponse(client, { spaceId, actorId, requestKey, response });
  return { ...response, replayed: false };
}

async function event(client, { spaceId, kind, objectId, revision, type, epoch, requestKey }) {
  return appendEvent(client, {
    spaceId, aggregateKind: kind, aggregateId: objectId, aggregateRevision: revision,
    eventType: type, policyEpoch: epoch,
    payloadRef: `${kind}:${objectId}:revision:${revision}`, correlationId: requestKey
  });
}

async function changedRun(client, { spaceId, runId, state, waitReason = null, clearLease = true, epoch, requestKey }) {
  const row = await client.query(
    `UPDATE runs SET state=$3, wait_reason=$4, revision=revision+1,
       fence=fence+CASE WHEN $5::boolean THEN 1 ELSE 0 END,
       lease_owner=CASE WHEN $5::boolean THEN NULL ELSE lease_owner END,
       lease_until=CASE WHEN $5::boolean THEN NULL ELSE lease_until END
     WHERE space_id=$1 AND id=$2 RETURNING revision,fence`,
    [spaceId, runId, state, waitReason, clearLease]
  );
  const revision = Number(row.rows[0].revision);
  const eventId = await event(client, {
    spaceId, kind: 'run', objectId: runId, revision, type: `run.${state}`, epoch, requestKey
  });
  return { spaceId, runId, state, revision, fence: Number(row.rows[0].fence), eventId };
}

export async function createGoal(pool, {
  schema = schemaDefault, spaceId, actorId, goalId, requestKey,
  outcome, constraints = [], checks, grantRefs = [], budgetLimitMicros = '0'
}) {
  [spaceId, actorId, goalId].forEach((v, i) => id(v, ['SPACE_ID','ACTOR_ID','GOAL_ID'][i]));
  if (typeof outcome !== 'string' || !outcome.trim() || outcome.length > 10000 ||
    !list(constraints) || constraints.some(x => typeof x !== 'string' || !x.trim()) ||
    !list(grantRefs) || grantRefs.some(x => typeof x !== 'string' || !x.trim()) ||
    !list(checks, 50) || !checks.length ||
    checks.some(x => !x || typeof x !== 'object' || !x.key || !x.description || typeof x.required !== 'boolean') ||
    new Set(checks.map(x => x.key)).size !== checks.length) fail('INVALID_GOAL', 400);
  const budget = money(budgetLimitMicros);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await access(client, spaceId, actorId);
    if (actor.kind !== 'human' || actor.role === 'guest') fail('ACCESS_DENIED', 403);
    return once(client, {
      spaceId, actorId, requestKey,
      body: { command: 'goal.create', goalId, outcome, constraints, checks, grantRefs, budget }
    }, async () => {
      await client.query('INSERT INTO objects(space_id,id,kind,created_by) VALUES ($1,$2,$3,$4)',
        [spaceId, goalId, 'goal', actorId]);
      await client.query('INSERT INTO object_revisions(space_id,object_id,revision,body) VALUES ($1,$2,0,$3)',
        [spaceId, goalId, { outcome, constraints, checks, grantRefs, budgetLimitMicros: budget }]);
      await client.query(
        `INSERT INTO object_acl(space_id,object_id,actor_id,actions,granted_epoch)
         VALUES ($1,$2,$3,ARRAY['read','write','share'], $4)`,
        [spaceId, goalId, actorId, actor.epoch]);
      await client.query(
        `INSERT INTO goals(space_id,id,owner_id,outcome,constraints,grant_refs,budget_limit_micros)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [spaceId, goalId, actorId, outcome, JSON.stringify(constraints), JSON.stringify(grantRefs), budget]);
      for (const check of checks) {
        id(check.key, 'CHECK_KEY');
        const validatorId = check.validatorId || actorId;
        id(validatorId,'VALIDATOR_ID');
        const validator = await access(client,spaceId,validatorId);
        if (validator.role === 'guest' || !['human','service'].includes(validator.kind)) {
          fail('INVALID_VALIDATOR',403);
        }
        if (validatorId !== actorId) {
          await client.query(
            `INSERT INTO object_acl(space_id,object_id,actor_id,actions,granted_epoch)
             VALUES ($1,$2,$3,ARRAY['read','write'],$4)
             ON CONFLICT(space_id,object_id,actor_id) DO NOTHING`,
            [spaceId,goalId,validatorId,actor.epoch]);
        }
        await client.query(
          'INSERT INTO goal_checks(space_id,goal_id,check_key,description,required,validator_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [spaceId, goalId, check.key, check.description, check.required, validatorId]);
      }
      const eventId = await event(client, {
        spaceId, kind: 'goal', objectId: goalId, revision: 0, type: 'goal.created',
        epoch: actor.epoch, requestKey
      });
      return { spaceId, goalId, revision: 0, eventId };
    });
  });
}

export async function grantTool(pool, {
  schema = schemaDefault, spaceId, actorId, goalId, grantId, workerId,
  toolId, maxQuoteMicros, expiresAt, requestKey
}) {
  [spaceId,actorId,goalId,grantId,workerId,toolId].forEach((v,i) =>
    id(v,['SPACE_ID','ACTOR_ID','GOAL_ID','GRANT_ID','WORKER_ID','TOOL_ID'][i]));
  const maxQuote = money(maxQuoteMicros);
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry <= new Date()) fail('INVALID_GRANT_EXPIRY',400);
  return inSpaceTransaction(pool,schema,spaceId,actorId,async client => {
    const actor=await access(client,spaceId,actorId,goalId);
    if (actor.kind!=='human') fail('ACCESS_DENIED',403);
    const worker=await access(client,spaceId,workerId);
    if (worker.kind!=='service') fail('WORKER_REQUIRED',403);
    return once(client,{
      spaceId,actorId,requestKey,
      body:{command:'goal.grant_tool',goalId,grantId,workerId,toolId,maxQuote,expiresAt:expiry.toISOString()}
    },async () => {
      // Worker operations read this ACL before locking the goal. Take the ACL
      // write lock first as well; a later goal-state failure rolls this upsert
      // back with the entire transaction, so no provisional access is visible.
      await client.query(
        `INSERT INTO object_acl(space_id,object_id,actor_id,actions,granted_epoch)
         VALUES ($1,$2,$3,ARRAY['read','write'],$4)
         ON CONFLICT(space_id,object_id,actor_id) DO UPDATE SET
           actions=EXCLUDED.actions,granted_epoch=EXCLUDED.granted_epoch,revoked_at=NULL`,
        [spaceId,goalId,workerId,actor.epoch]);
      const goal=await client.query(
        'SELECT state FROM goals WHERE space_id=$1 AND id=$2 FOR UPDATE',[spaceId,goalId]);
      if (goal.rows[0]?.state!=='active') fail('GOAL_NOT_ACTIVE');
      await client.query(
        `INSERT INTO execution_grants
         (space_id,id,goal_id,actor_id,tool_id,max_quote_micros,expires_at,policy_epoch,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [spaceId,grantId,goalId,workerId,toolId,maxQuote,expiry,actor.epoch,actorId]);
      const updated=await client.query(
        `UPDATE goals SET grant_refs=grant_refs || to_jsonb($3::text),revision=revision+1
         WHERE space_id=$1 AND id=$2 RETURNING revision,grant_refs`,[spaceId,goalId,grantId]);
      const revision=Number(updated.rows[0].revision);
      await client.query(
        `UPDATE objects SET revision=$3 WHERE space_id=$1 AND id=$2`,[spaceId,goalId,revision]);
      await client.query(
        `INSERT INTO object_revisions(space_id,object_id,revision,body) VALUES ($1,$2,$3,$4)`,
        [spaceId,goalId,revision,{grantRefs:updated.rows[0].grant_refs}]);
      const eventId=await event(client,{
        spaceId,kind:'goal',objectId:goalId,revision,type:'goal.grant_added',
        epoch:actor.epoch,requestKey
      });
      return {spaceId,goalId,grantId,revision,eventId};
    });
  });
}

export async function createRun(pool, {
  schema = schemaDefault, spaceId, actorId, goalId, runId, requestKey, steps
}) {
  [spaceId, actorId, goalId, runId].forEach((v, i) => id(v, ['SPACE_ID','ACTOR_ID','GOAL_ID','RUN_ID'][i]));
  if (!list(steps, 100) || !steps.length || steps.some(s => !s || typeof s.action !== 'string' ||
      !s.action.trim() || s.action.length > 2000 || !Number.isInteger(s.maxAttempts) ||
      s.maxAttempts < 1 || s.maxAttempts > 10 || !list(s.inputRefs)) ||
      new Set(steps.map(s => s.key)).size !== steps.length) fail('INVALID_STEPS', 400);
  // Only requestGoalBriefRun may provision this action and its matching grant.
  if (steps.some(step => step.action === 'internal.goal_brief.v1')) {
    fail('RESERVED_INTERNAL_STEP', 400);
  }
  for (const step of steps) id(step.key, 'STEP_KEY');
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await access(client, spaceId, actorId, goalId);
    return once(client, {
      spaceId, actorId, requestKey, body: { command: 'run.create', goalId, runId, steps }
    }, async () => {
      const goal = await client.query(
        'SELECT revision,state FROM goals WHERE space_id=$1 AND id=$2 FOR SHARE', [spaceId, goalId]);
      if (goal.rows[0]?.state !== 'active') fail('GOAL_NOT_ACTIVE');
      const goalRevision = Number(goal.rows[0].revision);
      await client.query(
        'INSERT INTO runs(space_id,id,goal_id,goal_revision) VALUES ($1,$2,$3,$4)',
        [spaceId, runId, goalId, goalRevision]);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await client.query(
          `INSERT INTO steps(space_id,run_id,step_key,position,action,input_refs,max_attempts)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [spaceId, runId, step.key, i, step.action, JSON.stringify(step.inputRefs), step.maxAttempts]);
      }
      await client.query(
        `INSERT INTO run_checks(space_id,run_id,check_key)
         SELECT $1,$2,check_key FROM goal_checks WHERE space_id=$1 AND goal_id=$3`,
        [spaceId, runId, goalId]);
      const eventId = await event(client, {
        spaceId, kind: 'run', objectId: runId, revision: 0, type: 'run.queued',
        epoch: actor.epoch, requestKey
      });
      return { spaceId, runId, goalId, goalRevision, state: 'queued', fence: 0, eventId };
    });
  });
}

// One explicit request authorizes only a zero-cost internal brief for one
// personal Goal. Worker identity, grant, goal revision and Run are committed
// together, so a crash can be retried with the same request key.
export async function requestGoalBriefRun(pool, {
  schema = schemaDefault, spaceId, actorId, goalId, workerId, grantId, runId, requestKey
}) {
  [spaceId, actorId, goalId, workerId, grantId, runId, requestKey].forEach((value, index) =>
    id(value, ['SPACE_ID', 'ACTOR_ID', 'GOAL_ID', 'WORKER_ID', 'GRANT_ID', 'RUN_ID', 'REQUEST_KEY'][index]));
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await access(client, spaceId, actorId, goalId);
    if (actor.kind !== 'human' || actor.role === 'guest') fail('CONTROLLER_REQUIRED', 403);
    const personal = await client.query(
      'SELECT kind,owner_id FROM spaces WHERE id=$1 FOR SHARE', [spaceId]);
    if (personal.rows[0]?.kind !== 'personal' || personal.rows[0]?.owner_id !== actorId) {
      fail('PERSONAL_GOAL_REQUIRED', 403);
    }
    return once(client, {
      spaceId, actorId, requestKey,
      body: { command: 'goal.brief.request', goalId, workerId, grantId, runId }
    }, async () => {
      await client.query(
        `INSERT INTO principals(id,kind) VALUES ($1,'service') ON CONFLICT DO NOTHING`,
        [workerId]);
      const principal = await client.query(
        'SELECT kind,active FROM principals WHERE id=$1 FOR SHARE', [workerId]);
      if (principal.rows[0]?.kind !== 'service' || !principal.rows[0]?.active) {
        fail('WORKER_UNAVAILABLE', 403);
      }
      await client.query(
        `INSERT INTO memberships(space_id,actor_id,role)
         VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, [spaceId, workerId]);
      const member = await client.query(
        `SELECT active FROM memberships WHERE space_id=$1 AND actor_id=$2 FOR SHARE`,
        [spaceId, workerId]);
      if (!member.rows[0]?.active) fail('ACCESS_REVOKED', 403);
      // Match grantTool and the worker: lock Worker ACL before Goal.
      await client.query(
        `INSERT INTO object_acl(space_id,object_id,actor_id,actions,granted_epoch)
         VALUES ($1,$2,$3,ARRAY['read','write'],$4)
         ON CONFLICT(space_id,object_id,actor_id) DO UPDATE SET
           actions=EXCLUDED.actions,granted_epoch=EXCLUDED.granted_epoch,revoked_at=NULL`,
        [spaceId, goalId, workerId, actor.epoch]);
      const goal = await client.query(
        'SELECT state,owner_id,revision FROM goals WHERE space_id=$1 AND id=$2 FOR UPDATE',
        [spaceId, goalId]);
      if (goal.rows[0]?.state !== 'active' || goal.rows[0].owner_id !== actorId) {
        fail('GOAL_NOT_ACTIVE');
      }
      const grant = await client.query(
        `INSERT INTO execution_grants
         (space_id,id,goal_id,actor_id,tool_id,max_quote_micros,expires_at,policy_epoch,created_by)
         VALUES ($1,$2,$3,$4,'internal.goal_brief.v1',0,now()+interval '1 day',$5,$6)
         RETURNING expires_at`,
        [spaceId, grantId, goalId, workerId, actor.epoch, actorId]);
      const updated = await client.query(
        `UPDATE goals SET grant_refs=grant_refs || to_jsonb($3::text),revision=revision+1
         WHERE space_id=$1 AND id=$2 RETURNING revision,grant_refs`,
        [spaceId, goalId, grantId]);
      const goalRevision = Number(updated.rows[0].revision);
      await client.query('UPDATE objects SET revision=$3 WHERE space_id=$1 AND id=$2',
        [spaceId, goalId, goalRevision]);
      await client.query(
        `INSERT INTO object_revisions(space_id,object_id,revision,body)
         VALUES ($1,$2,$3,$4)`,
        [spaceId, goalId, goalRevision, { grantRefs: updated.rows[0].grant_refs }]);
      const goalEventId = await event(client, {
        spaceId, kind: 'goal', objectId: goalId, revision: goalRevision,
        type: 'goal.grant_added', epoch: actor.epoch, requestKey
      });
      await client.query(
        `INSERT INTO runs(space_id,id,goal_id,goal_revision,checkpoint)
         VALUES ($1,$2,$3,$4,$5)`,
        [spaceId, runId, goalId, goalRevision, {
          origin: 'personal_goal_brief_v1', grantId, workerId
        }]);
      await client.query(
        `INSERT INTO steps(space_id,run_id,step_key,position,action,input_refs,max_attempts)
         VALUES ($1,$2,'brief',0,'internal.goal_brief.v1','[]'::jsonb,2)`,
        [spaceId, runId]);
      await client.query(
        `INSERT INTO run_checks(space_id,run_id,check_key)
         SELECT $1,$2,check_key FROM goal_checks WHERE space_id=$1 AND goal_id=$3`,
        [spaceId, runId, goalId]);
      const runEventId = await event(client, {
        spaceId, kind: 'run', objectId: runId, revision: 0,
        type: 'run.queued', epoch: actor.epoch, requestKey
      });
      return {
        spaceId, goalId, runId, grantId, workerId, goalRevision,
        grantExpiresAt: grant.rows[0].expires_at, state: 'queued',
        goalEventId, runEventId
      };
    });
  });
}

async function runAccess(client, spaceId, actorId, runId, action = 'write') {
  const ref = await client.query('SELECT goal_id FROM runs WHERE space_id=$1 AND id=$2', [spaceId, runId]);
  if (!ref.rowCount) fail('RUN_NOT_FOUND', 404);
  const actor = await access(client, spaceId, actorId, ref.rows[0].goal_id, action);
  return { ...actor, goalId: ref.rows[0].goal_id };
}

export async function claimRun(pool, {
  schema = schemaDefault, spaceId, actorId, runId, leaseSeconds = 30
}) {
  [spaceId, actorId, runId].forEach((v, i) => id(v, ['SPACE_ID','ACTOR_ID','RUN_ID'][i]));
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) fail('INVALID_LEASE', 400);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    const run = await client.query(
      `SELECT * FROM runs WHERE space_id=$1 AND id=$2
       AND (state='queued' OR (state IN ('running','reconciling')
         AND (lease_until IS NULL OR lease_until<now())))
       FOR UPDATE SKIP LOCKED`, [spaceId, runId]);
    if (!run.rowCount) return null;
    if (run.rows[0].checkpoint?.origin !== 'personal_goal_brief_v1') {
      const reserved = await client.query(
        `SELECT 1 FROM steps WHERE space_id=$1 AND run_id=$2
         AND action='internal.goal_brief.v1' LIMIT 1`, [spaceId,runId]);
      if (reserved.rowCount) fail('BRIEF_AUTHORIZATION_REQUIRED', 403);
    }
    if (run.rows[0].checkpoint?.origin === 'personal_goal_brief_v1' &&
      (run.rows[0].checkpoint.workerId !== actorId ||
       typeof run.rows[0].checkpoint.grantId !== 'string' ||
       !run.rows[0].checkpoint.grantId)) {
      fail('BRIEF_AUTHORIZATION_REQUIRED', 403);
    }
    const unresolved = await client.query(
      `UPDATE effects SET state='unknown' WHERE space_id=$1 AND run_id=$2 AND state='inflight'
       RETURNING step_key`, [spaceId, runId]);
    const unknown = await client.query(
      `SELECT 1 FROM effects WHERE space_id=$1 AND run_id=$2 AND state='unknown' LIMIT 1`, [spaceId, runId]);
    const state = unresolved.rowCount || unknown.rowCount ? 'reconciling' : 'running';
    const briefTakeover = state === 'running' && run.rows[0].state === 'running' &&
      run.rows[0].checkpoint?.origin === 'personal_goal_brief_v1';
    let briefRetryExhausted = false;
    if (briefTakeover) {
      const step = await client.query(
        `SELECT attempts,max_attempts FROM steps
         WHERE space_id=$1 AND run_id=$2 AND step_key='brief'
           AND action='internal.goal_brief.v1' AND state='running' FOR UPDATE`,
        [spaceId,runId]);
      briefRetryExhausted = step.rows.some(row => row.attempts >= row.max_attempts);
    }
    const claimed = await client.query(
      `UPDATE runs SET state=$3,fence=fence+1,revision=revision+1,lease_owner=$4,
       lease_until=now()+($5::integer * interval '1 second')
       WHERE space_id=$1 AND id=$2 RETURNING fence,revision,lease_until`,
      [spaceId, runId, state, actorId, leaseSeconds]);
    if (state === 'running') {
      await client.query(
        `UPDATE steps SET claimed_fence=$3,
           attempts=attempts+CASE WHEN $4::boolean AND action='internal.goal_brief.v1'
             AND attempts<max_attempts THEN 1 ELSE 0 END
         WHERE space_id=$1 AND run_id=$2 AND state='running'`,
        [spaceId,runId,claimed.rows[0].fence,briefTakeover]);
    }
    const revision = Number(claimed.rows[0].revision);
    const eventId = await event(client, {
      spaceId, kind: 'run', objectId: runId, revision, type: `run.${state}`,
      epoch: actor.epoch, requestKey: `claim:${runId}:${claimed.rows[0].fence}`
    });
    return { runId, state, fence: Number(claimed.rows[0].fence), briefRetryExhausted,
      leaseUntil: claimed.rows[0].lease_until, eventId };
  });
}

async function leased(client, spaceId, actorId, runId, fence) {
  const row = await client.query(
    `SELECT * FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE`, [spaceId, runId]);
  if (!row.rowCount) fail('RUN_NOT_FOUND', 404);
  const run = row.rows[0];
  if (run.lease_owner !== actorId || Number(run.fence) !== fence ||
      !run.lease_until || new Date(run.lease_until) <= new Date() ||
      !['running','reconciling'].includes(run.state)) fail('STALE_LEASE');
  return run;
}

export async function startStep(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence
}) {
  [spaceId, actorId, runId, stepKey].forEach((v, i) => id(v, ['SPACE_ID','ACTOR_ID','RUN_ID','STEP_KEY'][i]));
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    const run = await leased(client, spaceId, actorId, runId, fence);
    if (run.state !== 'running') fail('EFFECT_RECONCILING');
    const step = await client.query(
      `UPDATE steps SET state='running', attempts=attempts+1, claimed_fence=$4
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3 AND state='pending'
         AND attempts<max_attempts RETURNING attempts`, [spaceId, runId, stepKey, fence]);
    if (!step.rowCount) fail('STEP_NOT_CLAIMABLE');
    const result = await changedRun(client, {
      spaceId, runId, state: 'running', clearLease: false, epoch: actor.epoch,
      requestKey: `step:${stepKey}:${step.rows[0].attempts}`
    });
    return { ...result, stepKey, attempts: step.rows[0].attempts };
  });
}

export async function admitEffect(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence,
  toolId, input, idempotencyKey, grantId, quoteMicros = '0'
}) {
  [spaceId, actorId, runId, stepKey, toolId, idempotencyKey, grantId].forEach((v, i) =>
    id(v, ['SPACE_ID','ACTOR_ID','RUN_ID','STEP_KEY','TOOL_ID','IDEMPOTENCY_KEY','GRANT_ID'][i]));
  const quote = money(quoteMicros);
  const intentHash = hashRequest({ toolId, input });
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    const run = await leased(client, spaceId, actorId, runId, fence);
    if (run.state !== 'running') fail('EFFECT_RECONCILING');
    const grant = await client.query(
      `SELECT 1 FROM execution_grants g JOIN goals goal
       ON goal.space_id=g.space_id AND goal.id=g.goal_id
       WHERE g.space_id=$1 AND g.id=$2 AND g.goal_id=$3 AND g.actor_id=$4
         AND g.tool_id=$5 AND g.revoked_at IS NULL AND g.expires_at>now()
         AND g.policy_epoch=$6 AND g.max_quote_micros>=$7::numeric
         AND goal.grant_refs ? $2 AND goal.state='active' AND goal.revision=$8
       FOR SHARE OF g,goal`,
      [spaceId,grantId,actor.goalId,actorId,toolId,actor.epoch,quote,run.goal_revision]);
    if (!grant.rowCount) fail('TOOL_GRANT_DENIED',403);
    const step = await client.query(
      `SELECT state,claimed_fence FROM steps WHERE space_id=$1 AND run_id=$2 AND step_key=$3 FOR UPDATE`,
      [spaceId, runId, stepKey]);
    if (step.rows[0]?.state !== 'running' || Number(step.rows[0].claimed_fence) !== fence) fail('STEP_NOT_RUNNING');
    const existing = await client.query(
      'SELECT * FROM effects WHERE space_id=$1 AND run_id=$2 AND step_key=$3 FOR UPDATE',
      [spaceId, runId, stepKey]);
    if (existing.rowCount) {
      const e = existing.rows[0];
      if (e.intent_hash !== intentHash || e.idempotency_key !== idempotencyKey) fail('IDEMPOTENCY_CONFLICT');
      return { state: e.state, replayed: true, intentHash };
    }
    const reserved = await client.query(
      `UPDATE goals SET budget_reserved_micros=budget_reserved_micros+$3::numeric
       WHERE space_id=$1 AND id=$2
         AND budget_spent_micros+budget_reserved_micros+$3::numeric<=budget_limit_micros
       RETURNING id`, [spaceId, actor.goalId, quote]);
    if (!reserved.rowCount) fail('BUDGET_EXCEEDED');
    await client.query(
      `UPDATE runs SET budget_reserved_micros=budget_reserved_micros+$3::numeric
       WHERE space_id=$1 AND id=$2`, [spaceId, runId, quote]);
    await client.query(
      `INSERT INTO effects(space_id,run_id,step_key,intent_hash,idempotency_key,tool_id,grant_id,quote_micros,fence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [spaceId, runId, stepKey, intentHash, idempotencyKey, toolId, grantId, quote, fence]);
    const result = await changedRun(client, {
      spaceId, runId, state: 'running', clearLease: false, epoch: actor.epoch,
      requestKey: `effect:${stepKey}:prepared`
    });
    return { ...result, stepKey, state: 'prepared', replayed: false, intentHash };
  });
}

export async function markEffectInflight(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence
}) {
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    const run = await leased(client, spaceId, actorId, runId, fence);
    if (run.state !== 'running') fail('EFFECT_RECONCILING');
    const grant = await client.query(
      `SELECT 1 FROM effects e JOIN execution_grants g
       ON g.space_id=e.space_id AND g.id=e.grant_id
       WHERE e.space_id=$1 AND e.run_id=$2 AND e.step_key=$3
         AND g.actor_id=$4 AND g.revoked_at IS NULL AND g.expires_at>now()
         AND g.policy_epoch=$5 FOR SHARE OF g`,
      [spaceId,runId,stepKey,actorId,actor.epoch]);
    if (!grant.rowCount) fail('TOOL_GRANT_DENIED',403);
    const effect = await client.query(
      `UPDATE effects SET state='inflight',fence=$4
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3 AND state='prepared'
       RETURNING idempotency_key,intent_hash`, [spaceId, runId, stepKey, fence]);
    if (!effect.rowCount) fail('EFFECT_NOT_PREPARED');
    const result = await changedRun(client, {
      spaceId, runId, state: 'running', clearLease: false, epoch: actor.epoch,
      requestKey: `effect:${stepKey}:inflight`
    });
    return { ...result, stepKey, idempotencyKey: effect.rows[0].idempotency_key,
      intentHash: effect.rows[0].intent_hash };
  });
}

export async function markEffectUnknown(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence
}) {
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    await leased(client, spaceId, actorId, runId, fence);
    const effect = await client.query(
      `UPDATE effects SET state='unknown'
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3 AND state='inflight' AND fence=$4
       RETURNING step_key`, [spaceId, runId, stepKey, fence]);
    if (!effect.rowCount) fail('EFFECT_NOT_INFLIGHT');
    return changedRun(client, {
      spaceId, runId, state: 'reconciling', epoch: actor.epoch,
      requestKey: `effect:${stepKey}:unknown`
    });
  });
}

export async function verifyEffect(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence,
  outcome, receipt, actualMicros = '0'
}) {
  if (!['succeeded','failed'].includes(outcome) || !receipt || typeof receipt !== 'object') fail('INVALID_VERIFICATION', 400);
  const actual = money(actualMicros);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('VERIFIER_REQUIRED', 403);
    const cancelled = await client.query(
      'SELECT state FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE',[spaceId,runId]);
    const run = cancelled.rows[0].state === 'cancelled'
      ? cancelled.rows[0] : await leased(client, spaceId, actorId, runId, fence);
    const effect = await client.query(
      `SELECT quote_micros,state FROM effects WHERE space_id=$1 AND run_id=$2 AND step_key=$3 FOR UPDATE`,
      [spaceId, runId, stepKey]);
    if (!effect.rowCount || !['unknown','inflight'].includes(effect.rows[0].state)) fail('EFFECT_NOT_VERIFIABLE');
    if (outcome === 'failed' && actual !== '0') fail('INVALID_SETTLEMENT', 400);
    const quote = effect.rows[0].quote_micros;
    const budget = await client.query(
      `SELECT budget_spent_micros,budget_limit_micros FROM goals
       WHERE space_id=$1 AND id=$2 FOR UPDATE`,[spaceId,actor.goalId]);
    if (BigInt(actual)>BigInt(quote) ||
      BigInt(budget.rows[0].budget_spent_micros)+BigInt(actual)>BigInt(budget.rows[0].budget_limit_micros)) {
      // The external action may already have happened. Keep the effect
      // unresolved and its quote reserved until a separate manual
      // reconciliation records the actual charge and revised budget.
      fail('SETTLEMENT_REQUIRES_REVIEW');
    }
    await client.query(
      `UPDATE effects SET state=$4,receipt=$5,actual_micros=$6,verified_by=$7,
       verified_at=CASE WHEN $4='succeeded' THEN now() ELSE NULL END
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3`,
      [spaceId, runId, stepKey, outcome, receipt, actual, actorId]);
    await client.query(
      `UPDATE goals SET budget_reserved_micros=budget_reserved_micros-$3::numeric,
       budget_spent_micros=budget_spent_micros+$4::numeric
       WHERE space_id=$1 AND id=$2`, [spaceId, actor.goalId, quote, actual]);
    await client.query(
      `UPDATE runs SET budget_reserved_micros=budget_reserved_micros-$3::numeric,
       budget_spent_micros=budget_spent_micros+$4::numeric
       WHERE space_id=$1 AND id=$2`, [spaceId, runId, quote, actual]);
    const unresolved = await client.query(
      `SELECT 1 FROM effects WHERE space_id=$1 AND run_id=$2 AND state IN ('unknown','inflight') LIMIT 1`,
      [spaceId, runId]);
    const next = run.state === 'reconciling' && !unresolved.rowCount
      ? (run.wait_reason === 'pause_after_reconcile' ? 'paused' : 'queued') : run.state;
    return changedRun(client, {
      spaceId, runId, state: next, clearLease: next === 'queued' || next === 'paused' || next === 'cancelled',
      epoch: actor.epoch, requestKey: `effect:${stepKey}:${outcome}`
    });
  });
}

export async function settleStep(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence, outcome,
  resultRef = null, waitReason = null
}) {
  if (!['completed','waiting','failed'].includes(outcome)) fail('INVALID_STEP_OUTCOME', 400);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    const run = await leased(client, spaceId, actorId, runId, fence);
    if (run.state !== 'running') fail('EFFECT_RECONCILING');
    const step = await client.query(
      `SELECT state,attempts,max_attempts,claimed_fence FROM steps
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3 FOR UPDATE`, [spaceId, runId, stepKey]);
    if (step.rows[0]?.state !== 'running' || Number(step.rows[0].claimed_fence) !== fence) fail('STEP_NOT_RUNNING');
    const effects = await client.query(
      `SELECT state FROM effects WHERE space_id=$1 AND run_id=$2 AND step_key=$3`, [spaceId, runId, stepKey]);
    if (effects.rowCount && !['succeeded','failed'].includes(effects.rows[0].state)) fail('EFFECT_UNRESOLVED');
    if (outcome === 'completed' && effects.rows[0]?.state === 'failed') fail('EFFECT_FAILED');
    const retry = outcome === 'failed' && step.rows[0].attempts < step.rows[0].max_attempts && !effects.rowCount;
    const stepState = retry ? 'pending' : outcome;
    await client.query(
      `UPDATE steps SET state=$4,result_ref=$5,claimed_fence=NULL
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3`,
      [spaceId, runId, stepKey, stepState, resultRef]);
    const next = outcome === 'waiting' ? 'waiting' : outcome === 'failed' && !retry ? 'failed' : 'queued';
    return changedRun(client, {
      spaceId, runId, state: next, waitReason: next === 'waiting' ? (waitReason || 'external condition') : null,
      epoch: actor.epoch, requestKey: `step:${stepKey}:${outcome}`
    });
  });
}

// A deliberately narrow internal action. It records a database fact, not an
// artifact, tool effect, model answer, or acceptance result. The goal lock is
// acquired before the run lock so a concurrent goal transition cannot make the
// recorded revision stale before this transaction commits.
export async function settleGoalPreflight(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence
}) {
  [spaceId, actorId, runId, stepKey].forEach((value, index) =>
    id(value, ['SPACE_ID', 'ACTOR_ID', 'RUN_ID', 'STEP_KEY'][index]));
  if (!Number.isSafeInteger(fence) || fence < 1) fail('INVALID_FENCE', 400);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    const grants = await client.query(
      `SELECT id FROM execution_grants WHERE space_id=$1 AND goal_id=$2
         AND actor_id=$3 AND tool_id='internal.goal_preflight.v1'
         AND revoked_at IS NULL AND expires_at>now() AND policy_epoch=$4
       FOR SHARE`, [spaceId, actor.goalId, actorId, actor.epoch]);
    const goal = await client.query(
      'SELECT state,revision,grant_refs FROM goals WHERE space_id=$1 AND id=$2 FOR SHARE',
      [spaceId, actor.goalId]);
    if (!goal.rowCount) fail('GOAL_NOT_FOUND', 404);
    const run = await leased(client, spaceId, actorId, runId, fence);
    if (run.state !== 'running') fail('EFFECT_RECONCILING');
    const step = await client.query(
      `SELECT state,action,input_refs,position,claimed_fence FROM steps
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3 FOR UPDATE`,
      [spaceId, runId, stepKey]);
    if (step.rows[0]?.state !== 'running' || Number(step.rows[0].claimed_fence) !== fence) {
      fail('STEP_NOT_RUNNING');
    }
    if (step.rows[0].action !== 'internal.goal_preflight.v1' ||
        !Array.isArray(step.rows[0].input_refs) || step.rows[0].input_refs.length) {
      fail('UNSUPPORTED_INTERNAL_STEP', 400);
    }
    const earlier = await client.query(
      `SELECT 1 FROM steps WHERE space_id=$1 AND run_id=$2 AND position<$3
         AND state<>'completed' LIMIT 1`,
      [spaceId, runId, step.rows[0].position]);
    if (earlier.rowCount) fail('STEP_DEPENDENCY_INCOMPLETE');
    const effects = await client.query(
      'SELECT 1 FROM effects WHERE space_id=$1 AND run_id=$2 AND step_key=$3 LIMIT 1',
      [spaceId, runId, stepKey]);
    if (effects.rowCount) fail('INTERNAL_STEP_HAS_EFFECT');
    const goalChanged = goal.rows[0].state !== 'active' ||
      Number(goal.rows[0].revision) !== Number(run.goal_revision);
    const grantActive = grants.rows.some(grant => goal.rows[0].grant_refs?.includes(grant.id));
    if (goalChanged || !grantActive) {
      await client.query(
        `UPDATE steps SET state='waiting',claimed_fence=NULL
         WHERE space_id=$1 AND run_id=$2 AND step_key=$3`, [spaceId, runId, stepKey]);
      return changedRun(client, {
        spaceId, runId, state: 'waiting',
        waitReason: goalChanged ? 'goal_changed_requires_new_run' : 'internal_grant_required',
        epoch: actor.epoch, requestKey: `preflight:${stepKey}:blocked`
      });
    }
    const resultRef = `goal:${actor.goalId}:revision:${run.goal_revision}`;
    await client.query(
      `UPDATE steps SET state='completed',result_ref=$4,claimed_fence=NULL
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3`,
      [spaceId, runId, stepKey, resultRef]);
    const result = await changedRun(client, {
      spaceId, runId, state: 'queued', epoch: actor.epoch,
      requestKey: `preflight:${stepKey}:fence:${fence}`
    });
    return { ...result, stepKey, resultRef };
  });
}

// This intentionally supports one deterministic, database-only artifact kind.
// User text is quoted as data, never interpreted as an instruction or a tool.
function goalBriefText({ goalId, revision, outcome, constraints, checks }) {
  const lines = [
    '群想目标执行简报 v1',
    `目标：${JSON.stringify(goalId)}`,
    `目标修订：${revision}`,
    `预期成果：${JSON.stringify(outcome)}`,
    '约束：',
    ...constraints.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`),
    '验收条件：',
    ...checks.map(check => `${check.required ? '[必需]' : '[可选]'} ${JSON.stringify(check.check_key)} ${JSON.stringify(check.description)}`),
    '本简报只列出已保存的目标要求；它不表示目标已经执行或验收。'
  ];
  return lines.join('\n');
}

export async function settleGoalBrief(pool, {
  schema = schemaDefault, spaceId, actorId, runId, stepKey, fence
}) {
  [spaceId, actorId, runId, stepKey].forEach((value, index) =>
    id(value, ['SPACE_ID', 'ACTOR_ID', 'RUN_ID', 'STEP_KEY'][index]));
  if (!Number.isSafeInteger(fence) || fence < 1) fail('INVALID_FENCE', 400);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
    // Keep the ACL/grant -> goal -> run -> step lock order used by preflight.
    const grants = await client.query(
      `SELECT id FROM execution_grants WHERE space_id=$1 AND goal_id=$2
         AND actor_id=$3 AND tool_id='internal.goal_brief.v1'
         AND revoked_at IS NULL AND expires_at>now() AND policy_epoch=$4
       FOR SHARE`, [spaceId, actor.goalId, actorId, actor.epoch]);
    const goal = await client.query(
      `SELECT g.state,g.revision,g.grant_refs,g.outcome,g.constraints,g.owner_id,
              s.kind AS space_kind,s.owner_id AS space_owner
       FROM goals g JOIN spaces s ON s.id=g.space_id
       WHERE g.space_id=$1 AND g.id=$2 FOR SHARE OF g,s`,
      [spaceId, actor.goalId]);
    if (!goal.rowCount) fail('GOAL_NOT_FOUND', 404);
    if (goal.rows[0].space_kind !== 'personal' ||
        goal.rows[0].owner_id !== goal.rows[0].space_owner) fail('PERSONAL_GOAL_REQUIRED', 403);
    const run = await leased(client, spaceId, actorId, runId, fence);
    if (run.state !== 'running') fail('EFFECT_RECONCILING');
    if (run.checkpoint?.origin !== 'personal_goal_brief_v1' ||
        run.checkpoint.workerId !== actorId ||
        typeof run.checkpoint.grantId !== 'string' ||
        !run.checkpoint.grantId) fail('BRIEF_AUTHORIZATION_REQUIRED', 403);
    const step = await client.query(
      `SELECT state,action,input_refs,position,claimed_fence FROM steps
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3 FOR UPDATE`,
      [spaceId, runId, stepKey]);
    if (step.rows[0]?.state !== 'running' || Number(step.rows[0].claimed_fence) !== fence) {
      fail('STEP_NOT_RUNNING');
    }
    if (step.rows[0].action !== 'internal.goal_brief.v1' ||
        !Array.isArray(step.rows[0].input_refs) || step.rows[0].input_refs.length) {
      fail('UNSUPPORTED_INTERNAL_STEP', 400);
    }
    const earlier = await client.query(
      `SELECT 1 FROM steps WHERE space_id=$1 AND run_id=$2 AND position<$3
         AND state<>'completed' LIMIT 1`,
      [spaceId, runId, step.rows[0].position]);
    if (earlier.rowCount) fail('STEP_DEPENDENCY_INCOMPLETE');
    const effects = await client.query(
      'SELECT 1 FROM effects WHERE space_id=$1 AND run_id=$2 AND step_key=$3 LIMIT 1',
      [spaceId, runId, stepKey]);
    if (effects.rowCount) fail('INTERNAL_STEP_HAS_EFFECT');
    const goalChanged = goal.rows[0].state !== 'active' ||
      Number(goal.rows[0].revision) !== Number(run.goal_revision);
    const grantActive = grants.rows.some(grant =>
      grant.id === run.checkpoint.grantId && goal.rows[0].grant_refs?.includes(grant.id));
    if (goalChanged || !grantActive) {
      await client.query(
        `UPDATE steps SET state='waiting',claimed_fence=NULL
         WHERE space_id=$1 AND run_id=$2 AND step_key=$3`, [spaceId, runId, stepKey]);
      return changedRun(client, {
        spaceId, runId, state: 'waiting',
        waitReason: goalChanged ? 'goal_changed_requires_new_run' : 'internal_grant_required',
        epoch: actor.epoch, requestKey: `goal-brief:${stepKey}:blocked`
      });
    }
    const checks = await client.query(
      `SELECT check_key,description,required FROM goal_checks
       WHERE space_id=$1 AND goal_id=$2 ORDER BY check_key`,
      [spaceId, actor.goalId]);
    const content = goalBriefText({
      goalId: actor.goalId, revision: Number(run.goal_revision),
      outcome: goal.rows[0].outcome, constraints: goal.rows[0].constraints,
      checks: checks.rows
    });
    if (Buffer.byteLength(content, 'utf8') > 1048576) {
      await client.query(
        `UPDATE steps SET state='waiting',claimed_fence=NULL
         WHERE space_id=$1 AND run_id=$2 AND step_key=$3`, [spaceId, runId, stepKey]);
      return changedRun(client, {
        spaceId, runId, state: 'waiting', waitReason: 'goal_brief_too_large',
        epoch: actor.epoch, requestKey: `goal-brief:${stepKey}:too-large`
      });
    }
    const artifactId = `goal-brief-${createHash('sha256')
      .update(JSON.stringify([spaceId, runId, stepKey])).digest('hex').slice(0, 40)}`;
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
    const contentRef = `inline:object-revision:${artifactId}:0`;
    await client.query('INSERT INTO objects(space_id,id,kind,created_by) VALUES ($1,$2,$3,$4)',
      [spaceId, artifactId, 'artifact', actorId]);
    await client.query(
      `INSERT INTO object_revisions(space_id,object_id,revision,body)
       VALUES ($1,$2,0,$3)`, [spaceId, artifactId, {
        kind: 'goal_brief_v1', content, contentHash, contentRef,
        source: { goalId: actor.goalId, goalRevision: Number(run.goal_revision), runId, stepKey }
      }]);
    await client.query(
      `INSERT INTO object_acl(space_id,object_id,actor_id,actions,granted_epoch)
       VALUES ($1,$2,$3,ARRAY['read'], $5),($1,$2,$4,ARRAY['read'], $5)`,
      [spaceId, artifactId, actorId, goal.rows[0].owner_id, actor.epoch]);
    await client.query(
      `INSERT INTO artifacts(space_id,id,run_id,content_ref,content_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [spaceId, artifactId, runId, contentRef, contentHash]);
    const artifactEventId = await event(client, {
      spaceId, kind: 'artifact', objectId: artifactId, revision: 0,
      type: 'artifact.recorded', epoch: actor.epoch,
      requestKey: `goal-brief:${runId}:${stepKey}`
    });
    const resultRef = `artifact:${artifactId}:revision:0`;
    await client.query(
      `UPDATE steps SET state='completed',result_ref=$4,claimed_fence=NULL
       WHERE space_id=$1 AND run_id=$2 AND step_key=$3`,
      [spaceId, runId, stepKey, resultRef]);
    const result = await changedRun(client, {
      spaceId, runId, state: 'queued', epoch: actor.epoch,
      requestKey: `goal-brief:${stepKey}:fence:${fence}`
    });
    return { ...result, stepKey, artifactId, artifactEventId, contentHash, resultRef };
  });
}

export async function readGoalBriefArtifact(pool, {
  schema = schemaDefault, spaceId, actorId, artifactId
}) {
  [spaceId, actorId, artifactId].forEach((value, index) =>
    id(value, ['SPACE_ID', 'ACTOR_ID', 'ARTIFACT_ID'][index]));
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    await access(client, spaceId, actorId, artifactId, 'read');
    const row = await client.query(
      `SELECT a.content_ref,a.content_hash,a.revision,a.lifecycle,o.lifecycle AS object_lifecycle,
              r.id AS run_id,r.goal_id,r.goal_revision,st.step_key,ov.body
       FROM artifacts a JOIN objects o ON o.space_id=a.space_id AND o.id=a.id
       JOIN runs r ON r.space_id=a.space_id AND r.id=a.run_id
       JOIN steps st ON st.space_id=a.space_id AND st.run_id=a.run_id
         AND st.state='completed' AND st.action='internal.goal_brief.v1'
         AND st.result_ref=('artifact:' || a.id || ':revision:' || a.revision::text)
       JOIN object_revisions ov ON ov.space_id=a.space_id AND ov.object_id=a.id AND ov.revision=a.revision
       WHERE a.space_id=$1 AND a.id=$2`, [spaceId, artifactId]);
    if (!row.rowCount || row.rows[0].lifecycle !== 'active' ||
        row.rows[0].object_lifecycle !== 'active') fail('ARTIFACT_NOT_FOUND', 404);
    await access(client, spaceId, actorId, row.rows[0].goal_id, 'read');
    const { content_ref: contentRef, content_hash: contentHash, body } = row.rows[0];
    if (body?.kind !== 'goal_brief_v1' || typeof body.content !== 'string' ||
        body.contentRef !== contentRef || body.contentHash !== contentHash ||
        body.source?.goalId !== row.rows[0].goal_id ||
        body.source?.goalRevision !== Number(row.rows[0].goal_revision) ||
        body.source?.runId !== row.rows[0].run_id ||
        body.source?.stepKey !== row.rows[0].step_key ||
        contentRef !== `inline:object-revision:${artifactId}:${row.rows[0].revision}` ||
        createHash('sha256').update(body.content, 'utf8').digest('hex') !== contentHash) {
      fail('ARTIFACT_CORRUPT', 500);
    }
    return {
      spaceId, artifactId, revision: Number(row.rows[0].revision),
      content: body.content, contentHash,
      source: body.source
    };
  });
}

export async function transitionRun(pool, {
  schema = schemaDefault, spaceId, actorId, runId, requestKey, action, waitReason = null, fence = null
}) {
  if (!['pause','resume','cancel','wait'].includes(action)) fail('INVALID_RUN_ACTION', 400);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    if (action !== 'wait' && actor.kind !== 'human') fail('CONTROLLER_REQUIRED',403);
    return once(client, {
      spaceId, actorId, requestKey, body: { command: 'run.transition', runId, action, waitReason, fence }
    }, async () => {
      const run = await client.query('SELECT * FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE', [spaceId, runId]);
      const state = run.rows[0].state;
      const allowed = {
        pause: ['queued','running','waiting'],
        resume: ['paused','waiting'],
        cancel: ['queued','running','waiting','paused','reconciling'],
        wait: ['running']
      };
      if (!allowed[action].includes(state)) fail('ILLEGAL_TRANSITION');
      if (action === 'wait' && actor.kind !== 'service') fail('WORKER_REQUIRED', 403);
      if (action === 'wait' && (!waitReason || typeof waitReason !== 'string')) fail('WAIT_REASON_REQUIRED', 400);
      if (action === 'wait') await leased(client,spaceId,actorId,runId,fence);
      if (action === 'resume') {
        const goal = await client.query('SELECT revision,state FROM goals WHERE space_id=$1 AND id=$2',
          [spaceId, actor.goalId]);
        if (goal.rows[0].state !== 'active' || Number(goal.rows[0].revision) !== Number(run.rows[0].goal_revision)) fail('GOAL_CHANGED');
        const unknown = await client.query(
          `SELECT 1 FROM effects WHERE space_id=$1 AND run_id=$2 AND state IN ('unknown','inflight') LIMIT 1`,
          [spaceId, runId]);
        if (unknown.rowCount) fail('EFFECT_UNRESOLVED');
        await client.query(
          `UPDATE steps SET state='pending',claimed_fence=NULL
           WHERE space_id=$1 AND run_id=$2 AND state='waiting'`,[spaceId,runId]);
      }
      if (action === 'pause') {
        const inflight=await client.query(
          `UPDATE effects SET state='unknown' WHERE space_id=$1 AND run_id=$2 AND state='inflight'
           RETURNING step_key`,[spaceId,runId]);
        const unknown=await client.query(
          `SELECT 1 FROM effects WHERE space_id=$1 AND run_id=$2 AND state='unknown' LIMIT 1`,
          [spaceId,runId]);
        if (inflight.rowCount || unknown.rowCount) {
          return changedRun(client,{
            spaceId,runId,state:'reconciling',waitReason:'pause_after_reconcile',
            epoch:actor.epoch,requestKey
          });
        }
      }
      const next = { pause:'paused',resume:'queued',cancel:'cancelled',wait:'waiting' }[action];
      if (next === 'cancelled') {
        await client.query(
          `UPDATE steps SET state='cancelled' WHERE space_id=$1 AND run_id=$2
           AND state IN ('pending','running','waiting')`, [spaceId, runId]);
        // An inflight external effect remains unknown; cancellation is not a
        // claim that the remote side did nothing.
        await client.query(
          `UPDATE effects SET state='unknown' WHERE space_id=$1 AND run_id=$2 AND state='inflight'`,
          [spaceId, runId]);
      }
      return changedRun(client, {
        spaceId, runId, state: next, waitReason: next === 'waiting' ? waitReason : null,
        epoch: actor.epoch, requestKey
      });
    });
  });
}

export async function recordArtifact(pool, {
  schema = schemaDefault, spaceId, actorId, runId, artifactId = randomUUID(),
  requestKey, contentRef, contentHash
}) {
  [spaceId, actorId, runId, artifactId, contentRef].forEach((v,i) =>
    id(v,['SPACE_ID','ACTOR_ID','RUN_ID','ARTIFACT_ID','CONTENT_REF'][i]));
  if (!/^[0-9a-f]{64}$/.test(contentHash)) fail('INVALID_CONTENT_HASH', 400);
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const actor = await runAccess(client, spaceId, actorId, runId);
    return once(client, {
      spaceId, actorId, requestKey, body: { command:'artifact.record',runId,artifactId,contentRef,contentHash }
    }, async () => {
      const run = await client.query('SELECT state FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE', [spaceId,runId]);
      if (!['running','queued','waiting'].includes(run.rows[0].state)) fail('RUN_NOT_WRITABLE');
      await client.query('INSERT INTO objects(space_id,id,kind,created_by) VALUES ($1,$2,$3,$4)',
        [spaceId,artifactId,'artifact',actorId]);
      await client.query('INSERT INTO object_revisions(space_id,object_id,revision,body) VALUES ($1,$2,0,$3)',
        [spaceId,artifactId,{contentRef,contentHash,runId}]);
      await client.query(
        `INSERT INTO object_acl(space_id,object_id,actor_id,actions,granted_epoch)
         VALUES ($1,$2,$3,ARRAY['read','write'], $4)`,
        [spaceId,artifactId,actorId,actor.epoch]);
      await client.query(
        `INSERT INTO artifacts(space_id,id,run_id,content_ref,content_hash)
         VALUES ($1,$2,$3,$4,$5)`, [spaceId,artifactId,runId,contentRef,contentHash]);
      const eventId = await event(client, {
        spaceId,kind:'artifact',objectId:artifactId,revision:0,type:'artifact.recorded',
        epoch:actor.epoch,requestKey
      });
      return { spaceId,artifactId,runId,revision:0,eventId };
    });
  });
}

export async function recordAcceptance(pool, {
  schema = schemaDefault, spaceId, actorId, runId, checkKey, artifactId, artifactRevision,
  requestKey
}) {
  [spaceId,actorId,runId,checkKey,artifactId].forEach((v,i) =>
    id(v,['SPACE_ID','ACTOR_ID','RUN_ID','CHECK_KEY','ARTIFACT_ID'][i]));
  if (!Number.isSafeInteger(artifactRevision) || artifactRevision < 0) fail('INVALID_REVISION',400);
  return inSpaceTransaction(pool,schema,spaceId,actorId,async client => {
    const actor = await runAccess(client,spaceId,actorId,runId);
    if (actor.kind === 'agent') fail('VERIFIER_REQUIRED',403);
    return once(client,{
      spaceId,actorId,requestKey,
      body:{command:'run.accept',runId,checkKey,artifactId,artifactRevision}
    },async () => {
      const run = await client.query('SELECT state FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE',
        [spaceId,runId]);
      if (['cancelled','completed','failed'].includes(run.rows[0].state)) fail('RUN_NOT_WRITABLE');
      const validator = await client.query(
        `SELECT gc.validator_id FROM goal_checks gc
         JOIN runs r ON r.space_id=gc.space_id AND r.goal_id=gc.goal_id
         WHERE r.space_id=$1 AND r.id=$2 AND gc.check_key=$3`,
        [spaceId,runId,checkKey]);
      if (!validator.rowCount) fail('CHECK_NOT_FOUND',404);
      if (validator.rows[0].validator_id !== actorId) fail('VERIFIER_REQUIRED',403);
      const artifact = await client.query(
        `SELECT a.revision,a.lifecycle,o.revision AS object_revision,o.lifecycle AS object_lifecycle,
                ov.body->>'kind' AS content_kind
         FROM artifacts a JOIN objects o ON o.space_id=a.space_id AND o.id=a.id
         JOIN object_revisions ov ON ov.space_id=a.space_id AND ov.object_id=a.id
           AND ov.revision=a.revision
         WHERE a.space_id=$1 AND a.id=$2 AND a.run_id=$3 FOR SHARE OF a,o`,
        [spaceId,artifactId,runId]);
      if (!artifact.rowCount || artifact.rows[0].lifecycle !== 'active' ||
        artifact.rows[0].object_lifecycle !== 'active' ||
        Number(artifact.rows[0].revision) !== artifactRevision ||
        Number(artifact.rows[0].object_revision) !== artifactRevision) fail('STALE_ARTIFACT');
      if (artifact.rows[0].content_kind === 'goal_brief_v1') {
        fail('BRIEF_NOT_ACCEPTANCE_EVIDENCE');
      }
      const check = await client.query(
        `UPDATE run_checks SET state='passed',artifact_id=$4,artifact_revision=$5,
         verified_by=$6,verified_at=now()
         WHERE space_id=$1 AND run_id=$2 AND check_key=$3 RETURNING check_key`,
        [spaceId,runId,checkKey,artifactId,artifactRevision,actorId]);
      if (!check.rowCount) fail('CHECK_NOT_FOUND',404);
      const result=await changedRun(client,{
        spaceId,runId,state:run.rows[0].state,clearLease:false,epoch:actor.epoch,requestKey
      });
      return {...result,checkKey,artifactId,artifactRevision};
    });
  });
}

async function assertRunEvidenceCurrent(client, { spaceId, runId, goalId }) {
  const open=await client.query(
    `SELECT 1 FROM steps WHERE space_id=$1 AND run_id=$2 AND state<>'completed' LIMIT 1`,
    [spaceId,runId]);
  if (open.rowCount) fail('STEPS_INCOMPLETE');
  const effects=await client.query(
    `SELECT 1 FROM effects WHERE space_id=$1 AND run_id=$2 AND state<>'succeeded' LIMIT 1`,
    [spaceId,runId]);
  if (effects.rowCount) fail('EFFECT_UNRESOLVED');
  // Hold locks through the state change; a concurrent artifact deletion or
  // revision cannot invalidate accepted evidence after this check.
  await client.query(
    `SELECT a.id FROM run_checks rc
     JOIN artifacts a ON a.space_id=rc.space_id AND a.id=rc.artifact_id
     JOIN objects o ON o.space_id=a.space_id AND o.id=a.id
     WHERE rc.space_id=$1 AND rc.run_id=$2 AND rc.state='passed'
     FOR SHARE OF a,o`,[spaceId,runId]);
  const checks=await client.query(
    `SELECT 1 FROM goal_checks gc
     LEFT JOIN run_checks rc ON rc.space_id=gc.space_id AND rc.run_id=$2 AND rc.check_key=gc.check_key
     LEFT JOIN artifacts a ON a.space_id=rc.space_id AND a.id=rc.artifact_id
     LEFT JOIN objects o ON o.space_id=a.space_id AND o.id=a.id
     WHERE gc.space_id=$1 AND gc.goal_id=$3 AND gc.required
       AND (rc.check_key IS NULL OR rc.state<>'passed' OR a.id IS NULL OR a.lifecycle<>'active'
         OR o.lifecycle<>'active' OR a.revision<>rc.artifact_revision
         OR o.revision<>rc.artifact_revision) LIMIT 1`,
    [spaceId,runId,goalId]);
  if (checks.rowCount) fail('ACCEPTANCE_INCOMPLETE');
}

export async function finishRun(pool, {
  schema = schemaDefault,spaceId,actorId,runId,requestKey
}) {
  return inSpaceTransaction(pool,schema,spaceId,actorId,async client => {
    const actor=await runAccess(client,spaceId,actorId,runId);
    return once(client,{
      spaceId,actorId,requestKey,body:{command:'run.finish',runId}
    },async () => {
      const goal=await client.query('SELECT state,revision FROM goals WHERE space_id=$1 AND id=$2 FOR SHARE',
        [spaceId,actor.goalId]);
      // Match goal completion and internal preflight: goal before run.
      const run=await client.query('SELECT * FROM runs WHERE space_id=$1 AND id=$2 FOR UPDATE',
        [spaceId,runId]);
      if (!['running','queued'].includes(run.rows[0].state)) fail('ILLEGAL_TRANSITION');
      if (goal.rows[0].state!=='active' ||
        Number(goal.rows[0].revision)!==Number(run.rows[0].goal_revision)) fail('GOAL_CHANGED');
      await assertRunEvidenceCurrent(client,{spaceId,runId,goalId:actor.goalId});
      return changedRun(client,{
        spaceId,runId,state:'completed',epoch:actor.epoch,requestKey
      });
    });
  });
}

export async function completeGoal(pool, {
  schema=schemaDefault,spaceId,actorId,goalId,runId,requestKey
}) {
  [spaceId,actorId,goalId,runId].forEach((v,i) =>
    id(v,['SPACE_ID','ACTOR_ID','GOAL_ID','RUN_ID'][i]));
  return inSpaceTransaction(pool,schema,spaceId,actorId,async client => {
    const actor=await access(client,spaceId,actorId,goalId);
    if (actor.kind!=='human') fail('CONTROLLER_REQUIRED',403);
    return once(client,{
      spaceId,actorId,requestKey,body:{command:'goal.complete',goalId,runId}
    },async () => {
      const goal=await client.query(
        'SELECT state,revision FROM goals WHERE space_id=$1 AND id=$2 FOR UPDATE',
        [spaceId,goalId]);
      if (goal.rows[0]?.state!=='active') fail('GOAL_NOT_ACTIVE');
      const run=await client.query(
        `SELECT state,goal_revision FROM runs
         WHERE space_id=$1 AND id=$2 AND goal_id=$3 FOR SHARE`,
        [spaceId,runId,goalId]);
      if (run.rows[0]?.state!=='completed' ||
        Number(run.rows[0].goal_revision)!==Number(goal.rows[0].revision)) {
        fail('ACCEPTANCE_INCOMPLETE');
      }
      await assertRunEvidenceCurrent(client,{spaceId,runId,goalId});
      const updated=await client.query(
        `UPDATE goals SET state='completed',revision=revision+1
         WHERE space_id=$1 AND id=$2 RETURNING revision`,[spaceId,goalId]);
      const revision=Number(updated.rows[0].revision);
      await client.query('UPDATE objects SET revision=$3 WHERE space_id=$1 AND id=$2',
        [spaceId,goalId,revision]);
      await client.query(
        `INSERT INTO object_revisions(space_id,object_id,revision,body)
         VALUES ($1,$2,$3,$4)`,[spaceId,goalId,revision,{state:'completed',acceptedRunId:runId}]);
      const eventId=await event(client,{
        spaceId,kind:'goal',objectId:goalId,revision,type:'goal.completed',
        epoch:actor.epoch,requestKey
      });
      return {spaceId,goalId,runId,state:'completed',revision,eventId};
    });
  });
}

export async function readRun(pool,{schema=schemaDefault,spaceId,actorId,runId}) {
  return inSpaceTransaction(pool,schema,spaceId,actorId,async client => {
    await runAccess(client,spaceId,actorId,runId,'read');
    const run=await client.query('SELECT * FROM runs WHERE space_id=$1 AND id=$2',[spaceId,runId]);
    const steps=await client.query('SELECT * FROM steps WHERE space_id=$1 AND run_id=$2 ORDER BY position',[spaceId,runId]);
    const effects=await client.query(
      `SELECT step_key,state,idempotency_key,receipt,quote_micros,actual_micros
       FROM effects WHERE space_id=$1 AND run_id=$2`,[spaceId,runId]);
    const checks=await client.query('SELECT * FROM run_checks WHERE space_id=$1 AND run_id=$2',[spaceId,runId]);
    return {run:run.rows[0],steps:steps.rows,effects:effects.rows,checks:checks.rows};
  });
}
