class PerformanceMonitor {
  private deviceTier: 'high' | 'medium' | 'low' = 'high';

  constructor() {
    this.detectDeviceTier();
  }

  private detectDeviceTier(): void {
    if (typeof window === 'undefined') {
      this.deviceTier = 'high';
      return;
    }

    const nav = navigator as Navigator & {
      deviceMemory?: number;
      hardwareConcurrency?: number;
    };
    const hardwareConcurrency = nav.hardwareConcurrency || 4;
    const deviceMemory = nav.deviceMemory || 8;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      nav.userAgent
    );

    let gpuTier = 1;
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl') ||
        (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

      if (gl) {
        try {
          const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
            if (renderer) {
              if (
                renderer.includes('NVIDIA') ||
                renderer.includes('AMD') ||
                renderer.includes('Radeon')
              ) {
                gpuTier = 3;
              } else if (renderer.includes('Intel')) {
                gpuTier = 2;
              }
            }
          }
        } catch {}
        try {
          const loseCtx = gl.getExtension('WEBGL_lose_context');
          if (loseCtx) loseCtx.loseContext();
        } catch {}
      }
    } catch {
      gpuTier = 1;
    }

    let score = 0;
    score += hardwareConcurrency >= 8 ? 3 : hardwareConcurrency >= 4 ? 2 : 1;
    score += deviceMemory >= 8 ? 3 : deviceMemory >= 4 ? 2 : 1;
    score += gpuTier;
    score += isMobile ? -1 : 1;

    if (score >= 7) {
      this.deviceTier = 'high';
    } else if (score >= 4) {
      this.deviceTier = 'medium';
    } else {
      this.deviceTier = 'low';
    }
  }

  getDeviceTier(): 'high' | 'medium' | 'low' {
    return this.deviceTier;
  }
}

export const performanceMonitor = new PerformanceMonitor();

export function getAnimationMultiplier(): number {
  const tier = performanceMonitor.getDeviceTier();
  switch (tier) {
    case 'high':
      return 1;
    case 'medium':
      return 0.7;
    case 'low':
      return 0.5;
    default:
      return 1;
  }
}

export function shouldReduceAnimations(): boolean {
  return performanceMonitor.getDeviceTier() === 'low';
}

export function getOptimizedDuration(baseDuration: number): number {
  return Math.round(baseDuration * getAnimationMultiplier());
}
