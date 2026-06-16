import { useState, useCallback, useRef, useEffect } from 'react';

type ModalAnimationState = 'closed' | 'opening' | 'open' | 'closing';

export function useModalAnimation(
  isOpen: boolean,
  onClose: () => void,
  options?: { closeDelay?: number }
) {
  const closeDelay = options?.closeDelay ?? 150;
  const [state, setState] = useState<ModalAnimationState>('closed');
  const rafRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const stateRef = useRef<ModalAnimationState>(state);
  stateRef.current = state;

  const isVisible = state !== 'closed';
  const isClosing = state === 'closing';

  useEffect(() => {
    if (isOpen && state === 'closed') {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setState('opening');
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => {
          if (stateRef.current !== 'opening') return;
          setState('open');
        });
      });
    } else if (!isOpen && state !== 'closed') {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setState('closing');
      timerRef.current = setTimeout(() => {
        setState('closed');
      }, closeDelay);
    }
  }, [isOpen]);

  const close = useCallback(() => {
    if (state === 'closed' || state === 'closing') return;
    onClose();
  }, [state, onClose]);

  // 根据动画阶段返回合适的CSS类
  const overlayClass = state === 'opening'
    ? 'modal-overlay'
    : isClosing
      ? 'modal-overlay-closing'
      : 'modal-overlay';
  const contentClass = state === 'opening'
    ? 'modal-content'
    : isClosing
      ? 'modal-content-closing'
      : 'modal-content';
  const sheetClass = state === 'opening'
    ? 'sheet-content'
    : isClosing
      ? 'sheet-content-closing'
      : 'sheet-content';

  return {
    isVisible,
    isClosing,
    close,
    overlayClass,
    contentClass,
    sheetClass,
  };
}