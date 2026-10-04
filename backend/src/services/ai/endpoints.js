// Shared by the catalog and transport. Never put credentials in a URL.
export function normalizeBaseUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const value = raw.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址必须是 HTTP(S) URL，不能包含凭据、查询参数或片段');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|messages|models)$/i, '');
  return url.toString().replace(/\/+$/, '');
}

export function normalizeEndpoint(raw, protocol = 'openai') {
  const base = normalizeBaseUrl(raw);
  return base ? `${base}/${protocol === 'anthropic' ? 'messages' : 'chat/completions'}` : '';
}
