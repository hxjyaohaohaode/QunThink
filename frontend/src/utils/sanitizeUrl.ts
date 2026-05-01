import { resolveBackendAssetUrl } from '../services/runtimeConfig';

export function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return '';
  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
  const trimmedUrl = url.trim().toLowerCase();
  for (const protocol of dangerousProtocols) {
    if (trimmedUrl.startsWith(protocol)) {
      return '';
    }
  }

  const resolvedUrl = resolveBackendAssetUrl(url.trim());
  if (!resolvedUrl.match(/^(https?:\/\/|\/)/i)) {
    return '';
  }

  return resolvedUrl;
}
