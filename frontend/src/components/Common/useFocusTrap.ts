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
    (el) => !el.matches(':disabled') && !el.closest('[hidden], [inert]') && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0),
  );
}

const trapStack: { id: symbol; container: HTMLElement; restoreTarget: HTMLElement | null }[] = [];

export function useFocusTrap<T extends HTMLElement>(active: boolean, onClose?: () => void) {
  const containerRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const trapId = Symbol('focus-trap');
    const entry = { id: trapId, container, restoreTarget: document.activeElement as HTMLElement | null };
    // React runs child effects first. A newly mounted parent must not cover its nested trap.
    const childIndex = trapStack.findIndex(item => container.contains(item.container));
    if (childIndex >= 0) {
      entry.restoreTarget = trapStack[childIndex].restoreTarget;
      trapStack[childIndex].restoreTarget = container;
      trapStack.splice(childIndex, 0, entry);
    } else trapStack.push(entry);
    container.setAttribute('data-focus-trap-active', '');
    const previousTabIndex = container.getAttribute('tabindex');
    if (previousTabIndex === null) container.tabIndex = -1;

    const focusFirst = () => {
      const elements = getFocusableElements(container);
      (elements[0] ?? container).focus();
    };
    if (trapStack[trapStack.length - 1]?.id === trapId) focusFirst();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (trapStack[trapStack.length - 1]?.id !== trapId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
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
      if (previousTabIndex === null) container.removeAttribute('tabindex');
      const wasTop = trapStack[trapStack.length - 1]?.id === trapId;
      const index = trapStack.findIndex(item => item.id === trapId);
      if (index >= 0) trapStack.splice(index, 1);
      for (const remaining of trapStack) {
        if (remaining.restoreTarget && container.contains(remaining.restoreTarget)) remaining.restoreTarget = entry.restoreTarget;
      }
      const parent = trapStack[trapStack.length - 1];
      const restoreTarget = parent && (!entry.restoreTarget || !parent.container.contains(entry.restoreTarget))
        ? getFocusableElements(parent.container)[0] ?? parent.container
        : entry.restoreTarget === parent?.container ? getFocusableElements(parent.container)[0] ?? parent.container : entry.restoreTarget;
      if (wasTop && restoreTarget?.isConnected && typeof restoreTarget.focus === 'function') {
        try { restoreTarget.focus(); } catch {}
      }
    };
  }, [active]);

  return containerRef;
}
