import { useCallback, useRef } from 'react';

type NotifyFn = (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;

const LARGE_EXPORT_THRESHOLD_BYTES = 100 * 1024;
const CHAT_APP_DB_NAME = 'ai-chat-db';
const LOCAL_STORAGE_PREFIXES = ['chat_app_', 'ai-chat-', 'app_cache_'];
const LOCAL_STORAGE_KEYS = ['messages-cache', 'groups-cache'];

function cleanupLocalStorage(): void {
  try {
    const keysToRemove = Object.keys(localStorage).filter(
      (key) => LOCAL_STORAGE_PREFIXES.some((p) => key.startsWith(p)) || LOCAL_STORAGE_KEYS.includes(key),
    );
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (e) {
    console.warn('clearAll failed:', e);
  }
}

function deleteChatDatabase(notify: NotifyFn): void {
  try {
    const request = indexedDB.deleteDatabase(CHAT_APP_DB_NAME);
    request.onblocked = () => {
      notify('数据库仍被其他页面占用，请刷新页面后完全生效', 'warning');
    };
    request.onerror = () => {
      console.warn('IndexedDB cleanup failed:', request.error);
    };
  } catch (e) {
    console.warn('IndexedDB cleanup failed:', e);
  }
}

export function useLocalDataManager(notify: NotifyFn) {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const exportData = useCallback((data: Record<string, unknown>, version: string) => {
    try {
      const exportPayload: Record<string, unknown> = {
        exportDate: new Date().toISOString(),
        version,
        ...data,
      };
      if (JSON.stringify(exportPayload).length > LARGE_EXPORT_THRESHOLD_BYTES) {
        notifyRef.current('数据量较大，导出可能需要一些时间...', 'info');
      }
      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `群想-数据导出-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notifyRef.current('数据导出成功', 'success');
    } catch (e) {
      notifyRef.current('导出失败: ' + (e as Error).message, 'error');
    }
  }, []);

  const clearAllData = useCallback(() => {
    cleanupLocalStorage();
    deleteChatDatabase((message, type) => notifyRef.current(message, type));
  }, []);

  return { exportData, clearAllData };
}
