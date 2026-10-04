import { getDiagnosticSurface, setDiagnosticSurface } from '../../observability/runtimeDiagnostics';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTasksStore } from '../../stores/tasksStore';
import { useTaskResultsStore } from '../../stores/taskResultsStore';
import { useMessagesStore } from '../../stores/messagesStore';
import { MessageContent } from '../Chat/MessageContent';
import { useGroupsStore } from '../../stores/groupsStore';
import { getAuthGeneration } from '../../services/api';
import { getCacheUserId } from '../../utils/cacheUtils';
import { useFocusTrap } from '../Common/useFocusTrap';
import { TaskResultEditor } from './TaskResultEditor';

export function ConversationWriting({ groupId, children }: { groupId: string; children: ReactNode }) {
  const open = useTaskResultsStore(state => state.panelGroupId === groupId);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => { const query = window.matchMedia('(max-width: 1100px)'); const update = () => setNarrow(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  return <div className={`conversation-writing ${open ? 'has-writing' : ''}`}><div className="conversation-writing-chat" {...(open && narrow ? { inert: '' } as Record<string, string> : {})}>{children}</div>{open && <WritingPanel groupId={groupId} narrow={narrow} />}</div>;
}
function WritingPanel({ groupId, narrow }: { groupId: string; narrow: boolean }) {
  const tasks = useTasksStore(state => state.tasks);
  const incomingSourceId = useTaskResultsStore(state => state.incomingSourceId);
  const selected = useTaskResultsStore(state => state.selectedTaskId);
  const draft = useTasksStore(state => state.composerDraft);
  const selectedSourceId = incomingSourceId || draft.sourceMessageId || null;
  const source = useMessagesStore(state => state.messages[groupId]?.find(message => message.id === selectedSourceId));
  const createPending = useTasksStore(state => state.pending.create);
  const recoveredCreate = useTasksStore(state => state.recoveredCreate);
  const uncertainCreate = useTasksStore(state => state.uncertainCreate);
  const group = useGroupsStore(state => state.groups.find(item => item.id === groupId));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const handledRecovery = useRef<typeof recoveredCreate>(null);
  const close = () => useTaskResultsStore.getState().closePanel();
  const panelRef = useFocusTrap<HTMLElement>(narrow, close);
  useEffect(() => {
    const previous = getDiagnosticSurface(); setDiagnosticSurface('writing');
    void useTasksStore.getState().fetch();
    return () => { if (previous !== 'writing' && getDiagnosticSurface() === 'writing') setDiagnosticSurface(previous); };
  }, [groupId]);
  useEffect(() => {
    if (!recoveredCreate || handledRecovery.current === recoveredCreate) return;
    setError('');
    if (recoveredCreate.deleted) handledRecovery.current = recoveredCreate;
    if (recoveredCreate.taskId && tasks.some(task => task.id === recoveredCreate.taskId && task.group_id === groupId)) { handledRecovery.current = recoveredCreate; setCreating(false); useTaskResultsStore.setState({ selectedTaskId: recoveredCreate.taskId }); }
  }, [recoveredCreate, tasks, groupId]);
  const matches = tasks.filter(task => task.group_id === groupId);
  const active = matches.find(task => task.id === selected);
  const otherDraft = !!draft.groupId && draft.groupId !== groupId && (!!draft.title || !!draft.prompt);
  function update(patch: Partial<typeof draft>) { useTasksStore.getState().setComposerDraft({ ...useTasksStore.getState().composerDraft, groupId, ...patch }); }
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (createPending || otherDraft || (!uncertainCreate && selectedSourceId && !source)) return;
    setError(''); const user = getCacheUserId(), generation = getAuthGeneration();
    try {
      const sourceId = uncertainCreate ? draft.sourceMessageId || null : selectedSourceId;
      const sourceEditedAt = uncertainCreate ? draft.sourceMessageEditedAt : source?.edited_at ?? null;
      if (!uncertainCreate) update({ sourceMessageId: sourceId || '', sourceMessageEditedAt: sourceEditedAt });
      const saved = await useTasksStore.getState().create({ title: draft.title, prompt: draft.prompt, category: group?.space_category === 'play' ? 'play' : group?.space_category === 'social' ? 'social' : 'work', group_id: groupId, model_id: null, source_message_id: sourceId, source_message_edited_at: sourceEditedAt, auto_run: false, run_at: null, repeat_minutes: null });
      if (user !== getCacheUserId() || generation !== getAuthGeneration()) return;
      setCreating(false); await useTaskResultsStore.getState().select(saved.id);
    } catch (error) { if (user === getCacheUserId() && generation === getAuthGeneration()) setError(error instanceof Error ? error.message : '无法保存，请保留输入并重试'); }
  }
  return <aside data-observe="writing" ref={panelRef} role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="会话文稿" className={`writing-panel ${narrow ? 'is-sheet' : ''}`}>
    <div className="writing-panel-toolbar"><button className="writing-link" onClick={() => { handledRecovery.current = recoveredCreate; setCreating(false); useTaskResultsStore.setState({ selectedTaskId: null }); }}>← 此会话的文稿{matches.length ? ` · ${matches.length}` : ''}</button><button className="writing-close" aria-label="收起文稿，返回对话" onClick={close}>×</button></div>
    <div className="writing-panel-scroll">{recoveredCreate && <p role="status" className="writing-feedback mb-3">{recoveredCreate.deleted ? '上次保存已核验；原任务后来已删除，没有重新创建' : '已找到上次保存的同一份文稿，可以继续编辑'}</p>}{active && !creating ? <TaskResultEditor key={active.id} taskId={active.id} /> : <div className="writing-start">
      <p className="writing-eyebrow">从讨论，到你自己的作品</p><h2>写在这段对话旁边</h2><p className="writing-help">邀请、笔记、文章、学习小结。材料留在对话中，正文可以反复修改与核对。</p>
      {matches.length > 0 && <ol className="writing-task-list">{matches.map(task => <li key={task.id}><button onClick={() => { setCreating(false); void useTaskResultsStore.getState().select(task.id); }}><span>{task.title}</span><small>{task.source_stale ? '来源待复核' : task.status === 'completed' ? '打开已保存文稿' : task.result ? '继续检查与编辑' : '继续写正文'} →</small></button></li>)}</ol>}
      {!creating && matches.length > 0 ? <button className="workspace-button" onClick={() => { useTasksStore.setState({ recoveredCreate: null }); setCreating(true); }}>＋ 写一份新文稿</button> : <form className="writing-new-form" onSubmit={event => void create(event)}>
        <h3>先说明这份文稿的用途</h3><p className="writing-help">保存后即可人工写作，无需连接模型，也不会自动调用 AI。</p>
        {selectedSourceId && <section className="writing-selected-source"><p className="writing-eyebrow">从这条消息开始</p>{source ? <MessageContent content={source.content} isUser={source.sender_type === 'user'} /> : <p role="alert">原消息暂不可用，请先返回对话核对，或明确改用此会话近期材料。</p>}<button type="button" className="writing-link" disabled={!!createPending || uncertainCreate} onClick={() => { useTaskResultsStore.setState({ incomingSourceId: null }); update({ sourceMessageId: '', sourceMessageEditedAt: null }); }}>改为只关联会话近期材料</button></section>}
        {otherDraft ? <p role="alert" className="writing-warning">另一会话还有未保存的任务要求。请先在工作台继续保存，避免替换已有输入。</p> : <><fieldset disabled={!!createPending || uncertainCreate}><label>文稿名称<input required maxLength={150} value={draft.title} onChange={event => update({ title: event.target.value })} placeholder="例如：读书活动邀请" className="workspace-input" /></label><label>用途与检查要求<textarea required maxLength={12000} rows={4} value={draft.prompt} onChange={event => update({ prompt: event.target.value })} placeholder="写给谁、想传达什么？哪些日期或要求必须核对？" className="workspace-input" /></label></fieldset><p className="writing-material-note">材料范围：此会话最近最多 40 条消息{selectedSourceId ? '；上面的起始消息会另行保留来源标识' : ''}。先展示实际读取的材料供你检查；不会把用途描述当成已完成的正文。</p><button className="workspace-primary" disabled={!!createPending || !draft.title.trim() || !draft.prompt.trim() || (!uncertainCreate && !!selectedSourceId && !source)}>{createPending ? '正在建立文稿…' : uncertainCreate ? '核验并重试保存' : '保存用途，开始写正文'}</button></>}
        {error && <p role="alert" className="writing-feedback is-error">{error}</p>}
      </form>}
    </div>}</div>
  </aside>;
}
