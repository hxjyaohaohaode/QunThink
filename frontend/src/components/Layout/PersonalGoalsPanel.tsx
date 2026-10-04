import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildPersonalGoalInput, buildPersonalRunInput, personalGoalsApi, retainSubmissionKey,
  type PersonalGoal, type PersonalGoalBrief, type PersonalGoalDetail, type PersonalGoalRun, type PersonalRunDetail,
} from '../../services/personalGoals';
import { useConfirm } from '../Common';

const field = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent/30';
const secondary = 'rounded-xl px-3 py-2 text-xs border border-border text-text-secondary hover:bg-bg-surface2 disabled:opacity-40';
const primary = 'rounded-xl px-4 py-2.5 text-sm bg-accent text-white disabled:opacity-40';

const goalNames: Record<PersonalGoal['state'], string> = {
  active: '已记录 · 未验收完成', paused: '已暂停', completed: '已验收完成', cancelled: '已取消',
};
const runNames: Record<PersonalGoalRun['state'], string> = {
  queued: '待继续或验收', running: '执行中', waiting: '等待条件', paused: '已暂停',
  reconciling: '核验外部效果中', completed: '运行已验收', failed: '运行失败', cancelled: '已取消',
};

function displayError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 503) return '个人目标服务未配置、未迁移或暂不可用。请联系管理员检查基础数据库，再重试；已填写的内容会保留在本页面。';
  if (status === 409) return '状态或幂等键发生冲突。请刷新目标并核对已有记录，再决定下一步。';
  return error instanceof Error ? error.message : '操作失败，请刷新后重试';
}

export function PersonalGoalsPanel() {
  const [goals, setGoals] = useState<PersonalGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [executionAvailable, setExecutionAvailable] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [constraintsText, setConstraintsText] = useState('');
  const [checksText, setChecksText] = useState('');
  const [stepsText, setStepsText] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showRunCreate, setShowRunCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonalGoalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [runDetail, setRunDetail] = useState<PersonalRunDetail | null>(null);
  const [brief, setBrief] = useState<PersonalGoalBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const createAttempt = useRef<{ payload: string; key: string } | null>(null);
  const runAttempts = useRef(new Map<string, { payload: string; key: string }>());
  const transitionKeys = useRef(new Map<string, string>());
  const briefAttempts = useRef(new Map<string, string>());
  const busyRef = useRef(false);
  const selectionEpoch = useRef(0);
  const runEpoch = useRef(0);
  const briefEpoch = useRef(0);
  const { confirm, ConfirmModal } = useConfirm();

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const result = await personalGoalsApi.list();
      setGoals(result.goals);
      setExecutionAvailable(result.executionAvailable === true);
      setListError('');
      return true;
    } catch (error) {
      setListError(displayError(error));
      setExecutionAvailable(false);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);

  async function openGoal(goalId: string) {
    const epoch = ++selectionEpoch.current;
    runEpoch.current++;
    briefEpoch.current++;
    if (selectedId !== goalId) { setStepsText(''); setShowRunCreate(false); }
    setSelectedId(goalId);
    setDetail(null);
    setDetailLoading(true);
    setRunDetail(null);
    setBrief(null);
    setActionError('');
    try {
      const result = await personalGoalsApi.detail(goalId);
      if (epoch !== selectionEpoch.current) return false;
      setDetail(result);
      setExecutionAvailable(result.executionAvailable === true);
      return true;
    } catch (error) {
      if (epoch === selectionEpoch.current) setActionError(displayError(error));
      return false;
    } finally {
      if (epoch === selectionEpoch.current) setDetailLoading(false);
    }
  }

  async function refreshGoal(goalId: string) {
    if (await refreshList() && selectedId === goalId) await openGoal(goalId);
  }

  async function refreshVisible() {
    if (await refreshList() && selectedId) await openGoal(selectedId);
  }

  async function createGoal() {
    if (busyRef.current) return;
    setActionError(''); setNotice('');
    let payload;
    try {
      payload = buildPersonalGoalInput(outcome, constraintsText, checksText);
      createAttempt.current = retainSubmissionKey(createAttempt.current, payload);
    } catch (error) { setActionError(displayError(error)); return; }
    busyRef.current = true; setBusy('create');
    try {
      const result = await personalGoalsApi.create(payload, createAttempt.current.key);
      createAttempt.current = null;
      setOutcome(''); setConstraintsText(''); setChecksText(''); setShowCreate(false);
      setNotice(result.replayed ? '已找到此前提交的同一目标；未重复创建。' : '目标已保存。当前不会自动执行，请继续记录步骤或等待执行能力接入。');
      await refreshList();
      await openGoal(result.goalId);
    } catch (error) {
      if ((error as { status?: number })?.status === 400) createAttempt.current = null;
      setActionError(displayError(error));
    } finally { busyRef.current = false; setBusy(''); }
  }

  async function createRun() {
    if (busyRef.current || listError || !detail || detail.goal.state !== 'active') return;
    setActionError(''); setNotice('');
    let payload;
    try {
      payload = buildPersonalRunInput(stepsText);
      runAttempts.current.set(detail.goal.id, retainSubmissionKey(runAttempts.current.get(detail.goal.id) || null, payload));
    } catch (error) { setActionError(displayError(error)); return; }
    busyRef.current = true; setBusy('run');
    try {
      const result = await personalGoalsApi.createRun(detail.goal.id, payload, runAttempts.current.get(detail.goal.id)!.key);
      runAttempts.current.delete(detail.goal.id);
      setStepsText(''); setShowRunCreate(false);
      setNotice(result.replayed ? '已找到此前提交的同一运行；未重复创建。' : '步骤已持久记录为待领取运行；当前没有自动执行者。');
      await refreshGoal(detail.goal.id);
    } catch (error) {
      if ((error as { status?: number })?.status === 400) runAttempts.current.delete(detail.goal.id);
      setActionError(displayError(error));
    } finally { busyRef.current = false; setBusy(''); }
  }

  async function openRun(goalId: string, runId: string) {
    const epoch = ++runEpoch.current;
    briefEpoch.current++;
    setBrief(null);
    setRunDetail(null);
    try {
      const result = await personalGoalsApi.runDetail(goalId, runId);
      if (epoch === runEpoch.current) setRunDetail(result);
    } catch (error) {
      if (epoch === runEpoch.current) setActionError(displayError(error));
    }
  }

  async function openBrief(goalId: string, runId: string) {
    const epoch = ++briefEpoch.current;
    setBrief(null);
    setBriefLoading(true);
    try {
      const result = await personalGoalsApi.readBrief(goalId, runId);
      if (epoch === briefEpoch.current) setBrief(result);
    } catch (error) {
      if (epoch === briefEpoch.current) setActionError(displayError(error));
    } finally {
      if (epoch === briefEpoch.current) setBriefLoading(false);
    }
  }

  async function createBrief() {
    if (!detail || detail.goal.state !== 'active' || listError || busyRef.current) return;
    const goalId = detail.goal.id;
    const epoch = selectionEpoch.current;
    const key = briefAttempts.current.get(goalId) || crypto.randomUUID();
    briefAttempts.current.set(goalId, key);
    busyRef.current = true; setBusy('brief'); setActionError(''); setNotice('');
    try {
      const result = await personalGoalsApi.createBrief(goalId, key);
      if (result.artifactId) briefAttempts.current.delete(goalId);
      setNotice(result.artifactId
        ? '执行简报已保存，可打开查看目标要求。它不代表原目标已执行或通过验收。'
        : '简报运行已保存，但目前未生成正文。请检查运行状态后用同一操作重试。');
      await refreshList();
      if (selectionEpoch.current === epoch && await openGoal(goalId) && result.artifactId) {
        await openBrief(goalId, result.runId);
      }
    } catch (error) {
      if ((error as { status?: number })?.status === 400) briefAttempts.current.delete(goalId);
      setActionError(displayError(error));
    } finally { busyRef.current = false; setBusy(''); }
  }

  async function resetUncertainAttempt(kind: 'goal' | 'run' | 'brief') {
    const goalId = detail?.goal.id;
    const refreshed = await refreshList();
    if (!refreshed) return;
    if (kind !== 'goal' && (!goalId || !await openGoal(goalId))) return;
    if (!await confirm({
      title: '放弃原提交键并重新开始',
      description: kind === 'brief'
        ? '目标记录已刷新。请先核对是否已有刚生成的执行简报；换用新键可能产生另一份简报。'
        : kind === 'run'
          ? '运行记录已刷新。请先核对是否已有刚提交的运行；换用新键可能创建另一份记录。'
          : '目标列表已刷新。请先核对是否已有刚提交的目标；换用新键可能创建另一份记录。',
    })) return;
    if (kind === 'goal') createAttempt.current = null;
    else if (kind === 'brief' && goalId) briefAttempts.current.delete(goalId);
    else if (goalId) runAttempts.current.delete(goalId);
    setActionError('');
    setNotice('已放弃原提交键。请确认列表里没有重复内容后再提交。');
  }

  async function transition(run: PersonalGoalRun, action: 'pause' | 'resume' | 'cancel') {
    if (!detail || listError || busyRef.current) return;
    if (action === 'cancel' && !await confirm({
      title: '取消这次运行', description: '取消会阻止后续步骤。已经发出的外部效果仍可能发生，需单独核验。', danger: true,
    })) return;
    busyRef.current = true; setBusy(`${run.id}:${action}`); setActionError(''); setNotice('');
    const operation = `${detail.goal.id}:${run.id}:${action}`;
    const key = transitionKeys.current.get(operation) || crypto.randomUUID();
    transitionKeys.current.set(operation, key);
    try {
      await personalGoalsApi.transitionRun(detail.goal.id, run.id, action, key);
      transitionKeys.current.delete(operation);
      setNotice(action === 'pause' ? '运行已暂停；若外部效果未确认，状态会继续显示待核验。' : action === 'resume' ? '运行已恢复为待领取，当前没有自动执行者。' : '运行已取消；外部已发动作不会因此自动撤销。');
      await refreshGoal(detail.goal.id);
      if (runDetail?.run.id === run.id) await openRun(detail.goal.id, run.id);
    } catch (error) {
      setActionError(displayError(error));
    } finally { busyRef.current = false; setBusy(''); }
  }

  async function completeWith(run: PersonalGoalRun) {
    if (!detail || listError || busyRef.current || run.state !== 'completed' || String(run.goal_revision) !== String(detail.goal.revision)) return;
    if (!await confirm({ title: '确认目标完成', description: '该运行已通过服务端步骤、效果与产物验收。请核对目标结果与验收条件后确认完成。' })) return;
    busyRef.current = true; setBusy('complete'); setActionError('');
    const operation = `${detail.goal.id}:${run.id}:complete`;
    const key = transitionKeys.current.get(operation) || crypto.randomUUID();
    transitionKeys.current.set(operation, key);
    try {
      await personalGoalsApi.complete(detail.goal.id, run.id, key);
      transitionKeys.current.delete(operation);
      setNotice('目标已依据服务端通过验收的运行确认完成。');
      await refreshGoal(detail.goal.id);
    } catch (error) { setActionError(displayError(error)); }
    finally { busyRef.current = false; setBusy(''); }
  }

  return <section className="space-y-5" aria-label="个人目标">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">个人目标</h2><p className="text-sm text-text-secondary mt-1">保存要达到的结果、硬约束和验收条件；目标状态以服务端记录为准。</p></div>
      <div className="flex gap-2"><button className={secondary} onClick={() => void refreshVisible()} disabled={loading}>刷新</button><button className={primary} onClick={() => setShowCreate(value => !value)} disabled={Boolean(listError)}>{showCreate ? '收起' : '＋ 创建目标'}</button></div>
    </div>
    {!executionAvailable && <div role="status" className="rounded-xl border border-amber-400/40 bg-amber-500/5 p-4 text-sm text-text-secondary">通用 Agent 执行仍不可用。可明确触发仅整理目标要求的零费用执行简报；其他步骤没有自动执行者。目标完成仍需实际成果与验收。</div>}
    {listError && <div role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-500">{listError} 已显示的旧记录可能过期，刷新成功前暂停修改。</div>}
    {actionError && <div role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-500">{actionError}</div>}
    {notice && <div role="status" className="rounded-xl border border-accent/30 p-3 text-sm text-text-secondary">{notice}</div>}
    {showCreate && <form className="rounded-2xl border border-border bg-bg-surface p-5 space-y-4" onSubmit={event => { event.preventDefault(); void createGoal(); }}>
      <h3 className="font-medium">记录新目标</h3>
      <label className="block text-xs text-text-secondary space-y-2">希望得到的可检查结果<textarea className={field} required maxLength={10000} rows={3} value={outcome} onChange={event => setOutcome(event.target.value)} placeholder="例如：完成项目交付文档并由我检查版本" /></label>
      <label className="block text-xs text-text-secondary space-y-2">硬约束（每行一条，可留空）<textarea className={field} rows={2} value={constraintsText} onChange={event => setConstraintsText(event.target.value)} placeholder="例如：不能覆盖现有用户文件" /></label>
      <label className="block text-xs text-text-secondary space-y-2">验收条件（每行一条，至少一条）<textarea className={field} required rows={3} value={checksText} onChange={event => setChecksText(event.target.value)} placeholder="例如：文档可打开且包含所有已确认章节" /></label>
      <p className="text-xs text-text-muted">当前预算上限固定为 0 微单位，不授予任何工具或付费执行权限。提交结果不确定时保持原内容重试，幂等键会复用。</p>
      {createAttempt.current && <div className="text-xs text-amber-600">上次提交结果未确认；可用原内容和原幂等键重试。<button type="button" className="underline ml-2" onClick={() => void resetUncertainAttempt('goal')}>刷新列表并放弃原提交键</button></div>}
      <button className={primary} disabled={busy !== '' || Boolean(listError)}>{busy === 'create' ? '保存中…' : '保存目标'}</button>
    </form>}
    <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4">
      <div className="space-y-2"><h3 className="font-medium text-sm">最近目标（最多 100 项）</h3>
        {loading && <p className="text-sm text-text-muted">正在读取目标…</p>}
        {!loading && !listError && goals.length === 0 && <p className="rounded-xl border border-dashed border-border p-5 text-sm text-text-muted">还没有个人目标。先写下可检查的结果与验收条件。</p>}
        {goals.map(goal => <button key={goal.id} className={`w-full text-left rounded-xl border p-4 bg-bg-surface ${selectedId === goal.id ? 'border-accent' : 'border-border'}`} onClick={() => void openGoal(goal.id)}><span className="block text-sm font-medium break-words line-clamp-3">{goal.outcome}</span><span className="block text-xs text-text-muted mt-2">{goalNames[goal.state] || goal.state} · {new Date(goal.created_at).toLocaleString()}</span></button>)}
      </div>
      <div className="rounded-2xl border border-border bg-bg-surface p-5 min-h-44">
        {!selectedId && <p className="text-sm text-text-muted">选择目标查看约束、验收条件和运行记录。</p>}
        {selectedId && !detail && <p className="text-sm text-text-muted">{detailLoading ? '正在读取目标详情…' : '详情读取失败，请刷新或重新选择目标。'}</p>}
        {detail && <div className="space-y-5">
          <div><h3 className="font-semibold break-words">{detail.goal.outcome}</h3><p className="text-xs text-text-muted mt-2">{goalNames[detail.goal.state] || detail.goal.state} · 修订 {detail.goal.revision} · 预算 {detail.goal.budget_limit_micros} 微单位，已结算 {detail.goal.budget_spent_micros} 微单位</p></div>
          <div><h4 className="text-sm font-medium">硬约束</h4>{detail.goal.constraints.length ? <ul className="list-disc pl-5 text-sm text-text-secondary mt-2 space-y-1">{detail.goal.constraints.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="text-xs text-text-muted mt-1">未记录额外约束</p>}</div>
          <div><h4 className="text-sm font-medium">验收条件</h4><ul className="list-disc pl-5 text-sm text-text-secondary mt-2 space-y-1">{detail.checks.map(check => <li key={check.check_key}>{check.description}{check.required ? '（必需）' : '（可选）'}</li>)}</ul></div>
          {detail.goal.state === 'active' && <div className="rounded-xl border border-border p-3 space-y-2"><button className={secondary} disabled={busy !== '' || Boolean(listError)} onClick={() => void createBrief()}>{busy === 'brief' ? '正在生成…' : '生成目标执行简报'}</button><p className="text-xs text-text-muted">此操作仅授权内部 Worker 在 24 小时内整理该目标当前修订的结果、约束和验收条件；不调用模型或外部工具，不产生费用，也不会自动判定目标完成。</p>{briefAttempts.current.has(detail.goal.id) && <p className="text-xs text-amber-600">上次请求结果未确认；重试会沿用同一提交键。<button className="underline ml-1" onClick={() => void resetUncertainAttempt('brief')}>刷新核对后换新键</button></p>}</div>}
          {detail.goal.state === 'active' && <div><button className={secondary} onClick={() => setShowRunCreate(value => !value)}>{showRunCreate ? '收起步骤' : '记录执行步骤'}</button><p className="text-xs text-text-muted mt-2">仅保存待领取运行；不会开始 AI 或工具调用。</p></div>}
          {showRunCreate && detail.goal.state === 'active' && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void createRun(); }}><label className="block text-xs text-text-secondary space-y-2">步骤（每行一步）<textarea className={field} required rows={3} value={stepsText} onChange={event => setStepsText(event.target.value)} placeholder="例如：核对现有资料与缺口" /></label>{runAttempts.current.has(detail.goal.id) && <p className="text-xs text-amber-600">上次运行提交结果未确认；保持原步骤重试，或<button type="button" className="underline ml-1" onClick={() => void resetUncertainAttempt('run')}>刷新记录并放弃原提交键</button>。</p>}<button className={primary} disabled={busy !== '' || Boolean(listError)}>{busy === 'run' ? '记录中…' : '保存为待领取运行'}</button></form>}
          <div className="space-y-2"><h4 className="text-sm font-medium">运行记录</h4>{detail.runs.length === 0 && <p className="text-xs text-text-muted">暂无运行；目标仍未执行或验收。</p>}
            {detail.runs.map(run => <div key={run.id} className="rounded-xl border border-border p-3 text-xs text-text-secondary"><div className="flex flex-wrap justify-between gap-2"><span>{runNames[run.state] || run.state} · {new Date(run.created_at).toLocaleString()}</span><button className="text-accent" onClick={() => void openRun(detail.goal.id, run.id)}>查看步骤与验收</button></div>{run.wait_reason && <p className="mt-2">等待原因：{run.wait_reason}</p>}
              <div className="flex flex-wrap gap-2 mt-3">{(['queued','running','waiting'].includes(run.state)) && <button className={secondary} disabled={busy !== '' || Boolean(listError)} onClick={() => void transition(run, 'pause')}>暂停</button>}{(['paused','waiting'].includes(run.state)) && <button className={secondary} disabled={busy !== '' || Boolean(listError)} onClick={() => void transition(run, 'resume')}>恢复为待领取</button>}{(['queued','running','waiting','paused','reconciling'].includes(run.state)) && <button className={secondary} disabled={busy !== '' || Boolean(listError)} onClick={() => void transition(run, 'cancel')}>取消运行</button>}{detail.goal.state === 'active' && run.state === 'completed' && String(run.goal_revision) === String(detail.goal.revision) && <button className={primary} disabled={busy !== '' || Boolean(listError)} onClick={() => void completeWith(run)}>以此运行验收目标</button>}</div>
            </div>)}
          </div>
          {runDetail && <div className="rounded-xl bg-bg-primary p-4 space-y-3 text-xs text-text-secondary"><h4 className="font-medium">运行详情 · {runNames[runDetail.run.state] || runDetail.run.state}</h4><p>步骤：{runDetail.steps.map(step => `${step.action}（${step.state}）`).join('；') || '无'}</p><p>验收：{runDetail.checks.map(check => `${check.check_key}：${check.state}${check.artifact_id ? `，产物 ${check.artifact_id} 修订 ${check.artifact_revision}` : ''}`).join('；') || '无'}</p>{runDetail.effects.some(effect => ['unknown','inflight'].includes(effect.state)) && <p className="text-amber-600">存在结果未确认的外部效果，暂停或取消不代表外部动作未发生。</p>}{runDetail.steps.some(step => step.action === 'internal.goal_brief.v1' && step.state === 'completed') && <button className={secondary} onClick={() => void openBrief(detail.goal.id, runDetail.run.id)}>打开执行简报</button>}{!runDetail.executionAvailable && <p>通用 Agent 尚不可用；执行简报只整理目标要求，不是已验收的目标成果。</p>}</div>}
          {briefLoading && <p className="text-xs text-text-muted">正在读取简报…</p>}
          {brief && <div className="rounded-xl border border-border p-4 space-y-2"><h4 className="text-sm font-medium">目标执行简报 · 修订 {brief.source.goalRevision}</h4><p className="text-xs text-text-muted">产物 {brief.artifactId} · 不可用作目标验收证据</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-text-secondary">{brief.content}</pre></div>}
        </div>}
      </div>
    </div>{ConfirmModal}
  </section>;
}
