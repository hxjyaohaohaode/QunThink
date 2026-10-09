import { useEffect, useRef } from 'react';
import dayjs from 'dayjs';
import { motion, useReducedMotion } from 'framer-motion';
import { useMemoryStore, type MemoryScope } from '../../stores/memoryStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { useConfirm } from '../Common';

const field = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60';
const button = 'rounded-xl px-3 py-2 text-xs border border-border text-text-secondary hover:bg-bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 motion-safe:transition-colors';
const primary = `${button} bg-accent text-white border-transparent`;

export function MemoryCenter() {
  const groups = useGroupsStore(state => state.groups);
  const state = useMemoryStore();
  const { memories, total, loading, loadingMore, busy, error, loadError, notice, note, editing, pending } = state;
  const reducedMotion = useReducedMotion();
  const listHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const editInput = useRef<HTMLTextAreaElement>(null);
  const previousEdit = useRef<string | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const { confirm, ConfirmModal } = useConfirm();
  const captureScope = (): MemoryScope => ({ accountId: state.accountId, generation: state.generation });

  useEffect(() => { mounted.current = true; state.activate(); void useMemoryStore.getState().refresh(); return () => { mounted.current = false; }; }, [state.activate]);
  useEffect(() => {
    if (editing) editInput.current?.focus();
    else if (previousEdit.current) (editButtons.current.get(previousEdit.current) || listHeading.current)?.focus({ preventScroll: true });
    previousEdit.current = editing?.id || null;
  }, [editing?.id]);


  async function forget(id: string) {
    const origin = captureScope();
    if (!await confirm({ title: '遗忘这条记忆',
      description: '这会撤销该记录并清除当前保存的正文，也会清除它在本页的更正草稿。已导出的文件及外部副本需要分别处理。', danger: true })) return;
    if (mounted.current) await useMemoryStore.getState().forget(id, origin);
  }
  async function cancelEdit() {
    const origin = captureScope(), edit = useMemoryStore.getState().editing;
    if (edit && edit.text !== edit.baseContent && !await confirm({ title: '放弃更正草稿', description: '尚未提交的更正输入会被清除，已保存的记录不会改变。', danger: true })) return;
    if (mounted.current && edit) useMemoryStore.getState().cancelEdit(origin, edit);
  }
  async function discardCreate() {
    const origin = captureScope(), intent = useMemoryStore.getState().pending;
    if (!intent || intent.type !== 'create') return;
    if (!await confirm({ title: '结束本次保存核对', description: '原请求可能已保存成功。结束核对只会清除本页输入，不会撤销或删除服务器上的记录。请先查看现有记录；再次输入并保存可能形成重复记录。', danger: true })) return;
    if (mounted.current) useMemoryStore.getState().discardCreate(origin, intent);
  }
  const revealRecords = () => { listHeading.current?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' }); listHeading.current?.focus({ preventScroll: true }); };
  const locked = !!pending;
  const transition = { duration: reducedMotion ? 0 : 0.18 };

  return <section className="max-w-3xl space-y-5" aria-label="个人记忆记录" data-observe="memory">
    <div><h2 className="text-xl font-semibold">个人记忆记录</h2>
      <p className="text-sm text-text-secondary mt-1">这里只保存你主动写下的笔记和从消息保存的摘录。摘录未经事实核验；个人笔记目前不会自动进入群聊上下文。</p><details className="text-xs text-text-secondary mt-2"><summary>此设备如何保存遗忘核验信息</summary><p className="mt-2">未完成的遗忘请求可在刷新后继续。成功后仅保留不含正文的记录编号与回执状态，防止其他窗口的旧内容再次显示；不会自动发送新的遗忘请求。退出账号会隐藏这些信息，重新登录同一账号可继续。清除浏览器站点数据会失去设备上的核验信息，不会撤销服务器已完成的遗忘。</p></details></div>


    {pending && <motion.div initial={reducedMotion ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={transition} className="rounded-2xl border border-accent/30 bg-accent/5 p-4 space-y-3" aria-label="操作核对" aria-busy={busy}>
      <p role="status" className="text-sm font-medium">{busy ? '正在等待操作回执…' : pending.type === 'create' ? '笔记保存待核对' : pending.type === 'correct' ? '更正结果待核对' : '遗忘结果待核对'}</p>
      <p className="text-xs text-text-secondary">{pending.type === 'create' ? '核对会复用同一请求和原内容；列表刷新不会替你判断是否重复。' : pending.type === 'correct' ? '先读取当前记录。只有版本未变才重试原更正，不会覆盖其他修订。' : '该记录的正文已隐藏。核对会再次请求遗忘同一条记录并核对结果，不会创建或恢复它。'}</p>
      {!busy && <div className="flex flex-wrap gap-2"><button className={primary} onClick={() => void state.retry()}>{pending.type === 'create' ? '同一请求核对保存' : pending.type === 'correct' ? '核对并重试更正' : '重试核对遗忘'}</button>
        <button className={button} onClick={revealRecords}>查看现有记录</button>
        {pending.type === 'forget' && <button className={button} onClick={state.deferForget}>稍后核对，继续使用</button>}
        {pending.type === 'create' && <button className={button} onClick={() => void discardCreate()}>结束本次核对…</button>}</div>}
    </motion.div>}
    {state.deferredForget.length > 0 && <div className="rounded-xl border border-border p-3 space-y-2" aria-label="尚未确认的遗忘请求">
      <p className="text-sm text-text-secondary">还有 {state.deferredForget.length} 条遗忘结果未确认，正文继续隐藏。此设备仅保存账号归属、记录编号、时间和核验状态；刷新或重开后仍可核对，不保存这条记忆的正文。</p>
      <p className="text-xs text-text-secondary">下方按钮会再次请求遗忘对应的同一记录并核对结果。记录不存在或连接失败时仍保留待核验状态，不会把空列表当作完成。</p>
      <div className="space-y-2">{state.deferredForget.map((id, index) => <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-primary p-2"><div className="min-w-0 text-xs text-text-secondary"><p>请求时间（本地）：{state.forgetStartedAt[id] ? <time dateTime={state.forgetStartedAt[id]}>{dayjs(state.forgetStartedAt[id]).format('YYYY-MM-DD HH:mm')}</time> : '尚未取得'}</p><details className="mt-1"><summary>记录编号 · {id.slice(-8)}</summary><p className="break-all mt-1">{id}</p></details></div><button className={button} disabled={locked || busy} onClick={() => void state.resumeForget(id)}>继续核对遗忘（{index + 1}）</button></div>)}</div>
    </div>}
    {state.recoveryError && <div role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-700 dark:text-red-300">{state.recoveryError}<button className="underline ml-2" onClick={() => void state.refresh()}>重新读取核验记录</button></div>}
    {error && <div role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}
    {notice && <p role="status" className="text-sm text-text-secondary">{notice}</p>}

    <form className="rounded-2xl border border-border bg-bg-surface p-4 space-y-3" aria-busy={busy && pending?.type === 'create'} onSubmit={event => { event.preventDefault(); void state.saveNote(); }}>
      <label className="block text-sm font-medium" htmlFor="memory-note">写一条个人笔记</label>
      <textarea id="memory-note" className={field} value={note} maxLength={5000} rows={3}
        disabled={pending?.type === 'create'} aria-describedby="memory-draft-help"
        onChange={event => state.setNote(event.target.value)} placeholder="记录需要以后查看或更正的内容" />
      <p id="memory-draft-help" className="text-xs text-text-secondary">草稿仅保留在当前标签页内存，切换工作台后可继续；刷新、关闭标签页或退出账号会丢失未保存输入。保存待核对时会锁定原内容。</p>
      <div className="flex items-center justify-between gap-3"><button type="submit" disabled={locked || busy || !!state.recoveryError || !note.trim() || !state.accountId} className={primary}>{busy && pending?.type === 'create' ? '正在保存…' : '保存笔记'}</button><span className="text-xs text-text-secondary" aria-label={`已输入 ${note.length} 字，最多 5000 字`}>{note.length} / 5000</span></div>
    </form>

    {editing && !state.recoveryError && <motion.section aria-label="更正草稿" initial={reducedMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={transition} className="rounded-2xl border border-accent/40 bg-bg-surface p-4 space-y-3">
      <h3 className="text-sm font-semibold">更正个人笔记 · 基于修订 {editing.revision}</h3>
      {editing.current && <div className="rounded-xl bg-bg-primary p-3 space-y-1"><p className="text-xs text-text-secondary">当前保存的修订 {editing.current.revision}，请与下方草稿对照</p><p className="text-sm whitespace-pre-wrap break-words">{editing.current.content}</p></div>}
      <textarea ref={editInput} aria-label="更正个人笔记" className={field} value={editing.text} rows={3} maxLength={5000} readOnly={editing.unavailable} disabled={locked} onChange={event => state.setEditText(event.target.value)} />
      <div className="flex flex-wrap gap-2">{editing.current ? <button className={primary} disabled={locked} onClick={state.rebaseEdit}>基于当前版本继续编辑</button> : !editing.unavailable && <button className={primary} disabled={locked || !editing.text.trim() || editing.text.trim() === editing.baseContent} onClick={() => void state.saveCorrection()}>保存更正</button>}
        <button className={button} disabled={locked} onClick={() => void cancelEdit()}>取消</button></div>
    </motion.section>}

    <div className="flex items-center justify-between gap-3"><h3 ref={listHeading} tabIndex={-1} className="font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">可查看记录（{state.loaded ? total : '待读取'}）</h3><button className={button} disabled={loading} onClick={() => void state.refresh()}>{loading ? '正在刷新…' : '刷新'}</button></div>
    {loadError && <div role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-700 dark:text-red-300">{loadError} <button className="underline ml-2 focus-visible:ring-2 focus-visible:ring-accent/50" onClick={() => void state.refresh()}>重新读取</button></div>}
    <div aria-busy={loading || loadingMore} className="space-y-3">
      {loading && <p role="status" className="text-sm text-text-secondary">正在读取记录…</p>}
      {!loading && !loadError && state.loaded && memories.length === 0 && <p className="text-sm text-text-secondary">{pending?.type === 'forget' || state.deferredForget.length > 0 ? '暂无其他可查看记录，待核对遗忘的正文已隐藏。' : '暂无可查看记录，可以从第一条个人笔记开始。'}</p>}
      {memories.map(memory => {
        const groupName = memory.source ? groups.find(group => group.id === memory.source?.groupId)?.name : null;
        return <motion.article key={memory.id} layout={reducedMotion || editing || pending ? false : 'position'} initial={false} transition={transition} className="rounded-2xl border border-border bg-bg-surface p-4 space-y-3">
          <div className="text-xs text-text-secondary">{memory.kind === 'user_note' ? '个人笔记 · 用户自述，未核验' : `消息摘录 · ${groupName || '来源群已不可用'} · 未核验`} · {new Date(memory.recordedAt).toLocaleString()} · 修订 {memory.revision}</div>
          <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{memory.content}</p>
          <div className="flex gap-2">{memory.kind === 'user_note' && <button ref={element => { if (element) editButtons.current.set(memory.id, element); else editButtons.current.delete(memory.id); }} className={button} disabled={locked || !!editing} onClick={() => state.beginEdit(memory)}>{editing?.id === memory.id ? '正在更正' : '更正'}</button>}<button className={button} disabled={locked} onClick={() => void forget(memory.id)}>遗忘</button></div>
        </motion.article>;
      })}
      {state.nextOffset < total && <button className={button} disabled={loadingMore || loading} onClick={() => void state.loadMore()}>{loadingMore ? '读取中…' : `加载较早记录（还有 ${total - state.nextOffset} 条）`}</button>}
    </div>
    {ConfirmModal}
  </section>;
}
