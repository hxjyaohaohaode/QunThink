import {
  getAnimationMultiplier,
  shouldReduceAnimations,
  getOptimizedDuration as getOptimizedDurationBase,
} from './performance';

export const getOptimizedDuration = getOptimizedDurationBase;

export const durations = {
  instant: 0,
  fastest: 100,
  fast: 150,
  normal: 300,
  slow: 500,
  slower: 700,
  slowest: 1000,
} as const;

export const cubicBezier = {
  standard: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
  decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0.0, 1, 1)',
  sharp: 'cubic-bezier(0.4, 0.0, 0.6, 1)',
  emphasized: 'cubic-bezier(0.2, 0.0, 0, 1)',
  emphasizedDecelerate: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  emphasizedAccelerate: 'cubic-bezier(0.3, 0.0, 0.8, 0.15)',
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
} as const;

export interface StaggerConfig {
  delay: number;
  increment: number;
  from?: 'start' | 'end' | 'center';
}

export const staggerPresets = {
  fast: { delay: 0, increment: 30, from: 'start' as const },
  normal: { delay: 0, increment: 50, from: 'start' as const },
  slow: { delay: 0, increment: 100, from: 'start' as const },
  fromCenter: { delay: 0, increment: 50, from: 'center' as const },
  fromEnd: { delay: 0, increment: 50, from: 'end' as const },
} as const;

export function getStaggerDelay(
  index: number,
  total: number,
  config: StaggerConfig
): number {
  const { delay, increment, from = 'start' } = config;

  let adjustedIndex: number;
  switch (from) {
    case 'center':
      adjustedIndex = Math.abs(index - Math.floor(total / 2));
      break;
    case 'end':
      adjustedIndex = total - 1 - index;
      break;
    default:
      adjustedIndex = index;
  }

  return delay + adjustedIndex * increment;
}

export interface AnimationConfig {
  duration: number;
  easing: string;
  fill?: 'none' | 'forwards' | 'backwards' | 'both';
  delay?: number;
  iterations?: number;
  direction?: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
}

export const animationPresets = {
  fadeIn: {
    duration: durations.fast,
    easing: cubicBezier.standard,
    fill: 'forwards' as const,
  },
  fadeOut: {
    duration: durations.fast,
    easing: cubicBezier.standard,
    fill: 'forwards' as const,
  },
  slideInLeft: {
    duration: durations.normal,
    easing: cubicBezier.decelerate,
    fill: 'forwards' as const,
  },
  slideInRight: {
    duration: durations.normal,
    easing: cubicBezier.decelerate,
    fill: 'forwards' as const,
  },
  slideOutLeft: {
    duration: durations.normal,
    easing: cubicBezier.accelerate,
    fill: 'forwards' as const,
  },
  slideOutRight: {
    duration: durations.normal,
    easing: cubicBezier.accelerate,
    fill: 'forwards' as const,
  },
  scaleIn: {
    duration: durations.fast,
    easing: cubicBezier.spring,
    fill: 'forwards' as const,
  },
  scaleOut: {
    duration: durations.fast,
    easing: cubicBezier.accelerate,
    fill: 'forwards' as const,
  },
  bounce: {
    duration: durations.slow,
    easing: cubicBezier.bounce,
    fill: 'forwards' as const,
  },
  pulse: {
    duration: durations.slow,
    easing: cubicBezier.standard,
    iterations: Infinity,
    direction: 'alternate' as const,
  },
  shimmer: {
    duration: 1500,
    easing: 'linear',
    iterations: Infinity,
  },
  typingDot: {
    duration: 1000,
    easing: cubicBezier.standard,
    iterations: Infinity,
  },
  ripple: {
    duration: durations.slow,
    easing: cubicBezier.decelerate,
    fill: 'forwards' as const,
  },
  glow: {
    duration: durations.slow,
    easing: cubicBezier.standard,
    iterations: Infinity,
    direction: 'alternate' as const,
  },
} as const;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function shouldDisableAnimations(): boolean {
  return prefersReducedMotion() || shouldReduceAnimations();
}

export function getOptimizedStaggerDelay(baseDelay: number): number {
  if (shouldDisableAnimations()) return 0;
  return Math.round(baseDelay * getAnimationMultiplier());
}
