import { useCallback } from 'react';
import { Toast, ToastType, pushGlobalToast } from './Toast';

interface ToastOptions {
  message: string;
  type?: ToastType;
  duration?: number;
}

/**
 * 模块级单例 toast 队列：同屏多个 toast 堆叠展示，互不覆盖。
 * 返回的 Toast 元素为兼容占位（全局宿主负责渲染），保留既有调用点写法。
 */
export function useToast() {
  const showToast = useCallback((options: ToastOptions) => {
    pushGlobalToast({
      message: options.message,
      type: options.type,
      duration: options.duration,
    });
  }, []);

  const ToastComponent = <Toast />;

  return { showToast, Toast: ToastComponent };
}
