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

export const memoryApi = {
  async list(offset = 0): Promise<{ total: number; offset: number; memories: MemoryRecord[] }> {
    const { data } = await axiosInstance.get('/memory', { params: { limit: 100, offset } });
    return data;
  },
  async store(content: string, key: string): Promise<void> {
    await axiosInstance.post('/memory/store', { content, category: 'note' },
      { headers: { 'Idempotency-Key': key } });
  },
  async correct(id: string, content: string, expectedRevision: number): Promise<void> {
    await axiosInstance.post(`/memory/${encodeURIComponent(id)}/correct`,
      { content, expectedRevision });
  },
  async forget(id: string): Promise<void> {
    await axiosInstance.post(`/memory/${encodeURIComponent(id)}/forget`, {});
  },
};
