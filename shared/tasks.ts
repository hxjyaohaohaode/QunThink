export type TaskCategory = 'work' | 'social' | 'play';
export type TaskStatus = 'pending' | 'running' | 'needs_review' | 'outcome_unknown' | 'completed' | 'failed' | 'cancelled';
export interface WorkspaceTask {
  id: string;
  title: string;
  prompt: string;
  category: TaskCategory;
  model_id: string | null;
  group_id: string | null;
  status: TaskStatus;
  /** The latest generation attempt. Acceptance must name this exact run. */
  run_id?: string | null;
  /** Present only when the latest generated result was explicitly accepted. */
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
export type TaskCreateInput = Pick<WorkspaceTask, 'title' | 'prompt' | 'category' | 'model_id' | 'group_id' | 'run_at' | 'repeat_minutes' | 'auto_run'>;
