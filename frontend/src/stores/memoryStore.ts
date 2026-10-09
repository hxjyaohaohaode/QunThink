import { create } from 'zustand';
import { memoryApi, type MemoryRecord } from '../services/memory';
import { getCacheUserId } from '../utils/cacheUtils';
import { recordDiagnostic } from '../observability/runtimeDiagnostics';
import { MEMORY_FORGET_PREFIX, getMemoryForgetReceipt, type MemoryForgetReceipt, parseMemoryForgetReceipt, readMemoryForgetReceipts, rememberMemoryForget, confirmMemoryForget } from '../utils/memoryForgetRecovery';

export interface MemoryScope { accountId: string | null; generation: number; }
interface EditDraft { id: string; text: string; baseContent: string; revision: number; current: MemoryRecord | null; unavailable: boolean; }
type Intent =
  | { type: 'create'; content: string; draft: string; key: string; uncertain: boolean }
  | { type: 'correct'; id: string; content: string; draft: string; revision: number; baseContent: string; uncertain: boolean }
  | { type: 'forget'; id: string; uncertain: boolean };
interface MemoryState extends MemoryScope {
  memories: MemoryRecord[]; total: number; nextOffset: number; loaded: boolean;
  loading: boolean; loadingMore: boolean; loadError: string;
  note: string; editing: EditDraft | null; pending: Intent | null; busy: boolean;
  error: string; notice: string; hiddenIds: string[]; deferredForget: string[];
  recoveryError: string; forgetStartedAt: Record<string, string>; syncForgetReceipts: () => void;
  observeForgetStorage: (key: string | null, value: string | null) => void;
  activate: () => void; cleanup: () => void;
  refresh: () => Promise<void>; loadMore: () => Promise<void>;
  setNote: (text: string) => void; beginEdit: (memory: MemoryRecord) => void;
  setEditText: (text: string) => void; cancelEdit: (scope: MemoryScope, draft: EditDraft) => void;
  rebaseEdit: () => void; saveNote: () => Promise<void>; saveCorrection: () => Promise<void>;
  retry: () => Promise<void>; forget: (id: string, scope: MemoryScope) => Promise<void>;
  discardCreate: (scope: MemoryScope, intent: Intent) => void;
  deferForget: () => void; resumeForget: (id: string) => Promise<void>;
}
const blank = () => ({ memories: [] as MemoryRecord[], total: 0, nextOffset: 0, loaded: false,
  loading: false, loadingMore: false, loadError: '', note: '', editing: null as EditDraft | null,
  pending: null as Intent | null, busy: false, error: '', notice: '', hiddenIds: [] as string[], deferredForget: [] as string[],
  recoveryError: '', forgetStartedAt: {} as Record<string, string> });
function details(error: unknown) {
  const value = error as { status?: number; code?: string; response?: { status?: number; data?: { code?: string } } };
  return { status: value?.status ?? value?.response?.status, code: value?.response?.data?.code ?? value?.code };
}
function definitive(error: unknown) {
  const { status } = details(error);
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}

// Note and correction bodies stay in this tab. Only minimal pending-forget IDs survive reload.
export const useMemoryStore = create<MemoryState>((set, get) => {
  let generation = 0, readSequence = 0;
  const reset = (accountId: string | null) => {
    readSequence++;
    set({ ...blank(), accountId, generation: ++generation });
    if (accountId) syncForgetReceipts();
  };
  const scope = (): MemoryScope => ({ accountId: get().accountId, generation: get().generation });
  const current = (origin: MemoryScope) => {
    const same = origin.generation === get().generation && origin.accountId === get().accountId && origin.accountId === getCacheUserId();
    // Also scrub an idle old scope when App's normal account cleanup has not run yet.
    if (!same && get().accountId !== getCacheUserId()) reset(getCacheUserId());
    return same;
  };
  const activate = () => {
    const user = getCacheUserId();
    const unchanged = get().accountId === user;
    if (!unchanged) reset(user);
    else if (user) syncForgetReceipts();
    return !!user && unchanged;
  };
  const invalidateReads = () => { readSequence++; set({ loading: false, loadingMore: false }); };
  function absorbForgetReceipts(receipts: MemoryForgetReceipt[], clearRecoveryError = false) {
    const state = get();
    const hiddenIds = [...new Set([...state.hiddenIds, ...receipts.map(receipt => receipt.memoryId)])];
    const activeId = state.pending?.type === 'forget' ? state.pending.id : null;
    const confirmedIds = new Set(receipts.filter(receipt => receipt.state === 'confirmed').map(receipt => receipt.memoryId));
    // Removal in another tab (or clearing browser storage) is not a server
    // receipt. Keep already-observed pending IDs until this tab verifies them.
    const deferredForget = [...new Set([...state.deferredForget, ...receipts.filter(receipt => receipt.state === 'pending').map(receipt => receipt.memoryId)])].filter(id => id !== activeId && !confirmedIds.has(id));
    const forgetStartedAt = { ...state.forgetStartedAt, ...Object.fromEntries(receipts.map(receipt => [receipt.memoryId, receipt.startedAt])) };
    if (hiddenIds.length !== state.hiddenIds.length || JSON.stringify(deferredForget) !== JSON.stringify(state.deferredForget) || (clearRecoveryError && state.recoveryError)) {
      readSequence++;
      set({ hiddenIds, deferredForget, forgetStartedAt, recoveryError: clearRecoveryError ? '' : state.recoveryError, loading: false, loadingMore: false,
        memories: state.memories.filter(memory => !hiddenIds.includes(memory.id)),
        editing: state.editing && hiddenIds.includes(state.editing.id) ? null : state.editing, loaded: false });
    }
  }
  function failedRecoveryRead() {
    readSequence++;
    set({ recoveryError: '此设备的遗忘核验记录暂不可读，已暂停展示记忆正文。请恢复浏览器存储后重新读取，核验完成前不会把未知结果当作成功。',
      memories: [], loading: false, loadingMore: false, loaded: false });
  }
  function syncForgetReceipts() {
    const accountId = get().accountId;
    if (!accountId || accountId !== getCacheUserId()) return;
    try { absorbForgetReceipts(readMemoryForgetReceipts(accountId), true); }
    catch { failedRecoveryRead(); }
  }
  function checkBodyBarriers(ids: string[]) {
    const accountId = get().accountId;
    if (!accountId || accountId !== getCacheUserId()) return false;
    try {
      // localStorage key enumeration is not a cross-tab snapshot. An unrelated
      // key removal can shift an ID out of that scan, so every body publication
      // checks its exact barrier key independently before touching UI state.
      const receipts = [...new Set(ids)].map(id => getMemoryForgetReceipt(accountId, id)).filter((value): value is MemoryForgetReceipt => value !== null);
      absorbForgetReceipts(receipts);
      return !get().recoveryError;
    } catch { failedRecoveryRead(); return false; }
  }
  const put = (memory: MemoryRecord) => set(state => ({
    memories: state.hiddenIds.includes(memory.id) || state.recoveryError
      ? state.memories.filter(item => item.id !== memory.id)
      : [memory, ...state.memories.filter(item => item.id !== memory.id)],
  }));
  const hide = (id: string) => set(state => ({
    hiddenIds: [...new Set([...state.hiddenIds, id])], loaded: false,
    memories: state.memories.filter(item => item.id !== id),
    total: Math.max(0, state.total - (state.memories.some(item => item.id === id) ? 1 : 0)),
  }));
  async function read(more: boolean) {
    activate();
    if (!get().accountId || get().recoveryError) return;
    if (more && (get().loading || get().loadingMore || get().nextOffset >= get().total)) return;
    const origin = scope(), sequence = ++readSequence;
    // Offset pagination is not a snapshot. Re-read the already viewed prefix so a
    // deletion before the old offset cannot skip records or retain its old body.
    const target = more ? get().nextOffset + 100 : 100;
    set({ loading: !more, loadingMore: more, loadError: '' });
    try {
      let offset = 0, total = 0;
      const collected: MemoryRecord[] = [];
      do {
        const result = await memoryApi.list(offset, origin.accountId!);
        if (!current(origin) || sequence !== readSequence) return;
        collected.push(...result.memories);
        total = result.total;
        offset += result.memories.length;
        if (!result.memories.length) break;
      } while (offset < target && offset < total);
      syncForgetReceipts();
      if (!checkBodyBarriers(collected.map(memory => memory.id)) || !current(origin) || sequence !== readSequence) return;
      const unique = new Map(collected.map(memory => [memory.id, memory]));
      const visible = [...unique.values()].filter(memory => !get().hiddenIds.includes(memory.id));
      set({ memories: visible, total, nextOffset: offset, loaded: true, loadError: '' });
    } catch {
      if (current(origin) && sequence === readSequence) set({ loadError: more ? '较早记录读取失败，已加载的记录仍保留。' : '记录读取失败，草稿和待核对操作仍保留。' });
    } finally {
      if (current(origin) && sequence === readSequence) set({ loading: false, loadingMore: false });
    }
  }
  function done(intent: Intent, memory?: MemoryRecord, observed = false) {
    syncForgetReceipts();
    checkBodyBarriers([...(memory ? [memory.id] : []), ...(intent.type !== 'create' ? [intent.id] : [])]);
    invalidateReads();
    if (intent.type === 'create' && memory && get().hiddenIds.includes(memory.id)) {
      set(state => ({ pending: null, error: '', note: state.note === intent.draft ? '' : state.note,
        notice: '原保存对应的记录已有遗忘操作，正文保持隐藏，本次没有重新创建。' }));
      return;
    }
    if (intent.type === 'correct' && get().hiddenIds.includes(intent.id)) {
      set({ pending: null, editing: null, error: '', notice: '该记录已有遗忘请求，旧正文继续隐藏。' });
      return;
    }
    if (memory) put(memory);
    set(state => ({ pending: null, error: '', loaded: false,
      deferredForget: intent.type === 'forget' ? state.deferredForget.filter(id => id !== intent.id) : state.deferredForget,
      note: intent.type === 'create' && state.note === intent.draft ? '' : state.note,
      editing: intent.type === 'correct' || (intent.type === 'forget' && state.editing?.id === intent.id) ? null : state.editing,
      notice: intent.type === 'create' ? '笔记已保存；不会自动当作已核实事实或发送给其他群。' : intent.type === 'correct'
        ? observed ? '已核对：当前记录与本次更正一致，没有重复提交。请检查依赖旧内容的草稿和已发布内容。' : '更正已保存；请检查依赖旧内容的草稿和已发布内容。'
        : '该记录已遗忘，当前保存的正文已清除；已导出文件和外部副本需分别处理。',
    }));
  }
  async function checkCorrection(intent: Extract<Intent, { type: 'correct' }>, origin: MemoryScope, retryIfUnchanged: boolean) {
    try {
      const memory = await memoryApi.get(intent.id, origin.accountId!);
      if (!current(origin)) return;
      syncForgetReceipts();
      checkBodyBarriers([memory.id]);
      if (get().recoveryError) { set({ error: '设备核验记录不可读，更正结果仍待核对；请恢复设备存储后重试。' }); return; }
      if (get().hiddenIds.includes(intent.id)) { done(intent); return; }
      invalidateReads(); put(memory);
      if (memory.content === intent.content && memory.revision === intent.revision + 1) {
        done(intent, memory, true); return;
      }
      if (memory.revision === intent.revision && memory.content === intent.baseContent) {
        if (retryIfUnchanged) { await dispatch(intent, origin); return; }
        set({ error: '当前版本尚未改变，可以核对后重试原更正。' }); return;
      }
      // Never silently rebase onto a revision the user did not inspect.
      set(state => ({ pending: null, editing: state.editing ? { ...state.editing, current: memory } : null,
        error: '记录已有其他修订。你的更正草稿仍保留，请对照当前版本后再决定。' }));
    } catch (error) {
      if (!current(origin)) return;
      const { code } = details(error);
      if (['MEMORY_NOT_FOUND', 'MEMORY_FORGOTTEN', 'SOURCE_UNAVAILABLE'].includes(code || '')) {
        hide(intent.id);
        set(state => {
          const changedDraft = state.editing && state.editing.text.trim() !== state.editing.baseContent.trim();
          return { pending: null, editing: changedDraft ? { ...state.editing!, baseContent: '', current: null, unavailable: true } : null,
            error: changedDraft ? '原记录已不可用，不能再更正；你的未提交草稿仍可选中复制或放弃。' : '原记录已不可用，不能再更正；未修改的旧正文已从本页清除。' };
        });
      } else set({ error: '暂时无法核对更正结果。原内容和版本仍已锁定，请稍后再核对。' });
    }
  }
  async function dispatch(intent: Intent, origin: MemoryScope) {
    try {
      if (intent.type === 'create') {
        const memory = await memoryApi.store(intent.content, intent.key, origin.accountId!);
        if (current(origin)) done(intent, memory);
      } else if (intent.type === 'correct') {
        const memory = await memoryApi.correct(intent.id, intent.content, intent.revision, origin.accountId!);
        if (current(origin)) done(intent, memory);
      } else {
        await memoryApi.forget(intent.id, origin.accountId!);
        if (current(origin)) {
          try { confirmMemoryForget(origin.accountId!, intent.id); }
          catch { set({ pending: { ...intent, uncertain: true }, error: '服务器已确认遗忘，设备尚未记录完成回执；可继续核对同一记录。' }); return; }
          done(intent);
        }
      }
    } catch (error) {
      if (!current(origin)) return;
      const { code } = details(error);
      if (code === 'ACCOUNT_CHANGED' || code === 'STALE_ACCOUNT_RESPONSE') { reset(null); return; }
      if (intent.type === 'create' && code === 'MEMORY_FORGOTTEN') {
        invalidateReads();
        // The 410 carries no trusted memory ID; the note may have changed since create.
        // Do not guess from content or leave a known-forgotten body in a stale list.
        set({ memories: [], total: 0, nextOffset: 0, loaded: false, pending: null, note: '', error: '', notice: '原保存请求对应的记录已遗忘，本次没有重新创建。' });
      } else if (intent.type === 'create' && code === 'IDEMPOTENCY_CONFLICT') {
        set({ pending: { ...intent, uncertain: true }, error: '原请求对应的记录已存在且内容发生变化。请查看现有记录，不会自动另建笔记。' });
      } else if (intent.type === 'correct' && ['STALE_MEMORY', 'MEMORY_NOT_FOUND', 'MEMORY_FORGOTTEN', 'SOURCE_UNAVAILABLE'].includes(code || '')) {
        await checkCorrection(intent, origin, false);
      } else if (intent.type !== 'forget' && !intent.uncertain && definitive(error)) {
        set({ pending: null, error: '此次提交被拒绝，草稿仍保留。请检查内容或登录状态后重试。' });
      } else {
        set({ pending: { ...intent, uncertain: true }, error: intent.type === 'create'
          ? '保存结果尚未确认。内容已锁定，请使用同一请求核对，避免重复创建。'
          : intent.type === 'correct' ? '更正结果尚未确认。请先核对当前版本，不会直接重复写入。'
            : '遗忘结果尚未确认，正文已在本页隐藏。请重试核对；这不会恢复或重复创建记录。' });
      }
    }
  }
  async function run(intent: Intent, isRetry = false) {
    if (!activate() || get().busy || get().recoveryError) return;
    if (intent.type === 'forget') {
      try {
        const receipt = rememberMemoryForget(get().accountId!, intent.id);
        set(state => ({ forgetStartedAt: { ...state.forgetStartedAt, [intent.id]: receipt.startedAt } }));
      } catch { set({ error: '尚未发送这次遗忘请求：设备无法保存核验编号。请恢复浏览器存储后重试。' }); return; }
      hide(intent.id);
      if (get().editing?.id === intent.id) set({ editing: null });
    }
    const origin = scope(), started = performance.now();
    invalidateReads();
    set({ busy: true, pending: intent, error: '', notice: '' });
    recordDiagnostic('interaction', 'memory', 'started');
    try {
      if (isRetry && intent.type === 'correct') await checkCorrection(intent, origin, true);
      else await dispatch(intent, origin);
    } finally {
      if (current(origin)) {
        invalidateReads();
        recordDiagnostic('interaction', 'memory', get().pending ? 'unknown' : get().error ? 'failed' : 'succeeded', performance.now() - started);
        set({ busy: false });
        void read(false);
      }
    }
  }
  return {
    ...blank(), accountId: null, generation,
    activate: () => { activate(); }, cleanup: () => reset(null), syncForgetReceipts,
    observeForgetStorage: (key, value) => {
      const accountId = get().accountId;
      if (!accountId || accountId !== getCacheUserId()) return;
      // Queued storage events retain the actual old/new receipt after the
      // other tab has already received its ACK and removed the durable key.
      // Re-reading only current storage would miss the entire privacy action.
      if (key && !key.startsWith(`${MEMORY_FORGET_PREFIX}${encodeURIComponent(accountId)}:`)) return;
      invalidateReads();
      if (key && value !== null) {
        try {
          const receipt = parseMemoryForgetReceipt(accountId, key, value);
          hide(receipt.memoryId);
          set(state => ({
            editing: state.editing?.id === receipt.memoryId ? null : state.editing,
            deferredForget: [...new Set([...state.deferredForget, receipt.memoryId])].filter(id => !(state.pending?.type === 'forget' && state.pending.id === id)),
            forgetStartedAt: { ...state.forgetStartedAt, [receipt.memoryId]: receipt.startedAt },
            notice: receipt.state === 'confirmed'
              ? '其他窗口已记录这条记忆的遗忘回执，旧正文已隐藏。可刷新查看最新记录。'
              : '其他窗口正在核对一条遗忘请求，相关正文已隐藏。',
          }));
        } catch {
          set({ memories: [], loaded: false, recoveryError: '收到的遗忘核验记录无法确认，已暂停展示记忆正文。请恢复设备记录后重新核验。' });
          return;
        }
      } else if (key === null) {
        // Clearing storage is not a deletion receipt. Drop stale projections,
        // keep known pending IDs, and require a fresh authoritative list.
        set({ memories: [], editing: null, loaded: false });
      }
      syncForgetReceipts();
    },
    refresh: () => read(false), loadMore: () => read(true),
    setNote: note => { if (activate() && get().pending?.type !== 'create') set({ note: note.slice(0, 5000) }); },
    beginEdit: memory => {
      if (!activate() || get().pending || get().editing || memory.kind !== 'user_note') return;
      if (!checkBodyBarriers([memory.id]) || get().hiddenIds.includes(memory.id) || !get().memories.some(item => item.id === memory.id && item.revision === memory.revision)) return;
      set({ editing: { id: memory.id, text: memory.content, baseContent: memory.content, revision: memory.revision, current: null, unavailable: false }, error: '', notice: '' });
    },
    setEditText: text => { if (activate() && get().editing && !get().pending && !get().editing!.unavailable) set(state => ({ editing: { ...state.editing!, text: text.slice(0, 5000) } })); },
    cancelEdit: (origin, draft) => { if (current(origin) && !get().pending && get().editing === draft) set({ editing: null, error: '' }); },
    rebaseEdit: () => {
      if (!activate() || get().pending || !get().editing?.current) return;
      const memory = get().editing!.current!;
      set(state => ({ editing: { ...state.editing!, revision: memory.revision, baseContent: memory.content, current: null }, error: '', notice: '已保留你的草稿。请确认内容，再保存到当前版本。' }));
    },
    saveNote: async () => {
      if (!activate() || get().pending || get().busy || get().recoveryError) return;
      const draft = get().note, content = draft.trim();
      if (!content || content.length > 5000) return;
      await run({ type: 'create', content, draft, key: crypto.randomUUID(), uncertain: false });
    },
    saveCorrection: async () => {
      if (!activate() || get().pending || get().busy || get().recoveryError) return;
      const edit = get().editing, content = edit?.text.trim();
      if (!edit || edit.current || edit.unavailable || !content || content.length > 5000 || content === edit.baseContent) return;
      await run({ type: 'correct', id: edit.id, content, draft: edit.text, revision: edit.revision, baseContent: edit.baseContent, uncertain: false });
    },
    retry: async () => { if (activate() && get().pending && !get().busy) await run(get().pending!, true); },
    forget: async (id, origin) => {
      if (!current(origin) || !activate() || get().pending || get().busy || !get().memories.some(item => item.id === id)) return;
      await run({ type: 'forget', id, uncertain: false });
    },
    deferForget: () => {
      if (!activate() || get().busy || get().pending?.type !== 'forget') return;
      const intent = get().pending as Extract<Intent, { type: 'forget' }>;
      set(state => ({ deferredForget: [...new Set([...state.deferredForget, intent.id])], pending: null, error: '',
        notice: '遗忘结果仍未确认，正文继续隐藏。你可以继续其他操作，稍后再核对这条请求。' }));
    },
    resumeForget: async id => {
      if (!activate() || get().busy || get().pending || !get().deferredForget.includes(id)) return;
      await run({ type: 'forget', id, uncertain: true });
    },
    discardCreate: (origin, intent) => {
      if (!current(origin) || get().busy || get().pending !== intent || intent.type !== 'create') return;
      set({ note: '', pending: null, error: '', notice: '已结束本次核对并清除这份输入。这不会删除可能已保存的记录，请在列表中检查。' });
    },
  };
});

// Keep the navigation warning active even while another workspace panel is mounted.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', event => {
    const state = useMemoryStore.getState();
    if (!state.note && !state.editing && !state.pending && !state.deferredForget.length) return;
    event.preventDefault(); event.returnValue = '';
  });
}

// Cross-tab pending privacy commands must hide their body before a stale list
// response can republish it. No network mutation is triggered by this event.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    const accountId = useMemoryStore.getState().accountId;
    if (accountId && (event.key === null || event.key?.startsWith(`${MEMORY_FORGET_PREFIX}${encodeURIComponent(accountId)}:`))) {
      useMemoryStore.getState().observeForgetStorage(event.key, event.newValue ?? event.oldValue);
    }
  });
}
