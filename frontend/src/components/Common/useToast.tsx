import { useState, useCallback, useRef } from 'react';
import { Toast, ToastType } from './Toast';

interface ToastOptions {
  message: string;
  type?: ToastType;
  duration?: number;
}

interface ToastState {
  visible: boolean;
  message: string;
  type: ToastType;
  duration: number;
  toastId: number;
}

export function useToast() {
  const toastIdRef = useRef(0);
  const [state, setState] = useState<ToastState>({
    visible: false,
    message: '',
    type: 'info',
    duration: 2500,
    toastId: 0,
  });

  const showToast = useCallback((options: ToastOptions) => {
    toastIdRef.current += 1;
    setState({
      visible: true,
      message: options.message,
      type: options.type || 'info',
      duration: options.duration || 2500,
      toastId: toastIdRef.current,
    });
  }, []);

  const handleClose = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }));
  }, []);

  const ToastComponent = (
    <Toast
      visible={state.visible}
      message={state.message}
      type={state.type}
      duration={state.duration}
      toastId={state.toastId}
      onClose={handleClose}
    />
  );

  return { showToast, Toast: ToastComponent };
}
