import { axiosInstance } from './api';

export interface MemoryRecord {
  id: string;
  content: string;
  category: string;
  kind: 'user_note' | 'message_quote';
  evidence: 'user_asserted' | 'source_quote_unverified';
  confirmedFact: false;
  source: { type: string; id: string; groupId: string } | null;
  revision: number;
  recordedAt: string;
}

function record(value: MemoryRecord): MemoryRecord {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.content !== 'string' ||
    !['user_note', 'message_quote'].includes(value.kind) || !Number.isSafeInteger(value.revision) ||
    value.revision < 0 || typeof value.recordedAt !== 'string') throw new Error('记忆回执格式未确认');
  return value;
}
const headers = (userId: string) => ({ 'X-Expected-User-Id': userId });

export const memoryApi = {
  async list(offset: number, userId: string): Promise<{ total: number; offset: number; memories: MemoryRecord[] }> {
    const { data } = await axiosInstance.get('/memory', { params: { limit: 100, offset }, headers: headers(userId) });
    if (!Number.isSafeInteger(data.total) || data.total < 0 || data.offset !== offset || !Array.isArray(data.memories)) {
      throw new Error('记忆列表格式未确认');
    }
    return { ...data, memories: data.memories.map(record) };
  },
  async get(id: string, userId: string): Promise<MemoryRecord> {
    const { data } = await axiosInstance.get(`/memory/${encodeURIComponent(id)}`, { headers: headers(userId) });
    const memory = record(data.memory);
    if (memory.id !== id) throw new Error('记忆回执对象未确认');
    return memory;
  },
  async store(content: string, key: string, userId: string): Promise<MemoryRecord> {
    const { data } = await axiosInstance.post('/memory/store', { content, category: 'note' },
      { headers: { ...headers(userId), 'Idempotency-Key': key } });
    const memory = record(data.memory);
    if (memory.id !== data.memoryId || memory.kind !== 'user_note' || memory.content !== content) {
      throw new Error('保存回执内容未确认');
    }
    return memory;
  },
  async correct(id: string, content: string, expectedRevision: number, userId: string): Promise<MemoryRecord> {
    const { data } = await axiosInstance.post(`/memory/${encodeURIComponent(id)}/correct`,
      { content, expectedRevision }, { headers: headers(userId) });
    const memory = record(data.memory);
    if (memory.id !== id || memory.content !== content || memory.revision !== expectedRevision + 1) {
      throw new Error('更正回执内容未确认');
    }
    return memory;
  },
  async forget(id: string, userId: string): Promise<void> {
    const { data } = await axiosInstance.post(`/memory/${encodeURIComponent(id)}/forget`, {}, { headers: headers(userId) });
    if (data.memoryId !== id || data.forgotten !== true) throw new Error('遗忘回执未确认');
  },
};
