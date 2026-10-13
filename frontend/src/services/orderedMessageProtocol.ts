import type { Message, MessageOrder, OrderedMessagesQuery, OrderedMessagesResponse } from '../../../shared/contracts';

const MAX_SEQUENCE = 9223372036854775807n;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function protocolError(message = '消息排序数据无法核验，请重新读取历史') {
  return Object.assign(new Error(message), { code: 'INVALID_MESSAGE_ORDER_SCHEMA', status: 503 });
}
export function validSequence(value: unknown, allowZero = false): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && (allowZero || value !== '0') && BigInt(value) <= MAX_SEQUENCE;
}
export function validMessageOrder(value: unknown): value is MessageOrder {
  return record(value) && typeof value.generation === 'string' && UUID_V4.test(value.generation) && validSequence(value.sequence);
}
export function compareSequence(a: string, b: string): number { return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0; }
export function sortOrderedMessages(messages: Message[]): Message[] {
  // Stable sort leaves previews/outbox in their independent arrival order at the tail.
  return [...messages].sort((a, b) => {
    const ac = a.confirmation === 'confirmed' && validMessageOrder(a.server_order);
    const bc = b.confirmation === 'confirmed' && validMessageOrder(b.server_order);
    return ac && bc ? compareSequence(a.server_order!.sequence, b.server_order!.sequence) : ac ? -1 : bc ? 1 : 0;
  });
}
export function validOrderedMessage(value: unknown, group: string, generation?: string): value is Message {
  return record(value) && typeof value.id === 'string' && value.id.length > 0 && value.group_id === group &&
    ['user', 'ai', 'system'].includes(value.sender_type as string) && typeof value.content === 'string' &&
    ['text', 'code', 'file', 'system'].includes(value.content_type as string) &&
    typeof value.created_at === 'string' && value.created_at.length > 0 && Number.isFinite(Date.parse(value.created_at)) &&
    validMessageOrder(value.server_order) && (!generation || value.server_order.generation === generation);
}

export interface OrderedCursor { v: 1; owner: string; group: string; generation: string; kind: 'before' | 'after'; at: string; until?: string }
export function decodeOrderedCursor(token: unknown, owner: string, group: string, kind: OrderedCursor['kind']): OrderedCursor {
  if (typeof token !== 'string' || token.length === 0 || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw protocolError();
  try {
    const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const cursor = JSON.parse(raw);
    if (!record(cursor) || cursor.v !== 1 || cursor.owner !== owner || cursor.group !== group || cursor.kind !== kind ||
      typeof cursor.generation !== 'string' || !UUID_V4.test(cursor.generation) || !validSequence(cursor.at, kind === 'after') ||
      (kind === 'before' && !own(cursor, 'until')) || (own(cursor, 'until') && (!validSequence(cursor.until, true) || BigInt(cursor.at) > BigInt(cursor.until)))) throw protocolError();
    const canonical = JSON.stringify({ v: 1, owner, group, generation: cursor.generation, kind, at: cursor.at, ...(own(cursor, 'until') ? { until: cursor.until } : {}) });
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(canonical))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (canonical !== raw || encoded !== token) throw protocolError();
    return cursor as unknown as OrderedCursor;
  } catch { throw protocolError(); }
}

export function validateOrderedMessagesPage(value: unknown, context: OrderedMessagesQuery & { owner: string; group: string }): OrderedMessagesResponse {
  if (!record(value) || !['messages', 'hasMore', 'order', 'generation', 'high_watermark', 'consumed_through', 'before_cursor', 'after_cursor'].every(key => own(value, key)) ||
    value.order !== 'sequence_v1' || typeof value.hasMore !== 'boolean' || typeof value.generation !== 'string' || !UUID_V4.test(value.generation) ||
    !validSequence(value.high_watermark, true) || !Array.isArray(value.messages) || value.messages.length > (context.limit ?? 50) ||
    !(value.before_cursor === null || typeof value.before_cursor === 'string') || !(value.after_cursor === null || typeof value.after_cursor === 'string')) throw protocolError();
  if (context.before_cursor !== undefined && context.after_cursor !== undefined) throw protocolError();
  const kind = context.before_cursor !== undefined ? 'before' : context.after_cursor !== undefined ? 'after' : 'bootstrap';
  const requested = kind === 'bootstrap' ? null : decodeOrderedCursor(kind === 'before' ? context.before_cursor : context.after_cursor, context.owner, context.group, kind);
  const H = value.high_watermark;
  if (requested && (requested.generation !== value.generation || BigInt(requested.at) > BigInt(H) || (requested.until !== undefined && requested.until !== H))) throw protocolError();
  const ids = new Set<string>(); let previous: string | undefined;
  for (const row of value.messages) {
    if (!validOrderedMessage(row, context.group, value.generation) || ids.has(row.id) || BigInt(row.server_order!.sequence) > BigInt(H) ||
      (previous !== undefined && compareSequence(previous, row.server_order!.sequence) >= 0) ||
      (requested && (kind === 'before' ? compareSequence(row.server_order!.sequence, requested.at) >= 0 : compareSequence(row.server_order!.sequence, requested.at) <= 0))) throw protocolError();
    ids.add(row.id); previous = row.server_order!.sequence;
  }
  const first = (value.messages[0] as Message | undefined)?.server_order?.sequence;
  const last = (value.messages[value.messages.length - 1] as Message | undefined)?.server_order?.sequence;
  const checkCursor = (token: unknown, direction: 'before' | 'after', at: string, until?: string) => {
    const cursor = decodeOrderedCursor(token, context.owner, context.group, direction);
    if (cursor.generation !== value.generation || cursor.at !== at || cursor.until !== until) throw protocolError();
  };
  if (kind === 'before') {
    if (value.consumed_through !== null || value.after_cursor !== null) throw protocolError();
  } else {
    const expectedC = kind === 'after' && value.hasMore ? last : H;
    if (!expectedC || value.consumed_through !== expectedC) throw protocolError();
    checkCursor(value.after_cursor, 'after', expectedC, kind === 'after' && value.hasMore ? H : undefined);
  }
  if (kind === 'after') {
    if (value.before_cursor !== null || (value.hasMore && (!last || compareSequence(last, H) >= 0))) throw protocolError();
  } else if (value.hasMore) {
    if (!first) throw protocolError();
    checkCursor(value.before_cursor, 'before', first, H);
  } else if (value.before_cursor !== null) throw protocolError();
  return value as unknown as OrderedMessagesResponse;
}

/** Seconds or an IMF-fixdate only. Invalid/absent headers never cancel normal backoff. */
export function retryAfterMilliseconds(value: unknown, now: number): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^(0|[1-9][0-9]*)$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds * 1000 : undefined;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  if (!Number.isFinite(date) || new Date(date).toUTCString() !== value) return undefined;
  return Math.max(0, date - now);
}
