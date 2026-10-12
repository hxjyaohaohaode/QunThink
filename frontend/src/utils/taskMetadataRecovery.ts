import type { TaskMetadataChanges, UpdateTaskMetadataInput } from '../../../shared/tasks';
import { getCacheUserId } from './cacheUtils';

/** Necessary recovery identifiers only. Never write a title or schedule here. */
export interface MetadataJournal {
  taskId: string; key: string; revision: number; fields: Array<keyof TaskMetadataChanges>; payloadHash: string; createdAt: string;
}
export interface MetadataIntent extends MetadataJournal { payload?: UpdateTaskMetadataInput }
const prefix = 'qunthink_metadata_command_v1_';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = ['auto_run', 'run_at', 'title'];
export const metadataContentKey = (item: MetadataJournal) => `metadata-intent:${item.taskId}:${item.key}`;
export function canonicalMetadata(payload: UpdateTaskMetadataInput) {
  return JSON.stringify({ client_request_id: payload.client_request_id, expected_revision: payload.expected_revision, changes: Object.fromEntries(Object.entries(payload.changes).sort(([a], [b]) => a.localeCompare(b))) });
}
export function validMetadataChanges(value: unknown): value is TaskMetadataChanges {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>, keys = Object.keys(item);
  return keys.length > 0 && keys.every(key => fields.includes(key)) && (!('title' in item) || typeof item.title === 'string' && item.title.trim().length > 0 && item.title.trim().length <= 150) && (!('auto_run' in item) || typeof item.auto_run === 'boolean') && (!('run_at' in item) || item.run_at === null || typeof item.run_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item.run_at) && Number.isFinite(Date.parse(item.run_at)));
}
function accountPrefix() {
  const owner = getCacheUserId(); if (!owner) throw new Error('请先登录，再修改任务设置');
  return prefix + encodeURIComponent(owner) + ':';
}
export function journalValue(item: MetadataJournal): MetadataJournal {
  return { taskId: item.taskId, key: item.key, revision: item.revision, fields: [...item.fields], payloadHash: item.payloadHash, createdAt: item.createdAt };
}
export function readMetadataJournal(): MetadataJournal[] {
  const start = accountPrefix(), items: MetadataJournal[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i); if (!key?.startsWith(start)) continue;
      const raw = localStorage.getItem(key); if (raw === null) continue;
      const item = JSON.parse(raw) as MetadataJournal;
      if (!item || Object.keys(item).sort().join(',') !== 'createdAt,fields,key,payloadHash,revision,taskId' || !uuid.test(item.taskId) || !uuid.test(item.key) || key !== start + item.taskId + ':' + item.key || !Number.isSafeInteger(item.revision) || item.revision < 0 || !Array.isArray(item.fields) || !item.fields.length || item.fields.some(field => !fields.includes(field)) || new Set(item.fields).size !== item.fields.length || !/^[0-9a-f]{64}$/.test(item.payloadHash) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw new Error();
      items.push(item);
    }
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  } catch { throw new Error('此设备的任务设置待核验记录无法读取。请保留记录并恢复浏览器存储后重试'); }
}
export function persistMetadataJournal(item: MetadataJournal) {
  const key = accountPrefix() + item.taskId + ':' + item.key, raw = JSON.stringify(journalValue(item));
  try {
    const previous = localStorage.getItem(key); if (previous !== null && previous !== raw) throw new Error();
    localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw new Error();
  } catch { throw new Error('尚未发送：无法安全保存任务设置请求编号，请恢复浏览器存储后重试'); }
}
export function removeMetadataJournal(item: MetadataJournal) {
  const key = accountPrefix() + item.taskId + ':' + item.key;
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null) throw new Error('任务设置已确认，但设备记录尚未移除，请再次核验');
}

// The hash/encryption preparation window precedes the durable journal. Other
// stores must also block acceptance during that window, without a store cycle.
const activeMetadata = new Map<string, Set<symbol>>();
export function metadataWorkPending(taskId: string) { return !!activeMetadata.get(`${getCacheUserId()}:${taskId}`)?.size; }
export function beginMetadataWork(taskId: string) {
  const key = `${getCacheUserId()}:${taskId}`, token = Symbol(), group = activeMetadata.get(key) || new Set<symbol>();
  group.add(token); activeMetadata.set(key, group);
  return () => { group.delete(token); if (!group.size && activeMetadata.get(key) === group) activeMetadata.delete(key); };
}
export function clearMetadataWork() { activeMetadata.clear(); }
