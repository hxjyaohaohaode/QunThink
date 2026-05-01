import { useState, useCallback } from 'react';
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
}

export function useToast() {
  const [state, setState] = useState<ToastState>({
    visible: false,
    message: '',
    type: 'info',
    duration: 2500,
  });

  const showToast = useCallback((options: ToastOptions) => {
    setState({
      visible: true,
      message: options.message,
      type: options.type || 'info',
      duration: options.duration || 2500,
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
      onClose={handleClose}
    />
  );

  return { showToast, Toast: ToastComponent };
}
