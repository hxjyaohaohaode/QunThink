import type { ModelProbeReceipt } from '../../../shared/modelProbes';
export type { ModelProbeCapability, ModelProbeReceipt } from '../../../shared/modelProbes';

const safeErrors = {
  PROBE_UNKNOWN: '测试可能已执行或计费，但结果无法确认；请查询原请求并核对服务商记录',
  PROBE_FAILED: '服务商已返回，但本次能力测试未通过；请检查模型与能力声明',
  PROBE_REJECTED: '服务商拒绝了测试，请检查凭据、模型、参数或额度',
  PROBE_NOT_SENT: '测试在发送前停止，尚未验证该能力',
  PROBE_STALE: '配置已变化，本次测试不能验证当前配置',
  PROBE_CONFIG_CHANGED: '配置版本已改变，原请求未发出新的测试调用；请刷新后重新确认',
  PROBE_STORAGE_UNCERTAIN: '测试记录暂时无法可靠读取或保存，请查询原请求',
} as const;

// Shared by the transport and its error interceptor. Return a new, allowlisted
// object: never retain raw provider bodies, headers, credentials or error text.
export function probeReceipt(value: unknown): ModelProbeReceipt | null {
  const data = value as Partial<ModelProbeReceipt> | null;
  if (!data || typeof data !== 'object' || typeof data.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.requestId) ||
      typeof data.modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(data.modelId) ||
      !['chat', 'vision', 'tts'].includes(data.capability || '') ||
      !['running', 'succeeded', 'failed', 'unknown'].includes(data.status || '') ||
      typeof data.healthy !== 'boolean' || typeof data.stale !== 'boolean' ||
      typeof data.possibleCharge !== 'boolean' || typeof data.replayed !== 'boolean') return null;
  const code = data.code && Object.prototype.hasOwnProperty.call(safeErrors, data.code) ? data.code as keyof typeof safeErrors : undefined;
  return {
    requestId: data.requestId, modelId: data.modelId, capability: data.capability!, status: data.status!,
    healthy: data.status === 'succeeded' && !data.stale && data.healthy,
    stale: data.stale, possibleCharge: data.possibleCharge, replayed: data.replayed,
    ...(typeof data.responseTime === 'number' && Number.isFinite(data.responseTime) && data.responseTime >= 0 ? { responseTime: data.responseTime } : {}),
    ...(code ? { code, error: safeErrors[code] } : data.status === 'failed' ? { error: safeErrors.PROBE_FAILED } : {}),
  };
}
