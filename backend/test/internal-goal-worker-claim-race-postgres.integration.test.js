import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { applyFoundationsMigration, quoteSchema } from '../src/foundations/migrate.js';
import {
  claimRun, createGoal, createRun, finishRun, grantTool, readRun, requestGoalBriefRun
} from '../src/foundations/agentStore.js';
import { tickInternalGoalRun } from '../src/foundations/internalGoalWorker.js';

const connectionString = process.env.QUNTHINK_TEST_PG_URL;

// Delay only the late worker's claim SQL. Every read, lock, write and commit
// still runs against PostgreSQL; no sleeps or mocked database results decide
// the interleaving. The first worker settles before this claim reaches the DB.
function delayedClaim(pool) {
  const reached = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let delayed = false;
  return {
    reached: reached.promise,
    resume: resume.resolve,
    pool: {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, values) {
            if (!delayed && /SELECT \* FROM runs/.test(sql) && /FOR UPDATE SKIP LOCKED/.test(sql)) {
              delayed = true;
              reached.resolve();
              await resume.promise;
            }
            return client.query(sql, values);
          },
          release() { client.release(); }
        };
      }
    }
  };
}

for (const scenario of ['last preflight', 'next preflight', 'last brief']) {
  test(`late internal Goal claim cannot lease a settled step: ${scenario}`, {
    skip: !connectionString && 'QUNTHINK_TEST_PG_URL is required', timeout: 20000
  }, async () => {
    const pool = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 10000 });
    const schema = `qt_claim_race_${randomBytes(5).toString('hex')}`;
    const q = quoteSchema(schema);
    const owner = { schema, spaceId: 'space', actorId: 'owner' };
    const worker = { ...owner, actorId: 'worker', runId: 'run' };
    const tick = targetPool => tickInternalGoalRun(targetPool, {
      schema, spaceId: 'space', workerId: 'worker', runId: 'run'
    });
    const gate = delayedClaim(pool);
    let late;
    try {
      await applyFoundationsMigration(pool, { schema });
      await pool.query(`INSERT INTO ${q}.principals(id,kind) VALUES ('owner','human'),('worker','service')`);
      await pool.query(`INSERT INTO ${q}.spaces(id,kind,owner_id) VALUES ('space','personal','owner')`);
      await pool.query(`INSERT INTO ${q}.memberships(space_id,actor_id,role) VALUES
        ('space','owner','owner'),('space','worker','member')`);
      await createGoal(pool, {
        ...owner, goalId: 'goal', requestKey: 'goal', outcome: '检查目标状态',
        checks: [{ key: 'human-review', description: '人工检查真实成果', required: true }]
      });
      if (scenario === 'last brief') {
        await requestGoalBriefRun(pool, {
          ...owner, goalId: 'goal', runId: 'run', workerId: 'worker', grantId: 'grant', requestKey: 'run'
        });
      } else {
        await grantTool(pool, {
          ...owner, goalId: 'goal', grantId: 'grant', workerId: 'worker',
          toolId: 'internal.goal_preflight.v1', maxQuoteMicros: '0',
          expiresAt: new Date(Date.now() + 3600000).toISOString(), requestKey: 'grant'
        });
        await createRun(pool, {
          ...owner, goalId: 'goal', runId: 'run', requestKey: 'run',
          steps: (scenario === 'next preflight' ? ['first', 'second'] : ['first']).map(key => ({
            key, action: 'internal.goal_preflight.v1', inputRefs: [], maxAttempts: 2
          }))
        });
      }
      late = tick(gate.pool).then(value => ({ value }), error => ({ error }));
      await Promise.race([
        gate.reached,
        late.then(result => { throw result.error || new Error('late tick did not reach its claim'); })
      ]);
      const first = await tick(pool);
      assert.equal(first.advanced, true);
      const settled = await readRun(pool, worker);
      const events = await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events`);
      gate.resume();
      const second = await late;
      assert.ifError(second.error);
      assert.equal(second.value.advanced, false);
      const after = await readRun(pool, worker);
      assert.equal(after.run.state, 'queued', 'late claim must not strand a completed step in running');
      assert.equal(after.run.lease_owner, null);
      assert.equal(after.run.lease_until, null);
      assert.equal(after.run.fence, settled.run.fence, 'rejected claim must not advance the fence');
      assert.equal(after.run.revision, settled.run.revision);
      assert.deepEqual(after.steps, settled.steps);
      assert.deepEqual((await pool.query(`SELECT count(*)::int AS n FROM ${q}.domain_events`)).rows, events.rows);
      assert.equal(after.steps[0].state, 'completed');
      assert.equal(after.steps[0].attempts, 1);
      assert.equal(after.checks[0].state, 'pending');
      assert.equal(after.effects.length, 0);
      if (scenario === 'next preflight') {
        assert.equal(after.steps[1].state, 'pending');
        assert.equal(after.steps[1].attempts, 0);
        assert.equal((await tick(pool)).advanced, true, 'a fresh tick can claim the next step immediately');
      } else if (scenario === 'last brief') {
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${q}.artifacts`)).rows[0].n, 1);
      }
      const beforeEmptyClaim = await readRun(pool, worker);
      assert.equal(await claimRun(pool, worker), null, 'completed steps cannot be leased by a direct caller either');
      assert.deepEqual(await readRun(pool, worker), beforeEmptyClaim);
      assert.equal((await tick(pool)).state, 'awaiting_acceptance');
      await assert.rejects(finishRun(pool, { ...owner, runId: 'run', requestKey: 'finish' }),
        error => error.code === 'ACCEPTANCE_INCOMPLETE');
    } finally {
      gate.resume();
      if (late) await late;
      await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`).catch(() => {});
      await pool.end();
    }
  });
}
