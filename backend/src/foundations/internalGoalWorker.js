import { FoundationError } from './store.js';
import { claimRun, readRun, settleGoalBrief, settleGoalPreflight, settleStep, startStep } from './agentStore.js';

// An explicitly invoked, bounded worker tick. Only this exact database-only
// actions are executable here. No text supplied by a user is interpreted as a
// tool name, model instruction, external destination, or completed artifact.
export async function tickInternalGoalRun(pool, {
  schema = 'qunthink_core', spaceId, workerId, runId, leaseSeconds = 30
}) {
  const scope = { schema, spaceId, actorId: workerId, runId };
  const before = await readRun(pool, scope);
  if (!['queued', 'running'].includes(before.run.state)) {
    return { runId, state: before.run.state, advanced: false };
  }
  const next = before.steps.find(step => step.state !== 'completed');
  if (!next) return { runId, state: 'awaiting_acceptance', advanced: false };
  if (!['internal.goal_preflight.v1', 'internal.goal_brief.v1'].includes(next.action) ||
      !Array.isArray(next.input_refs) || next.input_refs.length ||
      !['pending', 'running'].includes(next.state)) {
    return { runId, state: 'unsupported_step', stepKey: next.step_key, advanced: false };
  }
  if (next.action === 'internal.goal_brief.v1' &&
      (before.run.checkpoint?.origin !== 'personal_goal_brief_v1' ||
        before.run.checkpoint.workerId !== workerId ||
        typeof before.run.checkpoint.grantId !== 'string')) {
    return { runId, state: 'unsupported_step', stepKey: next.step_key, advanced: false };
  }
  const claim = await claimRun(pool, { ...scope, leaseSeconds });
  if (!claim) return { runId, state: 'busy', advanced: false };
  if (claim.state === 'reconciling') return { runId, state: 'effect_unknown', advanced: false };
  let briefStarted = false;
  try {
    const current = await readRun(pool, scope);
    const step = current.steps.find(item => item.state !== 'completed');
    if (!step || step.step_key !== next.step_key ||
        step.action !== next.action ||
        !Array.isArray(step.input_refs) || step.input_refs.length) {
      return { runId, state: 'plan_changed', advanced: false };
    }
    if (step.state === 'pending') {
      await startStep(pool, { ...scope, stepKey: step.step_key, fence: claim.fence });
    } else if (step.state !== 'running' || Number(step.claimed_fence) !== claim.fence) {
      return { runId, state: 'step_unavailable', advanced: false };
    }
    briefStarted = step.action === 'internal.goal_brief.v1';
    if (briefStarted && claim.briefRetryExhausted) {
      const failed = await settleStep(pool, {
        ...scope, stepKey: step.step_key, fence: claim.fence,
        outcome: 'failed', resultRef: 'internal:goal_brief:retry_exhausted'
      });
      return { ...failed, advanced: false, reason: 'retry_exhausted' };
    }
    const settle = step.action === 'internal.goal_brief.v1' ? settleGoalBrief : settleGoalPreflight;
    const result = await settle(pool, {
      ...scope, stepKey: step.step_key, fence: claim.fence
    });
    return { ...result, advanced: result.state === 'queued' };
  } catch (error) {
    if (error instanceof FoundationError &&
        ['STALE_LEASE', 'ACCESS_REVOKED', 'ACCESS_DENIED'].includes(error.code)) {
      return { runId, state: 'interrupted', reason: error.code, advanced: false };
    }
    if (briefStarted && !(error instanceof FoundationError)) {
      try {
        const failed = await settleStep(pool, {
          ...scope, stepKey: next.step_key, fence: claim.fence,
          outcome: 'failed', resultRef: 'internal:goal_brief:write_failed'
        });
        return { ...failed, advanced: false, reason: 'brief_write_failed' };
      } catch (settleError) {
        if (settleError instanceof FoundationError &&
            ['STALE_LEASE', 'ACCESS_REVOKED', 'ACCESS_DENIED'].includes(settleError.code)) {
          return { runId, state: 'interrupted', reason: settleError.code, advanced: false };
        }
        throw error;
      }
    }
    throw error;
  }
}
