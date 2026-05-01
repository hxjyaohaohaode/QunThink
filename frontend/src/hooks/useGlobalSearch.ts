import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
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
  match_type: 'content' | 'attachment';
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

export interface GlobalSearchResponse {
  groups: GroupSearchResult[];
  messages: MessageSearchResult[];
  files: FileSearchResult[];
  agents: AgentSearchResult[];
  personas: PersonaSearchResult[];
  comments: CommentSearchResult[];
  total: number;
  query: string;
}

export type SearchFilterTab = 'all' | 'groups' | 'messages' | 'files' | 'agents' | 'personas' | 'comments';

export function useGlobalSearch() {
  const [query, setQuery] = useState('');
  const [searchData, setSearchData] = useState<GlobalSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SearchFilterTab>('all');

  const debouncedQuery = useDebounce(query, 300);

  const handleSearch = useCallback(async (searchQuery: string, tab: SearchFilterTab) => {
    if (!searchQuery.trim()) {
      setSearchData(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const typeParam = tab === 'all' ? undefined : tab;
      const response: GlobalSearchResponse = await api.globalSearch(searchQuery, {
        type: typeParam,
      });
      setSearchData(response);
    } catch (err) {
      setError('搜索失败');
      console.error('搜索失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    handleSearch(debouncedQuery, activeTab);
  }, [debouncedQuery, activeTab, handleSearch]);

  const resetSearch = useCallback(() => {
    setQuery('');
    setSearchData(null);
    setLoading(false);
    setError(null);
    setActiveTab('all');
  }, []);

  return {
    query,
    setQuery,
    searchData,
    loading,
    error,
    activeTab,
    setActiveTab,
    resetSearch,
  };
}
