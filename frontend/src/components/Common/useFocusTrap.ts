import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0,
  );
}

const trapStack: symbol[] = [];

export function useFocusTrap<T extends HTMLElement>(active: boolean, onClose?: () => void) {
  const containerRef = useRef<T | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const trapId = Symbol('focus-trap');
    trapStack.push(trapId);
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    container.setAttribute('data-focus-trap-active', '');

    const focusFirst = () => {
      const elements = getFocusableElements(container);
      (elements[0] ?? container).focus();
    };
    focusFirst();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (trapStack[trapStack.length - 1] !== trapId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = getFocusableElements(container);
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      const inside = activeEl && container.contains(activeEl);
      if (event.shiftKey) {
        if (!inside || activeEl === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      container.removeAttribute('data-focus-trap-active');
      const index = trapStack.indexOf(trapId);
      if (index >= 0) trapStack.splice(index, 1);
      const restoreTarget = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (restoreTarget && typeof restoreTarget.focus === 'function') {
        try { restoreTarget.focus(); } catch {}
      }
    };
  }, [active]);

  return containerRef;
}
