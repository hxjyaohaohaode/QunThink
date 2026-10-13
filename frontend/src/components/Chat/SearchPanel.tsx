import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { api, getAuthGeneration } from '../../services/api';
import { useGroupsStore } from '../../stores/groupsStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePersonasStore } from '../../stores/personasStore';
import { useAgentsStore } from '../../stores/agentsStore';
import { getCacheUserId } from '../../utils/cacheUtils';
import { useFocusTrap } from '../Common/useFocusTrap';
import { useGlobalSearch } from '../../hooks/useGlobalSearch';
import { readSearchHistory, rememberSearch, clearSearchHistory } from '../../utils/searchHistory';
import { motion } from 'framer-motion';
import { AI_AVATAR_LETTERS, AI_COLORS, AI_NAMES } from '../../types';


dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

type FilterTab = 'all' | 'groups' | 'messages' | 'files' | 'agents' | 'personas' | 'comments' | 'members' | 'media';
type QuickFilter = 'all' | 'images' | 'files' | 'links' | 'media';

function formatFileSize(bytes?: number) {
  if (!bytes || bytes <= 0) return '-';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function truncate(text: string | undefined, max = 120) {
  if (!text) return '-';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query || !query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 text-inherit rounded px-0.5">{part}</mark>
      : part
  );
}

export function SearchPanel() {
  const search = useGlobalSearch();
  const reduced = useReducedMotion();
  const { query, setQuery, activeTab, setActiveTab, groupId: selectedGroupId, setGroupId: setSelectedGroupId,
    quickFilter, setQuickFilter, dateFrom, setDateFrom, dateTo, setDateTo, searchData, loading, error } = search;
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [history, setHistory] = useState(readSearchHistory);
  const [opening, setOpening] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const groups = useGroupsStore(s => s.groups);
  const personas = usePersonasStore(s => s.personas);
  const setSearchPanelOpen = useNavigationStore(s => s.setSearchPanelOpen);
  const close = useCallback(() => setSearchPanelOpen(false), [setSearchPanelOpen]);
  const trapRef = useFocusTrap<HTMLDivElement>(true, close);
  const alive = useRef(true), navigation = useRef(0);
  useEffect(() => { setQuery(useNavigationStore.getState().searchInitialQuery); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; navigation.current++; }; }, []);
  useEffect(() => { if (searchData && !loading) setHistory(rememberSearch(searchData.query)); }, [searchData, loading]);
  const counts = useMemo(() => ({ all: searchData?.total || 0, ...Object.fromEntries(
    (['groups', 'messages', 'files', 'agents', 'personas', 'comments', 'members', 'media'] as const)
      .map(type => [type, searchData?.counts?.[type] ?? searchData?.[type]?.length ?? 0])) }), [searchData]) as Record<FilterTab, number>;

  async function openResult(kind: 'group' | 'agent', id: string, messageId?: string) {
    if (opening) return;
    const intent = ++navigation.current, user = getCacheUserId(), generation = getAuthGeneration();
    const current = () => alive.current && intent === navigation.current && user === getCacheUserId() && generation === getAuthGeneration();
    setOpening(true); setNavigationError('');
    try {
      if (kind === 'group') {
        const group = await api.getGroup(id);
        if (!current()) return;
        useGroupsStore.getState().upsertGroup(group);
      } else {
        const agent = await api.getAgent(id);
        if (!current()) return;
        useAgentsStore.getState().upsertAgent(agent);
      }
      if (current()) useNavigationStore.getState().openDestination({ kind, id, messageId });
    } catch {
      if (current()) setNavigationError('暂时无法打开，内容可能已删除或连接中断。请刷新搜索后重试。');
    } finally { if (current()) setOpening(false); }
  }
  const goToGroup = (id: string) => void openResult('group', id);
  const goToMessage = (id: string, messageId: string) => void openResult('group', id, messageId);

  const senderName = (senderType: string, senderId?: string) => {
    if (senderType === 'user') return '用户';
    if (senderType === 'system') return '系统';
    return personas[senderId || '']?.name || AI_NAMES[senderId || ''] || senderId || 'AI';
  };

  const senderLetter = (senderType: string, senderId?: string) => {
    if (senderType === 'user') return 'U';
    if (senderType === 'system') return 'S';
    return AI_AVATAR_LETTERS[senderId || ''] || senderName(senderType, senderId)[0] || 'A';
  };

  const senderColor = (senderType: string, senderId?: string) => {
    if (senderType === 'user') return AI_COLORS.user;
    if (senderType === 'system') return AI_COLORS.system;
    return personas[senderId || '']?.color || AI_COLORS[senderId || ''] || '#6b7280';
  };

  const tabButton = (tab: FilterTab, label: string) => (
    <button
      key={tab}
      onClick={() => setActiveTab(tab)}
      aria-pressed={activeTab === tab}
      className={`relative isolate min-h-10 rounded-xl px-3 py-2 text-xs font-medium whitespace-nowrap ${activeTab === tab ? 'text-accent' : 'text-text-secondary hover:text-text-primary'}`}
    >
      {activeTab === tab && <motion.span layoutId="search-selection" className="absolute inset-0 -z-10 rounded-xl bg-accent/10 border border-accent/20" transition={{ duration: reduced ? 0 : 0.24 }} />}
      {label} ({counts[tab]})
    </button>
  );

  return (
    <div className="search-overlay" onClick={close}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="全局搜索" className="search-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="search-header">
          <input
            aria-label="搜索关键词"
            maxLength={500}
            autoFocus
            data-search-input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索群聊、消息、文件、媒体、成员、智能体和人设"
            className="min-w-0 flex-1 rounded-xl border border-border-subtle bg-bg-surface2 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent"
          />
          <select
            aria-label="搜索范围"
            value={selectedGroupId}
            onChange={(event) => setSelectedGroupId(event.target.value)}
            className="search-scope rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-3 text-sm text-text-primary"
          >
            <option value="">全部群聊</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
          <button onClick={close} className="rounded-xl px-3 py-2 text-sm text-text-secondary hover:bg-bg-surface2 hover:text-text-primary">关闭</button>
        </div>

        <div className="search-tabs" aria-label="搜索类型">
          {tabButton('all', '全部')}
          {tabButton('groups', '群聊')}
          {tabButton('messages', '消息')}
          {tabButton('files', '文件')}
          {tabButton('media', '媒体')}
          {tabButton('agents', '智能体')}
          {tabButton('personas', '人设')}
          {tabButton('members', '成员')}
          {tabButton('comments', '评论')}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2">
          <span className="text-[10px] text-text-muted mr-1">筛选：</span>
          {([
            { key: 'all' as QuickFilter, label: '全部', icon: (<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>) },
            { key: 'images' as QuickFilter, label: '图片', icon: (<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>) },
            { key: 'media' as QuickFilter, label: '媒体', icon: (<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" /></svg>) },
            { key: 'files' as QuickFilter, label: '文件', icon: (<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>) },
            { key: 'links' as QuickFilter, label: '链接', icon: (<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" /></svg>) },
          ]).map((filter) => (
            <button
              key={filter.key}
              onClick={() => setQuickFilter(filter.key)}
              aria-pressed={quickFilter === filter.key}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${quickFilter === filter.key
                ? 'bg-accent text-white'
                : 'bg-bg-surface2 text-text-secondary hover:text-text-primary'
                }`}
            >
              {filter.icon}
              {filter.label}
            </button>
          ))}
          <div className="w-px h-4 bg-border-subtle mx-1" />
          <button
            onClick={() => setShowDateFilter(!showDateFilter)}
            aria-expanded={showDateFilter}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${showDateFilter || dateFrom || dateTo
              ? 'bg-accent text-white'
              : 'bg-bg-surface2 text-text-secondary hover:text-text-primary'
              }`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
            日期
          </button>
          {showDateFilter && (
            <div className="search-date-range flex flex-wrap items-center gap-2 ml-1 animate-fade-in">
              <input
                type="date"
                aria-label="开始日期"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-[110px] rounded-lg border border-border-subtle bg-bg-surface2 px-2 py-1 text-[10px] text-text-primary outline-none focus:border-accent"
              />
              <span className="text-[10px] text-text-muted">至</span>
              <input
                type="date"
                aria-label="结束日期"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-[110px] rounded-lg border border-border-subtle bg-bg-surface2 px-2 py-1 text-[10px] text-text-primary outline-none focus:border-accent"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                  className="text-[10px] text-text-muted hover:text-text-primary"
                >
                  清除
                </button>
              )}
            </div>
          )}
        </div>

        <div className="search-body">
          <aside className="search-history">
            <div className="flex items-center justify-between mb-3"><h4 className="text-sm font-medium text-text-primary">本次登录的搜索</h4>{!!history.length && <button className="text-xs text-text-muted" onClick={() => { clearSearchHistory(); setHistory([]); }}>清空</button>}</div>
            <div className="space-y-2">
              {history.length > 0 ? history.map((item) => (
                <button
                  key={item}
                  onClick={() => setQuery(item)}
                  className="block w-full rounded-lg border border-border-subtle px-3 py-2 text-left text-sm text-text-secondary hover:text-text-primary"
                >
                  {item}
                </button>
              )) : <p className="text-sm text-text-muted">暂无搜索历史。</p>}
            </div>
          </aside>

          <main className="search-results" aria-busy={loading || opening}>
            {!query.trim() && <p className="text-sm text-text-muted">输入关键词即可搜索整个系统。</p>}
            {loading && <p role="status" className="text-sm text-text-muted">搜索中…</p>}{opening && <p role="status" className="text-sm text-accent">正在打开内容…</p>}{navigationError && <p role="alert" className="text-sm text-red-500">{navigationError}</p>}
            {error && <div role="alert"><p className="text-sm text-red-500">{error}</p><button className="workspace-button mt-3" onClick={search.retry}>重试搜索</button></div>}
            {!loading && !error && query.trim() && searchData && search.total === 0 && (
              <p className="text-sm text-text-muted">没有找到 “{query}” 的结果。</p>
            )}

            {!loading && !error && searchData && (
              <div className="space-y-6">
                {(activeTab === 'all' || activeTab === 'groups') && searchData.groups.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">群聊</h5>
                    <div className="space-y-3">
                      {searchData.groups.map((result) => (
                        <button key={result.id} onClick={() => goToGroup(result.id)} className="block w-full rounded-xl border border-border-subtle bg-bg-surface2 p-4 text-left hover:border-accent">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-text-primary">{result.name}</div>
                              <div className="text-xs text-text-muted">{truncate(result.description, 100)}</div>
                            </div>
                            <span className="text-xs text-text-muted">{result.memberCount || 0} 位成员</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {(activeTab === 'all' || activeTab === 'messages') && searchData.messages.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">消息</h5>
                    <div className="space-y-3">
                      {searchData.messages.map((result) => (
                        <button key={result.id} onClick={() => goToMessage(result.group_id, result.id)} className="block w-full rounded-xl border border-border-subtle bg-bg-surface2 p-4 text-left hover:border-accent">
                          <div className="flex items-start gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ backgroundColor: senderColor(result.sender_type, result.sender_id) }}>
                              {senderLetter(result.sender_type, result.sender_id)}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm font-medium text-text-primary">{senderName(result.sender_type, result.sender_id)}</span>
                                <span className="text-xs text-text-muted">{dayjs(result.created_at).fromNow()}</span>
                              </div>
                              <div className="text-xs text-text-muted">{result.group_name}</div>
                              <p className="mt-2 text-sm text-text-secondary">{highlightText(truncate(result.content, 160), query)}</p>
                              {result.attachment_match_preview && (
                                <p className="mt-1.5 text-xs text-accent/80 line-clamp-2 whitespace-pre-line">{highlightText(truncate(result.attachment_match_preview, 200), query)}</p>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {(activeTab === 'all' || activeTab === 'files') && searchData.files.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">文件</h5>
                    <div className="space-y-3">
                      {searchData.files.map((result) => (
                        <button key={result.id} onClick={() => result.linked_message_id ? goToMessage(result.group_id, result.linked_message_id) : goToGroup(result.group_id)} className="block w-full rounded-xl border border-border-subtle bg-bg-surface2 p-4 text-left hover:border-accent">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-text-primary">{highlightText(result.filename, query)}</div>
                              <div className="text-xs text-text-muted">{result.group_name} · {result.mime_type} · {formatFileSize(result.file_size)}</div>
                              {result.media_description && (
                                <p className="mt-1.5 text-xs text-accent/80 line-clamp-2">AI识别: {highlightText(truncate(result.media_description, 160), query)}</p>
                              )}
                              {result.search_description && (
                                <p className="mt-1.5 text-xs text-text-secondary line-clamp-2">{highlightText(truncate(result.search_description, 160), query)}</p>
                              )}
                              {result.content_preview && !result.search_description && (
                                <p className="mt-1.5 text-xs text-text-muted line-clamp-2">{highlightText(truncate(result.content_preview, 160), query)}</p>
                              )}
                              {result.search_tags && result.search_tags.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {result.search_tags.slice(0, 5).map((tag) => (
                                    <span key={tag} className="inline-block rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">{tag}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <span className="text-xs text-text-muted flex-shrink-0">{dayjs(result.created_at).format('YYYY-MM-DD HH:mm')}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {(activeTab === 'all' || activeTab === 'agents') && searchData.agents.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">智能体</h5>
                    <div className="space-y-3">
                      {searchData.agents.map((result) => (
                        <button key={result.id} onClick={() => void openResult('agent', result.id)} className="block w-full rounded-xl border border-border-subtle bg-bg-surface2 p-4 text-left hover:border-accent">
                          <div className="text-sm font-medium text-text-primary">{result.name}</div>
                          <div className="mt-1 text-sm text-text-secondary">{truncate(result.description, 140)}</div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {(activeTab === 'all' || activeTab === 'personas') && searchData.personas.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">人设</h5>
                    <div className="space-y-3">
                      {searchData.personas.map((result) => (
                        <div key={result.id} className="rounded-xl border border-border-subtle bg-bg-surface2 p-4">
                          <div className="text-sm font-medium text-text-primary">{result.name}</div>
                          <details className="mt-1 text-sm text-text-secondary"><summary>{truncate(result.personality || result.style, 140)}</summary><p className="whitespace-pre-wrap break-words mt-2">{result.personality}</p><p className="whitespace-pre-wrap break-words mt-2">{result.style}</p></details>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {(activeTab === 'all' || activeTab === 'comments') && searchData.comments.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">评论</h5>
                    <div className="space-y-3">
                      {searchData.comments.map((result) => (
                        <button key={result.id} onClick={() => goToMessage(result.group_id, result.message_id)} className="block w-full rounded-xl border border-border-subtle bg-bg-surface2 p-4 text-left hover:border-accent">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-text-primary">{senderName(result.sender_type, result.sender_id)}</span>
                            <span className="text-xs text-text-muted">{dayjs(result.created_at).format('YYYY-MM-DD HH:mm')}</span>
                          </div>
                          <div className="text-xs text-text-muted">{result.group_name}</div>
                          <p className="mt-2 text-sm text-text-secondary">{highlightText(truncate(result.content, 160), query)}</p>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {(activeTab === 'all' || activeTab === 'members') && searchData.members.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">成员</h5>
                    <div className="space-y-3">
                      {searchData.members.map((result) => (
                        <button key={`${result.id}_${result.group_id}`} onClick={() => goToGroup(result.group_id)} className="block w-full rounded-xl border border-border-subtle bg-bg-surface2 p-4 text-left hover:border-accent">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold text-white flex-shrink-0" style={{ backgroundColor: result.type === 'ai' ? (result.color || AI_COLORS[result.id] || '#6b7280') : AI_COLORS.user }}>
                              {result.type === 'ai' ? (result.name?.[0] || 'A') : 'U'}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-text-primary">{highlightText(result.name, query)}</span>
                                <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${result.type === 'ai' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'}`}>
                                  {result.type === 'ai' ? 'AI' : '用户'}
                                </span>
                              </div>
                              <div className="text-xs text-text-muted mt-0.5">{result.group_name}</div>
                              {result.personality && (
                                <p className="mt-1.5 text-xs text-text-secondary line-clamp-2">{highlightText(truncate(result.personality, 120), query)}</p>
                              )}
                              {result.expertise && result.expertise.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {result.expertise.slice(0, 4).map((tag) => (
                                    <span key={tag} className="inline-block rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">{tag}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {(activeTab === 'all' || activeTab === 'media') && searchData.media.length > 0 && (
                  <section>
                    <h5 className="mb-3 text-sm font-semibold text-text-primary">媒体</h5>
                    <div className="space-y-3">
                      {searchData.media.map((result) => {
                        const mediaIcon = result.media_type === 'image'
                          ? (<svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>)
                          : result.media_type === 'audio'
                            ? (<svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" /></svg>)
                            : (<svg className="w-3.5 h-3.5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" /></svg>);
                        const mediaLabel = result.media_type === 'image' ? '图片' : result.media_type === 'audio' ? '音频' : '视频';
                        return (
                          <button key={result.id} onClick={() => goToGroup(result.group_id)} className="block w-full rounded-xl border border-border-subtle bg-bg-surface2 p-4 text-left hover:border-accent">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  {mediaIcon}
                                  <span className="text-sm font-medium text-text-primary">{highlightText(result.filename, query)}</span>
                                  <span className="inline-block rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">{mediaLabel}</span>
                                </div>
                                <div className="text-xs text-text-muted mt-0.5">{result.group_name} · {result.mime_type} · {formatFileSize(result.file_size)}</div>
                                {result.media_description && (
                                  <p className="mt-1.5 text-xs text-accent/80 line-clamp-2">AI识别: {highlightText(truncate(result.media_description, 160), query)}</p>
                                )}
                                {result.search_description && (
                                  <p className="mt-1.5 text-xs text-text-secondary line-clamp-2">{highlightText(truncate(result.search_description, 160), query)}</p>
                                )}
                                {result.content_preview && !result.search_description && !result.media_description && (
                                  <p className="mt-1.5 text-xs text-text-muted line-clamp-2">{highlightText(truncate(result.content_preview, 160), query)}</p>
                                )}
                                {result.search_tags && result.search_tags.length > 0 && (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    {result.search_tags.slice(0, 5).map((tag) => (
                                      <span key={tag} className="inline-block rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">{tag}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <span className="text-xs text-text-muted flex-shrink-0">{dayjs(result.created_at).format('YYYY-MM-DD HH:mm')}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            )}
          </main>
        </div>
        <footer className="search-footer">
          <span role="status">{query.trim() && !loading ? '共 ' + search.total + ' 条 · 第 ' + (search.offset / search.limit + 1) + ' 页' : '搜索你当前账号可访问的内容'}{activeTab === 'all' && !!searchData?.total ? '（每类每页 20 条）' : ''}</span>
          <div className="flex gap-2"><button className="workspace-button" disabled={loading || !search.offset} onClick={search.previousPage}>上一页</button><button className="workspace-button" disabled={loading || !search.hasMore} onClick={search.nextPage}>下一页</button></div>
        </footer>
      </div>
    </div>
  );
}
