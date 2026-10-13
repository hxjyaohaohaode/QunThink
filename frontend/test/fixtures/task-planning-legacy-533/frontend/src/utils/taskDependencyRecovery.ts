import type { UpdateTaskDependenciesInput } from '../../../shared/tasks';
import { getCacheUserId } from './cacheUtils';

// Only relationship IDs and the frozen command are durable. Never store titles,
// prompts, results or another account's projection in this recovery journal.
export interface DependencyIntent { taskId: string; payload: UpdateTaskDependenciesInput }
const prefix = 'qunthink_dependency_command_v1_';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validDependencyIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(id => typeof id === 'string' && uuid.test(id)) && new Set(value).size === value.length;
}
function accountPrefix() {
  const user = getCacheUserId();
  if (!user) throw new Error('请先登录，再修改前置任务');
  return prefix + encodeURIComponent(user) + ':';
}
export function readDependencyIntents(): DependencyIntent[] {
  const start = accountPrefix(), intents: DependencyIntent[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i); if (!key?.startsWith(start)) continue;
      const raw = localStorage.getItem(key); if (raw === null) continue;
      const item = JSON.parse(raw) as DependencyIntent;
      const payload = item?.payload;
      if (Object.keys(item).sort().join(',') !== 'payload,taskId' || !uuid.test(item.taskId) || key !== start + item.taskId + ':' + payload?.client_request_id || !payload || Object.keys(payload).sort().join(',') !== 'client_request_id,dependency_ids,expected_revision' || !uuid.test(payload.client_request_id) || !Number.isSafeInteger(payload.expected_revision) || payload.expected_revision < 0 || !validDependencyIds(payload.dependency_ids)) throw new Error();
      intents.push(item);
    }
    return intents;
  } catch { throw new Error('此设备的前置任务待核验记录无法读取，请保留记录并恢复浏览器存储后重试'); }
}
export function persistDependencyIntent(intent: DependencyIntent) {
  const key = accountPrefix() + intent.taskId + ':' + intent.payload.client_request_id;
  const value = JSON.stringify({ taskId: intent.taskId, payload: { client_request_id: intent.payload.client_request_id, expected_revision: intent.payload.expected_revision, dependency_ids: intent.payload.dependency_ids } });
  try {
    const previous = localStorage.getItem(key);
    if (previous !== null && previous !== value) throw new Error();
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw new Error();
  } catch { throw new Error('尚未发送：无法安全保存前置任务请求编号，请刷新后重试'); }
}
export function removeDependencyIntent(intent: DependencyIntent) {
  const key = accountPrefix() + intent.taskId + ':' + intent.payload.client_request_id;
  // Every request owns its UUID key. Settling it cannot delete another tab's intent.
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null) throw new Error('前置任务已确认，但设备记录尚未移除，请再次核验');
}
