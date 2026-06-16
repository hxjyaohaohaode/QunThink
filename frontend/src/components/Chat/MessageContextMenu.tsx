import React, { useState, useLayoutEffect, useRef, useCallback } from 'react';

interface ContextMenuAction {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MessageContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export function MessageContextMenu({ x, y, actions, onClose }: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = x;
    let adjustedY = y;

    if (rect.right > viewportWidth) {
      adjustedX = viewportWidth - rect.width - 8;
    }
    if (rect.bottom > viewportHeight) {
      adjustedY = viewportHeight - rect.height - 8;
    }
    if (adjustedX < 0) adjustedX = 8;
    if (adjustedY < 0) adjustedY = 8;

    setPosition({ x: adjustedX, y: adjustedY });
  }, [x, y]);

  useLayoutEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-50 bg-bg-surface rounded-xl shadow-2xl border border-border-subtle py-1.5 min-w-[180px] animate-fade-in"
        style={{ left: position.x, top: position.y }}
      >
        {actions.map((action, index) => (
          <button
            key={index}
            role="menuitem"
            onClick={() => {
              action.onClick();
              onClose();
            }}
            disabled={action.disabled}
            className={`w-full px-4 py-2.5 text-left text-sm flex items-center gap-3 transition-colors ${
              action.danger
                ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                : 'text-text-primary hover:bg-bg-surface2'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <span className="text-base flex items-center justify-center">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function useMessageContextMenu() {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    messageId: string;
  } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, messageId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, messageId });
  }, []);

  const handleLongPress = useCallback((messageId: string) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    const isTriggeredRef = { current: false };

    return {
      onTouchStart: (e: React.TouchEvent) => {
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        isTriggeredRef.current = false;

        // 触发触觉反馈
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(50);
        }

        timer = setTimeout(() => {
          isTriggeredRef.current = true;
          setContextMenu({ x: touch.clientX, y: touch.clientY, messageId });
        }, 400);
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!timer || isTriggeredRef.current) return;
        const touch = e.touches[0];
        const diffX = Math.abs(touch.clientX - startX);
        const diffY = Math.abs(touch.clientY - startY);

        // 增加容错距离到 20px，减少误触
        if (diffX > 20 || diffY > 20) {
          clearTimeout(timer);
          timer = null;
        }
      },
      onTouchEnd: () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // 如果菜单已触发，阻止后续点击事件
        if (isTriggeredRef.current) {
          setTimeout(() => { isTriggeredRef.current = false; }, 100);
        }
      },
    };
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return { contextMenu, handleContextMenu, handleLongPress, closeContextMenu };
}
