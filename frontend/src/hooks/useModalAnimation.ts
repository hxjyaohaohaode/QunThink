import { useState, useCallback, useRef, useEffect } from 'react';
import { useReducedMotion } from './useReducedMotion';

type ModalAnimationState = 'closed' | 'opening' | 'open' | 'closing';
export function useModalAnimation(isOpen: boolean, onClose: () => void, options?: { closeDelay?: number }) {
  const reduced = useReducedMotion();
  const closeDelay = reduced ? 0 : options?.closeDelay ?? 150;
  const [state, setState] = useState<ModalAnimationState>('closed');
  const stateRef = useRef(state); stateRef.current = state;
  const rafRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const clear = () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; }
    };
    clear();
    if (isOpen) {
      if (stateRef.current !== 'open') {
        if (reduced) setState('open');
        else {
          setState('opening');
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = requestAnimationFrame(() => setState('open'));
          });
        }
      }
    } else if (stateRef.current !== 'closed') {
      setState('closing');
      timerRef.current = setTimeout(() => setState('closed'), closeDelay);
    }
    // A close timer from an earlier intent must not hide a reopened dialog.
    return clear;
  }, [isOpen, closeDelay, reduced]);
  const close = useCallback(() => {
    if (stateRef.current !== 'closed' && stateRef.current !== 'closing') onClose();
  }, [onClose]);
  const isClosing = state === 'closing';
  return {
    isVisible: state !== 'closed', isClosing, close,
    overlayClass: isClosing ? 'modal-overlay-closing' : 'modal-overlay',
    contentClass: isClosing ? 'modal-content-closing' : 'modal-content',
    sheetClass: isClosing ? 'sheet-content-closing' : 'sheet-content',
  };
}
