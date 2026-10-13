import { useEffect, useState } from 'react';
import { getAuthGeneration } from '../../services/api';
import { getCacheUserId } from '../../utils/cacheUtils';
import { useTasksStore } from '../../stores/tasksStore';
import { parseEstimatedMinutesInput, taskPriorityLabels, validTaskPriority } from '../../utils/taskPlanning';
import { metadataChanges, metadataValues } from '../../stores/taskMetadataSlice';

function localDate(iso: string | null | undefined) {
  if (!iso) return '';
  const date = new Date(iso); if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function TaskMetadata({ taskId }: { taskId: string }) {
  const task = useTasksStore(state => state.tasks.find(value => value.id === taskId));
  const draft = useTasksStore(state => state.metadataDrafts[taskId]);
  const intent = useTasksStore(state => state.metadataIntents[taskId]);
  const queued = useTasksStore(state => state.metadataQueues[taskId]?.length || 0);
  const busy = useTasksStore(state => !!state.pending[taskId]);
  const error = useTasksStore(state => state.metadataErrors[taskId]);
  const notice = useTasksStore(state => state.metadataNotices[taskId]);
  const conflict = useTasksStore(state => state.metadataConflicts[taskId]);
  const recoveryError = useTasksStore(state => state.metadataRecoveryError);
  const [localError, setLocalError] = useState('');
  useEffect(() => { setLocalError(''); }, [taskId]);
  useEffect(() => {
    const refresh = () => { try { useTasksStore.getState().restoreMetadata(); void useTasksStore.getState().hydrateMetadata(); } catch { /* Store renders the recovery error. */ } };
    window.addEventListener('storage', refresh); refresh();
    return () => window.removeEventListener('storage', refresh);
  }, [taskId]);
  useEffect(() => {
    if (!draft && !intent) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [draft, intent]);
  if (!task && !intent) return null;
  const locked = !!task && ['running', 'outcome_unknown'].includes(task.status);
  const outdated = conflict || !!draft && draft.revision !== (task?.metadata_revision ?? 0);
  const values = { ...(draft?.values ?? (task ? metadataValues(task) : { title: '', auto_run: false, run_at: null, priority: null, estimated_minutes: null })), ...(intent?.payload?.changes ?? {}) };
  const estimateInput = intent?.payload && 'estimated_minutes' in intent.payload.changes ? String(values.estimated_minutes ?? '') : draft?.estimatedMinutesInput ?? String(values.estimated_minutes ?? '');
  const invalidEstimate = parseEstimatedMinutesInput(estimateInput) === undefined;
  const changed = !!draft && Object.keys(metadataChanges(draft)).length > 0;
  async function act(fn: () => Promise<void>) {
    const owner = getCacheUserId(), generation = getAuthGeneration(); setLocalError('');
    try { await fn(); } catch (error) { if (owner === getCacheUserId() && generation === getAuthGeneration()) setLocalError(error instanceof Error ? error.message : '暂时无法完成，请重试'); }
  }
  return <section aria-label="任务设置" data-testid="task-metadata" className="space-y-3">
    <h4 className="text-sm font-medium">任务设置</h4>
    {!task && <p className="text-sm">原任务暂不在列表中。仍可核验或结束原请求，不会重新创建任务。</p>}
    <fieldset disabled={busy || !!intent || locked || outdated || !!recoveryError || !task} className="space-y-3">
      <label className="workspace-label">设置任务名称<input className="workspace-input" value={values.title} maxLength={150} onChange={event => useTasksStore.getState().editMetadata(taskId, { title: event.target.value })} /></label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="workspace-label">优先级<select aria-label="设置优先级" className="workspace-input" value={values.priority ?? ''} onChange={event => { const priority = event.target.value === '' ? null : event.target.value; if (validTaskPriority(priority)) useTasksStore.getState().editMetadata(taskId, { priority }); }}><option value="">未设置</option>{Object.entries(taskPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="workspace-label">预计分钟<input aria-label="设置预计分钟" type="text" inputMode="numeric" className="workspace-input" value={estimateInput} aria-invalid={invalidEstimate || undefined} placeholder="未估算" onChange={event => useTasksStore.getState().editMetadataEstimate(taskId, event.target.value)} /><span className="text-xs text-text-secondary">留空为未估算；0 表示预计 0 分钟。</span></label>
      </div>
      <p className="text-xs text-text-secondary">仅用于本人规划，不影响任务排序、定时生成或模型调用。</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!values.auto_run} onChange={event => useTasksStore.getState().editMetadata(taskId, { auto_run: event.target.checked })} />启用定时生成</label>
      <label className="workspace-label">下次生成时间（{Intl.DateTimeFormat().resolvedOptions().timeZone}）<input aria-label="设置下次生成时间" type="datetime-local" className="workspace-input" value={localDate(values.run_at)} onChange={event => { const date = new Date(event.target.value); useTasksStore.getState().editMetadata(taskId, { run_at: event.target.value && Number.isFinite(date.getTime()) ? date.toISOString() : null }); }} /></label>
      <p className="text-xs text-text-secondary">启用后会按排期调用所选模型，可能产生费用。清空时间会移除排期；当前重复规则保持不变。</p>
    </fieldset>
    {locked && <p className="text-xs">正在生成或结果待核验时，不能修改任务设置。请先完成运行核验。</p>}
    {outdated && <p role="alert" className="text-sm text-red-500">设置已变化或原请求已结束。请读取最新设置，再明确重新编辑；不会自动覆盖其他页面的修改。</p>}
    {intent ? <div className="writing-warning" role="status"><p>任务设置保存结果待核验{queued > 1 ? `（还有 ${queued - 1} 笔请求需逐条核验）` : ''}。关闭再打开仍可继续核验。</p><p className="text-xs mt-2">核对并结束：已保存则返回原回执，未提交则关闭原编号。不会撤销已保存设置。</p>{!intent.payload && <p className="text-xs mt-2">此设备没有可验证的原内容，只能核验或结束原请求，不能重发。上方显示当前可读设置。</p>}<details><summary>原设置请求编号</summary><p className="break-all text-xs">{intent.key}</p></details><div className="flex flex-wrap gap-2 mt-2"><button className="workspace-button" disabled={busy} onClick={() => void act(() => useTasksStore.getState().verifyMetadata(taskId, intent.key))}>核验任务设置请求</button><button className="workspace-button" disabled={busy} onClick={() => void act(() => useTasksStore.getState().closeMetadata(taskId, intent.key))}>核对并结束原设置请求</button><button className="workspace-button" disabled={busy || !intent.payload} onClick={() => void act(() => useTasksStore.getState().retryMetadata(taskId, intent.key))}>按原设置同号重试</button></div></div> : <div className="flex flex-wrap gap-2"><button className="workspace-button" disabled={busy || !task || locked || outdated || !!recoveryError || !changed || invalidEstimate} onClick={() => void act(() => useTasksStore.getState().saveMetadata(taskId))}>{busy ? '正在保存设置…' : '保存任务设置'}</button>{(draft || outdated) && <button className="writing-link" disabled={busy || locked} onClick={() => void act(() => useTasksStore.getState().resetMetadata(taskId))}>读取最新设置并重新编辑</button>}</div>}
    {invalidEstimate && <p role="alert" className="text-sm text-red-500">预计分钟只能为空或 0 至 525600 的整数；当前输入尚未保存。</p>}
    {(recoveryError || error || localError) && <p role="alert" className="text-sm text-red-500">{recoveryError || error || localError}</p>}
    {notice && <p role="status" className="text-xs text-text-secondary">{notice}</p>}
  </section>;
}
