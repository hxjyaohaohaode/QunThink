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
  /** Generation brief belongs to a changed/revoked source; explicitly review/update it before another run. */
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
  result_editor_available?: boolean;
  result_head_version_id?: string | null;
  result_accepted_version_id?: string | null;
  /** Current linked source no longer matches the current result version (including manual-only documents). */
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

/** A document remains part of its original Task and conversation. */
export type TaskResultSourceStatus = 'current' | 'changed' | 'blocked';
export interface TaskResultSourceRef {
  id: string; revision: number | null; edited_at: string | null;
}
export interface TaskResultVersion {
  id: string;
  sequence: number;
  kind: 'generated' | 'manual';
  parent_version_id: string | null;
  run_id: string | null;
  content: string;
  content_hash: string;
  created_at: string;
  source_hash: string | null;
  source_messages: TaskResultSourceRef[];
  source_status: TaskResultSourceStatus;
  /** No content is returned while a source or permission is revoked. */
  content_hidden: boolean;
}
export interface TaskResultDocument {
  task_id: string; title: string; group_id: string | null;
  revision: number;
  head_version_id: string | null;
  accepted_version_id: string | null;
  accepted_content_hash: string | null;
  accepted_at: string | null;
  versions: TaskResultVersion[];
  source: {
    status: TaskResultSourceStatus;
    hash: string | null;
    messages: Array<TaskResultSourceRef & {
      sender_type: string; content: string; created_at: string;
      change: 'unchanged' | 'changed' | 'added';
    }>;
    missing_message_ids: string[];
    message: string | null;
  };
  generation: {
    status: TaskStatus; run_id: string | null;
    source_input_stale: boolean;
  };
}
export interface TaskResultCommandReceipt {
  id: string;
  operation: 'save' | 'accept' | 'adopt' | 'brief';
  task_id: string;
  version_id: string | null;
  committed_revision: number;
  committed_at: string;
  /** Historical receipt; never infer that the newest version is accepted. */
  status: 'succeeded';
}
export interface TaskResultMutationResponse {
  receipt: TaskResultCommandReceipt;
  document: TaskResultDocument | null;
  task_deleted?: boolean;
}
export interface TaskCreateCommandReceipt {
  status: 'succeeded'; operation: 'create'; client_request_id: string;
  task_id: string; task_deleted: boolean; task: WorkspaceTask | null;
}
export interface SaveTaskResultInput {
  client_request_id: string;
  expected_revision: number;
  base_version_id: string | null;
  content: string;
  /** Only send after explicit review of this exact current source snapshot. */
  reviewed_source_hash?: string | null;
}
export interface AcceptTaskResultVersionInput {
  client_request_id: string;
  expected_revision: number;
  version_id: string;
  content_hash: string;
  source_hash: string | null;
}
export interface AdoptTaskResultVersionInput {
  client_request_id: string;
  expected_revision: number;
  version_id: string;
}
export interface RebaseTaskBriefInput {
  client_request_id: string;
  expected_revision: number;
  prompt: string;
  source_hash: string | null;
}
