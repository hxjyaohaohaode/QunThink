import { z } from 'zod';

export const TASK_METADATA_LIMITS = Object.freeze({ commands: 10000, estimatedMinutes: 525600 });
export const metadataError = (code, message, status = 409) => Object.assign(new Error(message), {
  code, status, statusCode: status, isOperational: true
});
const storageError = () => metadataError('TASK_METADATA_STORAGE_UNCERTAIN', '任务设置或回执暂时无法核实，请保留原请求编号', 503);
// Optional at command boundaries: injecting defaults into parsed requests
// would change the hash of already-persisted legacy creation/edit intents.
export const taskPriorityInput = z.enum(['low', 'medium', 'high']).nullable();
export const taskEstimatedMinutesInput = z.number().int().min(0).max(TASK_METADATA_LIMITS.estimatedMinutes).nullable();
export function taskPlanningValues(task) {
  const priority = task.priority === undefined ? null : task.priority;
  const estimated_minutes = task.estimated_minutes === undefined ? null : task.estimated_minutes;
  if (!taskPriorityInput.safeParse(priority).success || !taskEstimatedMinutesInput.safeParse(estimated_minutes).success) throw storageError();
  return { priority, estimated_minutes };
}
export const editTaskMetadataInput = z.object({
  client_request_id: z.string().uuid().transform(value => value.toLowerCase()),
  expected_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  changes: z.object({
    title: z.string().trim().min(1).max(150).optional(),
    auto_run: z.boolean().optional(),
    run_at: z.iso.datetime().nullable().optional(),
    priority: taskPriorityInput.optional(),
    estimated_minutes: taskEstimatedMinutesInput.optional()
  }).strict().refine(value => Object.keys(value).length > 0 && Object.values(value).every(item => item !== undefined), { message: '至少修改一项明确的任务设置，字段不可为undefined' })
}).strict();

export function metadataRevision(task) {
  const revision = task.metadata_revision === undefined ? 0 : task.metadata_revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw storageError();
  return revision;
}

// Every writer of these fields shares this counter, including scheduling,
// acceptance, cancellation and restart recovery. Reads never migrate old tasks.
export function advanceTaskMetadataRevisions(db, before) {
  const previous = new Map((before.tasks || []).map(task => [task.id, task]));
  for (const task of db.data.tasks || []) {
    const old = previous.get(task.id);
    if (!old) continue;
    const prior = metadataRevision(old), current = metadataRevision(task);
    if (current !== prior && current !== prior + 1) throw storageError();
    const planning = taskPlanningValues(task), oldPlanning = taskPlanningValues(old);
    const changed = task.title !== old.title || task.auto_run !== old.auto_run || task.run_at !== old.run_at ||
      planning.priority !== oldPlanning.priority || planning.estimated_minutes !== oldPlanning.estimated_minutes;
    if (changed && current === prior) {
      if (prior >= Number.MAX_SAFE_INTEGER) throw storageError();
      task.metadata_revision = prior + 1;
    }
  }
}
