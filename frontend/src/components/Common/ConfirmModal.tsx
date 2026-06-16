import { useState, useEffect, useCallback } from 'react';

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

  useEffect(() => {
    if (visible) {
      setShow(true);
      setIsClosing(false);
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setShow(false);
      setIsClosing(false);
      onCancel();
    }, 200);
  }, [onCancel]);

  const handleConfirm = useCallback(() => {
    if (isClosing) return; // 防止双击重复触发
    setIsClosing(true);
    setTimeout(() => {
      setShow(false);
      setIsClosing(false);
      onConfirm();
    }, 200);
  }, [onConfirm, isClosing]);

  if (!show && !visible) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 p-4 backdrop-blur-sm transition-opacity duration-200 ${
        show && !isClosing ? 'opacity-100' : 'opacity-0'
      } bg-black/50`}
      onClick={handleClose}
    >
      <div
        className={`w-full max-w-[420px] bg-bg-surface rounded-2xl shadow-xl border border-border-subtle overflow-hidden transition-all duration-[250ms] ${
          show && !isClosing
            ? 'opacity-100 scale-100'
            : 'opacity-0 scale-90'
        }`}
        style={{
          transitionTimingFunction: show && !isClosing 
            ? 'cubic-bezier(0.175, 0.885, 0.32, 1.275)' 
            : 'cubic-bezier(0.4, 0.0, 1, 1)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-8 pb-4">
          <h3 className="text-lg font-semibold text-text-primary text-center">
            {title}
          </h3>
          {description && (
            <p className="mt-2 text-sm text-text-secondary text-center leading-relaxed">
              {description}
            </p>
          )}
        </div>
        <div className="flex gap-3 px-6 pb-6 pt-2">
          <button
            onClick={handleClose}
            className="flex-1 py-2.5 text-sm font-medium text-text-secondary bg-transparent border border-border rounded-[10px] hover:bg-bg-surface2 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
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
