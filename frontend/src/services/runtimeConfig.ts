const LOCAL_BACKEND_PORTS = ['3002', '3003'];
const LAST_KNOWN_BACKEND_ORIGIN_KEY = 'app:last-known-backend-origin';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function parseOrigin(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  try {
    return trimTrailingSlash(new URL(value).origin);
  } catch {
    return '';
  }
}

function isLocalOrigin(origin: string): boolean {
  if (!origin) {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function getConfiguredBackendOrigin(): string {
  return parseOrigin(import.meta.env.VITE_BACKEND_URL?.trim());
}

function getRememberedBackendOrigin(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    return parseOrigin(window.localStorage.getItem(LAST_KNOWN_BACKEND_ORIGIN_KEY));
  } catch {
    return '';
  }
}

function buildLocalBackendOrigins(): string[] {
  if (typeof window === 'undefined') {
    return LOCAL_BACKEND_PORTS.map(port => `http://localhost:${port}`);
  }

  const { hostname, protocol } = window.location;
  if (!isLocalHostname(hostname)) {
    return [];
  }

  return LOCAL_BACKEND_PORTS.map(port => `${protocol}//${hostname}:${port}`);
}

function dedupeOrigins(origins: string[]): string[] {
  return Array.from(new Set(origins.filter(Boolean)));
}

export function rememberBackendOrigin(value: string | null | undefined): void {
  const origin = parseOrigin(value);
  if (!origin || typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LAST_KNOWN_BACKEND_ORIGIN_KEY, origin);
  } catch {}
}

function isSameSiteOrigin(origin: string): boolean {
  if (!origin || typeof window === 'undefined') {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return parsed.hostname === window.location.hostname;
  } catch {
    return false;
  }
}

export function getBackendOriginCandidates(): string[] {
  const configuredOrigin = getConfiguredBackendOrigin();
  const rememberedOrigin = getRememberedBackendOrigin();
  const localOrigins = buildLocalBackendOrigins();

  if (configuredOrigin && !isLocalOrigin(configuredOrigin)) {
    return dedupeOrigins([configuredOrigin]);
  }

  if (typeof window === 'undefined') {
    return dedupeOrigins([rememberedOrigin, configuredOrigin, ...localOrigins]);
  }

  const { hostname, protocol, port } = window.location;
  const sameOriginIsBackend = isLocalHostname(hostname) && LOCAL_BACKEND_PORTS.includes(port);
  const sameOriginCandidate = sameOriginIsBackend ? `${protocol}//${hostname}:${port}` : '';

  const sameSiteCandidates = [configuredOrigin, rememberedOrigin, ...localOrigins, sameOriginCandidate]
    .filter(Boolean)
    .filter(isSameSiteOrigin);
  const crossSiteCandidates = [configuredOrigin, rememberedOrigin]
    .filter(Boolean)
    .filter(o => !isSameSiteOrigin(o));

  return dedupeOrigins([...sameSiteCandidates, ...crossSiteCandidates]);
}

export function getBackendOrigin(): string {
  return getBackendOriginCandidates()[0] || '';
}

export function getApiBaseUrl(): string {
  const backendOrigin = getBackendOrigin();
  return backendOrigin ? `${backendOrigin}/api` : '/api';
}

export function getApiBaseUrlCandidates(): string[] {
  const candidates = getBackendOriginCandidates();
  if (candidates.length === 0) {
    return ['/api'];
  }

  return candidates.map(origin => `${origin}/api`);
}

export function getWebSocketUrl(): string {
  const backendOrigin = getBackendOrigin();
  if (backendOrigin) {
    const wsProtocol = backendOrigin.startsWith('https://') ? 'wss' : 'ws';
    const wsHost = backendOrigin.replace(/^https?:\/\//, '');
    return `${wsProtocol}://${wsHost}/ws`;
  }

  if (typeof window === 'undefined') {
    return 'ws://localhost:3002/ws';
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}/ws`;
}

export function resolveBackendAssetUrl(url: string): string {
  if (!url) {
    return '';
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (!url.startsWith('/')) {
    return url;
  }

  if (!url.startsWith('/api/') && !url.startsWith('/uploads/')) {
    return url;
  }

  const backendOrigin = getBackendOrigin();
  return backendOrigin ? `${backendOrigin}${url}` : url;
}
