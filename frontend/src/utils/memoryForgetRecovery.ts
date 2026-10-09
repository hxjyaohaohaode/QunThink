// Durable command metadata is separate from optional private-content caches.
// These entries contain no note text, category, source, draft, or credential.
export interface MemoryForgetReceipt {
  version: 1;
  accountId: string;
  memoryId: string;
  startedAt: string;
  state: 'pending' | 'confirmed';
  confirmedAt?: string;
}
export const MEMORY_FORGET_PREFIX = 'qunthink_memory_forget_v1:';
const LIMIT = 512;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const prefix = (accountId: string) => `${MEMORY_FORGET_PREFIX}${encodeURIComponent(accountId)}:`;
const keyFor = (accountId: string, memoryId: string) => `${prefix(accountId)}${encodeURIComponent(memoryId)}`;
const unavailable = () => new Error('设备上的遗忘请求记录无法读取或保存，请恢复此浏览器的存储后重试。');

export function parseMemoryForgetReceipt(accountId: string, key: string, raw: string | null): MemoryForgetReceipt {
  try {
    if (!validId(accountId) || !key.startsWith(prefix(accountId)) || !raw || raw.length > 2048) throw unavailable();
    const value = JSON.parse(raw) as MemoryForgetReceipt;
    if (!value || Object.keys(value).sort().join(',') !== (value.state === 'confirmed' ? 'accountId,confirmedAt,memoryId,startedAt,state,version' : 'accountId,memoryId,startedAt,state,version') ||
      value.version !== 1 || !['pending', 'confirmed'].includes(value.state) || (value.state === 'confirmed' && (typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt)))) || value.accountId !== accountId || !validId(value.memoryId) ||
      keyFor(accountId, value.memoryId) !== key || typeof value.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.startedAt))) throw unavailable();
    return value;
  } catch { throw unavailable(); }
}

export function getMemoryForgetReceipt(accountId: string, memoryId: string): MemoryForgetReceipt | null {
  if (!validId(accountId) || !validId(memoryId)) throw unavailable();
  try {
    const key = keyFor(accountId, memoryId), raw = localStorage.getItem(key);
    return raw === null ? null : parseMemoryForgetReceipt(accountId, key, raw);
  } catch { throw unavailable(); }
}

export function readMemoryForgetReceipts(accountId: string): MemoryForgetReceipt[] {
  if (!validId(accountId)) throw unavailable();
  try {
    const result: MemoryForgetReceipt[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix(accountId))) continue;
      result.push(parseMemoryForgetReceipt(accountId, key, localStorage.getItem(key)));
    }
    return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.memoryId.localeCompare(b.memoryId));
  } catch { throw unavailable(); }
}

export function rememberMemoryForget(accountId: string, memoryId: string): MemoryForgetReceipt {
  if (!validId(memoryId)) throw unavailable();
  const receipts = readMemoryForgetReceipts(accountId);
  const existing = receipts.find(receipt => receipt.memoryId === memoryId);
  if (existing) return existing;
  if (receipts.filter(receipt => receipt.state === 'pending').length >= LIMIT) throw new Error('待核验遗忘请求已达设备上限，请先核对已有请求。');
  const receipt: MemoryForgetReceipt = { version: 1, accountId, memoryId, startedAt: new Date().toISOString(), state: 'pending' };
  const key = keyFor(accountId, memoryId), serialized = JSON.stringify(receipt);
  try {
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw unavailable();
  } catch { throw unavailable(); }
  return receipt;
}

// Call only after the actual memory API has verified this ID's forgotten:true
// response. Retain a content-free confirmed barrier: deleting the key would let
// another tab's pre-forget response publish before queued storage events arrive.
// Confirmed IDs do not consume pending-command admission capacity.
export function confirmMemoryForget(accountId: string, memoryId: string): void {
  if (!validId(accountId) || !validId(memoryId)) throw unavailable();
  try {
    const previous = readMemoryForgetReceipts(accountId).find(receipt => receipt.memoryId === memoryId);
    if (previous?.state === 'confirmed') return;
    const now = new Date().toISOString();
    const receipt: MemoryForgetReceipt = { version: 1, accountId, memoryId,
      startedAt: previous?.startedAt || now, state: 'confirmed', confirmedAt: now };
    const key = keyFor(accountId, memoryId), serialized = JSON.stringify(receipt);
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw unavailable();
  } catch { throw new Error('服务器已确认遗忘，设备尚未记录完成回执；可继续核对同一记录。'); }
}
