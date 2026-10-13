export const SEARCH_TYPES = ['groups', 'messages', 'files', 'agents', 'personas', 'comments', 'members', 'media'];

export function parseSearchOptions(query) {
  const fail = () => { throw Object.assign(new Error('搜索条件无效，请检查关键词、日期和分页参数'), { status: 400 }); };
  for (const key of ['q', 'type', 'groupId', 'limit', 'offset', 'quickFilter', 'dateFrom', 'dateTo']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') fail();
  }
  const q = query.q?.trim();
  if (!q || q.length > 500) fail();
  const integer = (value, fallback, max, min = 0) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail();
    return Number(value);
  };
  const limit = integer(query.limit, 20, 50, 1), offset = integer(query.offset, 0, 1000000);
  const types = query.type ? [...new Set(query.type.split(','))] : SEARCH_TYPES;
  if (!types.length || types.some(type => !SEARCH_TYPES.includes(type))) fail();
  const quickFilter = query.quickFilter || 'all';
  if (!['all', 'images', 'files', 'links', 'media'].includes(quickFilter)) fail();
  const date = (value, end) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) fail();
    const day = value.slice(0, 10);
    const calendarDay = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(+calendarDay) || calendarDay.toISOString().slice(0, 10) !== day) fail();
    const result = new Date(value.length === 10 ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value);
    if (!Number.isFinite(+result)) fail();
    return result;
  };
  const fromDate = date(query.dateFrom, false), toDate = date(query.dateTo, true);
  if (fromDate && toDate && fromDate > toDate) fail();
  return { q, types, groupId: query.groupId || '', limit, offset, quickFilter, fromDate, toDate };
}

export function withinSearchDates(item, fromDate, toDate) {
  if (!fromDate && !toDate) return true;
  const timestamp = Date.parse(item.created_at);
  return Number.isFinite(timestamp) && (!fromDate || timestamp >= +fromDate) && (!toDate || timestamp <= +toDate);
}

export function newestFirst(items) {
  return [...items].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || String(a.id).localeCompare(String(b.id)));
}

export function fileMatchesQuickFilter(file, filter) {
  if (filter === 'all') return true;
  const mime = String(file.mime_type || file.type || '').toLowerCase();
  const name = String(file.filename || file.name || '').toLowerCase();
  const image = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(name);
  const media = image || /^(audio|video)\//.test(mime) || /\.(mp3|wav|ogg|m4a|aac|flac|wma|mp4|avi|mov|mkv|webm|flv|wmv)$/.test(name);
  if (filter === 'images') return image;
  if (filter === 'media') return media;
  if (filter === 'files') return !media;
  return false;
}

// Count every authorized match, retaining only the requested page per category.
export function createSearchCollector(results, { limit, offset, fromDate, toDate }) {
  const counts = Object.fromEntries(SEARCH_TYPES.map(type => [type, 0]));
  return {
    add(type, item) {
      if (!['personas', 'members'].includes(type) && !withinSearchDates(item, fromDate, toDate)) return;
      const index = counts[type]++;
      if (index >= offset && index < offset + limit) results[type].push(item);
    },
    finish() {
      results.counts = counts;
      results.total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      results.pagination = { offset, limit, hasMore: SEARCH_TYPES.some(type => counts[type] > offset + limit) };
      return results;
    }
  };
}
