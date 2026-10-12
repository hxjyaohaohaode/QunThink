import { useEffect, useState } from 'react';
import type { DependencyState, WorkspaceTask } from '../../../../shared/tasks';
import { getAuthGeneration } from '../../services/api';
import { getCacheUserId } from '../../utils/cacheUtils';
import { useTasksStore } from '../../stores/tasksStore';

const reasonLabels: Record<string, string> = {
  missing: '任务已删除或不可用', unaccepted: '尚未验收当前成果', failed: '生成失败', cancelled: '已停止',
  outcome_unknown: '结果待核验', running: '正在生成', source_changed: '来源已变化', dependency_changed: '前置关系或成果已变化', invalid: '关系无效',
};
export function DependencySummary({ state }: { state?: DependencyState }) {
  if (!state?.blocked && !state?.result_stale) return null;
  return <div className="workspace-notice mt-3" role="status" aria-label="前置任务状态">
    {state.blocked && <p>前置任务尚未就绪，暂时不能生成或验收。仍可编辑和保存正文。</p>}
    {state.result_stale && <p>前置任务或其成果已变化，旧验收不再有效。请核对正文，并明确保存新的复核版本。</p>}
    {!!state.reasons?.length && <ul className="text-xs mt-2 space-y-1">{state.reasons.map((reason, index) => <li key={`${reason.task_id}:${reason.code}:${index}`}>{reason.title || '不可用的前置任务'}：{reasonLabels[reason.code] || '需要重新核验'}</li>)}</ul>}
  </div>;
}
export function DependencyPicker({ tasks, value, onChange, taskId, disabled = false }: {
  tasks: WorkspaceTask[]; value: string[]; onChange: (ids: string[]) => void; taskId?: string; disabled?: boolean;
}) {
  const choices = tasks.filter(task => task.id !== taskId);
  const missing = value.filter(id => !choices.some(task => task.id === id));
  return <fieldset disabled={disabled} className="space-y-2" aria-label="选择前置任务">
    <legend className="text-sm font-medium">前置任务 · 可选（{value.length}/32）</legend>
    <p className="text-xs text-text-secondary">仅选择当前账号的任务。前置任务当前成果验收后，才能生成或验收本任务。依赖关系不会把前置任务正文发送给 AI。</p>
    <div className="max-h-48 overflow-y-auto space-y-2">
      {choices.map(task => <label key={task.id} className="flex items-start gap-2 text-sm break-words"><input type="checkbox" checked={value.includes(task.id)} disabled={!value.includes(task.id) && value.length >= 32} onChange={event => onChange(event.target.checked ? [...value, task.id] : value.filter(id => id !== task.id))} /><span>{task.title}</span></label>)}
      {missing.map(id => <label key={id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked onChange={() => onChange(value.filter(value => value !== id))} /><span>不可用的前置任务（取消勾选可移除关系）</span></label>)}
      {!choices.length && !missing.length && <p className="text-xs text-text-muted">当前没有其他任务，可先保存本任务，稍后再添加前置关系。</p>}
    </div>
  </fieldset>;
}
export function TaskDependencies({ taskId }: { taskId: string }) {
  const task = useTasksStore(state => state.tasks.find(task => task.id === taskId));
  const tasks = useTasksStore(state => state.tasks);
  const draft = useTasksStore(state => state.dependencyDrafts[taskId]);
  const intent = useTasksStore(state => state.dependencyIntents[taskId]);
  const queued = useTasksStore(state => state.dependencyQueues[taskId]?.length || 0);
  const busy = useTasksStore(state => !!state.pending[taskId]);
  const error = useTasksStore(state => state.dependencyErrors[taskId]);
  const recoveryError = useTasksStore(state => state.dependencyRecoveryError);
  const notice = useTasksStore(state => state.dependencyNotices[taskId]);
  const conflict = useTasksStore(state => state.dependencyConflicts[taskId]);
  const [localError, setLocalError] = useState('');
  useEffect(() => { setLocalError(''); }, [taskId]);
  if (!task && !intent) return null;
  const locked = !!task && ['running', 'outcome_unknown'].includes(task.status);
  const outdated = conflict || (!!draft && draft.revision !== (task?.dependency_revision ?? 0));
  const ids = intent?.payload.dependency_ids ?? draft?.ids ?? task?.dependency_ids ?? [];
  const changed = !!draft && JSON.stringify([...draft.ids].sort()) !== JSON.stringify([...(task?.dependency_ids || [])].sort());
  async function act(fn: () => Promise<void>) {
    const user = getCacheUserId(), generation = getAuthGeneration();
    setLocalError('');
    try { await fn(); } catch (error) { if (user === getCacheUserId() && generation === getAuthGeneration()) setLocalError(error instanceof Error ? error.message : '暂时无法完成，请重试'); }
  }
  return <section className="space-y-3" aria-label="编辑前置任务" data-testid="task-dependencies">
    {!task && <p className="text-sm">原任务暂不在当前列表中。请核验已有的前置任务请求；不会重新创建任务。</p>}
    <DependencyPicker tasks={tasks} taskId={taskId} value={ids} disabled={busy || !!intent || locked || outdated || !!recoveryError} onChange={ids => useTasksStore.getState().editDependencies(taskId, ids)} />
    {locked && <p className="text-xs text-text-secondary">正在生成或结果待核验时，不能修改前置任务。请先完成运行核验。</p>}
    {outdated && <p role="alert" className="text-sm text-red-500">前置任务关系已被修改。请读取最新关系，再重新选择；不会自动覆盖其他页面的修改。</p>}
    {intent ? <div className="writing-warning" role="status"><p>前置任务保存结果待核验{queued > 1 ? `（还有 ${queued - 1} 笔请求需逐条核验）` : ''}，当前展示的是原请求的冻结选择。关闭再打开仍可继续核验；不会自动运行模型。</p><p className="text-xs mt-2">核对并结束原请求：已保存则返回原回执；未提交则关闭该编号，保留已保存的关系，随后才能重新选择。</p><details><summary>原请求编号</summary><p className="break-all text-xs">{intent.payload.client_request_id}</p></details><div className="flex flex-wrap gap-2 mt-2"><button className="workspace-button" disabled={busy} onClick={() => void act(() => useTasksStore.getState().verifyDependencies(taskId, intent.payload.client_request_id))}>核验前置任务请求</button><button className="workspace-button" disabled={busy} onClick={() => void act(() => useTasksStore.getState().closeDependencies(taskId, intent.payload.client_request_id))}>核对并结束原前置请求</button><button className="workspace-button" disabled={busy} onClick={() => void act(() => useTasksStore.getState().retryDependencies(taskId, intent.payload.client_request_id))}>按原选择同号重试</button></div></div> : <div className="flex flex-wrap gap-2"><button className="workspace-button" disabled={busy || locked || outdated || !!recoveryError || !changed} onClick={() => void act(() => useTasksStore.getState().saveDependencies(taskId))}>{busy ? '正在保存前置任务…' : '保存前置任务'}</button>{(draft || outdated) && <button className="writing-link" disabled={busy || locked} onClick={() => void act(() => useTasksStore.getState().resetDependencies(taskId))}>读取最新关系并重新选择</button>}</div>}
    {(recoveryError || error || localError) && <p role="alert" className="text-sm text-red-500">{recoveryError || error || localError}</p>}
    {notice && <p role="status" className="text-xs text-text-secondary">{notice}</p>}
  </section>;
}
