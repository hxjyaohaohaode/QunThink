import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { TaskCategory, TaskStatus, WorkspaceTask } from '../../../../shared/tasks';
import { useModelsStore, requestError } from '../../stores/modelsStore';
import { emptyTaskDraft, useTasksStore, type TaskComposerDraft } from '../../stores/tasksStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { useProfileStore } from '../../stores/profileStore';
import { api } from '../../services/api';
import { ModelCenter } from './ModelCenter';
import { PersonalGoalsPanel } from './PersonalGoalsPanel';
import { MemoryCenter } from './MemoryCenter';
import { RuntimeDiagnostics } from './RuntimeDiagnostics';
import { MessageContent } from '../Chat/MessageContent';
import { useConfirm } from '../Common';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { setDiagnosticSurface } from '../../observability/runtimeDiagnostics';

const categoryNames = { work: '工作', social: '社交', play: '娱乐' };
const statusNames: Record<TaskStatus, string> = { pending: '待开始', running: '正在生成', needs_review: '等你检查', outcome_unknown: '需要核验', completed: '已确认成果', failed: '需要重试', cancelled: '已停止' };
const viewNames = { overview: '工作台', goals: '个人目标', memory: '记忆记录', models: '模型中心', diagnostics: '运行记录' };
type View = keyof typeof viewNames;
type Stage = 'all' | 'attention' | 'running' | 'completed';
function needsReview(task: WorkspaceTask) { return !task.source_stale && (task.result_pending_review === true || task.status === 'needs_review'); }
function attention(task: WorkspaceTask) { return !!task.source_input_stale || !!task.source_stale || needsReview(task) || task.status === 'outcome_unknown' || task.status === 'failed'; }
function taskStatus(task: WorkspaceTask) {
  if (task.source_input_stale) return '原始消息已变化';
  if (task.source_stale) return '来源已变化';
  if (needsReview(task)) return task.error ? '需要重新生成' : '等你检查';
  if (task.status === 'pending' && task.accepted_run_id === task.result_run_id && task.accepted_run_id) return '等待下次生成';
  return task.status === 'completed' && !task.accepted_run_id ? '旧成果待核验' : statusNames[task.status];
}
function dateLabel(value: string | null) { if (!value || !Number.isFinite(Date.parse(value))) return '未设置'; return new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
const templates: Array<{ category: TaskCategory; symbol: string; title: string; description: string; prompt: string }> = [
  { category: 'work', symbol: '↗', title: '推进一个项目', description: '把讨论变成有依据、可检查的下一步', prompt: '请根据当前项目讨论整理：目标、已确认结论、待办事项、风险，以及下一步最有价值的行动。不要把建议当成已经完成的工作。' },
  { category: 'social', symbol: '◎', title: '一起聊聊', description: '让不同视角参与思考，保留自己的判断', prompt: '围绕近期讨论，整理值得继续交流的话题。尊重不同观点，提出三个具体的后续问题，保持自然友好的语气。' },
  { category: 'play', symbol: '✦', title: '打开想象力', description: '故事、角色、创意，从一个小选择开始', prompt: '请设计一场可以直接开始的互动创作游戏：给出世界背景、角色、规则和第一个选择。每次推进一小步，把决定权留给参与者。' }
];

export function WorkspacePage({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const catalog = useModelsStore(state => state.catalog);
  const groups = useGroupsStore(state => state.groups);
  const nickname = useProfileStore(state => state.profile.nickname);
  const tasks = useTasksStore(state => state.tasks);
  const load = useTasksStore(state => state.fetch);
  const loading = useTasksStore(state => state.loading);
  const loadError = useTasksStore(state => state.error);
  const lastUpdated = useTasksStore(state => state.lastUpdated);
  const incomingDraft = useTasksStore(state => state.draft);
  const draft = useTasksStore(state => state.composerDraft);
  const pending = useTasksStore(state => state.pending);
  const uncertainCreate = useTasksStore(state => state.uncertainCreate);
  const [view, setView] = useState<View>('overview');
  const [filter, setFilter] = useState<'all' | TaskCategory>('all');
  const [stage, setStage] = useState<Stage>('all');
  const [composer, setComposer] = useState(!!draft.title || !!draft.prompt || uncertainCreate);
  const [spaceBusy, setSpaceBusy] = useState<TaskCategory | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [taskSearch, setTaskSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { confirm, ConfirmModal } = useConfirm();
  const reduced = useReducedMotion();
  const titleRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const submitLock = useRef(false);
  const spaceLock = useRef(false);
  const transition = { duration: reduced ? 0 : 0.22, ease: [0.2, 0.8, 0.2, 1] as const };
  const ready = catalog?.models.filter(model => model.ready && model.verifiedCapabilities?.includes('chat')) || [];
  const setDraft = (patch: Partial<TaskComposerDraft>) => useTasksStore.getState().setComposerDraft({ ...useTasksStore.getState().composerDraft, ...patch });

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);
  useEffect(() => { setDiagnosticSurface(view === 'overview' ? 'workspace' : view); }, [view]);
  useEffect(() => {
    if (!incomingDraft || uncertainCreate || pending.create) return;
    // Never silently replace writing that was already in progress.
    if (draft.title || draft.prompt) { setNotice('有一段来自对话的内容待接续。请先保存或清空当前任务草稿。'); return; }
    setDraft({ title: '从对话继续', prompt: incomingDraft.prompt, groupId: incomingDraft.groupId || '', sourceMessageId: incomingDraft.messageId || '', sourceMessageEditedAt: incomingDraft.editedAt ?? null });
    setComposer(true); setView('overview');
    useTasksStore.getState().setDraft(null);
  }, [incomingDraft, draft.title, draft.prompt, uncertainCreate, pending.create]);
  useEffect(() => {
    if (composer && view === 'overview') titleRef.current?.focus({ preventScroll: true });
  }, [composer, view]);
  useEffect(() => {
    if (!copiedId) return;
    const timer = setTimeout(() => setCopiedId(null), 2500);
    return () => clearTimeout(timer);
  }, [copiedId]);
  useEffect(() => {
    if (!draft.title && !draft.prompt && !uncertainCreate) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draft.title, draft.prompt, uncertainCreate]);

  const visibleTasks = useMemo(() => tasks.filter(task => (filter === 'all' || task.category === filter) &&
    (stage === 'all' || (stage === 'attention' && attention(task)) || (stage === 'running' && task.status === 'running') || (stage === 'completed' && !!task.accepted_run_id && !task.source_stale)) &&
    `${task.title} ${task.prompt}`.toLocaleLowerCase().includes(taskSearch.trim().toLocaleLowerCase())), [tasks, filter, stage, taskSearch]);
  const attentionCount = tasks.filter(attention).length;
  const runningCount = tasks.filter(task => task.status === 'running').length;
  async function perform(action: () => Promise<unknown>, success?: string) {
    setError('');
    try { await action(); if (success) setNotice(success); return true; }
    catch (reason) { setError(requestError(reason)); return false; }
  }
  async function submit() {
    if (submitLock.current || pending.create) return;
    submitLock.current = true;
    try {
      if (draft.autoRun && (!draft.runAt || !Number.isFinite(Date.parse(draft.runAt)) || (!uncertainCreate && Date.parse(draft.runAt) <= Date.now()))) { setError('请选择未来的生成时间'); return; }
      if (!uncertainCreate && draft.autoRun && !ready.length) { setError('启用自动生成前，请先连接并测试一个对话模型'); return; }
      const saved = await perform(async () => {
        const task = await useTasksStore.getState().create({ title: draft.title, prompt: draft.prompt, category: draft.category, model_id: draft.modelId || null, group_id: draft.groupId || null, source_message_id: draft.sourceMessageId || null, source_message_edited_at: draft.sourceMessageEditedAt, run_at: draft.autoRun && draft.runAt ? new Date(draft.runAt).toISOString() : null, repeat_minutes: draft.autoRun && draft.repeat ? Number(draft.repeat) : null, auto_run: draft.autoRun });
        setSelected(task.id); setComposer(false); setTaskSearch(''); setFilter('all'); setStage('all');
      }, draft.autoRun ? '任务已保存，定时生成已开启。可随时暂停。' : '任务已保存。准备好后，点击“生成草稿”开始。');
      if (saved) setView('overview');
    } finally { submitLock.current = false; }
  }
  async function createSpace(template: typeof templates[number]) {
    if (!ready.length) { setView('models'); setNotice('完成对话测试后，就可以创建这个会话。'); return; }
    if (spaceLock.current) return;
    spaceLock.current = true; setSpaceBusy(template.category);
    try {
      await perform(async () => {
        const preferred = ready.find(model => model.id === catalog?.defaults.chat);
        const members = [...new Set([preferred?.id, ...ready.map(model => model.id)].filter((id): id is string => !!id))].slice(0, 3);
        const group = await api.createGroup(template.title, template.description, members, undefined, template.category);
        await useGroupsStore.getState().fetchGroups(); onOpenConversation(group.id);
      });
    } finally { spaceLock.current = false; setSpaceBusy(null); }
  }
  async function startTask(template?: typeof templates[number]) {
    if (template && (draft.title || draft.prompt)) {
      if (uncertainCreate || pending.create) { setComposer(true); setView('overview'); setNotice('先核验当前任务的保存结果，再开始新任务。'); return; }
      if (!await confirm({ title: '替换未保存的任务草稿？', description: '当前输入仍在本标签页。使用这个场景会替换当前内容；也可以取消，继续编辑。' })) return;
    }
    if (template) useTasksStore.getState().setComposerDraft({ ...emptyTaskDraft(), title: template.title, prompt: template.prompt, category: template.category });
    setView('overview'); setComposer(true); setSelected(null); setError('');
    requestAnimationFrame(() => { composerRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' }); titleRef.current?.focus({ preventScroll: true }); });
  }
  async function discardDraft() {
    if (uncertainCreate || pending.create) return;
    if (!await confirm({ title: '清空未保存的草稿？', description: '只清空当前输入，已保存的任务不会改变。', danger: true })) return;
    useTasksStore.getState().setComposerDraft(emptyTaskDraft()); setComposer(false); setError('');
  }
  async function remove(task: WorkspaceTask) {
    if (await confirm({ title: '删除任务', description: `删除“${task.title}”及其执行结果？此操作无法恢复。`, danger: true })) await perform(() => useTasksStore.getState().remove(task.id), '任务已删除');
  }
  async function resolveUnknown(task: WorkspaceTask, decision: 'allow_retry' | 'abandon') {
    if (!task.run_id) { setError('缺少待核验运行标识，请刷新后检查'); return; }
    const runId = task.run_id;
    if (!await confirm(decision === 'allow_retry' ? { title: '记录核验并允许重试', description: '请先核对上次模型调用及可能产生的费用。此操作只解除重试限制，不会立即发起新调用。之后重新生成可能再次收费。' } : { title: '放弃本次任务', description: '放弃会停止后续自动生成，不会撤销服务商可能已处理的调用或费用。', danger: true })) return;
    await perform(() => useTasksStore.getState().resolveUnknown(task.id, runId, decision), decision === 'allow_retry' ? '已记录核验。你可以主动发起一次新的生成。' : '已停止后续生成');
  }
  async function run(task: WorkspaceTask) {
    if ((needsReview(task) || task.source_stale) && !await confirm({ title: '重新生成草稿', description: '重新生成后，旧草稿失去确认资格，但历史文本仍可查看。模型服务可能再次收费。' })) return;
    await perform(() => useTasksStore.getState().run(task.id));
  }
  async function copy(task: WorkspaceTask) { if (await perform(() => navigator.clipboard.writeText(task.result))) setCopiedId(task.id); }

  return <div className="workspace-page h-full overflow-y-auto bg-bg-primary" data-testid="workspace" data-observe="workspace">
    <div className="max-w-6xl mx-auto px-4 md:px-9 py-6 md:py-9 pb-28">
      <header className="workspace-header flex flex-wrap justify-between items-start gap-5 mb-7">
        <div><p className="text-xs font-semibold tracking-[0.18em] text-accent mb-2">QunThink · 群想</p><h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{nickname ? `${nickname}，让想法继续向前` : '让想法，继续向前'}</h1><p className="text-sm text-text-secondary mt-2">交流、创作、检查成果。每一步都有着落。</p></div>
        <button className="workspace-primary" onClick={() => void startTask()}>{draft.title || draft.prompt || uncertainCreate ? '继续任务草稿' : '＋ 新任务'}</button>
      </header>
      <nav className="workspace-tabs flex gap-1 overflow-x-auto mb-7" aria-label="工作台分区">{(Object.entries(viewNames) as Array<[View, string]>).map(([id, label]) => <button key={id} className={`workspace-tab ${view === id ? 'is-active' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{label}{view === id && <motion.span layoutId="workspace-active-tab" className="workspace-tab-indicator" transition={transition} />}</button>)}</nav>
      <div className="sr-only" role="status" aria-live="polite">{notice}</div>
      {notice && <div className="workspace-notice mb-4 flex items-start justify-between gap-3"><span>{notice}</span><button className="shrink-0 underline" aria-label="关闭提示" onClick={() => setNotice('')}>知道了</button></div>}
      {(error || loadError) && <div className="workspace-error mb-4" role="alert"><p>{error || loadError}</p><button className="underline mt-2" onClick={() => { setError(''); void load(); }}>刷新任务状态</button></div>}
      <motion.div key={view} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={transition}>
        {view === 'models' ? <section data-observe="models" className="max-w-3xl"><ModelCenter /></section> : view === 'goals' ? <section data-observe="goals"><PersonalGoalsPanel /></section> : view === 'memory' ? <section data-observe="memory"><MemoryCenter /></section> : view === 'diagnostics' ? <RuntimeDiagnostics /> : <>
          {!ready.length && <section className="workspace-setup mb-6"><div><span className="text-xs font-semibold text-accent">开始之前</span><h2 className="text-base font-semibold mt-1">连接你的第一个 AI</h2><p className="text-sm text-text-secondary mt-2">添加服务商并完成对话测试。也可以先保存想法，准备好后再生成。</p></div><button className="workspace-button" onClick={() => setView('models')}>设置模型 →</button></section>}
          <div className="grid grid-cols-3 gap-2 md:gap-4 mb-6" aria-label="任务概览">{([{ id: 'attention', label: '需要你处理', value: attentionCount, hint: '检查草稿与异常' }, { id: 'running', label: '正在进行', value: runningCount, hint: '不必停留等待' }, { id: 'all', label: '全部任务', value: tasks.length, hint: '想法与成果' }] as const).map(item => <button key={item.id} aria-pressed={stage === item.id} onClick={() => setStage(stage === item.id ? 'all' : item.id)} className={`workspace-stat ${stage === item.id ? 'is-active' : ''}`}><span className="text-xl md:text-3xl font-semibold tabular-nums">{loading && !tasks.length ? '—' : item.value}</span><span className="block text-xs md:text-sm mt-2">{item.label}</span><span className="hidden sm:block text-xs text-text-muted mt-1">{item.hint}</span></button>)}</div>
          <AnimatePresence initial={false}>{composer && <motion.section ref={composerRef} key="composer" data-observe="task-composer" initial={{ opacity: 0, height: reduced ? 'auto' : 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: reduced ? 'auto' : 0 }} transition={transition} className="overflow-hidden mb-6">
            <form className="workspace-composer" onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={!!pending.create}>
              <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-lg">给想法一个下一步</h2><p className="text-xs text-text-secondary mt-1">输入只保留在当前账号的本标签页，切换页面后可继续；关闭标签页会丢失未保存内容。</p></div><button type="button" className="workspace-button shrink-0" onClick={() => setComposer(false)}>收起</button></div>
              {uncertainCreate && <div role="alert" className="workspace-notice">上次保存的回复未能确认。内容已锁定，点击“核验并重试保存”将复用原请求编号，不会重复创建。</div>}
              <fieldset disabled={!!pending.create || uncertainCreate} className="space-y-4 disabled:opacity-70">
                <label className="workspace-label">任务名称<input ref={titleRef} required maxLength={150} className="workspace-input" value={draft.title} onChange={event => setDraft({ title: event.target.value })} placeholder="例如：整理本周项目讨论" /></label>
                <label className="workspace-label">希望得到什么<textarea required maxLength={12000} rows={4} className="workspace-input resize-y" value={draft.prompt} onChange={event => setDraft({ prompt: event.target.value })} placeholder="描述你要的草稿、依据和检查标准。越具体，越容易核对。" /><span className="text-text-muted text-xs">{draft.prompt.length.toLocaleString()} / 12,000</span></label>
                <div className="grid sm:grid-cols-3 gap-3"><label className="workspace-label">场景<select className="workspace-input" value={draft.category} onChange={event => setDraft({ category: event.target.value as TaskCategory })}>{Object.entries(categoryNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="workspace-label">运行模型<select className="workspace-input" value={draft.modelId} onChange={event => setDraft({ modelId: event.target.value })}><option value="">默认对话模型</option>{ready.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label className="workspace-label">作为依据的会话<select className="workspace-input" value={draft.groupId} onChange={event => setDraft({ groupId: event.target.value, sourceMessageId: '', sourceMessageEditedAt: null })}><option value="">不读取会话</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label></div>
                {draft.groupId && !groups.some(group => group.id === draft.groupId) && <p role="alert" className="text-sm text-red-500">原会话已不可用，请重新选择依据。</p>}
                <details className="workspace-schedule" open={draft.autoRun || undefined}><summary>定时生成 · 可选</summary><label className="flex items-center gap-2 text-sm mt-3"><input type="checkbox" checked={draft.autoRun} onChange={event => setDraft({ autoRun: event.target.checked })} />到时间自动生成</label><p className="text-xs text-text-secondary mt-2 leading-relaxed">模型调用可能收费；只生成文字草稿，不操作外部系统。每轮结果需你检查，异常时暂停后续生成。</p>{draft.autoRun && <div className="grid sm:grid-cols-2 gap-3 mt-3"><label className="workspace-label">生成时间（{Intl.DateTimeFormat().resolvedOptions().timeZone}）<input type="datetime-local" required className="workspace-input" value={draft.runAt} onChange={event => setDraft({ runAt: event.target.value })} /></label><label className="workspace-label">重复<select className="workspace-input" value={draft.repeat} onChange={event => setDraft({ repeat: event.target.value })}><option value="">仅一次</option><option value="60">每小时</option><option value="1440">每天</option><option value="10080">每周</option></select></label></div>}</details>
              </fieldset>
              <div className="flex flex-wrap items-center gap-3"><button disabled={!!pending.create || !draft.title.trim() || !draft.prompt.trim() || (!uncertainCreate && !!draft.groupId && !groups.some(group => group.id === draft.groupId))} className="workspace-primary">{pending.create ? '正在保存…' : uncertainCreate ? '核验并重试保存' : draft.autoRun ? '保存并启用定时生成' : '保存任务'}</button>{!uncertainCreate && <button type="button" disabled={!!pending.create} className="workspace-button" onClick={() => void discardDraft()}>清空草稿</button>}<span className="text-xs text-text-muted">{draft.autoRun ? '保存后按所选时间调用模型' : '保存不会立即调用模型'}</span></div>
            </form>
          </motion.section>}</AnimatePresence>
          <section aria-labelledby="tasks-title"><div className="flex flex-wrap justify-between items-end gap-4 mb-4"><div><h2 id="tasks-title" className="text-lg font-semibold">想法与成果</h2><p className="text-xs text-text-muted mt-1">{lastUpdated ? `最近同步 ${dateLabel(lastUpdated)}` : '正在连接任务记录'} · {visibleTasks.length} 项</p></div><div className="flex gap-2 items-center"><input aria-label="搜索任务" type="search" value={taskSearch} onChange={event => setTaskSearch(event.target.value)} placeholder="搜索名称或内容" className="workspace-input max-w-56" /><button className="workspace-button shrink-0" disabled={loading} onClick={() => void load()}>刷新</button></div></div>
            <div className="flex flex-wrap gap-2 mb-4" aria-label="任务筛选">{(['all', 'work', 'social', 'play'] as const).map(id => <button key={id} aria-pressed={filter === id} className={`workspace-filter ${filter === id ? 'is-active' : ''}`} onClick={() => setFilter(id)}>{id === 'all' ? '全部场景' : categoryNames[id]}</button>)}{stage !== 'all' && <button className="workspace-filter is-active" onClick={() => setStage('all')}>{stage === 'attention' ? '需要处理' : stage === 'running' ? '正在进行' : '已确认'} ×</button>}</div>
            <div className="space-y-3">{visibleTasks.map(task => {
              const isOpen = selected === task.id;
              const taskBusy = !!pending[task.id];
              const group = groups.find(item => item.id === task.group_id);
              return <motion.article layout={reduced ? false : 'position'} transition={transition} className={`workspace-task ${isOpen ? 'is-open' : ''}`} key={task.id} data-observe="task-card" aria-busy={taskBusy}>
                <div className="flex justify-between gap-3"><button className="text-left min-w-0 flex-1" aria-expanded={isOpen} aria-controls={`task-detail-${task.id}`} onClick={() => setSelected(isOpen ? null : task.id)}><span className="text-xs text-text-muted">{categoryNames[task.category]}{task.group_id && ` · ${group?.name || '来源会话不可用'}`}</span><h3 className="font-semibold text-base break-words mt-1">{task.title}</h3></button><span className={`workspace-status ${attention(task) ? 'needs-attention' : task.status === 'running' ? 'is-running' : ''}`}>{taskStatus(task)}</span></div>
                {!isOpen && <p className="text-sm text-text-secondary mt-3 line-clamp-2 break-words">{task.prompt}</p>}
                {task.auto_run && task.run_at && <p className="text-xs text-text-muted mt-3">下次生成 {dateLabel(task.run_at)}{task.repeat_minutes ? ` · 每 ${task.repeat_minutes >= 1440 ? `${task.repeat_minutes / 1440} 天` : `${task.repeat_minutes} 分钟`}` : ''}</p>}
                {task.source_input_stale && <p className="workspace-notice mt-3" role="status">创建此任务的原始消息已被更改或撤回，不能继续复用。请打开来源会话，从当前内容重新创建任务。</p>}
                {task.source_stale && <p className="workspace-notice mt-3" role="status">来源已变化。先打开关联会话核对，再重新生成；旧成果不能继续验收。</p>}
                {task.status === 'outcome_unknown' && <p className="workspace-notice mt-3" role="status">调用后的连接中断、取消或服务异常，无法证明模型未处理或未计费。请先核对服务商记录，再决定下一步。</p>}
                {task.error && <p className="text-xs text-red-500 mt-3 break-words" role="status">{task.error}</p>}
                <div className="flex flex-wrap items-center gap-2 mt-4">
                  {task.status === 'running' || pending[task.id] === '生成中' ? <button className="workspace-button" disabled={!!pending[`${task.id}:cancel`]} onClick={() => void perform(() => useTasksStore.getState().update(task.id, { status: 'cancelled', ...(task.run_request_id ? { cancel_request_id: task.run_request_id } : task.run_id ? { run_id: task.run_id } : {}) }), '停止请求已提交；如模型已收到请求，仍需核验结果与费用。')}>{pending[`${task.id}:cancel`] ? '正在请求停止…' : '停止生成'}</button> : task.status === 'outcome_unknown' ? <><button className="workspace-button" disabled={taskBusy} onClick={() => void resolveUnknown(task, 'allow_retry')}>已核验，允许重试</button><button className="workspace-button" disabled={taskBusy} onClick={() => void resolveUnknown(task, 'abandon')}>停止此任务</button></> : <button className="workspace-button" disabled={taskBusy || !ready.length || task.source_input_stale} onClick={() => void run(task)}>{taskBusy ? pending[task.id] : task.run_count ? '重新生成' : '生成草稿'}</button>}
                  <button className={needsReview(task) && !isOpen ? 'workspace-primary' : 'workspace-button'} onClick={() => setSelected(isOpen ? null : task.id)}>{isOpen ? '收起详情' : needsReview(task) ? '检查草稿' : '打开详情'}</button>
                  {task.auto_run && task.status !== 'running' && task.status !== 'outcome_unknown' && <button className="workspace-button" disabled={taskBusy} onClick={() => void perform(() => useTasksStore.getState().update(task.id, { auto_run: false }), '已暂停定时生成')}>暂停定时</button>}
                  {!ready.length && task.status !== 'outcome_unknown' && <button className="text-xs text-accent underline" onClick={() => setView('models')}>先连接模型</button>}
                </div>
                <AnimatePresence initial={false}>{isOpen && <motion.div id={`task-detail-${task.id}`} key="details" initial={{ height: reduced ? 'auto' : 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: reduced ? 'auto' : 0, opacity: 0 }} transition={transition} className="overflow-hidden"><div className="pt-5 mt-4 border-t border-border space-y-4">
                  <section><h4 className="text-xs font-semibold text-text-muted mb-2">任务要求</h4><p className="whitespace-pre-wrap text-sm text-text-secondary break-words">{task.prompt}</p></section>
                  {task.group_id && <button className="text-sm text-accent underline" disabled={!group} onClick={() => onOpenConversation(task.group_id!)}>{group ? '打开来源会话 →' : '来源会话已不可用'}</button>}
                  {task.result && <section className="workspace-result"><div className="text-xs text-text-secondary mb-4">{task.source_stale ? '来源已变化 · 仅供历史参考' : needsReview(task) ? 'AI 生成草稿 · 请核对内容和来源' : task.accepted_run_id && task.accepted_run_id === task.result_run_id ? '已确认的文字成果 · 未执行外部操作' : '历史文字草稿 · 尚无有效验收'}</div><MessageContent content={task.result} isUser={false} /><div className="flex flex-wrap gap-2 mt-4"><button className="workspace-button" onClick={() => void copy(task)}>{copiedId === task.id ? '已复制 ✓' : '复制文本'}</button>{needsReview(task) && !task.error && <button className="workspace-primary" disabled={!task.run_id || taskBusy} onClick={() => void perform(() => useTasksStore.getState().accept(task.id, task.run_id!), '已记录你对此次文字成果的确认')}>{taskBusy ? pending[task.id] : '确认此稿成果'}</button>}</div>{needsReview(task) && !task.run_id && <p role="alert" className="text-xs text-red-500 mt-2">运行标识缺失，无法安全确认。请刷新核验。</p>}</section>}
                  {task.history.length > 0 && <details className="workspace-history"><summary>过程与用量 · 最近 {task.history.length} 次</summary><ol>{[...task.history].reverse().map(history => <li key={history.id} className="py-4 border-b border-border last:border-0"><p className="text-xs font-medium">{dateLabel(history.finished_at)} · {history.source_stale ? '来源已变化，历史内容不可据此验收' : history.status === 'outcome_unknown' ? '结果与费用待核验' : history.status === 'failed' ? '生成失败' : history.status === 'accepted' || history.id === task.accepted_run_id ? '已验收' : '已生成，未验收'}</p><p className="text-xs text-text-muted mt-2">{history.usage_status === 'provider_reported' && history.usage ? `服务商用量：输入 ${history.usage.inputTokens} / 输出 ${history.usage.outputTokens} / 总计 ${history.usage.totalTokens} tokens；费用未核算` : '用量与费用未核实，请以服务商账单为准'}</p>{history.error && <p className="text-xs text-red-500 mt-2">{history.error}</p>}{history.result && <p className="text-xs whitespace-pre-wrap break-words mt-3">{history.result}</p>}</li>)}</ol></details>}
                  {task.run_id && <details className="text-xs text-text-muted"><summary>核验标识</summary><p className="break-all mt-2">{task.run_id}</p></details>}
                  {task.status !== 'running' && task.status !== 'outcome_unknown' && <button className="text-xs text-red-500 hover:underline" disabled={taskBusy} onClick={() => void remove(task)}>删除任务与成果</button>}
                </div></motion.div>}</AnimatePresence>
              </motion.article>;
            })}</div>
            {!visibleTasks.length && <div className="workspace-empty"><span className="text-3xl text-accent" aria-hidden="true">{taskSearch || filter !== 'all' || stage !== 'all' ? '⌕' : '↗'}</span><h3 className="font-medium mt-3">{loading && !tasks.length ? '正在加载任务' : tasks.length ? '没有符合条件的任务' : '从一个值得继续的想法开始'}</h3><p className="text-sm text-text-secondary mt-2">{tasks.length ? '可以换个关键词，或清除筛选查看全部。' : '保存目标和背景，连接模型后生成草稿，最后由你检查成果。'}</p>{tasks.length ? <button className="workspace-button mt-5" onClick={() => { setTaskSearch(''); setFilter('all'); setStage('all'); }}>清除筛选</button> : <button className="workspace-primary mt-5" onClick={() => void startTask()}>写下第一个任务</button>}</div>}
          </section>
          <section className="mt-9" aria-labelledby="scenes-title"><h2 id="scenes-title" className="text-sm font-semibold mb-3">换个场景，打开思路</h2><div className="grid md:grid-cols-3 gap-3">{templates.map(template => <article className={`workspace-scene scene-${template.category}`} key={template.category}><span className="text-xl text-accent" aria-hidden="true">{template.symbol}</span><h3 className="font-semibold text-sm mt-3">{template.title}</h3><p className="text-xs text-text-secondary mt-2 mb-4 leading-relaxed">{template.description}</p><div className="flex flex-wrap gap-2"><button className="workspace-button" disabled={spaceBusy !== null} onClick={() => void createSpace(template)}>{spaceBusy === template.category ? '创建中…' : '创建会话'}</button><button className="workspace-button" onClick={() => void startTask(template)}>从模板起草</button></div></article>)}</div></section>
        </>}
      </motion.div>
    </div>{ConfirmModal}
  </div>;
}
