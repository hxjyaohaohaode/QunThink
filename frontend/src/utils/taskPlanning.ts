import type { TaskPriority } from '../../../shared/tasks';

export const taskPriorityLabels = { low: '低', medium: '中', high: '高' } as const;
export const validTaskPriority = (value: unknown): value is TaskPriority | null => value === null || value === 'low' || value === 'medium' || value === 'high';
export const validEstimatedMinutes = (value: unknown): value is number | null => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 525600;
/** Only an actually empty control clears an estimate. Invalid text never becomes null. */
export function parseEstimatedMinutesInput(value: string): number | null | undefined {
  if (value === '') return null;
  if (!/^\d+$/.test(value)) return undefined;
  const minutes = Number(value);
  return validEstimatedMinutes(minutes) ? minutes : undefined;
}
/** Validation only: do not normalize or add fields to frozen creation payloads. */
export function validPlanningFields(value: object): boolean {
  const fields = value as Record<string, unknown>;
  return (!Object.prototype.hasOwnProperty.call(fields, 'priority') || validTaskPriority(fields.priority)) && (!Object.prototype.hasOwnProperty.call(fields, 'estimated_minutes') || validEstimatedMinutes(fields.estimated_minutes));
}
