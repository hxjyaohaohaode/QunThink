import { useState, useEffect, useCallback, useRef, useId } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { useReducedMotion } from '../../hooks/useReducedMotion';

interface ConfirmModalProps {
  visible: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  loading?: boolean;
}

export function ConfirmModal({
  visible,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
  danger = false,
  loading = false,
}: ConfirmModalProps) {
  const [show, setShow] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const reducedMotion = useReducedMotion();
  const descriptionId = useId();
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    closingRef.current = false;
    if (visible) {
      setShow(true);
      setIsClosing(false);
    } else { setShow(false); setIsClosing(false); }
  }, [visible]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const finish = useCallback((accepted: boolean) => {
    if (closingRef.current || loading || !visible) return;
    closingRef.current = true;
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setShow(false);
      (accepted ? onConfirm : onCancel)();
    }, reducedMotion ? 0 : 160);
  }, [onConfirm, onCancel, loading, visible, reducedMotion]);
  const handleClose = useCallback(() => finish(false), [finish]);
  const handleConfirm = useCallback(() => finish(true), [finish]);
  const trapRef = useFocusTrap<HTMLDivElement>(show && visible, handleClose);

  if (!show && !visible) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-[80] p-4 backdrop-blur-sm transition-opacity duration-200 ${
        show && !isClosing ? 'opacity-100' : 'opacity-0'
      } bg-black/50`}
      onClick={handleClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={loading}
        className={`w-full max-w-[420px] bg-bg-surface rounded-2xl shadow-xl border border-border-subtle overflow-hidden transition-[opacity,transform] duration-150 ${
          show && !isClosing
            ? 'opacity-100 scale-100'
            : 'opacity-0 scale-[0.97]'
        }`}
        style={{
          transitionTimingFunction: show && !isClosing
            ? 'cubic-bezier(0.16, 1, 0.3, 1)'
            : 'cubic-bezier(0.4, 0.0, 1, 1)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-8 pb-4">
          <h3 className="text-lg font-semibold text-text-primary text-center">
            {title}
          </h3>
          {description && (
            <p id={descriptionId} className="mt-2 text-sm text-text-secondary text-center leading-relaxed">
              {description}
            </p>
          )}
        </div>
        <div className="flex gap-3 px-6 pb-6 pt-2">
          <button
            onClick={handleClose}
            disabled={loading || isClosing}
            className="flex-1 py-2.5 text-sm font-medium text-text-secondary bg-transparent border border-border rounded-[10px] hover:bg-bg-surface2 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || isClosing}
            className={`flex-1 py-2.5 text-sm font-medium text-white rounded-[10px] transition-colors flex items-center justify-center gap-2 ${
              danger
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-accent hover:bg-accent-hover'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loading && (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
