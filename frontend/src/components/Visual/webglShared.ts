export const MAX_DEVICE_PIXEL_RATIO = 1.5;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function clampDpr(requested?: number): number {
  const fallback = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const raw =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(Math.max(raw, 0.5), MAX_DEVICE_PIXEL_RATIO);
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = (hex ?? '').replace('#', '').trim();
  const padded = clean.padEnd(6, '0').slice(0, 6);
  const parse = (chunk: string): number => {
    const v = parseInt(chunk, 16);
    return Number.isFinite(v) ? v / 255 : 0;
  };
  return [parse(padded.slice(0, 2)), parse(padded.slice(2, 4)), parse(padded.slice(4, 6))];
}

export function safeCallMethod(obj: unknown, method: string): void {
  if (obj && typeof (obj as Record<string, unknown>)[method] === 'function') {
    try {
      ((obj as Record<string, unknown>)[method] as () => void).call(obj);
    } catch {
      /* 资源释放失败时静默忽略 */
    }
  }
}

export function loseGlContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  try {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* 静默忽略 */
  }
}
