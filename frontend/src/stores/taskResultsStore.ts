import { create } from 'zustand';
import { axiosInstance, getAuthGeneration } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import { loadWritingContent, persistTaskReceipt, readTaskReceipts, removeTaskReceipt, removeWritingDraft, saveWritingContent, textHash, writingPreferences, type TaskCommandReceipt } from '../utils/taskRecovery';
import type { TaskResultDocument, TaskResultMutationResponse, TaskResultVersion } from '../../../shared/tasks';

interface Editor {
  body: string; baseVersionId: string | null; editSequence: number; dirty: boolean;
  recovery: 'off' | 'saving' | 'saved' | 'failed'; conflict: boolean;
  reviewedSourceHash: string | null; loaded: boolean;
}
interface PendingCommand { receipt: TaskCommandReceipt; payload?: Record<string, unknown>; editSequence?: number; }
interface ResultState {
  documents: Record<string, TaskResultDocument>; editors: Record<string, Editor>;
  offline: Record<string, boolean>;
  briefs: Record<string, string>;
  editBrief: (taskId: string, prompt: string) => void;
  discardBrief: (taskId: string, expectedPrompt: string) => void;
  loading: Record<string, boolean>; pending: Record<string, string>; uncertain: Record<string, TaskCommandReceipt>;
  uncertainQueues: Record<string, TaskCommandReceipt[]>;
  recoveryError: string | null;
  errors: Record<string, string>; notices: Record<string, string>;
  panelGroupId: string | null; selectedTaskId: string | null; incomingSourceId: string | null;
  openPanel: (groupId: string, taskId?: string, sourceId?: string) => void;
  closePanel: () => void;
  select: (taskId: string) => Promise<void>;
  fetch: (taskId: string) => Promise<void>;
  edit: (taskId: string, body: string) => void;
  recover: (taskId: string) => Promise<void>;
  save: (taskId: string) => Promise<void>;
  accept: (taskId: string, versionId: string, contentHash: string, sourceHash: string | null) => Promise<void>;
  adopt: (taskId: string, versionId: string) => Promise<void>;
  updateBrief: (taskId: string, prompt: string, sourceHash: string | null) => Promise<void>;
  reviewSources: (taskId: string, hash: string) => void;
  verify: (taskId: string, key?: string) => Promise<void>;
  retry: (taskId: string, key?: string) => Promise<void>;
  closeCommand: (taskId: string, key: string) => Promise<void>;
  canRetry: (taskId: string) => boolean;
  rebase: (taskId: string) => void;
  refreshRecovery: () => void;
  cleanup: () => void;
}
let epoch = 0;
const sequences = new Map<string, number>();
const projectionSequences = new Map<string, number>();
const revocationSequences = new Map<string, number>();
const commands = new Map<string, PendingCommand>();
const locks = new Set<string>();
const initialized = new Set<string>();
const context = () => ({ user: getCacheUserId(), auth: getAuthGeneration(), epoch });
const current = (scope: ReturnType<typeof context>) => scope.user === getCacheUserId() && scope.auth === getAuthGeneration() && scope.epoch === epoch;
const head = (document: TaskResultDocument) => document.versions.find(version => version.id === document.head_version_id);
const freshEditor = (document: TaskResultDocument): Editor => ({ body: head(document)?.content || '', baseVersionId: document.head_version_id, editSequence: 0, dirty: false, recovery: writingPreferences().recoverDrafts ? 'saved' : 'off', conflict: false, reviewedSourceHash: null, loaded: true });
function errorMessage(error: unknown) {
  const status = (error as { response?: { status: number }; status?: number }).response?.status ?? (error as { status?: number }).status;
  if (status === 409) return '服务器上已有更新或同一请求正在处理。你的文字仍在；请先核验或结束原请求，再比较版本继续';
  if (status === 400 || status === 422) return '这次输入未通过检查。文字仍在；请核验或结束原请求，再修正后保存';
  if (status === 403 || status === 404) return '这份文稿或来源目前不可用，请核对当前账号与会话权限';
  return '这次操作的回复未能确认。文字仍保留，请先核验原请求，避免重复保存';
}
const statusOf = (error: unknown) => (error as { response?: { status: number }; status?: number }).response?.status ?? (error as { status?: number }).status;
const versionUuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const receiptTime = (value: unknown) => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
function endpoint(action: TaskCommandReceipt['action']) { return action === 'save_revision' ? 'versions' : action === 'accept_revision' ? 'accept' : action === 'review_brief' ? 'brief' : 'adopt'; }

export const useTaskResultsStore = create<ResultState>((set, get) => {
  function syncReceipts(id: string) {
    let receipts: TaskCommandReceipt[];
    try { receipts = readTaskReceipts(); set(state => ({ recoveryError: null, ...(state.recoveryError && state.errors[id] === state.recoveryError ? { errors: { ...state.errors, [id]: '' } } : {}) })); }
    catch (error) { const message = error instanceof Error ? error.message : '无法读取待核验记录，已暂停新的提交'; set(state => ({ recoveryError: message, errors: { ...state.errors, [id]: message } })); throw error; }
    const merged = new Map((get().uncertainQueues[id] || []).map(item => [item.key, item]));
    for (const receipt of receipts) if (receipt.taskId === id && ['save_revision', 'accept_revision', 'adopt_revision', 'review_brief'].includes(receipt.action)) {
      merged.set(receipt.key, receipt);
      if (!commands.has(receipt.key)) commands.set(receipt.key, { receipt });
    }
    const queue = [...merged.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.key.localeCompare(b.key));
    set(state => { const uncertain = { ...state.uncertain }; if (queue.length) uncertain[id] = queue[0]; else delete uncertain[id]; return { uncertain, uncertainQueues: { ...state.uncertainQueues, [id]: queue } }; });
    return queue;
  }
  function activeCommand(id: string) {
    const receipt = get().uncertain[id];
    return receipt ? commands.get(receipt.key) || { receipt } : undefined;
  }
  function clearRevokedContent(id: string) {
    set(state => { const briefs = { ...state.briefs }; delete briefs[id]; return { briefs }; });
    removeWritingDraft(id); removeWritingDraft(id, 'offline');
    try { for (const receipt of readTaskReceipts()) if (receipt.taskId === id) removeWritingDraft(`result-intent:${receipt.key}`); } catch { /* Receipt lookup remains available once local storage recovers. */ }
    for (const command of commands.values()) if (command.receipt.taskId === id) { removeWritingDraft(`result-intent:${command.receipt.key}`); commands.set(command.receipt.key, { receipt: command.receipt }); }
  }
  function apply(document: TaskResultDocument, saved?: PendingCommand, versionId?: string | null, snapshotSequence = 0) {
    const id = document.task_id, prior = get().documents[id];
    if (document.source.status === 'blocked') revocationSequences.set(id, Math.max(revocationSequences.get(id) || 0, snapshotSequence));
    else if (snapshotSequence < (revocationSequences.get(id) || 0)) return;
    else revocationSequences.delete(id);
    if (prior && document.revision < prior.revision) return;
    // Source edits need not increment the document revision. A late mutation response
    // must not clear a newer source review projected by a subsequent read.
    if (prior && document.revision === prior.revision && snapshotSequence < (projectionSequences.get(id) || 0)) document = prior;
    else projectionSequences.set(id, snapshotSequence);
    const old = get().editors[id];
    let editor = old || freshEditor(document);
    if (old) {
      if (saved?.receipt.action === 'save_revision' && versionId) {
        if (!saved.payload && !old.dirty) editor = { ...freshEditor(document), editSequence: old.editSequence };
        else {
          const unchanged = old.editSequence === saved.editSequence;
          editor = { ...old, body: unchanged && typeof saved.payload?.content === 'string' ? saved.payload.content : old.body, baseVersionId: versionId, dirty: !unchanged, conflict: document.head_version_id !== versionId, reviewedSourceHash: null };
        }
      } else if (saved?.receipt.action === 'adopt_revision' && old.editSequence === saved.editSequence) {
        editor = { ...freshEditor(document), editSequence: old.editSequence };
      } else if (!old.dirty && !locks.has(id) && !get().uncertain[id] && old.baseVersionId !== document.head_version_id) {
        editor = { ...freshEditor(document), editSequence: old.editSequence };
      } else {
        editor = { ...old, conflict: old.baseVersionId !== document.head_version_id, reviewedSourceHash: prior?.source.hash === document.source.hash ? old.reviewedSourceHash : null };
      }
    }
    set(state => ({ documents: { ...state.documents, [id]: document }, editors: { ...state.editors, [id]: editor } }));
    if (writingPreferences().offlineCopies && document.source.status !== 'blocked') void saveWritingContent(id, { body: JSON.stringify(document), baseRevisionId: document.head_version_id, savedAt: new Date().toISOString() }, 'offline');
    if (document.source.status === 'blocked') clearRevokedContent(id);
  }
  async function persistEditor(id: string) {
    const scope = context(), editor = get().editors[id]; if (!editor || get().documents[id]?.source.status === 'blocked') return;
    if (!writingPreferences().recoverDrafts) { set(state => ({ editors: { ...state.editors, [id]: { ...state.editors[id], recovery: 'off' } } })); return; }
    const sequence = editor.editSequence;
    set(state => ({ editors: { ...state.editors, [id]: { ...state.editors[id], recovery: 'saving' } } }));
    const okay = await saveWritingContent(id, { body: editor.body, baseRevisionId: editor.baseVersionId, savedAt: new Date().toISOString() });
    if (!current(scope) || get().editors[id]?.editSequence !== sequence) return;
    set(state => ({ editors: { ...state.editors, [id]: { ...state.editors[id], recovery: okay ? 'saved' : 'failed' } } }));
  }
  function markUnknown(id: string, command: PendingCommand, message: string) {
    if (!commands.has(command.receipt.key)) return;
    syncReceipts(id);
    set(state => ({ errors: { ...state.errors, [id]: message } }));
  }
  function settle(id: string, command: PendingCommand, response: TaskResultMutationResponse, snapshotSequence: number) {
    const operation = command.receipt.action === 'save_revision' ? 'save' : command.receipt.action === 'accept_revision' ? 'accept' : command.receipt.action === 'review_brief' ? 'brief' : 'adopt';
    if (response.receipt.id !== command.receipt.key || response.receipt.task_id !== id || response.receipt.operation !== operation || !['succeeded', 'cancelled'].includes(response.receipt.status) || (response.document ? response.document.task_id !== id : response.task_deleted !== true)) throw new Error('回执标识不匹配');
    const cancelled = response.receipt.status === 'cancelled';
    const acceptedSequence = response.document?.versions.find(version => version.id === response.receipt.version_id)?.sequence;
    const acceptedLabel = acceptedSequence ? `版本 ${acceptedSequence}` : '原请求指定的版本';
    if (cancelled && (response.receipt.version_id !== null || response.receipt.committed_revision !== null || response.receipt.committed_at !== null || !receiptTime(response.receipt.closed_at))) throw new Error('结束回执不完整');
    const receipt = response.receipt;
    if (receipt.status === 'succeeded') {
      if (!Number.isSafeInteger(receipt.committed_revision) || receipt.committed_revision < 0 || !receiptTime(receipt.committed_at) || ('closed_at' in receipt) || !(versionUuid(receipt.version_id) || operation === 'brief' && receipt.version_id === null)) throw new Error('成功回执不完整，请继续核验原请求');
      if (command.receipt.revisionId && receipt.version_id !== command.receipt.revisionId) throw new Error('成功回执没有指向原请求的版本');
      if (response.document && (receipt.committed_revision > response.document.revision || (receipt.version_id && !response.document.versions.some(version => version.id === receipt.version_id)))) throw new Error('成功回执与文稿版本记录不符');
    }
    // An old ACK can arrive after this exact key was settled. It must never settle
    // the next queued command or project over newer local edits/source barriers.
    if (!commands.has(command.receipt.key) && !get().uncertainQueues[id]?.some(item => item.key === command.receipt.key)) return;
    // Settle only this command's read generation. A newer GET must still publish
    // its eventual permission/source result, regardless of response arrival order.
    const latestSnapshot = sequences.get(id) === snapshotSequence;
    if (latestSnapshot) sequences.set(id, snapshotSequence + 1);
    if (response.document) apply(response.document, cancelled ? undefined : command, cancelled ? undefined : response.receipt.version_id, snapshotSequence);
    try { removeTaskReceipt(command.receipt.key); } catch { /* Retain an unremoved key for a later authoritative query. */ }
    commands.delete(command.receipt.key); removeWritingDraft(`result-intent:${command.receipt.key}`);
    if (!cancelled && command.receipt.action === 'review_brief' && get().briefs[id] === command.payload?.prompt) set(state => { const briefs = { ...state.briefs }; delete briefs[id]; return { briefs }; });
    set(state => ({ uncertainQueues: { ...state.uncertainQueues, [id]: (state.uncertainQueues[id] || []).filter(item => item.key !== command.receipt.key) }, ...(latestSnapshot ? { loading: { ...state.loading, [id]: false }, errors: { ...state.errors, [id]: '' } } : {}), notices: { ...state.notices, [id]: cancelled ? response.task_deleted ? '原请求已结束；文稿已删除，未恢复旧正文' : '这次待确认请求已结束，已保存版本保持不变。当前输入仍在；其余待确认请求处理完后可继续保存' : response.task_deleted ? '原请求已确认，但任务已被删除，未恢复旧内容' : command.receipt.action === 'accept_revision' ? `已记录对${acceptedLabel}的验收；当前正文与来源状态请以上方标记为准` : '原请求已确认，已保存版本保持原样；之后写下的文字仍保留' } }));
    syncReceipts(id);
    if (response.task_deleted) {
      clearRevokedContent(id); removeWritingDraft(id);
      set(state => { const documents = { ...state.documents }, editors = { ...state.editors }; delete documents[id]; delete editors[id]; return { documents, editors }; });
    } else void persistEditor(id);
  }
  async function dispatch(id: string, command: PendingCommand) {
    const scope = context(); if (!scope.user) throw new Error('请先登录');
    if (get().documents[id]?.source.status === 'blocked') { markUnknown(id, command, '来源目前不可用，仅可核验原请求，不能重发正文'); return; }
    if (!command.payload) throw new Error('原请求正文未保存在此设备。可以核验回执，不能用新文字代替原请求重发');
    const snapshotSequence = (sequences.get(id) || 0) + 1; sequences.set(id, snapshotSequence);
    try {
      const { data } = await axiosInstance.post<TaskResultMutationResponse>(`/tasks/${id}/result/${endpoint(command.receipt.action)}`, command.payload, { headers: { 'Idempotency-Key': command.receipt.key, 'X-Expected-User-Id': scope.user } });
      if (!current(scope)) return;
      settle(id, command, data, snapshotSequence);
    } catch (error) {
      if (!current(scope)) return;
      markUnknown(id, command, errorMessage(error));
      if (statusOf(error) === 409) await get().fetch(id);
    }
  }
  async function mutate(id: string, action: TaskCommandReceipt['action'], payload: Record<string, unknown>, label: string) {
    if (locks.has(id)) return;
    if (get().offline[id]) throw new Error('请先联网核对来源与权限，再保存或验收');
    try { syncReceipts(id); } catch { return; }
    if (get().uncertain[id]) throw new Error('先核验或结束上次请求，再继续保存或验收');
    locks.add(id);
    const scope = context(), editor = get().editors[id];
    set(state => ({ pending: { ...state.pending, [id]: label }, errors: { ...state.errors, [id]: '' }, notices: { ...state.notices, [id]: '' } }));
    sequences.set(id, (sequences.get(id) || 0) + 1);
    try {
      const key = crypto.randomUUID(), frozen = structuredClone({ ...payload, client_request_id: key });
      const command: PendingCommand = { receipt: { key, action, taskId: id, baseRevisionId: editor?.baseVersionId ?? null, revisionId: typeof payload.version_id === 'string' ? payload.version_id : undefined, contentHash: typeof payload.content_hash === 'string' ? payload.content_hash : undefined, payloadHash: await textHash(JSON.stringify(frozen)), createdAt: new Date().toISOString() }, payload: frozen, editSequence: editor?.editSequence };
      if (!current(scope)) return;
      persistTaskReceipt(command.receipt); // A failed journal write is a pre-dispatch failure.
      commands.set(key, command); syncReceipts(id);
      // If device recovery is enabled, keep the exact original operation separately from live typing.
      await saveWritingContent(`result-intent:${key}`, { body: JSON.stringify({ payload: frozen, editSequence: editor?.editSequence }), baseRevisionId: editor?.baseVersionId ?? null, savedAt: new Date().toISOString() });
      if (!current(scope)) return;
      await dispatch(id, command);
    } catch (error) {
      if (current(scope)) set(state => ({ errors: { ...state.errors, [id]: error instanceof Error ? error.message : '无法准备此操作，尚未发送' } }));
    } finally {
      if (current(scope)) { locks.delete(id); set(state => { const pending = { ...state.pending }; delete pending[id]; return { pending }; }); }
    }
  }
  return {
    documents: {}, editors: {}, offline: {}, briefs: {}, recoveryError: null,
    editBrief: (id, prompt) => set(state => ({ briefs: { ...state.briefs, [id]: prompt } })),
    discardBrief: (id, expectedPrompt) => set(state => { if (state.briefs[id] !== expectedPrompt) return {}; const briefs = { ...state.briefs }; delete briefs[id]; return { briefs }; }), loading: {}, pending: {}, uncertain: {}, uncertainQueues: {}, errors: {}, notices: {}, panelGroupId: null, selectedTaskId: null, incomingSourceId: null,
    openPanel: (groupId, taskId, sourceId) => { set({ panelGroupId: groupId, selectedTaskId: taskId || null, incomingSourceId: sourceId || null }); if (taskId) void get().select(taskId); },
    closePanel: () => set({ panelGroupId: null, incomingSourceId: null }),
    select: async id => { set({ selectedTaskId: id }); await Promise.all([get().fetch(id), get().recover(id)]); },
    fetch: async id => {
      const scope = context(), sequence = (sequences.get(id) || 0) + 1; sequences.set(id, sequence);
      try { syncReceipts(id); } catch { /* The read still reports server availability. Mutation checks storage again. */ }
      set(state => ({ loading: { ...state.loading, [id]: true } }));
      try {
        const { data } = await axiosInstance.get<TaskResultDocument>(`/tasks/${id}/result`, { headers: { 'X-Expected-User-Id': scope.user || '' } });
        if (!current(scope) || sequences.get(id) !== sequence) return;
        apply(data, undefined, undefined, sequence); set(state => ({ offline: { ...state.offline, [id]: false } }));
      } catch (error) {
        if (current(scope) && sequences.get(id) === sequence) {
          if ([403, 404, 410].includes(statusOf(error) || 0)) {
            revocationSequences.set(id, sequence);
            clearRevokedContent(id);
            const previous = get().documents[id];
            if (previous) set(state => ({ documents: { ...state.documents, [id]: { ...previous, source: { ...previous.source, status: 'blocked', messages: [], hash: null }, versions: previous.versions.map(version => ({ ...version, content: '', content_hidden: true, source_status: 'blocked' })) } } }));
          }
          if (!statusOf(error) && typeof navigator !== 'undefined' && navigator.onLine === false) {
            const cached = await loadWritingContent(id, 'offline');
            if (!current(scope) || sequences.get(id) !== sequence) return;
            if (cached) { try { const snapshot = JSON.parse(cached.body) as TaskResultDocument; if (snapshot.task_id === id && Array.isArray(snapshot.versions)) { apply(snapshot, undefined, undefined, sequence); set(state => ({ offline: { ...state.offline, [id]: true }, errors: { ...state.errors, [id]: '正在查看此设备的离线副本。权限与来源尚未联网核对，不能保存或验收' } })); return; } } catch {} }
          }
          set(state => ({ errors: { ...state.errors, [id]: errorMessage(error) } }));
        }
      }
      finally { if (current(scope) && sequences.get(id) === sequence) set(state => ({ loading: { ...state.loading, [id]: false } })); }
    },
    edit: (id, body) => {
      const editor = get().editors[id]; if (!editor) return;
      set(state => ({ editors: { ...state.editors, [id]: { ...editor, body, dirty: true, editSequence: editor.editSequence + 1 } }, notices: { ...state.notices, [id]: '' } }));
      void persistEditor(id);
    },
    recover: async id => {
      const firstOpen = !initialized.has(id); initialized.add(id);
      const scope = context(), sequence = get().editors[id]?.editSequence || 0, alreadyDirty = get().editors[id]?.dirty === true;
      try {
        const queue = syncReceipts(id);
        for (const receipt of queue) {
          if (commands.get(receipt.key)?.payload) continue;
          const frozen = await loadWritingContent(`result-intent:${receipt.key}`);
          if (!current(scope)) return;
          if (frozen && commands.has(receipt.key)) {
            try { const restored = JSON.parse(frozen.body);
              if (restored.payload?.client_request_id === receipt.key && await textHash(JSON.stringify(restored.payload)) === receipt.payloadHash && current(scope) && commands.has(receipt.key)) {
                commands.set(receipt.key, { receipt, payload: restored.payload, editSequence: alreadyDirty ? undefined : sequence });
              }
            } catch { /* Never replay an unreadable or altered frozen payload. */ }
          }
        }
        syncReceipts(id); // Publish restored replay availability without replacing live typing.
        if (!firstOpen) return;
        const draft = await loadWritingContent(id);
        if (!current(scope) || !draft || (get().editors[id]?.editSequence || 0) !== sequence || get().editors[id]?.dirty) return;
        const document = get().documents[id]; if (document?.source.status === 'blocked') return;
        set(state => ({ editors: { ...state.editors, [id]: { body: draft.body, baseVersionId: draft.baseRevisionId, editSequence: sequence + 1, dirty: true, recovery: 'saved', conflict: !!document && draft.baseRevisionId !== document.head_version_id, reviewedSourceHash: null, loaded: true } }, notices: { ...state.notices, [id]: '已恢复此设备的未提交文稿，请核对后保存为版本' } }));
      } catch (error) { if (current(scope)) set(state => ({ errors: { ...state.errors, [id]: error instanceof Error ? error.message : '恢复失败' } })); }
    },
    save: async id => {
      const document = get().documents[id], editor = get().editors[id];
      if (!document || !editor || document.source.status === 'blocked' || editor.conflict) return;
      await mutate(id, 'save_revision', { expected_revision: document.revision, base_version_id: editor.baseVersionId, content: editor.body, ...(editor.reviewedSourceHash ? { reviewed_source_hash: editor.reviewedSourceHash } : {}) }, '保存版本中');
    },
    accept: async (id, versionId, contentHash, sourceHash) => {
      const document = get().documents[id], editor = get().editors[id];
      if (!document || editor?.dirty || document.source.status !== 'current') return;
      await mutate(id, 'accept_revision', { expected_revision: document.revision, version_id: versionId, content_hash: contentHash, source_hash: sourceHash }, '记录验收中');
    },
    adopt: async (id, versionId) => {
      const document = get().documents[id]; if (!document || get().editors[id]?.dirty) return;
      await mutate(id, 'adopt_revision', { expected_revision: document.revision, version_id: versionId }, '采用版本中');
    },
    updateBrief: async (id, prompt, sourceHash) => {
      const document = get().documents[id]; if (!document || document.source.status === 'blocked') return;
      await mutate(id, 'review_brief', { expected_revision: document.revision, prompt, source_hash: sourceHash }, '保存任务用途中');
    },
    reviewSources: (id, hash) => {
      const document = get().documents[id], editor = get().editors[id]; if (!document || !editor || (hash && document.source.hash !== hash) || document.source.status === 'blocked') return;
      set(state => ({ editors: { ...state.editors, [id]: { ...editor, reviewedSourceHash: hash || null } } }));
    },
    verify: async (id, key) => {
      syncReceipts(id);
      const command = key ? (get().uncertainQueues[id]?.some(item => item.key === key) ? commands.get(key) : undefined) : activeCommand(id); if (!command || locks.has(id)) return;
      const scope = context(), snapshotSequence = (sequences.get(id) || 0) + 1; sequences.set(id, snapshotSequence); locks.add(id); set(state => ({ pending: { ...state.pending, [id]: '核验原请求中' } }));
      try {
        const { data } = await axiosInstance.get<TaskResultMutationResponse>(`/tasks/${id}/result/commands/${command.receipt.key}`, { headers: { 'X-Expected-User-Id': scope.user || '' } });
        if (current(scope)) settle(id, command, data, snapshotSequence);
      } catch (error) {
        if (current(scope)) markUnknown(id, command, statusOf(error) === 404 ? '尚未找到此请求的回执。它可能仍在处理；请稍后再核验，不会用新文字重发' : '暂时无法核验原请求。文稿与请求编号仍保留');
      } finally { if (current(scope)) { locks.delete(id); set(state => { const pending = { ...state.pending }; delete pending[id]; return { pending }; }); } }
    },
    canRetry: id => !!activeCommand(id)?.payload,
    retry: async (id, key) => {
      syncReceipts(id);
      const command = key ? (get().uncertainQueues[id]?.some(item => item.key === key) ? commands.get(key) : undefined) : activeCommand(id); if (!command?.payload || locks.has(id)) return;
      const scope = context(); locks.add(id); set(state => ({ pending: { ...state.pending, [id]: '重试原请求中' } }));
      try { await dispatch(id, command); } finally { if (current(scope)) { locks.delete(id); set(state => { const pending = { ...state.pending }; delete pending[id]; return { pending }; }); } }
    },
    closeCommand: async (id, key) => {
      syncReceipts(id);
      if (!get().uncertainQueues[id]?.some(item => item.key === key)) throw new Error('这次请求已不在待核验列表，请查看最新结果');
      if (locks.has(id)) return;
      const command = commands.get(key); if (!command) return;
      const scope = context(), snapshotSequence = (sequences.get(id) || 0) + 1; sequences.set(id, snapshotSequence);
      locks.add(id); set(state => ({ pending: { ...state.pending, [id]: '核对并结束原请求中' } }));
      try {
        const operation = command.receipt.action === 'save_revision' ? 'save' : command.receipt.action === 'accept_revision' ? 'accept' : command.receipt.action === 'review_brief' ? 'brief' : 'adopt';
        const { data } = await axiosInstance.post<TaskResultMutationResponse>(`/tasks/${id}/result/commands/${key}/close`, { operation }, { headers: { 'X-Expected-User-Id': scope.user || '' } });
        if (current(scope)) settle(id, command, data, snapshotSequence);
      } catch {
        if (current(scope)) markUnknown(id, command, '尚未确认是否已结束。原请求编号和当前输入仍保留，请再次核验或结束同一请求');
      } finally { if (current(scope)) { locks.delete(id); set(state => { const pending = { ...state.pending }; delete pending[id]; return { pending }; }); } }
    },
    rebase: id => {
      const document = get().documents[id], editor = get().editors[id]; if (!document || !editor || get().uncertain[id]) return;
      set(state => ({ editors: { ...state.editors, [id]: { ...editor, baseVersionId: document.head_version_id, conflict: false, dirty: true, reviewedSourceHash: null } } }));
      void persistEditor(id);
    },
    refreshRecovery: () => { for (const id of Object.keys(get().editors)) void persistEditor(id); },
    cleanup: () => { epoch++; sequences.clear(); projectionSequences.clear(); revocationSequences.clear(); commands.clear(); locks.clear(); initialized.clear(); set({ documents: {}, editors: {}, offline: {}, briefs: {}, recoveryError: null, loading: {}, pending: {}, uncertain: {}, uncertainQueues: {}, errors: {}, notices: {}, panelGroupId: null, selectedTaskId: null, incomingSourceId: null }); },
  };
});
export const resultHead = (document?: TaskResultDocument): TaskResultVersion | undefined => document?.versions.find(version => version.id === document.head_version_id);
