import { useEffect, useMemo, useState } from 'react';
import { useTasksStore } from '../../stores/tasksStore';
import { useTaskResultsStore } from '../../stores/taskResultsStore';
import { readTaskReceipts } from '../../utils/taskRecovery';
import { getCacheUserId } from '../../utils/cacheUtils';
import { TaskResultEditor } from './TaskResultEditor';

const operations: Record<string, string> = { save_revision: '保存正文', accept_revision: '确认版本', adopt_revision: '采用版本', review_brief: '更新用途' };

/** A receipt remains reachable even if its document no longer appears in a list. */
export function PendingResultRecovery() {
  const tasks = useTasksStore(state => state.tasks);
  const queues = useTaskResultsStore(state => state.uncertainQueues);
  const notices = useTaskResultsStore(state => state.notices);
  const [storageChange, setStorageChange] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const user = getCacheUserId();
  useEffect(() => { setSelected(null); }, [user]);
  useEffect(() => {
    const changed = () => setStorageChange(value => value + 1);
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, []);
  const result = useMemo(() => {
    try {
      const merged = new Map(Object.values(queues).flat().map(receipt => [receipt.key, receipt]));
      for (const receipt of readTaskReceipts()) merged.set(receipt.key, receipt);
      const receipts = [...merged.values()].filter(receipt => receipt.taskId && operations[receipt.action] && !tasks.some(task => task.id === receipt.taskId));
      const groups = new Map<string, typeof receipts>();
      for (const receipt of receipts) groups.set(receipt.taskId!, [...(groups.get(receipt.taskId!) || []), receipt]);
      return { groups: [...groups.entries()], error: '' };
    } catch (error) { return { groups: [], error: error instanceof Error ? error.message : '待确认记录暂时无法读取，请先恢复浏览器存储' }; }
  }, [tasks, queues, storageChange]);
  if (!result.groups.length && !selected && !result.error) return null;
  const settled = selected && !result.groups.some(([taskId]) => taskId === selected) && !queues[selected]?.length && notices[selected];
  return <section className="workspace-notice mb-4" aria-label="列表之外的待确认文稿请求">
    <h3 className="font-medium">原文稿未列出，操作仍可核验</h3>
    <p className="writing-help">文稿可能已删除或暂未加载。这里只保留必要的请求记录，核验不会重新创建或恢复旧正文。</p>
    {result.error && <p className="writing-feedback is-error" role="alert">{result.error}</p>}
    <ul>{result.groups.map(([taskId, receipts], index) => <li key={taskId} className="mt-3">
      <p>未列出的文稿 {index + 1} · {receipts.length} 次待确认操作</p>
      <p className="writing-help">{[...new Set(receipts.map(receipt => operations[receipt.action]))].join('、')} · {new Date(receipts[0].createdAt).toLocaleString('zh-CN')}</p>
      <button className="workspace-button" onClick={() => setSelected(taskId)}>核对这份文稿的原请求</button>
    </li>)}</ul>
    {selected && <div className="mt-4">
      <button className="writing-link mb-3" onClick={() => setSelected(null)}>收起请求核验</button>
      {settled ? <p className="writing-feedback" role="status">{notices[selected]}</p> : <TaskResultEditor taskId={selected} />}
    </div>}
  </section>;
}
