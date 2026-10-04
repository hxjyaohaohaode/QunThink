export type TaskCategory = 'work' | 'social' | 'play';
export type TaskStatus = 'pending' | 'running' | 'needs_review' | 'outcome_unknown' | 'completed' | 'failed' | 'cancelled';
export interface WorkspaceTask {
  id: string;
  /** UUID identifying the original creation intent; reusable only with the same input. */
  client_request_id?: string;
  title: string;
  prompt: string;
  category: TaskCategory;
  model_id: string | null;
  group_id: string | null;
  source_message_id?: string | null;
  source_message_edited_at?: string | null;
  /** Copied task input belongs to a changed/revoked source; create a fresh task. */
  source_input_stale?: boolean;
  status: TaskStatus;
  /** The latest generation attempt. Acceptance must name this exact run. */
  run_id?: string | null;
  run_request_id?: string | null;
  retry_of_run_id?: string | null;
  dispatch_status?: 'not_sent' | 'sent_or_unknown';
  /** Most recently accepted run; compare with result_run_id and run_id for the current result. */
  accepted_run_id?: string | null;
  result_run_id?: string | null;
  result_pending_review?: boolean;
  /** Current linked source no longer matches the run that generated this result. */
  source_stale?: boolean;
  result: string;
  error: string | null;
  run_at: string | null;
  repeat_minutes: number | null;
  auto_run: boolean;
  run_count: number;
  created_at: string;
  updated_at: string;
  history: Array<{
    id: string;
    client_request_id?: string | null;
    retry_of_run_id?: string | null;
    started_at?: string;
    source_stale?: boolean;
    /** Snapshot identities; context_audit records whether any messages were omitted. */
    source_messages?: Array<{ id: string; revision: number | null; edited_at: string | null }>;
    context_audit?: { included?: number; omitted?: number; [key: string]: unknown } | null;
    dispatch_status?: 'not_sent' | 'sent_or_unknown';
    resolution?: 'allow_retry' | 'abandon';
    resolved_at?: string;
    resolved_by?: string;
    accepted_at?: string;
    accepted_by?: string;
    finished_at: string;
    status: string;
    result: string;
    error: string | null;
    model_id?: string | null;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number; source: 'provider_response' } | null;
    usage_status?: 'provider_reported' | 'unknown';
    cost?: null;
  }>;
}
export type TaskCreateInput = Pick<WorkspaceTask, 'title' | 'prompt' | 'category' | 'model_id' | 'group_id' | 'run_at' | 'repeat_minutes' | 'auto_run'> & { client_request_id?: string; source_message_id?: string | null; source_message_edited_at?: string | null };
/** Prefer the Idempotency-Key header. A new UUID means an intentional new generation. */
export interface TaskRunInput { client_request_id?: string }
