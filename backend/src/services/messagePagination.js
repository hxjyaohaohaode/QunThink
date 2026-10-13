import { MAX_MESSAGE_SEQUENCE, validateMessageOrder, projectMessageOrder } from './messageOrder.js';

// Query cursors are deliberately unsigned. They select an authorized numeric
// boundary; they never grant account/group access or prove client consumption.
export const MESSAGE_PAGE_ORDER = 'sequence_v1';
export const MAX_MESSAGE_CURSOR_LENGTH = 1024;
export const MESSAGE_CURSOR_REQUIRED_TEXT = '消息分页协议已更新，请刷新客户端后继续。刷新前请确认草稿已保存，或复制未发送内容。';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code, status, text) => Object.assign(new Error(text), { code, status, statusCode: status, isOperational: true });
const invalid = () => fail('INVALID_MESSAGE_CURSOR', 400, '消息分页参数无效，请重新读取消息历史');
const reset = () => fail('CURSOR_RESET_REQUIRED', 409, '消息历史版本已变化，请重新读取消息历史');

function sequence(value, allowZero) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw invalid();
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > MAX_MESSAGE_SEQUENCE) throw invalid();
  return parsed;
}
function canonicalCursor(cursor) {
  return JSON.stringify({ v: cursor.v, owner: cursor.owner, group: cursor.group,
    generation: cursor.generation, kind: cursor.kind, at: cursor.at,
    ...(own(cursor, 'until') ? { until: cursor.until } : {}) });
}
function encodeCursor(cursor) {
  const value = Buffer.from(canonicalCursor(cursor), 'utf8').toString('base64url');
  if (value.length > MAX_MESSAGE_CURSOR_LENGTH) throw invalid();
  return value;
}

// Call only after authenticating the request and verifying the URL group is
// currently readable. No value in this decoder is used to open another scope.
function decodeCursor(value, { ownerId, groupId, generation, high, kind }) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_MESSAGE_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  let cursor, decoded;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw invalid();
    decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw invalid();
    cursor = JSON.parse(decoded);
  } catch { throw invalid(); }
  const required = ['v', 'owner', 'group', 'generation', 'kind', 'at'];
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || required.some(key => !own(cursor, key))
    || Object.keys(cursor).some(key => !required.includes(key) && key !== 'until')
    || cursor.v !== 1 || cursor.owner !== ownerId || cursor.group !== groupId
    || cursor.kind !== kind || typeof cursor.generation !== 'string' || !uuid.test(cursor.generation)
    || canonicalCursor(cursor) !== decoded) throw invalid();
  const at = sequence(cursor.at, kind === 'after');
  if (kind === 'before' && !own(cursor, 'until')) throw invalid();
  const until = own(cursor, 'until') ? sequence(cursor.until, true) : null;
  if (until !== null && at > until) throw invalid();
  // A well-formed old generation is a reset, even when a restored snapshot has
  // a lower H. Arbitrary future positions within this generation are invalid.
  if (cursor.generation !== generation) throw reset();
  if (at > high || (until !== null && until > high)) throw invalid();
  return { at, until };
}

// Parse the original URL, not Express's possibly nested/array-coerced query.
// Duplicate URL keys, unknown fields and mixed directions never partially run.
export function parseMessagePageQuery(rawQuery) {
  if (typeof rawQuery !== 'string' || rawQuery.length > 4096) throw invalid();
  const params = new URLSearchParams(rawQuery);
  if (params.has('before') || params.has('after')) {
    throw fail('MESSAGE_CURSOR_REQUIRED', 428, MESSAGE_CURSOR_REQUIRED_TEXT);
  }
  const allowed = new Set(['order', 'limit', 'before_cursor', 'after_cursor']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw invalid();
  const before = params.get('before_cursor'), after = params.get('after_cursor');
  if (before !== null && after !== null) throw invalid();
  if (!params.has('order')) {
    if (before !== null || after !== null) throw invalid();
    return { kind: 'legacy', rawLimit: params.get('limit') };
  }
  if (params.get('order') !== MESSAGE_PAGE_ORDER) throw invalid();
  const rawLimit = params.get('limit');
  if (rawLimit !== null && (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 200)) throw invalid();
  const cursor = before ?? after;
  if (cursor !== null && (cursor.length < 1 || cursor.length > MAX_MESSAGE_CURSOR_LENGTH)) throw invalid();
  return { kind: before !== null ? 'before' : after !== null ? 'after' : 'bootstrap',
    limit: rawLimit === null ? 50 : Number(rawLimit), cursor };
}

// Pure projection of one detached snapshot and its already source-filtered
// messages. It neither sorts stored arrays nor edits original message records.
export function orderedMessagePage({ snapshot, readableMessages, ownerId, groupId, query }) {
  const index = validateMessageOrder(snapshot, ownerId);
  const group = index.groups.get(groupId);
  if (!group) throw fail('MESSAGE_ORDER_UNAVAILABLE', 503, '消息顺序数据不可用，请核验存储后再继续');
  const high = group.nextSequence - 1n;
  const boundary = query.kind === 'bootstrap' ? { at: null, until: high }
    : decodeCursor(query.cursor, { ownerId, groupId, generation: group.generation, high, kind: query.kind });
  const until = boundary.until ?? high;
  const candidates = readableMessages.filter(message => message.group_id === groupId).map(message => {
    const binding = index.bindings.get(message.id);
    if (!binding || binding.groupId !== groupId) throw fail('MESSAGE_ORDER_UNAVAILABLE', 503, '消息顺序数据不可用，请核验存储后再继续');
    return { message, sequence: BigInt(binding.sequence) };
  }).filter(row => row.sequence <= until && (query.kind === 'before' ? row.sequence < boundary.at
    : query.kind === 'after' ? row.sequence > boundary.at : true))
    .sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
  const hasMore = candidates.length > query.limit;
  const rows = query.kind === 'after' ? candidates.slice(0, query.limit) : candidates.slice(-query.limit);
  const cursor = (kind, at, fixed) => encodeCursor({ v: 1, owner: ownerId, group: groupId,
    generation: group.generation, kind, at: String(at), ...(fixed === undefined ? {} : { until: String(fixed) }) });
  const consumed = query.kind === 'before' ? null : query.kind === 'after' && hasMore ? rows.at(-1).sequence : until;
  return {
    // Copy only the bounded response page, not every stored message body.
    messages: rows.map(row => projectMessageOrder(row.message, index)), hasMore, order: MESSAGE_PAGE_ORDER,
    generation: group.generation, high_watermark: String(until), consumed_through: consumed === null ? null : String(consumed),
    before_cursor: query.kind !== 'after' && hasMore && rows.length ? cursor('before', rows[0].sequence, until) : null,
    // A history page cannot replace the caller's independent consumption point.
    after_cursor: query.kind === 'before' ? null : cursor('after', consumed, hasMore && query.kind === 'after' ? until : undefined)
  };
}
