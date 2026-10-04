import { useEffect, useState } from 'react';
import type { TaskCategory, TaskStatus, WorkspaceTask } from '../../../../shared/tasks';
import { useModelsStore, requestError } from '../../stores/modelsStore';
import { useTasksStore } from '../../stores/tasksStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { useProfileStore } from '../../stores/profileStore';
import { api } from '../../services/api';
import { ModelCenter } from './ModelCenter';
import { PersonalGoalsPanel } from './PersonalGoalsPanel';
import { MemoryCenter } from './MemoryCenter';
import { MessageContent } from '../Chat/MessageContent';
import { useConfirm } from '../Common';

const input = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent/30';
const button = 'rounded-xl px-3 py-2 text-xs border border-border text-text-secondary hover:bg-bg-surface2 disabled:opacity-40';
const categoryNames = { work: '工作', social: '社交', play: '娱乐' };
const statusNames: Record<TaskStatus, string> = { pending: '待处理', running: '正在生成草稿', needs_review: '草稿待验收', outcome_unknown: '上次调用结果待核验', completed: '成果已确认', failed: '生成失败', cancelled: '已停止' };
function needsReview(task: WorkspaceTask) {
  return !task.source_stale && (task.result_pending_review === true || task.status === 'needs_review');
}
function taskStatusLabel(task: WorkspaceTask) {
  if (task.source_stale) return '成果来源已变化，需重新生成';
  if (needsReview(task)) return task.error ? '草稿需重新生成' : '草稿待验收';
  if (task.status === 'pending' && task.accepted_run_id && task.accepted_run_id === task.result_run_id) return '成果已确认，等待下次生成';
  return task.status === 'completed' && !task.accepted_run_id ? '旧结果，验收未核实' : statusNames[task.status];
}
function historyLabel(task: WorkspaceTask, run: WorkspaceTask['history'][number]) {
  if (run.status === 'outcome_unknown') return '结果和费用待核验';
  if (run.status === 'failed') return '生成失败';
  if (run.status === 'accepted' || run.id === task.accepted_run_id) return '草稿已验收';
  if (run.error) return '草稿已过期，需重新生成';
  return '已生成草稿，未记录验收';
}
function historyUsageLabel(run: WorkspaceTask['history'][number]) {
  return run.usage_status === 'provider_reported' && run.usage
    ? `服务商报告用量：输入 ${run.usage.inputTokens}、输出 ${run.usage.outputTokens}、合计 ${run.usage.totalTokens} tokens；费用未核算`
    : '用量与费用未核实，请以服务商账单为准';
}
const templates: Array<{ category: TaskCategory; symbol: string; title: string; description: string; prompt: string }> = [
  { category: 'work', symbol: '↗', title: '推进一个项目', description: '理清目标，拆解行动，记录结论', prompt: '请根据当前项目讨论整理：目标、已确认结论、待办事项、风险，以及下一步最有价值的行动。不要把建议当成已经完成的工作。' },
  { category: 'social', symbol: '◎', title: '一起聊聊', description: '交换观点，让不同 AI 加入对话', prompt: '围绕近期讨论，整理值得继续交流的话题。尊重不同观点，提出三个具体的后续问题，保持自然友好的语气。' },
  { category: 'play', symbol: '✦', title: '打开想象力', description: '故事接龙、角色互动、创意挑战', prompt: '请设计一场可以直接开始的互动创作游戏：给出世界背景、角色、规则和第一个选择。每次推进一小步，把决定权留给参与者。' }
];

export function WorkspacePage({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const catalog = useModelsStore(s => s.catalog);
  const groups = useGroupsStore(s => s.groups);
  const nickname = useProfileStore(s => s.profile.nickname);
  const tasks = useTasksStore(s => s.tasks);
  const load = useTasksStore(s => s.fetch);
  const loading = useTasksStore(s => s.loading);
  const loadError = useTasksStore(s => s.error);
  const draft = useTasksStore(s => s.draft);
  const [view, setView] = useState<'overview' | 'models' | 'goals' | 'memory'>('overview');
  const [filter, setFilter] = useState<'all' | TaskCategory>('all');
  const [composer, setComposer] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState<TaskCategory>('work');
  const [modelId, setModelId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [runAt, setRunAt] = useState('');
  const [repeat, setRepeat] = useState('');
  const [autoRun, setAutoRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acceptingTaskId, setAcceptingTaskId] = useState<string | null>(null);
  const [resolvingTaskId, setResolvingTaskId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [taskSearch, setTaskSearch] = useState('');
  const { confirm, ConfirmModal } = useConfirm();

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (draft) { setComposer(true); setPrompt(draft.prompt); setGroupId(draft.groupId || ''); setTitle('从对话继续'); useTasksStore.getState().setDraft(null); }
  }, [draft]);

  const ready = catalog?.models.filter(m => m.ready && m.verifiedCapabilities?.includes('chat')) || [];
  const chosen = tasks.find(t => t.id === selected);
  async function perform(action: () => Promise<unknown>) {
    setError('');
    try { await action(); } catch (e) { setError(requestError(e)); }
  }
  async function submit() {
    setBusy(true);
    await perform(async () => {
      await useTasksStore.getState().create({ title, prompt, category, model_id: modelId || null, group_id: groupId || null, run_at: runAt ? new Date(runAt).toISOString() : null, repeat_minutes: autoRun && repeat ? Number(repeat) : null, auto_run: autoRun });
      setComposer(false); setTitle(''); setPrompt(''); setRunAt(''); setAutoRun(false); setRepeat('');
    });
    setBusy(false);
  }
  async function createSpace(template: typeof templates[number]) {
    if (!ready.length) { setView('models'); return; }
    setBusy(true);
    await perform(async () => {
      const preferred = ready.find(m => m.id === catalog?.defaults.chat);
      const members = [...new Set([preferred?.id, ...ready.map(m => m.id)].filter((id): id is string => !!id))].slice(0, 3);
      const group = await api.createGroup(template.title, template.description, members, undefined, template.category);
      await useGroupsStore.getState().fetchGroups();
      onOpenConversation(group.id);
    });
    setBusy(false);
  }
  function startTask(template?: typeof templates[number]) {
    setTitle(template?.title || ''); setPrompt(template?.prompt || ''); setCategory(template?.category || 'work'); setComposer(true); setSelected(null);
  }
  async function remove(task: WorkspaceTask) {
    if (await confirm({ title: '删除任务', description: `删除“${task.title}”及其执行结果？此操作无法恢复。`, danger: true })) await perform(() => useTasksStore.getState().remove(task.id));
  }
  async function accept(task: WorkspaceTask) {
    if (!task.run_id || !needsReview(task) || task.error || task.source_stale || acceptingTaskId) return;
    setAcceptingTaskId(task.id);
    try { await perform(() => useTasksStore.getState().accept(task.id, task.run_id!)); }
    finally { setAcceptingTaskId(null); }
  }
  async function resolveUnknown(task: WorkspaceTask, decision: 'allow_retry' | 'abandon') {
    const confirmed = await confirm(decision === 'allow_retry'
      ? { title: '记录核验并允许重试', description: '确认你已核对上次模型调用及可能产生的费用。此操作只解除重试限制，不会立即发起新调用。之后重新生成可能再次收费。' }
      : { title: '放弃本次任务', description: '上次模型调用结果仍未知。放弃会停止这项任务后续自动生成，但不会撤销供应商可能已处理的调用或费用。', danger: true });
    if (!confirmed) return;
    setResolvingTaskId(task.id);
    try { await perform(() => useTasksStore.getState().resolveUnknown(task.id, decision)); }
    finally { setResolvingTaskId(null); }
  }
  async function runDraft(task: WorkspaceTask) {
    if ((needsReview(task) || task.source_stale) && !await confirm({ title: '重新生成草稿', description: '当前草稿未验收或其来源已变化。重新生成会使旧草稿失去确认资格，历史文本仍可查看，并可能再次产生模型费用。' })) return;
    await perform(() => useTasksStore.getState().run(task.id));
  }

  return <div className="h-full overflow-y-auto bg-bg-primary" data-testid="workspace">
    <div className="max-w-6xl mx-auto px-5 md:px-10 py-7 md:py-10 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div><p className="text-[10px] font-semibold tracking-[0.22em] text-accent mb-2">QUNTHINK / YOUR AI SPACE</p><h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{nickname ? `${nickname}，从想法开始` : '让想法，继续向前'}</h1><p className="text-sm text-text-secondary mt-2">一起思考、一起创作，检查每一步成果。</p></div>
        <div className="flex flex-wrap gap-2"><button className={button} onClick={() => setView(view === 'goals' ? 'overview' : 'goals')}>{view === 'goals' ? '返回工作台' : '个人目标'}</button><button className={button} onClick={() => setView(view === 'memory' ? 'overview' : 'memory')}>{view === 'memory' ? '返回工作台' : '记忆记录'}</button><button className={button} onClick={() => setView(view === 'models' ? 'overview' : 'models')}>{view === 'models' ? '返回工作台' : '模型中心'}</button><button className="bg-accent text-white rounded-xl px-4 py-2.5 text-sm font-medium" onClick={() => { setView('overview'); startTask(); }}>＋ 新任务</button></div>
      </div>
      {view === 'models' ? <div className="max-w-3xl"><ModelCenter /></div> : view === 'goals' ? <PersonalGoalsPanel /> : view === 'memory' ? <MemoryCenter /> : <>
        {!ready.length && <div className="rounded-2xl border border-accent/25 bg-accent/5 p-5 mb-6 flex flex-wrap gap-4 items-center justify-between"><div><h2 className="font-medium">先连接并测试你的 AI</h2><p className="text-sm text-text-secondary mt-1">添加服务商和模型并完成对话能力测试，才能自动选用模型创建会话或生成草稿。</p></div><button className="rounded-xl bg-accent text-white px-4 py-2 text-sm" onClick={() => setView('models')}>打开模型中心 →</button></div>}
        <div className="grid grid-cols-3 gap-3 mb-8">{[['已配置对话模型', ready.length], ['待检查草稿', tasks.filter(needsReview).length], ['定时草稿任务', tasks.filter(t => t.auto_run).length]].map(([label, count]) => <div className="rounded-2xl border border-border p-4 bg-bg-surface" key={label}><div className="text-2xl font-semibold">{count}</div><div className="text-xs text-text-secondary mt-1">{label}</div></div>)}</div>
        <div className="grid md:grid-cols-3 gap-4 mb-9">{templates.map(t => <article key={t.category} className="p-5 rounded-2xl border border-border bg-bg-surface hover:border-accent/40 transition-colors"><div className="flex items-center justify-between mb-6"><span className="text-2xl text-accent">{t.symbol}</span><span className="text-[11px] text-text-muted">{categoryNames[t.category]}</span></div><h2 className="text-base font-semibold">{t.title}</h2><p className="text-xs text-text-secondary mt-2 mb-5">{t.description}</p><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void createSpace(t)}>创建会话 ↗</button><button className={button} onClick={() => startTask(t)}>作为任务</button></div></article>)}</div>
        {(error || loadError) && <div className="rounded-xl border border-red-500/30 p-3 text-sm text-red-500 mb-4" role="alert">{error || loadError}<button className="ml-3 underline" onClick={() => void load()}>刷新</button></div>}
        {composer && <form className="rounded-2xl border border-accent/30 bg-bg-surface p-5 mb-6 space-y-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <div className="flex items-center justify-between"><h2 className="font-semibold">生成可检查的草稿</h2><button type="button" className={button} onClick={() => setComposer(false)}>收起</button></div>
          <label className="block text-xs text-text-secondary space-y-2">任务名称<input required maxLength={150} className={input} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：整理本周项目讨论" /></label>
          <label className="block text-xs text-text-secondary space-y-2">希望 AI 起草什么<textarea required maxLength={12000} rows={4} className={`${input} resize-y`} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述目标、草稿形式和需要注意的事项" /></label>
          <div className="grid sm:grid-cols-3 gap-3"><label className="text-xs text-text-secondary space-y-2">场景<select className={input} value={category} onChange={e => setCategory(e.target.value as TaskCategory)}>{Object.entries(categoryNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><label className="text-xs text-text-secondary space-y-2">运行模型<select className={input} value={modelId} onChange={e => setModelId(e.target.value)}><option value="">默认对话模型</option>{ready.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label className="text-xs text-text-secondary space-y-2">关联会话<select className={input} value={groupId} onChange={e => setGroupId(e.target.value)}><option value="">不读取会话</option>{groups.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}</select></label></div>
          <div className="rounded-xl bg-bg-surface2 p-4 space-y-3"><label className="text-sm flex gap-2 items-center"><input type="checkbox" checked={autoRun} onChange={e => setAutoRun(e.target.checked)} />到时间自动生成草稿</label><p className="text-xs text-text-secondary">服务器会调用模型生成文字草稿并保留结果，可能产生模型费用。此功能不会发送消息、修改文件或操作外部系统；草稿需由你检查并确认。失败后自动暂停，可随时停止。默认每天最多生成 24 次。</p>{autoRun && <div className="grid sm:grid-cols-2 gap-3"><label className="text-xs space-y-2">生成时间（本地时区）<input type="datetime-local" required={autoRun} className={input} value={runAt} onChange={e => setRunAt(e.target.value)} /></label><label className="text-xs space-y-2">重复<select className={input} value={repeat} onChange={e => setRepeat(e.target.value)}><option value="">仅一次</option><option value="60">每小时</option><option value="1440">每天</option><option value="10080">每周</option></select></label></div>}</div>
          <button disabled={busy || !title.trim() || !prompt.trim()} className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm disabled:opacity-50">{busy ? '保存中…' : autoRun ? '保存并启用定时生成' : '保存草稿任务'}</button>
        </form>}
        <div className="flex flex-wrap justify-between items-center gap-3 mb-4"><h2 className="font-semibold text-lg">草稿任务与结果</h2><input aria-label="搜索任务" value={taskSearch} onChange={e => setTaskSearch(e.target.value)} placeholder="搜索任务…" className={`${input} sm:!w-56`} /></div>
        <div className="flex flex-wrap gap-2 mb-4">{(['all', 'work', 'social', 'play'] as const).map(id => <button key={id} onClick={() => setFilter(id)} className={`px-3 py-1.5 rounded-lg text-xs ${filter === id ? 'bg-accent text-white' : 'bg-bg-surface2 text-text-secondary'}`}>{id === 'all' ? '全部' : categoryNames[id]}</button>)}</div>
        <div className="space-y-3">{tasks.filter(t => (filter === 'all' || t.category === filter) && `${t.title} ${t.prompt}`.toLowerCase().includes(taskSearch.toLowerCase())).map(task => <article className="rounded-2xl border border-border p-4 bg-bg-surface" key={task.id}>
          <div className="flex items-start justify-between gap-3"><button className="text-left min-w-0" onClick={() => setSelected(selected === task.id ? null : task.id)}><h3 className="font-medium text-sm break-words">{task.title}</h3><p className="text-xs text-text-muted mt-1.5">{categoryNames[task.category]} · {taskStatusLabel(task)}{task.auto_run && task.run_at ? ` · 下次 ${new Date(task.run_at).toLocaleString()}` : ''}{task.run_count ? ` · 已尝试 ${task.run_count} 次` : ''}</p></button><span className={`w-2 h-2 mt-1 rounded-full flex-shrink-0 ${needsReview(task) || task.source_stale || task.status === 'outcome_unknown' ? 'bg-amber-500' : task.status === 'completed' && task.accepted_run_id ? 'bg-emerald-500' : task.status === 'failed' ? 'bg-red-500' : task.status === 'running' ? 'bg-accent animate-pulse' : 'bg-text-muted/40'}`} /></div>
          {task.error && <p className="text-xs text-red-500 mt-3" role="status">{task.error}</p>}
          {task.source_stale && <p className="text-xs text-amber-600 mt-3" role="status">关联会话已变化，此结果所依据的来源不再是当前版本。请核对变化并重新生成。</p>}
          {task.status === 'outcome_unknown' && <p className="text-xs text-amber-600 mt-3" role="status">服务中断后无法确认上次模型调用是否已处理或计费。请先核对服务商账单和已有成果，再决定是否重新生成。</p>}
          <div className="flex flex-wrap gap-2 mt-4">{task.status === 'running' ? <button className={button} onClick={() => void perform(() => useTasksStore.getState().update(task.id, { status: 'cancelled' }))}>停止生成</button> : task.status === 'outcome_unknown' ? <><button className={button} disabled={resolvingTaskId !== null} onClick={() => void resolveUnknown(task, 'allow_retry')}>已核验，允许重试</button><button className={button} disabled={resolvingTaskId !== null} onClick={() => void resolveUnknown(task, 'abandon')}>放弃本次任务</button></> : <button className={button} disabled={!ready.length} onClick={() => void runDraft(task)}>{task.run_count ? '重新生成草稿' : '立即生成草稿'}</button>}{task.auto_run && task.status !== 'running' && task.status !== 'outcome_unknown' && <button className={button} onClick={() => void perform(() => useTasksStore.getState().update(task.id, { auto_run: false }))}>暂停定时生成</button>}<button className={button} onClick={() => setSelected(selected === task.id ? null : task.id)}>{selected === task.id ? '收起' : needsReview(task) ? '检查草稿' : '详情与结果'}</button>{task.status !== 'running' && task.status !== 'outcome_unknown' && <button className={`${button} ml-auto`} onClick={() => void remove(task)}>删除</button>}</div>
          {chosen?.id === task.id && <div className="mt-4 pt-4 border-t border-border space-y-4"><p className="whitespace-pre-wrap text-sm text-text-secondary break-words">{task.prompt}</p>{task.status === 'outcome_unknown' && task.run_id && <p className="text-xs text-text-muted break-all">待核验运行标识：{task.run_id}</p>}{task.group_id && <button className="text-xs text-accent" onClick={() => onOpenConversation(task.group_id!)}>打开关联会话 →</button>}{task.result && <div className="rounded-xl p-4 bg-bg-primary"><p className="text-xs text-text-muted mb-3">{task.source_stale ? '关联来源已变化 · 请重新生成' : needsReview(task) ? task.error ? '草稿来源已变化 · 请重新生成后验收' : 'AI 生成草稿 · 请核对内容与来源，再确认' : task.accepted_run_id && task.accepted_run_id === task.result_run_id ? '已确认的文字成果 · 未执行外部操作' : '此前生成的文字草稿 · 当前未记录有效验收'}</p><MessageContent content={task.result} isUser={false} /><div className="flex flex-wrap gap-2 mt-3"><button className={button} onClick={() => void perform(() => navigator.clipboard.writeText(task.result))}>复制文本</button>{needsReview(task) && !task.error && <button className="rounded-xl px-3 py-2 text-xs bg-accent text-white disabled:opacity-40" disabled={!task.run_id || acceptingTaskId !== null} onClick={() => void accept(task)}>{acceptingTaskId === task.id ? '确认中…' : '确认此草稿成果'}</button>}</div>{needsReview(task) && !task.run_id && <p className="text-xs text-red-500 mt-2">缺少本次运行标识，无法安全确认；请刷新后检查。</p>}</div>}{task.history.length > 0 && <details className="text-xs text-text-secondary"><summary className="cursor-pointer">生成与验收记录（最近 {task.history.length} 次）</summary>{[...task.history].reverse().map(h => <div className="py-3 border-b border-border" key={h.id}><p>{new Date(h.finished_at).toLocaleString()} · {historyLabel(task, h)}{h.error ? ` · ${h.error}` : ''}</p><p className="mt-1 text-text-muted">{historyUsageLabel(h)}</p>{h.result && <p className="mt-2 whitespace-pre-wrap break-words">{h.result}</p>}</div>)}</details>}</div>}
        </article>)}</div>
        {tasks.length === 0 && <div className="rounded-2xl border border-dashed border-border p-10 text-center"><p className="text-text-secondary text-sm">{loading ? '正在加载任务…' : '给想法一个可检查的草稿'}</p><p className="text-xs text-text-muted mt-2">可以先保存草稿任务，也可以从聊天消息创建。当前任务只生成文字，不会操作外部系统。</p><button className={`${button} mt-4`} onClick={() => startTask()}>创建第一个草稿任务</button></div>}
      </>}
    </div>{ConfirmModal}
  </div>;
}
