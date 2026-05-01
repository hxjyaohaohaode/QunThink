import { useEffect, useCallback } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useMessagesStore } from '../stores/messagesStore';
import { useGroupsStore } from '../stores/groupsStore';

interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  description: string;
  action: () => void;
  condition?: () => boolean;
}

export function useKeyboardShortcuts() {
  const { setReplyingTo } = useUIStore();
  const { messages } = useMessagesStore();
  const { currentGroup } = useGroupsStore();

  const getShortcuts = useCallback((): ShortcutConfig[] => {
    const groupMessages = currentGroup ? messages[currentGroup.id] || [] : [];
    const lastUserMessage = [...groupMessages].reverse().find(m => m.sender_type === 'user');

    return [
      {
        key: 'k',
        ctrl: true,
        description: '打开搜索',
        action: () => {
          const searchInput = document.querySelector('[data-search-input]') as HTMLElement;
          if (searchInput) {
            searchInput.focus();
          }
        },
      },
      {
        key: 'Enter',
        ctrl: true,
        description: '发送消息',
        action: () => {
          const sendButton = document.querySelector('[data-send-button]') as HTMLElement;
          if (sendButton) {
            sendButton.click();
          }
        },
        condition: () => {
          const textarea = document.querySelector('textarea');
          return !!textarea && document.activeElement === textarea;
        },
      },
      {
        key: 'Escape',
        description: '关闭弹窗/取消回复',
        action: () => {
          setReplyingTo(null);
          // 关闭所有弹窗
          const modals = document.querySelectorAll('[data-modal]');
          modals.forEach(modal => {
            const closeButton = modal.querySelector('[data-modal-close]') as HTMLElement;
            if (closeButton) closeButton.click();
          });
        },
      },
      {
        key: 'ArrowUp',
        description: '编辑最后一条消息',
        action: () => {
          if (lastUserMessage) {
            const messageElement = document.querySelector(`[data-message-id="${lastUserMessage.id}"]`);
            if (messageElement) {
              const editButton = messageElement.querySelector('[data-action="edit"]') as HTMLElement;
              if (editButton) editButton.click();
            }
          }
        },
        condition: () => {
          const textarea = document.querySelector('textarea');
          return !!textarea && document.activeElement === textarea && !textarea.value;
        },
      },
      {
        key: 'd',
        ctrl: true,
        shift: true,
        description: '清空聊天记录',
        action: () => {
          const clearButton = document.querySelector('[data-action="clear-chat"]') as HTMLElement;
          if (clearButton) clearButton.click();
        },
        condition: () => !!currentGroup,
      },
      {
        key: 'n',
        ctrl: true,
        description: '新建聊天',
        action: () => {
          const newChatButton = document.querySelector('[data-action="new-chat"]') as HTMLElement;
          if (newChatButton) newChatButton.click();
        },
      },
      {
        key: 'e',
        ctrl: true,
        description: '导出聊天记录',
        action: () => {
          const exportButton = document.querySelector('[data-action="export-chat"]') as HTMLElement;
          if (exportButton) exportButton.click();
        },
        condition: () => !!currentGroup && groupMessages.length > 0,
      },
      {
        key: 'r',
        ctrl: true,
        description: '刷新消息',
        action: () => {
          const refreshButton = document.querySelector('[data-action="refresh"]') as HTMLElement;
          if (refreshButton) refreshButton.click();
        },
        condition: () => !!currentGroup,
      },
    ];
  }, [currentGroup, messages, setReplyingTo]);

  useEffect(() => {
    const shortcuts = getShortcuts();

    const handleKeyDown = (e: KeyboardEvent) => {
      // 忽略输入框中的快捷键（除了特定允许的）
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      
      for (const shortcut of shortcuts) {
        const keyMatch = e.key === shortcut.key;
        const ctrlMatch = !!shortcut.ctrl === (e.ctrlKey || e.metaKey);
        const shiftMatch = !!shortcut.shift === e.shiftKey;
        const altMatch = !!shortcut.alt === e.altKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          // 检查条件
          if (shortcut.condition && !shortcut.condition()) {
            continue;
          }

          // 如果在输入框中，只允许特定快捷键
          if (isInput && !['Escape', 'ArrowUp', 'Enter'].includes(shortcut.key)) {
            continue;
          }

          e.preventDefault();
          e.stopPropagation();
          shortcut.action();
          break;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [getShortcuts]);

  return getShortcuts;
}

export function getShortcutHelpText(): string {
  return `
快捷键说明：
Ctrl+K - 打开搜索
Ctrl+Enter - 发送消息（输入框中）
Esc - 关闭弹窗/取消回复
↑ - 编辑最后一条消息（输入框为空时）
Ctrl+Shift+D - 清空聊天记录
Ctrl+N - 新建聊天
Ctrl+E - 导出聊天记录
Ctrl+R - 刷新消息
  `.trim();
}
