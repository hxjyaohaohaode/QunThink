import { getDiagnosticSurface, setDiagnosticSurface } from '../../observability/runtimeDiagnostics';
import { useEffect, useRef, useState } from 'react';
import { resultHead, useTaskResultsStore } from '../../stores/taskResultsStore';
import { useTasksStore } from '../../stores/tasksStore';
import { useModelsStore } from '../../stores/modelsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { setWritingPreferences, writingPreferences } from '../../utils/taskRecovery';
import { MessageContent } from '../Chat/MessageContent';
import { useConfirm } from '../Common/useConfirm';
import { getAuthGeneration } from '../../services/api';
import { getCacheUserId } from '../../utils/cacheUtils';

export function TaskResultEditor({ taskId, onOpenConversation }: { taskId: string; onOpenConversation?: (groupId: string) => void }) {
  const document = useTaskResultsStore(state => state.documents[taskId]);
  const editor = useTaskResultsStore(state => state.editors[taskId]);
  const offline = useTaskResultsStore(state => state.offline[taskId]);
  const pending = useTaskResultsStore(state => state.pending[taskId]);
  const uncertain = useTaskResultsStore(state => state.uncertain[taskId]);
  const unresolvedCount = useTaskResultsStore(state => state.uncertainQueues[taskId]?.length || 0);
  const recoveryError = useTaskResultsStore(state => state.recoveryError);
  const error = useTaskResultsStore(state => state.errors[taskId]);
  const notice = useTaskResultsStore(state => state.notices[taskId]);
  const loading = useTaskResultsStore(state => state.loading[taskId]);
  const task = useTasksStore(state => state.tasks.find(item => item.id === taskId));
  const taskPending = useTasksStore(state => state.pending[taskId]);
  const ready = useModelsStore(state => state.catalog?.models.some(model => model.ready && model.verifiedCapabilities?.includes('chat')));
  const brief = useTaskResultsStore(state => state.briefs[taskId] ?? null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [feedback, setFeedback] = useState('');
  const [settings, setSettings] = useState(writingPreferences);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const { confirm, ConfirmModal } = useConfirm();
  useEffect(() => {
    const previous = getDiagnosticSurface(); setDiagnosticSurface('writing');
    return () => { if (previous !== 'writing' && getDiagnosticSurface() === 'writing') setDiagnosticSurface(previous); };
  }, []);
  useEffect(() => {
    void useTaskResultsStore.getState().select(taskId);
    const refresh = () => { if (!window.document.hidden) void useTaskResultsStore.getState().fetch(taskId); };
    const timer = setInterval(refresh, 10000);
    const recover = () => { void useTaskResultsStore.getState().recover(taskId); };
    window.addEventListener('storage', recover);
    window.addEventListener('online', refresh); window.document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('storage', recover); window.removeEventListener('online', refresh); window.document.removeEventListener('visibilitychange', refresh); };
  }, [taskId]);
  useEffect(() => {
    if (!editor?.dirty && !uncertain && brief === null) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [editor?.dirty, uncertain, brief]);
  useEffect(() => { setMode('edit'); setFeedback(''); }, [taskId]);
  const version = resultHead(document);
  const blocked = document?.source.status === 'blocked';
  const stale = document?.source.status === 'changed' || version?.source_status === 'changed';
  const accepted = !!version && document?.accepted_version_id === version.id && document.accepted_content_hash === version.content_hash && !stale && !blocked;
  async function action(fn: () => Promise<void>) { setFeedback(''); try { await fn(); } catch (error) { setFeedback(error instanceof Error ? error.message : '暂时无法完成，请保留文字并重试'); } }
  function selectText() {
    setMode('edit');
    requestAnimationFrame(() => { bodyRef.current?.focus(); bodyRef.current?.select(); });
    setFeedback('已选中全文。可使用系统复制菜单，或 Ctrl/Cmd+C 复制');
  }
  async function copy() {
    if (!editor || blocked) return;
    try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(editor.body); setFeedback('已复制当前全文'); }
    catch { setFeedback('浏览器未允许自动复制。请选择全文后手动复制，或下载文本'); }
  }
  function download() {
    if (!editor || blocked) return;
    const url = URL.createObjectURL(new Blob([editor.body], { type: 'text/plain;charset=utf-8' }));
    const link = window.document.createElement('a'); link.href = url; link.download = `${document?.title || '群想文稿'}.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setFeedback('已准备文本下载，请查看浏览器的下载记录');
  }
  async function preference(key: 'recoverDrafts' | 'offlineCopies', enabled: boolean) {
    if (!enabled && !await confirm({ title: key === 'recoverDrafts' ? '关闭此设备的草稿恢复？' : '关闭私人离线副本？', description: key === 'recoverDrafts' ? '将移除此设备的加密草稿副本。当前页面文字保留，但刷新或关闭后，未保存到服务器的修改将无法恢复。必要的请求编号仍保留。' : '将移除已保存文稿的设备内容副本。服务器版本和必要的请求编号仍保留。' })) return;
    try { const next = { ...writingPreferences(), [key]: enabled }; setWritingPreferences(next); setSettings(next); useTaskResultsStore.getState().refreshRecovery(); if (enabled && key === 'offlineCopies') void useTaskResultsStore.getState().fetch(taskId); setFeedback('设备保存选择已更新'); }
    catch (error) { setFeedback(error instanceof Error ? error.message : '无法保存选择'); }
  }
  async function run() {
    if (!task || editor?.dirty || uncertain) return;
    if (!await confirm({ title: '让 AI 提供一个候选稿？', description: '会将任务用途和关联会话资料发送给已配置的模型服务商，可能产生费用。现有人工正文保留，新文字需要你选择是否采用。' })) return;
    await action(async () => { await useTasksStore.getState().run(taskId); await useTaskResultsStore.getState().fetch(taskId); });
  }
  async function resolveRun(decision: 'allow_retry' | 'abandon') {
    const runId = document?.generation.run_id;
    if (!runId) { setFeedback('缺少本次生成请求的标识，请先核对服务器最新状态'); return; }
    if (!await confirm(decision === 'allow_retry' ? { title: '记录核验并允许重试', description: '请先核对服务商记录中的处理结果和费用。此操作只解除重试限制，不会立即发起调用；之后的新生成可能再次收费。' } : { title: '停止这次任务生成', description: '停止后续生成，人工文稿保持原样。服务商可能已经处理的请求和费用不会被撤销。' })) return;
    await action(async () => { await useTasksStore.getState().resolveUnknown(taskId, runId, decision); await useTaskResultsStore.getState().fetch(taskId); });
  }
  async function closeOriginal() {
    const receipt = uncertain; if (!receipt) return;
    const key = receipt.key, user = getCacheUserId(), generation = getAuthGeneration();
    const kind = receipt.action === 'accept_revision' ? '版本验收' : receipt.action === 'adopt_revision' ? '版本采用' : receipt.action === 'review_brief' ? '用途更新' : '文稿保存';
    if (!await confirm({ title: `核对并结束这次待确认的${kind}请求`, description: '若原请求已提交，将返回原版本，保持已保存内容不变；若尚未提交，只结束这次旧请求，随后可提交新输入。当前输入保留，不会删除版本、撤销验收、停止 AI 或退费。', confirmText: '核对并结束这次请求' })) return;
    if (user !== getCacheUserId() || generation !== getAuthGeneration()) return;
    await action(() => useTaskResultsStore.getState().closeCommand(taskId, key));
  }
  const pendingRecovery = uncertain && <section className="writing-warning" aria-label="待确认的文稿请求">
    <h3>这次文稿操作待确认{unresolvedCount > 1 ? ` · 还有 ${unresolvedCount - 1} 次待逐条处理` : ''}</h3>
    <p className="writing-help">{Number.isFinite(Date.parse(uncertain.createdAt)) ? new Date(uncertain.createdAt).toLocaleString('zh-CN') : '此前'}的请求。可以继续编辑；处理完旧请求后再保存新输入。</p>
    {!useTaskResultsStore.getState().canRetry(taskId) && uncertain.action === 'save_revision' && <p className="writing-help">原文字未保存在此设备，请重新填写或从已存版本继续。</p>}
    <div className="flex flex-wrap gap-2 mt-2"><button className="workspace-button" disabled={!!pending} onClick={() => void action(() => useTaskResultsStore.getState().verify(taskId, uncertain.key))}>核验原请求</button><button className="workspace-button" disabled={!!pending} onClick={() => void closeOriginal()}>核对并结束这次请求</button>{!blocked && !offline && useTaskResultsStore.getState().canRetry(taskId) && <button className="writing-link" disabled={!!pending} onClick={() => void action(() => useTaskResultsStore.getState().retry(taskId, uncertain.key))}>按原内容重试同一请求</button>}</div>
  </section>;
  if (!document || !editor) return <div className="writing-loading" aria-live="polite"><p>{loading ? '正在打开同一份文稿…' : error || notice || '尚未读取到文稿'}</p>{pendingRecovery}<button className="workspace-button" onClick={() => void useTaskResultsStore.getState().select(taskId)}>重新读取</button>{ConfirmModal}</div>;
  const recoveryLabel = editor.recovery === 'saved' ? '未提交修改已加密保存在此设备' : editor.recovery === 'saving' ? '正在加密保存此设备草稿…' : editor.recovery === 'failed' ? '设备恢复保存失败，请保存版本或下载文本' : '未提交修改只在当前页面；可开启设备草稿恢复';
  return <div className="task-result-editor" data-testid="task-result-editor" data-observe="writing" data-task-id={taskId}>
    <header className="writing-document-heading"><div><p className="writing-eyebrow">同一会话 · 持续编辑</p><h2>{document.title}</h2></div><span className={`writing-state ${stale || blocked ? 'is-warning' : accepted ? 'is-accepted' : ''}`}>{blocked ? '来源不可用' : stale ? '需要复核' : editor.dirty ? '有未提交修改' : accepted ? `版本 ${version?.sequence} 已验收` : version ? `版本 ${version.sequence} 待检查` : '开始写正文'}</span></header>
    {recoveryError && <section className="writing-warning" aria-label="待核验记录读取失败"><p role="alert">{recoveryError}</p><button className="workspace-button" onClick={() => void useTaskResultsStore.getState().recover(taskId)}>重新读取待核验记录</button></section>}
    {pendingRecovery}
    {offline && <div className="writing-warning" role="status">离线副本 · 来源和权限尚未联网核对，可编辑此设备草稿，联网后再保存版本</div>}
    <p className="writing-help">{task?.prompt?.trim() ? <>用途：{task.prompt.slice(0, 120)}{task.prompt.length > 120 ? '…' : ''}</> : document.generation.source_input_stale ? '原用途待重新确认，展开用途与来源核对' : '用途暂不可读，请核对来源与当前账号权限'}</p>
    <details className="writing-context">
      <summary>用途与来源 · {document.source.messages.length} 条材料{stale ? ` · ${document.source.messages.filter(source => source.change !== 'unchanged').length} 条新增或修改` : ''} · 展开核对</summary>
      <p className="writing-purpose">{task?.prompt}</p>
      {(document.generation.source_input_stale || brief !== null) && <div className="writing-warning"><p>{document.generation.source_input_stale ? '原要求引用了已修改的消息。核对最新材料后，可在同一任务中更新用途，已有人工文稿保持不变。' : '服务器用途已有更新，你的未保存用途仍保留；请核对后保存或明确放弃。'}</p><label className="workspace-label">重新确认任务用途<textarea className="workspace-input" value={brief ?? task?.prompt ?? ''} onChange={event => useTaskResultsStore.getState().editBrief(taskId, event.target.value)} /></label>{brief !== null && <p className="writing-help">用途修改尚未保存；切换页面会保留，刷新或关闭前请保存此用途。</p>}<button className="workspace-button" disabled={!!recoveryError || !!pending || !!uncertain || blocked || offline || !((brief ?? task?.prompt) || '').trim() || editor.reviewedSourceHash !== document.source.hash} onClick={() => void action(async () => { await useTaskResultsStore.getState().updateBrief(taskId, brief ?? task?.prompt ?? '', document.source.hash); await useTasksStore.getState().fetch(); })}>按已复核来源更新用途</button>{brief !== null && <button className="writing-link ml-3" disabled={!!pending || !!uncertain} onClick={() => void action(async () => { const captured = brief; if (await confirm({ title: '放弃未保存的用途修改？', description: '只移除此页面保留的用途输入，不删除已保存正文、版本或原请求回执。' })) useTaskResultsStore.getState().discardBrief(taskId, captured); })}>放弃未保存的用途修改</button>}</div>}
      <p className="writing-help">这份文稿关联当前会话材料。核对明确的更正、日期和缺口；保存与验收不会自动发送给任何人。</p>
      {document.source.message && <p className="writing-source-warning">{document.source.message}</p>}
      <ol className="writing-sources">{document.source.messages.map((source, index) => <li key={source.id} data-source-id={source.id} className={source.change !== 'unchanged' ? 'is-changed' : ''}><div className="writing-source-heading"><span>材料 {index + 1} · {source.sender_type === 'user' ? '用户' : 'AI / 系统'}{source.change === 'changed' ? ' · 已修改' : source.change === 'added' ? ' · 新增' : ''}</span><button onClick={() => { useTaskResultsStore.getState().closePanel(); if (document.group_id) onOpenConversation?.(document.group_id); useNavigationStore.getState().setScrollToMessageId(source.id); }} className="writing-link">定位消息</button></div><details className="writing-source-body"><summary>查看这条材料全文</summary><MessageContent content={source.content} isUser={source.sender_type === 'user'} alwaysExpanded /></details></li>)}</ol>
      {!!document.source.missing_message_ids.length && <p role="alert">部分来源已撤回或不可见，暂时不能继续验收</p>}
      {!blocked && document.source.hash && <label className="writing-source-check"><input type="checkbox" checked={editor.reviewedSourceHash === document.source.hash} onChange={event => { useTaskResultsStore.getState().reviewSources(taskId, event.target.checked ? document.source.hash! : ''); }} />我已核对上面这组材料，保存时记录此次来源复核</label>}
    </details>
    {stale && <div className="writing-warning" role="status">来源已变化，先前验收不再代表当前材料。人工文字已保留，请核对正文、勾选来源复核，再保存一个新版本。</div>}
    {blocked ? <div className="writing-warning" role="alert">来源已撤回或权限已变化。为避免继续使用失效资料，正文暂不显示，也不能保存、复制或验收。请恢复合法来源后重新读取。</div> : <>
      <div className="writing-mode" role="group" aria-label="正文显示方式"><button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑正文</button><button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>全文预览</button><span>{editor.body.length.toLocaleString()} 字</span></div>
      {mode === 'edit' ? <label className="writing-body-label">文稿正文<textarea ref={bodyRef} aria-label="文稿正文" className="writing-body" value={editor.body} maxLength={64000} spellCheck onChange={event => useTaskResultsStore.getState().edit(taskId, event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); if (!pending && !uncertain && !editor.conflict && !offline) void action(() => useTaskResultsStore.getState().save(taskId)); } }} placeholder="直接写下邀请、文章或学习笔记。也可以连接模型后获取候选稿。" /></label> : <section className="writing-preview" aria-label="文稿全文预览"><MessageContent content={editor.body} isUser={false} alwaysExpanded /></section>}
      <p className={`writing-recovery ${editor.recovery === 'failed' ? 'is-warning' : ''}`} role="status">{editor.dirty ? recoveryLabel : version ? `服务器已保存版本 ${version.sequence} · ${editor.recovery === 'off' ? '设备草稿恢复未开启' : '设备草稿恢复已开启'}` : recoveryLabel}</p>
      {editor.conflict && <div className="writing-warning" role="alert"><p>服务器有较新的版本，你的输入没有被替换。请比较下面的服务器全文，再决定是否将当前输入保存为它之后的新版本。</p><details><summary>比较服务器当前版本</summary><div className="writing-comparison"><MessageContent content={version?.content || ''} isUser={false} alwaysExpanded /></div></details><button className="workspace-button" disabled={!!uncertain || !!pending} onClick={() => useTaskResultsStore.getState().rebase(taskId)}>已比较，保留我的文字继续</button></div>}
      <div className="writing-primary-actions"><button className="workspace-primary" disabled={!!recoveryError || !!offline || !!pending || !!uncertain || editor.conflict || !editor.body.trim()} onClick={() => void action(() => useTaskResultsStore.getState().save(taskId))}>{pending || (stale && editor.reviewedSourceHash ? '保存复核后的新版本' : '保存为新版本')}</button>{version && <button className="workspace-button" disabled={!!recoveryError || !!offline || !!pending || !!uncertain || editor.dirty || !!stale || editor.conflict || accepted || ['running', 'outcome_unknown'].includes(document.generation.status)} onClick={() => void action(() => useTaskResultsStore.getState().accept(taskId, version.id, version.content_hash, document.source.hash))}>{accepted ? `已验收版本 ${version.sequence}` : `验收版本 ${version.sequence}`}</button>}</div>
      {editor.dirty && version && <p className="writing-help">先保存修改，再验收你实际检查过的版本</p>}
      <div className="writing-delivery"><button className="writing-link" onClick={() => void copy()}>复制全文</button><button className="writing-link" onClick={selectText}>选择全文</button><button className="writing-link" onClick={download}>下载文本</button></div>
    </>}
    {(feedback || error || notice) && <div className={`writing-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'} aria-live="polite">{feedback || error || notice}</div>}

    <details className="writing-history"><summary>版本与生成记录 · {document.versions.length} 个版本</summary><ol>{[...document.versions].reverse().map(item => <li key={item.id}><p><strong>版本 {item.sequence}</strong> · {item.kind === 'manual' ? '人工编辑' : 'AI 候选'}{item.id === document.head_version_id ? ' · 当前正文' : ''}{item.id === document.accepted_version_id ? ' · 曾验收' : ''}{item.source_status !== 'current' ? ' · 来源待复核' : ''}</p><p className="writing-version-meta">{new Date(item.created_at).toLocaleString('zh-CN')}</p><details className="writing-version-meta"><summary>技术核验标识</summary><p>SHA-256 {item.content_hash}</p></details>{!item.content_hidden && <details><summary>展开完整版本</summary><MessageContent content={item.content} isUser={false} alwaysExpanded /></details>}{!item.content_hidden && item.id !== document.head_version_id && <button className="workspace-button" disabled={!!offline || editor.dirty || !!pending || !!uncertain || blocked} onClick={() => void action(async () => { if (await confirm({ title: `采用版本 ${item.sequence}？`, description: '将它设为当前正文；已有版本仍保留。请先检查全文和来源，采用不等于验收。' })) await useTaskResultsStore.getState().adopt(taskId, item.id); })}>检查后采用此版本</button>}</li>)}</ol></details>
    {document.generation.status === 'outcome_unknown' && <section className="writing-warning" aria-label="生成请求核验"><h3>上次生成结果与费用需要核验</h3><p>连接中断不代表服务商未处理。先检查服务商的调用记录，再选择下一步；人工文稿可继续保存。</p><div className="writing-primary-actions"><button className="workspace-button" disabled={!!taskPending || !document.generation.run_id} onClick={() => void resolveRun('allow_retry')}>已核验，允许重试</button><button className="workspace-button" disabled={!!taskPending || !document.generation.run_id} onClick={() => void resolveRun('abandon')}>停止后续生成</button></div><details><summary>本次运行标识</summary><p className="break-all">{document.generation.run_id || '暂缺，请刷新核验'}</p></details></section>}
    {task && !blocked && <div className="writing-generation"><p className="writing-help">{ready ? 'AI 只提供候选文字，你保留最终选择' : '可以先人工写作；需要 AI 时再到模型中心连接服务商'}</p><button className="workspace-button" disabled={!!offline || !ready || editor.dirty || !!pending || !!uncertain || !!taskPending || document.generation.status === 'running' || document.generation.status === 'outcome_unknown' || task.source_input_stale} onClick={() => void run()}>{taskPending || (document.generation.status === 'outcome_unknown' ? '本次调用需要先核验' : document.generation.status === 'running' ? '正在生成候选稿' : '让 AI 提供候选稿')}</button>{task.source_input_stale && <p className="writing-help">原任务要求引用的消息已修改。请先核对任务要求，不能直接复用旧输入调用模型。</p>}</div>}
    <details className="writing-device"><summary>此设备的保存选择</summary><label><input type="checkbox" checked={settings.recoverDrafts} onChange={event => void preference('recoverDrafts', event.target.checked)} />加密恢复未提交草稿</label><p>仅此浏览器，退出时清除。未开启时，切换页面仍可继续，刷新或关闭会失去未提交修改。</p><label><input type="checkbox" checked={settings.offlineCopies} onChange={event => void preference('offlineCopies', event.target.checked)} />保留私人已保存文稿的加密离线副本</label><p>与草稿恢复、服务器版本和必要请求编号分别管理。离线副本不证明当前权限；重新联网核对后才能使用。</p></details>
    <button className="writing-link writing-refresh" disabled={loading || !!pending} onClick={() => void useTaskResultsStore.getState().fetch(taskId)}>{loading ? '正在同步…' : '核对服务器最新状态'}</button>
    {ConfirmModal}
  </div>;
}
