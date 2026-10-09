import { type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, useStore } from 'zustand';
import { AnimatePresence, motion } from 'framer-motion';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface LegacyToastProps {
  visible?: boolean;
  message?: string;
  title?: string;
  type?: ToastType;
  duration?: number;
  toastId?: number;
  onClose?: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

const MAX_VISIBLE_TOASTS = 5;

interface ToastQueueState {
  items: ToastItem[];
}

const toastQueue = createStore<ToastQueueState>(() => ({ items: [] }));

let nextToastId = 1;
const dismissTimers = new Map<number, number>();

function clearDismissTimer(id: number) {
  const timer = dismissTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    dismissTimers.delete(id);
  }
}

function scheduleDismiss(id: number, duration: number) {
  clearDismissTimer(id);
  const timer = window.setTimeout(() => {
    dismissTimers.delete(id);
    dismissToast(id);
  }, duration);
  dismissTimers.set(id, timer);
}

function pushToast(message: string, type: ToastType, duration: number): number {
  const state = toastQueue.getState();
  let items = state.items;
  while (items.length >= MAX_VISIBLE_TOASTS) {
    const oldest = items[0];
    clearDismissTimer(oldest.id);
    items = items.slice(1);
  }
  const id = nextToastId++;
  toastQueue.setState({ items: [...items, { id, message, type }] });
  scheduleDismiss(id, duration);
  return id;
}

export function dismissToast(id: number) {
  clearDismissTimer(id);
  toastQueue.setState((state) => ({ items: state.items.filter((t) => t.id !== id) }));
}

let hostRoot: Root | null = null;
let hostContainer: HTMLDivElement | null = null;

function ensureGlobalHost() {
  if (hostRoot) return;
  if (typeof document === 'undefined') return;
  hostContainer = document.createElement('div');
  hostContainer.setAttribute('data-global-toast-host', '');
  document.body.appendChild(hostContainer);
  hostRoot = createRoot(hostContainer);
  hostRoot.render(<ToastHost />);
}

export function pushGlobalToast(options: { message: string; type?: ToastType; duration?: number }): number {
  ensureGlobalHost();
  return pushToast(options.message, options.type || 'info', options.duration ?? 2500);
}

const TOAST_ICONS: Record<ToastType, ReactNode> = {
  success: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  ),
  error: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  info: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
    </svg>
  ),
  warning: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  ),
};

const TOAST_BORDER_COLORS: Record<ToastType, string> = {
  success: 'border-l-emerald-500',
  error: 'border-l-red-500',
  warning: 'border-l-amber-500',
  info: 'border-l-accent',
};

const TOAST_ICON_COLORS: Record<ToastType, string> = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-accent',
};

function ToastCard({ item }: { item: ToastItem }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
      transition={reducedMotion ? { duration: 0.12 } : { duration: 0.22, ease: [0.0, 0.0, 0.2, 1] }}
      className={`flex items-start gap-3 px-4 py-3 bg-bg-surface border border-border-subtle border-l-[3px] ${TOAST_BORDER_COLORS[item.type]} rounded-[10px] shadow-lg min-w-[280px] max-w-[380px] pointer-events-auto`}
    >
      <div className={`flex-shrink-0 mt-0.5 text-sm font-bold ${TOAST_ICON_COLORS[item.type]}`}>
        {TOAST_ICONS[item.type]}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{item.message}</div>
      </div>
      <button
        onClick={() => dismissToast(item.id)}
        className="flex-shrink-0 text-text-muted hover:text-text-primary transition-colors leading-none"
        aria-label="关闭提示"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </motion.div>
  );
}

function ToastHost() {
  const items = useStore(toastQueue, (s) => s.items);
  if (items.length === 0) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[90] flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * 兼容层：历史代码通过 useToast().Toast 以 JSX 方式挂载提示容器。
 * 提示队列已模块级单例化并由全局宿主渲染，此组件仅作占位以保持调用点兼容。
 */
export function Toast(_props: LegacyToastProps) {
  void _props;
  return null;
}
