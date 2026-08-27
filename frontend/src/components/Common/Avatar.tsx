import { useEffect, useState } from 'react';
import { sanitizeUrl } from '../../utils/sanitizeUrl';

export interface AvatarProps {
  src?: string | null;
  color?: string;
  letter?: string | null;
  size?: number | string;
  alt?: string;
  className?: string;
}

type LoadStatus = 'idle' | 'loading' | 'ok' | 'error';

function resolveDataImageSrc(src: string): string | null {
  return /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);/i.test(src.trim()) ? src : null;
}

export function avatarBackgroundImageStyle(
  src: string | null | undefined
): string {
  const trimmed = typeof src === 'string' ? src.trim() : '';
  if (!trimmed) return 'none';
  const safe = /^data:image\//i.test(trimmed)
    ? resolveDataImageSrc(trimmed)
    : sanitizeUrl(trimmed);
  if (!safe) return 'none';
  return `url("${safe}")`;
}

export function Avatar({ src, color, letter, size = 36, alt = '', className = '' }: AvatarProps) {
  const [status, setStatus] = useState<LoadStatus>('idle');

  const trimmed = typeof src === 'string' ? src.trim() : '';
  const isDataUrl = /^data:image\//i.test(trimmed);
  const safeUrl = isDataUrl
    ? resolveDataImageSrc(trimmed)
    : sanitizeUrl(src);
  const hasImage = Boolean(safeUrl);

  useEffect(() => {
    if (!hasImage) {
      setStatus('idle');
      return;
    }
    if (isDataUrl) {
      setStatus('loading');
      return;
    }
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => { if (!cancelled) setStatus('ok'); };
    probe.onerror = () => { if (!cancelled) setStatus('error'); };
    setStatus('loading');
    probe.src = safeUrl as string;
    return () => { cancelled = true; };
  }, [safeUrl, hasImage, isDataUrl]);

  const resolved = status === 'ok';
  const showBackground = hasImage && !isDataUrl && resolved;
  const showImgElement = hasImage && isDataUrl;
  const showLetter = !resolved;
  const numericSize = typeof size === 'number' ? size : undefined;
  const dimensionStyle = numericSize !== undefined ? { width: numericSize, height: numericSize } : undefined;
  const fontSize = numericSize !== undefined ? Math.max(9, Math.round(numericSize * 0.42)) : undefined;

  return (
    <div
      className={`relative flex items-center justify-center flex-shrink-0 overflow-hidden ${className}`}
      style={{
        ...dimensionStyle,
        backgroundColor: showBackground || showImgElement ? 'transparent' : (color || '#95B1D4'),
        backgroundImage: showBackground ? `url("${safeUrl}")` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      {showLetter && letter ? (
        <span
          className="font-semibold text-white leading-none select-none"
          style={fontSize !== undefined ? { fontSize } : undefined}
        >
          {letter}
        </span>
      ) : null}
      {showImgElement ? (
        <img
          src={safeUrl as string}
          alt={alt}
          draggable={false}
          onError={() => setStatus('error')}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : null}
    </div>
  );
}
