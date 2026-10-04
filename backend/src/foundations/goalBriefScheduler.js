import { inSpaceTransaction } from './store.js';
import { personalSpaceId, stablePersonalId } from './personalWorkspace.js';
import { tickInternalGoalRun } from './internalGoalWorker.js';

const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_USERS_PER_TICK = 100;
const DEFAULT_RUNS_PER_USER = 5;

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error('INVALID_GOAL_BRIEF_SCHEDULER_CONFIG');
  }
  return parsed;
}

async function dueRuns(pool, { schema, spaceId, workerId, limit }) {
  return inSpaceTransaction(pool, schema, spaceId, workerId, async client => {
    const rows = await client.query(
      `SELECT r.id FROM runs r JOIN steps st
         ON st.space_id=r.space_id AND st.run_id=r.id
       WHERE r.space_id=$1 AND r.checkpoint->>'origin'='personal_goal_brief_v1'
         AND r.checkpoint->>'workerId'=$2
         AND st.step_key='brief' AND st.position=0
         AND st.action='internal.goal_brief.v1' AND st.input_refs='[]'::jsonb
         AND st.state IN ('pending','running')
         AND NOT EXISTS (SELECT 1 FROM steps other
           WHERE other.space_id=r.space_id AND other.run_id=r.id AND other.step_key<>st.step_key)
         AND NOT EXISTS (SELECT 1 FROM effects e
           WHERE e.space_id=r.space_id AND e.run_id=r.id)
         AND (r.state='queued' OR (r.state='running'
           AND (r.lease_until IS NULL OR r.lease_until<now())))
       ORDER BY r.created_at,r.id LIMIT $3`,
      [spaceId, workerId, limit]);
    return rows.rows.map(row => row.id);
  });
}

// Enumerate active auth users outside this module; each query is confined to
// that user's personal RLS space. A durable checkpoint proves that the Run
// came from the explicit brief request, and tick rechecks grants and fencing.
export async function scanPersonalGoalBriefs(pool, {
  schema = 'qunthink_core', userIds, runsPerUser = DEFAULT_RUNS_PER_USER,
  onError = () => {}
}) {
  const limit = boundedInteger(runsPerUser, DEFAULT_RUNS_PER_USER, 1, 100);
  const users = [...new Set(userIds)].filter(id => typeof id === 'string' && id.length > 0 && id.length <= 128);
  const report = { users: users.length, candidates: 0, advanced: 0, waiting: 0, errors: 0 };
  for (const userId of users) {
    const spaceId = personalSpaceId(userId);
    const workerId = stablePersonalId('worker', userId, 'goal-brief-v1');
    let runIds;
    try {
      runIds = await dueRuns(pool, { schema, spaceId, workerId, limit });
    } catch (error) {
      report.errors++;
      onError(error);
      continue;
    }
    report.candidates += runIds.length;
    for (const runId of runIds) {
      try {
        const result = await tickInternalGoalRun(pool, { schema, spaceId, workerId, runId });
        if (result.advanced) report.advanced++;
        if (result.state === 'waiting') report.waiting++;
      } catch (error) {
        report.errors++;
        onError(error);
      }
    }
  }
  return report;
}

// Sequential timer: no overlap in one process. PostgreSQL SKIP LOCKED and
// fences handle competing processes and crashed leases. stop() drains one
// in-flight scan before its pool is closed by the server shutdown path.
export function startGoalBriefScheduler({
  pool, schema = 'qunthink_core', listUserIds,
  intervalMs = DEFAULT_INTERVAL_MS, usersPerTick = DEFAULT_USERS_PER_TICK,
  runsPerUser = DEFAULT_RUNS_PER_USER, onError = () => {}, onTick = () => {}
}) {
  if (!pool?.connect || typeof listUserIds !== 'function') {
    throw new Error('INVALID_GOAL_BRIEF_SCHEDULER_CONFIG');
  }
  const interval = boundedInteger(intervalMs, DEFAULT_INTERVAL_MS, 1000, 300000);
  const userLimit = boundedInteger(usersPerTick, DEFAULT_USERS_PER_TICK, 1, 1000);
  const runLimit = boundedInteger(runsPerUser, DEFAULT_RUNS_PER_USER, 1, 100);
  let timer = null;
  let current = null;
  let stopped = false;
  let cursor = 0;

  async function runOnce() {
    if (stopped) return null;
    if (current) return current;
    current = (async () => {
      const ids = [...new Set(await listUserIds())]
        .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 128)
        .sort();
      if (!ids.length) return { users: 0, candidates: 0, advanced: 0, waiting: 0, errors: 0 };
      const count = Math.min(userLimit, ids.length);
      const selected = Array.from({ length: count }, (_, index) => ids[(cursor + index) % ids.length]);
      cursor = (cursor + count) % ids.length;
      return scanPersonalGoalBriefs(pool, {
        schema, userIds: selected, runsPerUser: runLimit, onError
      });
    })();
    try {
      const report = await current;
      onTick(report);
      return report;
    } finally {
      current = null;
    }
  }

  async function cycle() {
    if (stopped) return;
    try { await runOnce(); } catch (error) { onError(error); }
    if (!stopped) {
      timer = setTimeout(() => { void cycle(); }, interval);
      timer.unref?.();
    }
  }

  void cycle();
  return {
    runOnce,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (current) await current.catch(() => {});
    }
  };
}
