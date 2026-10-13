// Creation order belongs to the account snapshot, not to message contents.
// These pure helpers do no I/O, acquire no locks, and never dispatch models.
// The caller must commit their detached result with the account write fence.
export const MESSAGE_ORDER_VERSION = 1;
export const MAX_MESSAGE_SEQUENCE = 9223372036854775807n;
export const MESSAGE_ORDER_LIMITS = Object.freeze({ maxBindings: 100_000, maxBytes: 8 * 1024 * 1024 });

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;

function unavailable() {
  return Object.assign(new Error('消息顺序数据不可用，请核验存储后再继续'), {
    code: 'MESSAGE_ORDER_UNAVAILABLE', status: 503, statusCode: 503, isOperational: true
  });
}
function capacity() {
  return Object.assign(new Error('消息顺序存储已达到容量限制，未保存本次变更'), {
    code: 'MESSAGE_ORDER_CAPACITY_EXCEEDED', status: 409, statusCode: 409, isOperational: true
  });
}
function boundId() {
  return Object.assign(new Error('消息或群标识已使用，必须核对原结果'), {
    code: 'MESSAGE_ORDER_ID_BOUND', status: 409, statusCode: 409, isOperational: true
  });
}
function identity(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw unavailable();
  return value;
}
function exactKeys(value, required, optional = []) {
  if (!record(value) || required.some(key => !own(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw unavailable();
}
function limitsOf(limits = MESSAGE_ORDER_LIMITS) {
  if (!Number.isSafeInteger(limits.maxBindings) || limits.maxBindings < 0 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw unavailable();
  return limits;
}
function byteLength(order) {
  try { return Buffer.byteLength(JSON.stringify(order), 'utf8'); }
  catch { throw unavailable(); }
}
export function parseMessageSequence(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw unavailable();
  const number = BigInt(value);
  if ((!allowZero && number === 0n) || number > MAX_MESSAGE_SEQUENCE) throw unavailable();
  return number;
}

function inspectSidecar(order, ownerId, limits) {
  exactKeys(order, ['version', 'owner_id', 'groups']);
  if (order.version !== MESSAGE_ORDER_VERSION || order.owner_id !== identity(ownerId) || !Array.isArray(order.groups)) throw unavailable();
  const bytes = byteLength(order);
  if (bytes > limits.maxBytes) throw capacity();
  const groups = new Map(), bindings = new Map();
  for (const group of order.groups) {
    exactKeys(group, ['group_id', 'generation', 'next_sequence', 'bindings']);
    const id = identity(group.group_id);
    if (groups.has(id) || typeof group.generation !== 'string' || !uuid.test(group.generation) || !Array.isArray(group.bindings)) throw unavailable();
    const next = parseMessageSequence(group.next_sequence), used = new Set();
    for (const binding of group.bindings) {
      exactKeys(binding, ['message_id', 'sequence'], ['creation_intent_hash']);
      const messageId = identity(binding.message_id), sequence = parseMessageSequence(binding.sequence);
      if (bindings.has(messageId) || used.has(binding.sequence) || sequence >= next) throw unavailable();
      if (own(binding, 'creation_intent_hash') && (typeof binding.creation_intent_hash !== 'string' || !digest.test(binding.creation_intent_hash))) throw unavailable();
      used.add(binding.sequence);
      bindings.set(messageId, { groupId: id, sequence: binding.sequence, creationIntentHash: binding.creation_intent_hash });
      if (bindings.size > limits.maxBindings) throw capacity();
    }
    groups.set(id, { generation: group.generation, nextSequence: next });
  }
  return { groups, bindings, bytes };
}

function inspectBusiness(data, ownerId) {
  if (!record(data) || !Array.isArray(data.groups) || !Array.isArray(data.messages)) throw unavailable();
  identity(ownerId);
  const groups = new Map(), messages = new Map();
  for (const group of data.groups) {
    if (!record(group)) throw unavailable();
    const id = identity(group.id);
    if (groups.has(id) || (own(group, 'owner_user_id') && group.owner_user_id !== ownerId)) throw unavailable();
    groups.set(id, group);
  }
  for (const message of data.messages) {
    if (!record(message)) throw unavailable();
    const id = identity(message.id); identity(message.group_id);
    if (messages.has(id) || (own(message, 'owner_user_id') && message.owner_user_id !== ownerId)) throw unavailable();
    messages.set(id, message);
  }
  return { groups, messages };
}

// Returned Maps contain detached identity metadata only, never mutable records.
export function validateMessageOrder(data, ownerId, { limits } = {}) {
  const budget = limitsOf(limits), business = inspectBusiness(data, ownerId);
  const index = inspectSidecar(data.message_order, ownerId, budget);
  for (const id of business.groups.keys()) if (!index.groups.has(id)) throw unavailable();
  for (const [id, message] of business.messages) {
    const binding = index.bindings.get(id);
    if (!binding || binding.groupId !== message.group_id) throw unavailable();
  }
  return index;
}

// Offline migration only: do not call a loader or a source-reading helper here.
// Legacy ID/time/content/metadata/receipts and physical array order stay intact.
export function buildLegacyMessageOrder(data, ownerId, { generationForGroup, limits } = {}) {
  if (!record(data) || own(data, 'message_order') || typeof generationForGroup !== 'function') throw unavailable();
  const business = inspectBusiness(data, ownerId), groupIds = [...business.groups.keys()], seenGroups = new Set(groupIds);
  for (const message of business.messages.values()) if (!seenGroups.has(message.group_id)) {
    seenGroups.add(message.group_id); groupIds.push(message.group_id);
  }
  const order = { version: MESSAGE_ORDER_VERSION, owner_id: ownerId, groups: [] };
  const byGroup = new Map(groupIds.map(id => [id, []]));
  for (let index = 0; index < data.messages.length; index++) {
    const message = data.messages[index];
    // An unspecified local timezone cannot produce a reproducible migration.
    const time = typeof message.created_at === 'string' && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(message.created_at)
      ? Date.parse(message.created_at) : NaN;
    if (!Number.isFinite(time)) throw unavailable();
    byGroup.get(message.group_id).push({ message, index, time });
  }
  for (const id of groupIds) {
    const sorted = byGroup.get(id).sort((a, b) => a.time - b.time || a.index - b.index);
    const group = { group_id: id, generation: generationForGroup(id), next_sequence: String(BigInt(sorted.length) + 1n),
      bindings: sorted.map(({ message }, index) => ({ message_id: message.id, sequence: String(index + 1) })) };
    order.groups.push(group);
  }
  validateMessageOrder({ ...data, message_order: order }, ownerId, { limits });
  return order;
}

export function initializeNewAccountOrder(data, ownerId, options) {
  if (!Array.isArray(data?.messages) || data.messages.length !== 0) throw unavailable();
  const order = buildLegacyMessageOrder(data, ownerId, options);
  return { ...structuredClone(data), message_order: order };
}

export function prepareOrderedGroup(data, ownerId, group, { generation, limits } = {}) {
  const index = validateMessageOrder(data, ownerId, { limits });
  if (!record(group)) throw unavailable();
  const id = identity(group.id);
  if (index.groups.has(id)) throw boundId();
  const candidate = structuredClone(data);
  candidate.groups.push(structuredClone(group));
  candidate.message_order.groups.push({ group_id: id, generation, next_sequence: '1', bindings: [] });
  const after = validateMessageOrder(candidate, ownerId, { limits });
  assertPreservedIndexes(index, after, data, candidate);
  return candidate;
}

export function prepareOrderedAppend(data, ownerId, message, { creationIntentHash, limits } = {}) {
  const index = validateMessageOrder(data, ownerId, { limits });
  if (!record(message) || typeof creationIntentHash !== 'string' || !digest.test(creationIntentHash)) throw unavailable();
  const id = identity(message.id), groupId = identity(message.group_id);
  if (index.bindings.has(id)) throw boundId();
  // An orphan/deleted group's retained order metadata is never write authority.
  if (!data.groups.some(group => group.id === groupId)) throw unavailable();
  const group = index.groups.get(groupId);
  if (!group || group.nextSequence >= MAX_MESSAGE_SEQUENCE) throw capacity();
  const candidate = structuredClone(data), sequence = String(group.nextSequence);
  candidate.messages.push(structuredClone(message));
  const order = candidate.message_order.groups.find(row => row.group_id === groupId);
  order.bindings.push({ message_id: id, sequence, creation_intent_hash: creationIntentHash });
  order.next_sequence = String(group.nextSequence + 1n);
  const after = validateMessageOrder(candidate, ownerId, { limits });
  assertPreservedIndexes(index, after, data, candidate);
  return { data: candidate, serverOrder: { generation: group.generation, sequence } };
}

// Normal writes cannot erase tombstones, renumber, or switch generations.
// Explicit offline restore is a separate operation and does not use this gate.
export function assertMessageOrderPreserved(previous, candidate, ownerId, { limits } = {}) {
  const before = validateMessageOrder(previous, ownerId, { limits });
  const after = validateMessageOrder(candidate, ownerId, { limits });
  assertPreservedIndexes(before, after, previous, candidate);
  return after;
}

function assertPreservedIndexes(before, after, previous, candidate) {
  for (const [id, group] of before.groups) {
    const next = after.groups.get(id);
    if (!next || next.generation !== group.generation || next.nextSequence < group.nextSequence) throw unavailable();
  }
  for (const [id, binding] of before.bindings) {
    const next = after.bindings.get(id);
    if (!next || next.groupId !== binding.groupId || next.sequence !== binding.sequence || next.creationIntentHash !== binding.creationIntentHash) throw unavailable();
  }
  const previousGroupIds = new Set(previous.groups.map(group => group.id));
  const newGroupIds = new Set(candidate.groups.map(group => group.id));
  for (const id of after.groups.keys()) {
    if (!before.groups.has(id) && !newGroupIds.has(id)) throw unavailable();
    if (before.groups.has(id) && !previousGroupIds.has(id) && newGroupIds.has(id)) throw unavailable();
  }
  const previousMessages = new Map(previous.messages.map(message => [message.id, message]));
  const liveIds = new Set(candidate.messages.map(message => message.id));
  for (const message of candidate.messages) {
    if (!before.bindings.has(message.id)) continue;
    const old = previousMessages.get(message.id);
    if (!old) throw unavailable();
    if ((old.deleted_at || old.is_deleted) && !(message.deleted_at || message.is_deleted)) throw unavailable();
  }
  for (const [id, binding] of after.bindings) {
    if (before.bindings.has(id)) continue;
    if (!liveIds.has(id) || !newGroupIds.has(binding.groupId)) throw unavailable();
    const oldGroup = before.groups.get(binding.groupId);
    if (oldGroup && parseMessageSequence(binding.sequence) < oldGroup.nextSequence) throw unavailable();
  }
}

export function projectMessageOrder(message, index) {
  const binding = index?.bindings?.get(message?.id), group = index?.groups?.get(message?.group_id);
  if (!binding || !group || binding.groupId !== message.group_id) throw unavailable();
  return { ...structuredClone(message), server_order: { generation: group.generation, sequence: binding.sequence } };
}
