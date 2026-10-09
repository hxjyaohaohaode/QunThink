/** Paid synthetic model-capability probes. Unknown outcomes are query-only. */
export type ModelProbeCapability = 'chat' | 'vision' | 'tts'

export interface ModelProbeReceipt {
  /** Canonical UUID, including when the submitted UUID was deduplicated. */
  requestId: string
  modelId: string
  capability: ModelProbeCapability
  status: 'running' | 'succeeded' | 'failed' | 'unknown'
  /** Only true when this probe still verifies the current model configuration. */
  healthy: boolean
  stale: boolean
  /** May have been dispatched/charged; false is not a provider billing receipt. */
  possibleCharge: boolean
  replayed: boolean
  responseTime?: number
  code?: 'PROBE_UNKNOWN' | 'PROBE_FAILED' | 'PROBE_REJECTED' | 'PROBE_NOT_SENT' | 'PROBE_STALE' | 'PROBE_CONFIG_CHANGED' | 'PROBE_STORAGE_UNCERTAIN'
  error?: string
}

export interface ModelProbeRequest {
  clientRequestId: string
  modelId: string
  capability: ModelProbeCapability
  /** Capture before sending; replay the same value with the same UUID. */
  expectedRevision?: number
}
