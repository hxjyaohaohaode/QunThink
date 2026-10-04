import { useCallback, useEffect, useRef, useState } from 'react';
import { memoryApi, type MemoryRecord } from '../../services/memory';
import { useGroupsStore } from '../../stores/groupsStore';
import { useConfirm } from '../Common';

const field = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-accent/30';
const button = 'rounded-xl px-3 py-2 text-xs border border-border text-text-secondary hover:bg-bg-surface2 disabled:opacity-40';

export function MemoryCenter() {
  const groups = useGroupsStore(state => state.groups);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const pendingCreate = useRef<{ content: string; key: string } | null>(null);
  const busyRef = useRef(false);
  const loadEpoch = useRef(0);
  const { confirm, ConfirmModal } = useConfirm();

  const refresh = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setLoadingMore(false);
    try {
      const result = await memoryApi.list();
      if (epoch !== loadEpoch.current) return;
      setMemories(result.memories);
      setTotal(result.total);
      setError('');
    } catch (cause) {
      if (epoch === loadEpoch.current) setError(cause instanceof Error ? cause.message : '记忆读取失败');
    } finally {
      if (epoch === loadEpoch.current) setLoading(false);
    }
  }, []);

  async function loadMore() {
    if (loadingMore || loading || memories.length >= total) return;
    const epoch = ++loadEpoch.current;
    setLoadingMore(true);
    try {
      const result = await memoryApi.list(memories.length);
      if (epoch !== loadEpoch.current) return;
      setMemories(current => {
        const seen = new Set(current.map(memory => memory.id));
        return [...current, ...result.memories.filter(memory => !seen.has(memory.id))];
      });
      setTotal(result.total);
      setError('');
    } catch (cause) {
      if (epoch === loadEpoch.current) setError(cause instanceof Error ? cause.message : '较早记录读取失败');
    } finally {
      if (epoch === loadEpoch.current) setLoadingMore(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => { loadEpoch.current += 1; };
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作结果未确认，请刷新核对后再试');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function saveNote() {
    const content = note.trim();
    if (!content || content.length > 5000) return;
    void run(async () => {
      if (pendingCreate.current?.content !== content) {
        pendingCreate.current = { content, key: crypto.randomUUID() };
      }
      await memoryApi.store(content, pendingCreate.current.key);
      pendingCreate.current = null;
      setNote('');
      setNotice('记录已保存；目前不会自动当作已核实事实或发送给其他群。');
      await refresh();
    });
  }

  function saveCorrection(memory: MemoryRecord) {
    const content = editText.trim();
    if (!content || content.length > 5000 || memory.kind !== 'user_note') return;
    void run(async () => {
      await memoryApi.correct(memory.id, content, memory.revision);
      setEditingId(null);
      setNotice('更正已保存；请检查依赖旧内容的草稿和已发布内容。');
      await refresh();
    });
  }

  async function forget(memory: MemoryRecord) {
    if (!await confirm({ title: '遗忘这条记忆',
      description: '这会撤销当前记录并清除其中保存的正文。已导出的文件及外部副本需要分别处理。',
      danger: true })) return;
    void run(async () => {
      await memoryApi.forget(memory.id);
      if (editingId === memory.id) setEditingId(null);
      setNotice('该记录已撤销。');
      await refresh();
    });
  }

  return <section className="max-w-3xl space-y-5" aria-label="个人记忆记录">
    <div><h2 className="text-xl font-semibold">个人记忆记录</h2>
      <p className="text-sm text-text-secondary mt-1">这里只保存你主动写下的笔记和从消息保存的摘录。摘录未经事实核验；个人笔记目前不会自动进入群聊上下文。</p></div>
    <form className="rounded-2xl border border-border bg-bg-surface p-4 space-y-3" onSubmit={event => { event.preventDefault(); saveNote(); }}>
      <label className="block text-sm font-medium" htmlFor="memory-note">写一条个人笔记</label>
      <textarea id="memory-note" className={field} value={note} maxLength={5000} rows={3}
        onChange={event => setNote(event.target.value)} placeholder="记录需要以后查看或更正的内容" />
      <button type="submit" disabled={busy || !note.trim()} className="rounded-xl px-4 py-2 text-sm bg-accent text-white disabled:opacity-40">{busy ? '处理中…' : '保存笔记'}</button>
    </form>
    {error && <div role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-500">{error} <button className="underline ml-2" onClick={() => void refresh()}>刷新核对</button></div>}
    {notice && <p role="status" className="text-sm text-text-secondary">{notice}</p>}
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">可查看记录（{total}）</h3><button className={button} disabled={loading} onClick={() => void refresh()}>刷新</button></div>
    {loading ? <p className="text-sm text-text-muted">正在读取…</p> : memories.length === 0 ? <p className="text-sm text-text-muted">暂无可查看记录</p> : <div className="space-y-3">
      {memories.map(memory => {
        const groupName = memory.source ? groups.find(group => group.id === memory.source?.groupId)?.name : null;
        return <article key={memory.id} className="rounded-2xl border border-border bg-bg-surface p-4 space-y-3">
          <div className="text-xs text-text-muted">{memory.kind === 'user_note' ? '个人笔记 · 用户自述，未核验' : `消息摘录 · ${groupName || memory.source?.groupId || '来源群已不可用'} · 未核验`} · {new Date(memory.recordedAt).toLocaleString()}</div>
          {editingId === memory.id ? <div className="space-y-2"><textarea aria-label="更正个人笔记" className={field} value={editText} rows={3} maxLength={5000} onChange={event => setEditText(event.target.value)} /><div className="flex gap-2"><button className={button} disabled={busy || !editText.trim()} onClick={() => saveCorrection(memory)}>保存更正</button><button className={button} onClick={() => setEditingId(null)}>取消</button></div></div> : <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{memory.content}</p>}
          <div className="flex gap-2">{memory.kind === 'user_note' && editingId !== memory.id && <button className={button} disabled={busy} onClick={() => { setEditingId(memory.id); setEditText(memory.content); }}>更正</button>}<button className={button} disabled={busy} onClick={() => void forget(memory)}>遗忘</button></div>
        </article>;
      })}
      {total > memories.length && <button className={button} disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '读取中…' : `加载较早记录（还有 ${total - memories.length} 条）`}</button>}
    </div>}
    {ConfirmModal}
  </section>;
}
