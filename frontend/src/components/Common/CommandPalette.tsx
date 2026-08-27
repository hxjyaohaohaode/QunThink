import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { useNavigationStore } from '../../stores/navigationStore';
import { useThemeStore } from '../../stores/themeStore';
import { useGroupsStore } from '../../stores/groupsStore';
import { getCacheUserId, clearAllCachesForUser } from '../../utils/cacheUtils';

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  keywords: string;
  icon: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useNavigationStore((s) => s.commandPaletteOpen);
  const setOpen = useNavigationStore((s) => s.setCommandPaletteOpen);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: 'search',
        label: '全局搜索',
        hint: '消息 · 群组 · 文件',
        keywords: '搜索 search find 查找',
        icon: '🔍',
        run: () => useNavigationStore.getState().setSearchPanelOpen(true)
      },
      {
        id: 'theme',
        label: '切换主题（浅色 / 深色 / 跟随系统）',
        keywords: '主题 theme 深色 dark 浅色 light 亮色',
        icon: '🎨',
        run: () => {
          const store = useThemeStore.getState();
          const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
          const next = order[(order.indexOf(store.theme) + 1) % order.length];
          store.setTheme(next);
        }
      },
      {
        id: 'goto-agents',
        label: '前往智能体页',
        keywords: '智能体 agent agents 助手',
        icon: '🤖',
        run: () => {
          useNavigationStore.getState().setActiveDesktopView('agents');
          useNavigationStore.getState().setActiveMobileTab('agents');
        }
      },
      {
        id: 'goto-chat',
        label: '前往群聊页',
        keywords: '群聊 chat 聊天 会话',
        icon: '💬',
        run: () => {
          useNavigationStore.getState().setActiveDesktopView('chat');
          useNavigationStore.getState().setActiveMobileTab('chats');
        }
      },
      {
        id: 'pin-overview',
        label: '查看全部置顶会话',
        keywords: '置顶 pin 收藏',
        icon: '📌',
        run: () => {
          const pinned = useGroupsStore.getState().groups.filter(g => g.pinned);
          if (pinned.length === 0) {
            window.alert('当前没有置顶的会话');
            return;
          }
          useGroupsStore.getState().selectGroup(pinned[0].id);
        }
      },
      {
        id: 'clear-cache',
        label: '清理本地缓存',
        hint: '清除本设备的离线缓存（不影响服务器数据）',
        keywords: '缓存 cache 清理 清除 清空',
        icon: '🧹',
        run: () => {
          const uid = getCacheUserId();
          if (uid && window.confirm('确定清理本设备的离线缓存吗？\n（聊天云端数据不受影响，本地缓存将重新拉取）')) {
            clearAllCachesForUser(uid);
            window.alert('本地缓存已清理，页面即将刷新');
            window.location.reload();
          }
        }
      }
    ];
    return items;
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) || c.keywords.includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(i => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = filtered[activeIndex];
        if (item) {
          setOpen(false);
          item.run();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, filtered, activeIndex, setOpen]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      className="fixed inset-0 z-[95] flex items-start justify-center pt-[12vh] px-4 bg-black/45 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg bg-bg-surface border border-border-subtle rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle/60">
          <span className="text-text-muted text-sm">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入命令或关键词…"
            className="flex-1 bg-transparent outline-none text-sm text-text-primary placeholder-text-muted"
            aria-label="命令搜索"
          />
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] rounded border border-border-subtle text-text-muted">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5" role="listbox" aria-label="命令列表">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted">没有匹配的命令</div>
          ) : (
            filtered.map((cmd, idx) => (
              <button
                key={cmd.id}
                data-idx={idx}
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => { setOpen(false); cmd.run(); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                  idx === activeIndex ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-bg-surface2'
                }`}
              >
                <span className="text-base leading-none flex-shrink-0">{cmd.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate">{cmd.label}</span>
                  {cmd.hint && <span className="block text-[11px] text-text-muted truncate">{cmd.hint}</span>}
                </span>
                {idx === activeIndex && (
                  <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] rounded border border-border-subtle text-text-muted flex-shrink-0">↵</kbd>
                )}
              </button>
            ))
          )}
        </div>

        <div className="px-4 py-2 border-t border-border-subtle/60 text-[10px] text-text-muted flex items-center gap-3">
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span>ESC 关闭</span>
        </div>
      </div>
    </div>
  );
}
