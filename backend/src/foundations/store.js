import { createHash, randomUUID } from 'node:crypto';
import { quoteSchema } from './migrate.js';

export class FoundationError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function canonicalJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new FoundationError('INVALID_COMMAND', 400);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new FoundationError('INVALID_COMMAND', 400);
    }
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new FoundationError('INVALID_COMMAND', 400);
  return encoded;
}

export function hashRequest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function requiredId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new FoundationError(`INVALID_${label}`, 400);
  return value;
}

export async function inSpaceTransaction(pool, schema, spaceId, actorId, fn) {
  const schemaIdent = quoteSchema(schema);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schemaIdent}, pg_catalog`);
    await client.query("SELECT set_config('app.space_id', $1, true), set_config('app.actor_id', $2, true)", [spaceId, actorId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function reserveCommand(client, { spaceId, actorId, requestKey, requestHash }) {
  const inserted = await client.query(
    `INSERT INTO commands(space_id, actor_id, request_key, request_hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING request_key`,
    [spaceId, actorId, requestKey, requestHash]
  );
  if (inserted.rowCount) return null;
  const existing = await client.query(
    'SELECT request_hash, response FROM commands WHERE space_id=$1 AND actor_id=$2 AND request_key=$3',
    [spaceId, actorId, requestKey]
  );
  if (!existing.rowCount) throw new FoundationError('COMMAND_RECEIPT_UNKNOWN', 503);
  if (existing.rows[0].request_hash !== requestHash) throw new FoundationError('IDEMPOTENCY_CONFLICT');
  if (existing.rows[0].response === null) throw new FoundationError('COMMAND_RECEIPT_UNKNOWN', 503);
  return existing.rows[0].response;
}

export async function saveCommandResponse(client, { spaceId, actorId, requestKey, response }) {
  await client.query(
    'UPDATE commands SET response=$4 WHERE space_id=$1 AND actor_id=$2 AND request_key=$3',
    [spaceId, actorId, requestKey, response]
  );
}

export async function appendEvent(client, { spaceId, aggregateKind, aggregateId, aggregateRevision, eventType, policyEpoch, payloadRef, correlationId }) {
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO domain_events(space_id,id,aggregate_kind,aggregate_id,aggregate_revision,event_type,policy_epoch,payload_ref,correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [spaceId, eventId, aggregateKind, aggregateId, aggregateRevision, eventType, policyEpoch, payloadRef, correlationId]
  );
  await client.query('INSERT INTO outbox(space_id,event_id) VALUES ($1,$2)', [spaceId, eventId]);
  return eventId;
}

export async function executeObjectRevisionCommand(pool, {
  schema = 'qunthink_core', spaceId, actorId, objectId, requestKey,
  expectedRevision, body, eventType = 'object.revised'
}) {
  [spaceId, actorId, objectId, requestKey, eventType].forEach((value, index) =>
    requiredId(value, ['SPACE_ID', 'ACTOR_ID', 'OBJECT_ID', 'REQUEST_KEY', 'EVENT_TYPE'][index]));
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || body === undefined) {
    throw new FoundationError('INVALID_COMMAND', 400);
  }
  const requestHash = hashRequest({ spaceId, objectId, expectedRevision, body, eventType });
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    // Revocation takes the same space row FOR UPDATE. No check may be made
    // against an epoch that changes before this command commits.
    const space = await client.query('SELECT policy_epoch FROM spaces WHERE id=$1 FOR SHARE', [spaceId]);
    if (!space.rowCount) throw new FoundationError('SPACE_NOT_FOUND', 404);
    const member = await client.query(
      `SELECT m.active FROM memberships m JOIN principals p ON p.id=m.actor_id
       WHERE m.space_id=$1 AND m.actor_id=$2 AND p.active FOR SHARE OF m`,
      [spaceId, actorId]
    );
    if (!member.rows[0]?.active) throw new FoundationError('ACCESS_REVOKED', 403);
    const acl = await client.query(
      `SELECT actions FROM object_acl WHERE space_id=$1 AND object_id=$2 AND actor_id=$3
       AND revoked_at IS NULL FOR SHARE`,
      [spaceId, objectId, actorId]
    );
    if (!acl.rows[0]?.actions.includes('write')) throw new FoundationError('ACCESS_DENIED', 403);

    const prior = await reserveCommand(client, { spaceId, actorId, requestKey, requestHash });
    if (prior) return { ...prior, replayed: true };
    const changed = await client.query(
      `UPDATE objects SET revision=revision+1
       WHERE space_id=$1 AND id=$2 AND revision=$3 AND lifecycle='active'
       RETURNING revision`,
      [spaceId, objectId, expectedRevision]
    );
    if (!changed.rowCount) throw new FoundationError('REVISION_CONFLICT');
    const revision = Number(changed.rows[0].revision);
    await client.query(
      'INSERT INTO object_revisions(space_id,object_id,revision,body) VALUES ($1,$2,$3,$4)',
      [spaceId, objectId, revision, body]
    );
    const eventId = await appendEvent(client, {
      spaceId, aggregateKind: 'object', aggregateId: objectId, aggregateRevision: revision,
      eventType, policyEpoch: Number(space.rows[0].policy_epoch),
      payloadRef: `object:${objectId}:revision:${revision}`, correlationId: requestKey
    });
    const response = { spaceId, objectId, revision, eventId };
    await saveCommandResponse(client, { spaceId, actorId, requestKey, response });
    return { ...response, replayed: false };
  });
}

export async function disableMember(pool, {
  schema = 'qunthink_core', spaceId, actorId, targetId, requestKey
}) {
  [spaceId, actorId, targetId, requestKey].forEach((value, index) =>
    requiredId(value, ['SPACE_ID', 'ACTOR_ID', 'TARGET_ID', 'REQUEST_KEY'][index]));
  const requestHash = hashRequest({ spaceId, targetId, action: 'membership.disable' });
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const space = await client.query('SELECT owner_id,policy_epoch FROM spaces WHERE id=$1 FOR UPDATE', [spaceId]);
    if (!space.rowCount) throw new FoundationError('SPACE_NOT_FOUND', 404);
    const actor = await client.query(
      `SELECT m.role,m.active FROM memberships m JOIN principals p ON p.id=m.actor_id
       WHERE m.space_id=$1 AND m.actor_id=$2 AND p.active FOR SHARE OF m`, [spaceId, actorId]
    );
    if (!actor.rows[0]?.active || !['owner', 'admin'].includes(actor.rows[0].role)) {
      throw new FoundationError('ACCESS_DENIED', 403);
    }
    if (space.rows[0].owner_id === targetId) throw new FoundationError('OWNER_CANNOT_BE_DISABLED');
    const target = await client.query(
      'SELECT active FROM memberships WHERE space_id=$1 AND actor_id=$2 FOR UPDATE', [spaceId, targetId]
    );
    if (!target.rowCount) throw new FoundationError('MEMBER_NOT_FOUND', 404);
    const prior = await reserveCommand(client, { spaceId, actorId, requestKey, requestHash });
    if (prior) return { ...prior, replayed: true };
    if (!target.rows[0].active) throw new FoundationError('MEMBER_ALREADY_DISABLED');
    const epoch = Number(space.rows[0].policy_epoch) + 1;
    await client.query(
      `UPDATE memberships SET active=false, disabled_at=now(), revision=revision+1
       WHERE space_id=$1 AND actor_id=$2`, [spaceId, targetId]
    );
    await client.query('UPDATE spaces SET policy_epoch=$2 WHERE id=$1', [spaceId, epoch]);
    const eventId = await appendEvent(client, {
      spaceId, aggregateKind: 'space', aggregateId: spaceId, aggregateRevision: epoch,
      eventType: 'membership.disabled', policyEpoch: epoch,
      payloadRef: `membership:${targetId}:epoch:${epoch}`, correlationId: requestKey
    });
    const response = { spaceId, targetId, policyEpoch: epoch, eventId };
    await saveCommandResponse(client, { spaceId, actorId, requestKey, response });
    return { ...response, replayed: false };
  });
}

export async function readCommandReceipt(pool, { schema = 'qunthink_core', spaceId, actorId, requestKey }) {
  [spaceId, actorId, requestKey].forEach((value, index) =>
    requiredId(value, ['SPACE_ID', 'ACTOR_ID', 'REQUEST_KEY'][index]));
  return inSpaceTransaction(pool, schema, spaceId, actorId, async client => {
    const row = await client.query(
      'SELECT request_hash,response FROM commands WHERE space_id=$1 AND actor_id=$2 AND request_key=$3',
      [spaceId, actorId, requestKey]
    );
    return row.rows[0] || null;
  });
}

export async function claimOutbox(pool, { schema = 'qunthink_core', spaceId, workerId, leaseSeconds = 30 }) {
  [spaceId, workerId].forEach((value, index) => requiredId(value, ['SPACE_ID', 'WORKER_ID'][index]));
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new FoundationError('INVALID_LEASE', 400);
  return inSpaceTransaction(pool, schema, spaceId, workerId, async client => {
    const due = await client.query(
      `SELECT o.event_id FROM outbox o WHERE o.space_id=$1 AND o.delivered_at IS NULL
       AND (o.lease_until IS NULL OR o.lease_until < now())
       ORDER BY o.event_id FOR UPDATE SKIP LOCKED LIMIT 1`, [spaceId]
    );
    if (!due.rowCount) return null;
    const eventId = due.rows[0].event_id;
    const lease = await client.query(
      `UPDATE outbox SET lease_owner=$3, lease_until=now()+($4::integer * interval '1 second'), attempts=attempts+1
       WHERE space_id=$1 AND event_id=$2 RETURNING attempts,lease_until`,
      [spaceId, eventId, workerId, leaseSeconds]
    );
    return { spaceId, eventId, attempts: lease.rows[0].attempts, leaseUntil: lease.rows[0].lease_until };
  });
}

export async function markOutboxDelivered(pool, { schema = 'qunthink_core', spaceId, workerId, eventId, attempts }) {
  [spaceId, workerId, eventId].forEach((value, index) =>
    requiredId(value, ['SPACE_ID', 'WORKER_ID', 'EVENT_ID'][index]));
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new FoundationError('INVALID_LEASE', 400);
  return inSpaceTransaction(pool, schema, spaceId, workerId, async client => {
    const result = await client.query(
      `UPDATE outbox SET delivered_at=now(),lease_owner=NULL,lease_until=NULL
       WHERE space_id=$1 AND event_id=$2 AND lease_owner=$3 AND attempts=$4
         AND lease_until>now() AND delivered_at IS NULL`,
      [spaceId, eventId, workerId, attempts]
    );
    return result.rowCount === 1;
  });
}

export async function consumeEventOnce(pool, {
  schema = 'qunthink_core', spaceId, consumer, eventId, apply
}) {
  [spaceId, consumer, eventId].forEach((value, index) =>
    requiredId(value, ['SPACE_ID', 'CONSUMER', 'EVENT_ID'][index]));
  if (typeof apply !== 'function') throw new FoundationError('INVALID_CONSUMER', 400);
  return inSpaceTransaction(pool, schema, spaceId, consumer, async client => {
    const event = await client.query('SELECT * FROM domain_events WHERE space_id=$1 AND id=$2', [spaceId, eventId]);
    if (!event.rowCount) throw new FoundationError('EVENT_NOT_FOUND', 404);
    const inserted = await client.query(
      `INSERT INTO consumer_inbox(space_id,consumer,event_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING event_id`, [spaceId, consumer, eventId]
    );
    if (!inserted.rowCount) return false;
    await apply(client, event.rows[0]);
    return true;
  });
}
