import { getCacheUserId } from '../utils/cacheUtils';
import { useState, useEffect, useCallback, useRef } from 'react';
import { api, getAuthGeneration } from '../services/api';
import { useDebounce } from './useDebounce';

export interface SearchAttachment {
  id: string;
  filename: string;
  type: string;
  url: string;
}

export interface GroupSearchResult {
  id: string;
  name: string;
  description: string;
  type: string;
  memberCount: number;
  pinned: boolean;
  created_at: string;
  matchField: string;
}

export interface MessageSearchResult {
  id: string;
  group_id: string;
  group_name: string;
  sender_type: 'user' | 'ai' | 'system';
  sender_id?: string;
  content: string;
  content_type: string;
  has_attachments: boolean;
  attachments: SearchAttachment[];
  attachment_match?: { filename: string; match_type: string } | null;
  attachment_match_preview?: string | null;
  match_type: 'content' | 'attachment' | 'tts_transcript';
  created_at: string;
}

export interface FileSearchResult {
  id: string;
  group_id: string;
  group_name: string;
  filename: string;
  mime_type: string;
  file_size: number;
  search_description: string;
  search_tags: string[];
  media_description: string;
  content_preview: string;
  match_field: string;
  url: string;
  linked_message_id: string | null;
  created_at: string;
}

export interface AgentSearchResult {
  id: string;
  name: string;
  description: string;
  avatar_url: string | null;
  opening_message: string;
  match_field: string;
  created_at: string;
}

export interface PersonaSearchResult {
  id: string;
  name: string;
  style: string;
  personality: string;
  expertise: string[];
  keywords: string[];
  color: string;
  match_field: string;
}

export interface CommentSearchResult {
  id: string;
  message_id: string;
  group_id: string;
  group_name: string;
  sender_type: string;
  sender_id?: string;
  content: string;
  created_at: string;
}

export interface MemberSearchResult {
  id: string;
  name: string;
  type: 'ai' | 'user';
  group_id: string;
  group_name: string;
  personality?: string;
  style?: string;
  expertise?: string[];
  color?: string | null;
  avatar_url?: string | null;
  match_field: string;
}

export interface MediaSearchResult {
  id: string;
  group_id: string;
  group_name: string;
  filename: string;
  mime_type: string;
  media_type: 'image' | 'audio' | 'video';
  file_size?: number;
  media_description?: string;
  search_description?: string;
  search_tags?: string[];
  content_preview?: string;
  match_field?: string;
  url?: string;
  created_at: string;
}

export interface GlobalSearchResponse {
  groups: GroupSearchResult[];
  messages: MessageSearchResult[];
  files: FileSearchResult[];
  agents: AgentSearchResult[];
  personas: PersonaSearchResult[];
  comments: CommentSearchResult[];
  members: MemberSearchResult[];
  media: MediaSearchResult[];
  total: number;
  query: string;
  counts?: Partial<Record<Exclude<SearchFilterTab, 'all'>, number>>;
  pagination?: { offset: number; limit: number; hasMore: boolean };
}

export type SearchFilterTab = 'all' | 'groups' | 'messages' | 'files' | 'agents' | 'personas' | 'comments' | 'members' | 'media';
export type QuickFilter = 'all' | 'images' | 'files' | 'links' | 'media';

export function useGlobalSearch() {
  const [query, queryState] = useState('');
  const [searchData, setSearchData] = useState<GlobalSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, tabState] = useState<SearchFilterTab>('all');
  const [groupId, groupState] = useState('');
  const [quickFilter, quickState] = useState<QuickFilter>('all');
  const [dateFrom, fromState] = useState('');
  const [dateTo, toState] = useState('');
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const version = useRef(0);
  const debouncedQuery = useDebounce(query, 300);
  const limit = 20;
  const invalidate = useCallback(() => { version.current++; setOffset(0); setSearchData(null); setError(null); }, []);
  const setQuery = useCallback((value: string) => { if (value !== query) { invalidate(); queryState(value); } }, [invalidate, query]);
  const setActiveTab = useCallback((value: SearchFilterTab) => {
    if (value !== activeTab) { if (offset) invalidate(); tabState(value); }
  }, [invalidate, activeTab, offset]);
  const setGroupId = useCallback((value: string) => { if (value !== groupId) { invalidate(); groupState(value); } }, [invalidate, groupId]);
  const setQuickFilter = useCallback((value: QuickFilter) => { if (value !== quickFilter) { invalidate(); quickState(value); } }, [invalidate, quickFilter]);
  const setDateFrom = useCallback((value: string) => { if (value !== dateFrom) { invalidate(); fromState(value); } }, [invalidate, dateFrom]);
  const setDateTo = useCallback((value: string) => { if (value !== dateTo) { invalidate(); toState(value); } }, [invalidate, dateTo]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    const request = ++version.current, user = getCacheUserId(), generation = getAuthGeneration();
    const current = () => request === version.current && user === getCacheUserId() && generation === getAuthGeneration();
    const cleanup = () => { if (version.current === request) version.current++; };
    setError(null);
    if (!query.trim() || query !== debouncedQuery) {
      setSearchData(null); setLoading(!!query.trim()); return cleanup;
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setSearchData(null); setLoading(false); setError('开始日期不能晚于结束日期'); return cleanup;
    }
    const from = dateFrom ? new Date(dateFrom + 'T00:00:00.000') : null;
    const to = dateTo ? new Date(dateTo + 'T23:59:59.999') : null;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) {
      setSearchData(null); setLoading(false); setError('请输入有效的日期'); return cleanup;
    }
    setLoading(true);
    // Calendar inputs are interpreted in the user's local timezone, including
    // each boundary's daylight-saving offset, before transport as UTC instants.
    const options = {
      groupId: groupId || undefined, quickFilter, limit, offset,
      dateFrom: from?.toISOString(),
      dateTo: to?.toISOString(),
    };
    void api.globalSearch(debouncedQuery.trim(), options).then(response => {
      if (current()) setSearchData(response);
    }).catch(() => {
      if (current()) { setError('搜索未完成，请检查连接后重试'); setSearchData(null); }
    }).finally(() => { if (current()) setLoading(false); });
    return cleanup;
  }, [query, debouncedQuery, groupId, quickFilter, dateFrom, dateTo, offset, attempt]);

  const resetSearch = useCallback(() => {
    invalidate(); queryState(''); setLoading(false); tabState('all'); groupState('');
    quickState('all'); fromState(''); toState('');
  }, [invalidate]);
  const total = activeTab === 'all' ? searchData?.total || 0 : searchData?.counts?.[activeTab] ?? searchData?.[activeTab]?.length ?? 0;
  const maxCategory = activeTab === 'all'
    ? Math.max(0, ...Object.values(searchData?.counts || {}).map(value => value || 0)) : total;
  const hasMore = searchData?.pagination ? offset + limit < maxCategory : false;
  const nextPage = () => { if (!loading && hasMore) { version.current++; setLoading(true); setOffset(offset + limit); } };
  const previousPage = () => { if (!loading && offset) { version.current++; setLoading(true); setOffset(Math.max(0, offset - limit)); } };
  return { query, setQuery, searchData, loading, error, activeTab, setActiveTab, groupId, setGroupId,
    quickFilter, setQuickFilter, dateFrom, setDateFrom, dateTo, setDateTo, resetSearch, retry,
    offset, limit, total, hasMore, nextPage, previousPage };
}
