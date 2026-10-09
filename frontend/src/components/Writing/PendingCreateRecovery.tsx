import { useEffect, useState } from 'react';
import { useTasksStore } from '../../stores/tasksStore';
import { getAuthGeneration } from '../../services/api';
import { getCacheUserId } from '../../utils/cacheUtils';
import { useConfirm } from '../Common/useConfirm';

export function PendingCreateRecovery() {
  const receipts = useTasksStore(state => state.pendingCreates);
  const recoveryError = useTasksStore(state => state.recoveryError);
  const pending = useTasksStore(state => state.pending);
  const [feedback, setFeedback] = useState('');
  const { confirm, ConfirmModal } = useConfirm();
  useEffect(() => {
    const refresh = () => { void useTasksStore.getState().fetch(); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);
  async function act(key: string, action: 'verify' | 'close' | 'retry') {
    // Freeze both the requested key and identity before opening an asynchronous question.
    const user = getCacheUserId(), generation = getAuthGeneration();
    if (action === 'close' && !await confirm({ title: '核对并结束这次待确认的文稿创建请求', description: '若原请求已提交，将返回原文稿，保持已保存内容不变；若尚未提交，只结束这次旧请求，随后可提交新输入。不会删除文稿、撤销验收、停止 AI 或退费。', confirmText: '核对并结束这次请求' })) return;
    if (user !== getCacheUserId() || generation !== getAuthGeneration()) return;
    setFeedback('');
    try {
      if (action === 'close') await useTasksStore.getState().closeCreate(key);
      else if (action === 'retry') await useTasksStore.getState().retryCreate(key);
      else await useTasksStore.getState().verifyCreate(key);
    } catch { if (user === getCacheUserId() && generation === getAuthGeneration()) setFeedback(useTasksStore.getState().error || '这次请求尚待确认，请保留当前输入后重试'); }
  }
  if (recoveryError) return <section className="writing-warning mb-4" aria-label="待核验记录读取失败"><p role="alert">{recoveryError}</p><button type="button" className="workspace-button" onClick={() => void useTasksStore.getState().fetch()}>重新读取待核验记录</button></section>;
  if (!receipts.length) return null;
  return <section className="writing-warning mb-4" aria-label="待确认的文稿创建请求">
    <h3>有 {receipts.length} 次文稿创建待确认</h3>
    <p className="writing-help">可以继续填写新内容。请先逐条核验或结束旧请求，再提交新文稿。</p>
    <ol>{receipts.map((receipt, index) => {
      const canRetry = useTasksStore.getState().canRetryCreate(receipt.key);
      const busy = !!pending.create || !!pending[`create:${receipt.key}`];
      const time = Number.isFinite(Date.parse(receipt.createdAt)) ? new Date(receipt.createdAt).toLocaleString('zh-CN') : '时间未知';
      return <li key={receipt.key} className="mt-3">
        <p>第 {index + 1} 次创建 · {time}</p>
        {!canRetry && <p className="writing-help">原文字未保存在此设备，请重新填写或从已存版本继续。</p>}
        <div className="flex flex-wrap gap-2 mt-2">
          <button type="button" className="workspace-button" disabled={busy} onClick={() => void act(receipt.key, 'verify')}>核验这次创建</button>
          <button type="button" className="workspace-button" disabled={busy} onClick={() => void act(receipt.key, 'close')}>{pending[`create:${receipt.key}`] || '核对并结束这次请求'}</button>
          {canRetry && <button type="button" className="writing-link" disabled={busy} onClick={() => void act(receipt.key, 'retry')}>按原内容重试</button>}
        </div>
      </li>;
    })}</ol>
    {feedback && <p className="writing-feedback is-error" role="alert">{feedback}</p>}
    {ConfirmModal}
  </section>;
}
