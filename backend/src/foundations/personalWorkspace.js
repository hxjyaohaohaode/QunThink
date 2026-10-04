import { createHash } from 'node:crypto';
import pg from 'pg';
import { quoteSchema } from './migrate.js';
import { FoundationError } from './store.js';

let runtimePool;

export function personalSpaceId(actorId) {
  return `personal:${createHash('sha256').update(actorId).digest('hex').slice(0,32)}`;
}

export function stablePersonalId(kind, actorId, key, parent = '') {
  return `${kind}:${createHash('sha256').update(
    JSON.stringify([kind,actorId,parent,key])).digest('hex').slice(0,32)}`;
}

export function getPersonalGoalRuntime() {
  const connectionString = process.env.QUNTHINK_FOUNDATIONS_RUNTIME_URL;
  if (!connectionString) return null;
  if (!runtimePool) {
    runtimePool = new pg.Pool({
      connectionString, max: 8, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000, statement_timeout: 10000
    });
  }
  return { pool: runtimePool, schema: process.env.QUNTHINK_FOUNDATIONS_SCHEMA || 'qunthink_core' };
}

export async function closePersonalGoalRuntime() {
  const pool = runtimePool;
  runtimePool = null;
  if (pool) await pool.end();
}

// Personal space is derived solely from the verified session identity.
// Migrations are an explicit deployment step, never performed by a request.
export async function ensurePersonalWorkspace(pool, schema, actorId) {
  if (typeof actorId !== 'string' || !actorId || actorId.length > 128) {
    throw new FoundationError('SESSION_REQUIRED',401);
  }
  const spaceId = personalSpaceId(actorId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${quoteSchema(schema)}, pg_catalog`);
    await client.query(
      "SELECT set_config('app.space_id',$1,true),set_config('app.actor_id',$2,true)",
      [spaceId,actorId]);
    const migration = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version=2');
    if (!migration.rowCount) throw new FoundationError('FOUNDATION_NOT_MIGRATED',503);
    await client.query(
      "INSERT INTO principals(id,kind) VALUES ($1,'human') ON CONFLICT DO NOTHING",[actorId]);
    const principal = await client.query('SELECT kind,active FROM principals WHERE id=$1 FOR SHARE',[actorId]);
    if (principal.rows[0]?.kind !== 'human' || !principal.rows[0]?.active) {
      throw new FoundationError('IDENTITY_DISABLED',403);
    }
    await client.query(
      "INSERT INTO spaces(id,kind,owner_id) VALUES ($1,'personal',$2) ON CONFLICT DO NOTHING",
      [spaceId,actorId]);
    const space = await client.query('SELECT kind,owner_id FROM spaces WHERE id=$1 FOR SHARE',[spaceId]);
    if (space.rows[0]?.kind !== 'personal' || space.rows[0]?.owner_id !== actorId) {
      throw new FoundationError('PERSONAL_SPACE_CONFLICT');
    }
    await client.query(
      "INSERT INTO memberships(space_id,actor_id,role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING",
      [spaceId,actorId]);
    const member = await client.query(
      'SELECT active,role FROM memberships WHERE space_id=$1 AND actor_id=$2 FOR SHARE',
      [spaceId,actorId]);
    if (!member.rows[0]?.active || member.rows[0]?.role !== 'owner') {
      throw new FoundationError('ACCESS_REVOKED',403);
    }
    await client.query('COMMIT');
    return spaceId;
  } catch(error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function listPersonalGoals(pool,schema,spaceId,actorId) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL search_path TO ${quoteSchema(schema)}, pg_catalog`);
    await client.query("SELECT set_config('app.space_id',$1,true)",[spaceId]);
    const goals=await client.query(
      `SELECT g.id,g.outcome,g.constraints,g.grant_refs,g.budget_limit_micros,
       g.budget_reserved_micros,g.budget_spent_micros,g.state,g.revision,g.created_at
       FROM goals g JOIN object_acl a ON a.space_id=g.space_id AND a.object_id=g.id
       WHERE g.space_id=$1 AND g.owner_id=$2 AND a.actor_id=$2
         AND a.revoked_at IS NULL AND 'read'=ANY(a.actions)
         AND EXISTS (SELECT 1 FROM memberships m JOIN principals p ON p.id=m.actor_id
           WHERE m.space_id=g.space_id AND m.actor_id=$2 AND m.active AND p.active)
       ORDER BY g.created_at DESC,g.id DESC LIMIT 100`,[spaceId,actorId]);
    await client.query('COMMIT');
    return goals.rows;
  } catch(error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function readPersonalGoal(pool,schema,spaceId,actorId,goalId) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL search_path TO ${quoteSchema(schema)}, pg_catalog`);
    await client.query("SELECT set_config('app.space_id',$1,true)",[spaceId]);
    const goal=await client.query(
      `SELECT g.* FROM goals g JOIN object_acl a
       ON a.space_id=g.space_id AND a.object_id=g.id
       WHERE g.space_id=$1 AND g.id=$2 AND g.owner_id=$3
         AND a.actor_id=$3 AND a.revoked_at IS NULL AND 'read'=ANY(a.actions)
         AND EXISTS (SELECT 1 FROM memberships m JOIN principals p ON p.id=m.actor_id
           WHERE m.space_id=g.space_id AND m.actor_id=$3 AND m.active AND p.active)`,
      [spaceId,goalId,actorId]);
    if (!goal.rowCount) throw new FoundationError('GOAL_NOT_FOUND',404);
    const checks=await client.query(
      `SELECT check_key,description,required,validator_id
       FROM goal_checks WHERE space_id=$1 AND goal_id=$2 ORDER BY check_key`,
      [spaceId,goalId]);
    const runs=await client.query(
      `SELECT id,state,goal_revision,revision,fence,wait_reason,created_at
       FROM runs WHERE space_id=$1 AND goal_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [spaceId,goalId]);
    await client.query('COMMIT');
    return {goal:goal.rows[0],checks:checks.rows,runs:runs.rows};
  } catch(error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
