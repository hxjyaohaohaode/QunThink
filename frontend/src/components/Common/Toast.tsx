import { useEffect, useState, useRef } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastProps {
  visible: boolean;
  message: string;
  title?: string;
  type: ToastType;
  duration?: number;
  toastId?: number;
  onClose: () => void;
}

const TOAST_ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
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

export function Toast({ visible, message, title, type, duration = 2500, toastId, onClose }: ToastProps) {
  const [show, setShow] = useState(false);
  const [isHiding, setIsHiding] = useState(false);
  const reducedMotion = useReducedMotion();
  const timersRef = useRef<number[]>([]);
  const currentToastIdRef = useRef<number | undefined>(toastId);

  const safeSetTimeout = (fn: () => void, delay: number) => {
    const id = window.setTimeout(() => {
      fn();
      timersRef.current = timersRef.current.filter(t => t !== id);
    }, delay);
    timersRef.current.push(id);
    return id;
  };

  useEffect(() => {
    return () => {
      timersRef.current.forEach(id => clearTimeout(id));
    };
  }, []);

  useEffect(() => {
    if (visible) {
      currentToastIdRef.current = toastId;
      setShow(true);
      setIsHiding(false);
      const timer = safeSetTimeout(() => {
        setIsHiding(true);
        safeSetTimeout(() => {
          setShow(false);
          setIsHiding(false);
          if (currentToastIdRef.current === toastId) {
            onClose();
          }
        }, reducedMotion ? 0 : 250);
      }, duration);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      setIsHiding(false);
    }
  }, [visible, duration, toastId, onClose, reducedMotion]);

  if (!visible && !show) return null;

  const transitionStyle = reducedMotion
    ? {}
    : {
        transitionTimingFunction: show && !isHiding
          ? 'cubic-bezier(0.0, 0.0, 0.2, 1)'
          : 'cubic-bezier(0.4, 0.0, 1, 1)'
      };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
      <div
        className={`flex items-start gap-3 px-4 py-3 bg-bg-surface border border-border-subtle border-l-[3px] ${TOAST_BORDER_COLORS[type]} rounded-[10px] shadow-lg min-w-[280px] max-w-[380px] pointer-events-auto ${
          reducedMotion ? '' : 'transition-all duration-[250ms]'
        } ${
          show && !isHiding
            ? 'opacity-100 translate-x-0'
            : 'opacity-0 translate-x-8'
        }`}
        style={transitionStyle}
      >
        <div className={`flex-shrink-0 mt-0.5 text-sm font-bold ${TOAST_ICON_COLORS[type]}`}>
          {TOAST_ICONS[type]}
        </div>
        <div className="flex-1 min-w-0">
          {title && (
            <div className="text-sm font-medium text-text-primary">
              {title}
            </div>
          )}
          <div className={`text-xs text-text-secondary overflow-hidden text-ellipsis ${title ? 'mt-0.5' : 'text-sm font-medium text-text-primary'}`}>
            {message}
          </div>
        </div>
        <button
          onClick={() => {
            setIsHiding(true);
            safeSetTimeout(() => {
              setShow(false);
              setIsHiding(false);
              onClose();
            }, reducedMotion ? 0 : 250);
          }}
          className="flex-shrink-0 text-text-muted hover:text-text-primary transition-colors text-sm leading-none"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
