import { axiosInstance } from './api';
import type { ModelProbeRequest } from '../../../shared/modelProbes';

// The transport retains the initiating request ID even when the provider times out.
// Recovery never creates a fresh ID. A confirmed 404 may be explicitly resubmitted
// with its frozen revision; an existing unknown receipt stays query-only.
import type { ModelProbeCapability, ModelProbeReceipt } from './modelProbeReceipt';
export type { ModelProbeCapability, ModelProbeReceipt } from './modelProbeReceipt';
export { probeReceipt } from './modelProbeReceipt';
export const MODEL_PROBE_TIMEOUT_MS = 60000; // Vision makes two bounded 20-second calls.
export const probeKey = (modelId: string, capability: ModelProbeCapability) => `${modelId}:${capability}`;
export const probeUnresolved = (receipt: ModelProbeReceipt) => receipt.status === 'running' || receipt.status === 'unknown';
export async function startModelProbe(user: string | null, modelId: string, capability: ModelProbeCapability, requestId: string, expectedRevision: number) {
  const payload: ModelProbeRequest = { modelId, capability, clientRequestId: requestId, expectedRevision };
  const { data } = await axiosInstance.post('/user/model-catalog/test', payload, {
    timeout: MODEL_PROBE_TIMEOUT_MS,
    headers: { 'Idempotency-Key': requestId, 'X-Expected-User-Id': user || '' },
  });
  return data;
}
export async function readModelProbe(user: string | null, requestId: string) {
  const { data } = await axiosInstance.get(`/user/model-catalog/tests/${encodeURIComponent(requestId)}`, {
    headers: { 'X-Expected-User-Id': user || '' },
  });
  return data;
}
