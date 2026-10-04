import { axiosInstance } from './api';

export interface PersonalGoalInput {
  outcome: string;
  constraints: string[];
  checks: Array<{ key: string; description: string; required: boolean }>;
  budgetLimitMicros: string;
}

export interface PersonalGoal {
  id: string;
  outcome: string;
  constraints: string[];
  budget_limit_micros: string;
  budget_reserved_micros: string;
  budget_spent_micros: string;
  state: 'active' | 'paused' | 'completed' | 'cancelled';
  revision: number | string;
  created_at: string;
}

export interface PersonalGoalCheck {
  check_key: string;
  description: string;
  required: boolean;
}

export interface PersonalGoalRun {
  id: string;
  goal_id?: string;
  state: 'queued' | 'running' | 'waiting' | 'paused' | 'reconciling' | 'completed' | 'failed' | 'cancelled';
  goal_revision: number | string;
  revision: number | string;
  wait_reason: string | null;
  created_at: string;
}

export interface PersonalRunDetail {
  run: PersonalGoalRun;
  steps: Array<{ step_key: string; action: string; state: string; attempts: number; max_attempts: number; result_ref: string | null }>;
  effects: Array<{ step_key: string; state: string; receipt: unknown }>;
  checks: Array<{ check_key: string; state: 'pending' | 'passed' | 'failed'; artifact_id: string | null; artifact_revision: number | string | null }>;
  executionAvailable: boolean;
}

export interface PersonalGoalDetail {
  goal: PersonalGoal;
  checks: PersonalGoalCheck[];
  runs: PersonalGoalRun[];
  executionAvailable: boolean;
}

export interface PersonalRunInput {
  steps: Array<{ key: string; action: string; inputRefs: string[]; maxAttempts: number }>;
}

export interface PersonalGoalBrief {
  artifactId: string;
  revision: number;
  content: string;
  contentHash: string;
  source: { goalId: string; goalRevision: number; runId: string; stepKey: string };
}

export interface PersonalBriefRequest {
  runId: string;
  artifactId: string | null;
  runState: PersonalGoalRun['state'];
  replayed: boolean;
  advancement: { state: string; advanced: boolean };
  executionAvailable: false;
  briefExecutionAvailable: true;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function buildPersonalGoalInput(outcome: string, constraintsText: string, checksText: string): PersonalGoalInput {
  const result = outcome.trim();
  const constraints = lines(constraintsText);
  const descriptions = lines(checksText);
  if (!result || result.length > 10000) throw new Error('目标结果需在 1–10000 字内');
  if (constraints.length > 100 || constraints.some(item => item.length > 2000)) throw new Error('最多 100 条约束，每条不超过 2000 字');
  if (!descriptions.length || descriptions.length > 50 || descriptions.some(item => item.length > 2000)) {
    throw new Error('请填写 1–50 条明确的验收条件，每条不超过 2000 字');
  }
  return {
    outcome: result,
    constraints,
    checks: descriptions.map((description, index) => ({ key: `check-${index + 1}`, description, required: true })),
    budgetLimitMicros: '0',
  };
}

export function buildPersonalRunInput(stepsText: string): PersonalRunInput {
  const actions = lines(stepsText);
  if (!actions.length || actions.length > 100 || actions.some(action => action.length > 2000)) {
    throw new Error('请填写 1–100 个步骤，每步不超过 2000 字');
  }
  return { steps: actions.map((action, index) => ({ key: `step-${index + 1}`, action, inputRefs: [], maxAttempts: 1 })) };
}

export function retainSubmissionKey(
  previous: { payload: string; key: string } | null,
  payload: unknown,
  newKey: () => string = () => crypto.randomUUID()
): { payload: string; key: string } {
  const serialized = JSON.stringify(payload);
  if (previous && previous.payload !== serialized) {
    throw new Error('上次提交结果仍需核对。请恢复原内容重试，或刷新列表核对后明确开始新提交。');
  }
  return previous || { payload: serialized, key: newKey() };
}

export const personalGoalsApi = {
  async list(): Promise<{ goals: PersonalGoal[]; executionAvailable: boolean }> {
    const response = await axiosInstance.get('/goals');
    return response.data;
  },
  async create(input: PersonalGoalInput, requestKey: string): Promise<{ goalId: string; replayed?: boolean; executionAvailable: boolean }> {
    const response = await axiosInstance.post('/goals', input, { headers: { 'Idempotency-Key': requestKey } });
    return response.data;
  },
  async detail(goalId: string): Promise<PersonalGoalDetail> {
    const response = await axiosInstance.get(`/goals/${encodeURIComponent(goalId)}`);
    return response.data;
  },
  async createRun(goalId: string, input: PersonalRunInput, requestKey: string): Promise<{ runId: string; replayed?: boolean; executionAvailable: boolean }> {
    const response = await axiosInstance.post(`/goals/${encodeURIComponent(goalId)}/runs`, input, { headers: { 'Idempotency-Key': requestKey } });
    return response.data;
  },
  async createBrief(goalId: string, requestKey: string): Promise<PersonalBriefRequest> {
    const response = await axiosInstance.post(
      `/goals/${encodeURIComponent(goalId)}/briefs`, {},
      { headers: { 'Idempotency-Key': requestKey } }
    );
    return response.data;
  },
  async readBrief(goalId: string, runId: string): Promise<PersonalGoalBrief> {
    const response = await axiosInstance.get(
      `/goals/${encodeURIComponent(goalId)}/runs/${encodeURIComponent(runId)}/brief`
    );
    return response.data;
  },
  async runDetail(goalId: string, runId: string): Promise<PersonalRunDetail> {
    const response = await axiosInstance.get(`/goals/${encodeURIComponent(goalId)}/runs/${encodeURIComponent(runId)}`);
    return response.data;
  },
  async transitionRun(goalId: string, runId: string, action: 'pause' | 'resume' | 'cancel', requestKey: string): Promise<unknown> {
    const response = await axiosInstance.post(
      `/goals/${encodeURIComponent(goalId)}/runs/${encodeURIComponent(runId)}/${action}`,
      {},
      { headers: { 'Idempotency-Key': requestKey } }
    );
    return response.data;
  },
  async complete(goalId: string, runId: string, requestKey: string): Promise<unknown> {
    const response = await axiosInstance.post(
      `/goals/${encodeURIComponent(goalId)}/complete`,
      { runId },
      { headers: { 'Idempotency-Key': requestKey } }
    );
    return response.data;
  },
};
