import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '../components/Common/useConfirm';
import { useToast } from '../components/Common/useToast';
import { getAuthGeneration } from '../services/api';
import { getCacheUserId } from '../utils/cacheUtils';
import { clearCurrentUserCache } from '../utils/privateCache';
import { recordDiagnostic } from '../observability/runtimeDiagnostics';

/** An explicit, account-bound cleanup request; cache failure is not success. */
export function useLocalCacheClear() {
  const { confirm, cancelPending, ConfirmModal } = useConfirm();
  const { showToast } = useToast();
  const [clearing, setClearing] = useState(false);
  const operation = useRef<symbol | null>(null);
  const mounted = useRef(true);
  const userId = getCacheUserId(), generation = getAuthGeneration();
  useEffect(() => {
    mounted.current = true;
    operation.current = null;
    setClearing(false);
    cancelPending();
    return () => { mounted.current = false; operation.current = null; };
  }, [userId, generation, cancelPending]);

  const clear = useCallback(async () => {
    if (operation.current) return;
    const token = Symbol('cache-clear');
    operation.current = token;
    const current = () => mounted.current && operation.current === token && userId === getCacheUserId() && generation === getAuthGeneration();
    try {
      const accepted = await confirm({
        title: '清理当前浏览器缓存',
        description: '将清理当前账号在此浏览器的缓存，包括只保存在本地的未发送消息副本，请先复制备份。服务器记录不受影响，当前页面的编辑草稿仍保留；其他标签页占用时需关闭后重试。',
        confirmText: '清理缓存', danger: true,
      });
      if (!accepted || !current()) return;
      setClearing(true);
      recordDiagnostic('interaction', 'settings', 'started');
      await clearCurrentUserCache();
      if (!current()) return;
      recordDiagnostic('interaction', 'settings', 'succeeded');
      showToast({ message: '本地缓存已清理', type: 'success' });
    } catch {
      if (!current()) return;
      recordDiagnostic('interaction', 'settings', 'failed');
      showToast({ message: '缓存清理尚未完成，可能被其他页面占用。请关闭其他标签页后重试。', type: 'error' });
    } finally {
      if (operation.current === token) { operation.current = null; if (mounted.current) setClearing(false); }
    }
  }, [confirm, showToast, userId, generation]);
  return { clear, clearing, ConfirmModal };
}
