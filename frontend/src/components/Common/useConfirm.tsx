import { useState, useCallback, useRef } from 'react';
import { ConfirmModal } from './ConfirmModal';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState {
  visible: boolean;
  title: string;
  description?: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState>({
    visible: false,
    title: '',
    confirmText: '确认',
    cancelText: '取消',
    danger: false,
  });

  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setState({
        visible: true,
        title: options.title,
        description: options.description,
        confirmText: options.confirmText || '确认',
        cancelText: options.cancelText || '取消',
        danger: options.danger || false,
      });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }));
    resolverRef.current?.(true);
    resolverRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }));
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

  const ConfirmModalComponent = (
    <ConfirmModal
      visible={state.visible}
      title={state.title}
      description={state.description}
      confirmText={state.confirmText}
      cancelText={state.cancelText}
      danger={state.danger}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { confirm, ConfirmModal: ConfirmModalComponent };
}
