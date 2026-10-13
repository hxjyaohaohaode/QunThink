import type { useGlobalSearch } from '../../hooks/useGlobalSearch';

export function SearchPagination({ search }: { search: ReturnType<typeof useGlobalSearch> }) {
  if (!search.searchData) return null;
  return <nav aria-label="搜索结果分页" className="search-pagination">
    <span role="status">共 {search.total} 项 · 第 {Math.floor(search.offset / search.limit) + 1} 页</span>
    <div className="flex items-center gap-2">
      <button className="workspace-button" disabled={search.loading || search.offset === 0} onClick={search.previousPage}>上一页</button>
      <button className="workspace-button" disabled={search.loading || !search.hasMore} onClick={search.nextPage}>下一页</button>
    </div>
  </nav>;
}
