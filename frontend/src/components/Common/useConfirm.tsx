import { useState, useCallback, useRef, useEffect } from 'react';
import { ConfirmModal } from './ConfirmModal';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState {
  requestId: number;
  visible: boolean;
  title: string;
  description?: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState>({
    requestId: 0,
    visible: false,
    title: '',
    confirmText: '确认',
    cancelText: '取消',
    danger: false,
  });

  const nextRequestId = useRef(0);
  const resolverRef = useRef<{ requestId: number; resolve: (value: boolean) => void } | null>(null);

  useEffect(() => () => { resolverRef.current?.resolve(false); resolverRef.current = null; }, []);

  const cancelPending = useCallback(() => {
    const pending = resolverRef.current;
    resolverRef.current = null;
    if (pending) {
      pending.resolve(false);
      setState(prev => ({ ...prev, visible: false }));
    }
  }, []);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // Replacing a question is cancellation of the previous intent, never approval.
      resolverRef.current?.resolve(false);
      const requestId = ++nextRequestId.current;
      resolverRef.current = { requestId, resolve };
      setState({
        requestId,
        visible: true,
        title: options.title,
        description: options.description,
        confirmText: options.confirmText || '确认',
        cancelText: options.cancelText || '取消',
        danger: options.danger || false,
      });
    });
  }, []);

  const answer = useCallback((requestId: number, accepted: boolean) => {
    if (resolverRef.current?.requestId !== requestId) return;
    const pending = resolverRef.current;
    resolverRef.current = null;
    setState(prev => prev.requestId === requestId ? { ...prev, visible: false } : prev);
    pending.resolve(accepted);
  }, []);

  const ConfirmModalComponent = (
    <ConfirmModal
      key={state.requestId}
      visible={state.visible}
      title={state.title}
      description={state.description}
      confirmText={state.confirmText}
      cancelText={state.cancelText}
      danger={state.danger}
      onConfirm={() => answer(state.requestId, true)}
      onCancel={() => answer(state.requestId, false)}
    />
  );

  return { confirm, cancelPending, ConfirmModal: ConfirmModalComponent };
}
