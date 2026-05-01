import { cn } from '../../utils/cn';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type SpinnerSize = 'small' | 'medium' | 'large';
export type SpinnerColor = 'primary' | 'white' | 'muted';

interface LoadingSpinnerProps {
  size?: SpinnerSize;
  color?: SpinnerColor;
  className?: string;
}

const sizeStyles: Record<SpinnerSize, string> = {
  small: 'w-4 h-4 border-2',
  medium: 'w-6 h-6 border-2',
  large: 'w-10 h-10 border-3',
};

const colorStyles: Record<SpinnerColor, string> = {
  primary: 'border-border border-t-blue-500',
  white: 'border-white/30 border-t-white',
  muted: 'border-border border-t-text-muted',
};

export function LoadingSpinner({
  size = 'medium',
  color = 'primary',
  className,
}: LoadingSpinnerProps) {
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return (
      <div
        role="status"
        aria-label="加载中"
        className={cn(
          'rounded-full',
          sizeStyles[size],
          colorStyles[color],
          className
        )}
      />
    );
  }

  return (
    <div
      role="status"
      aria-label="加载中"
      className={cn(
        'rounded-full animate-spin',
        sizeStyles[size],
        colorStyles[color],
        className
      )}
    />
  );
}

interface LoadingOverlayProps {
  message?: string;
  className?: string;
}

export function LoadingOverlay({ message = '加载中...', className }: LoadingOverlayProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div role="status" aria-label="加载中" className={cn('flex flex-col items-center justify-center gap-3 py-8', className)}>
      <LoadingSpinner size="large" />
      <p className={cn('text-text-muted text-sm', !reducedMotion && 'animate-pulse')}>{message}</p>
    </div>
  );
}

interface LoadingDotsProps {
  className?: string;
}

export function LoadingDots({ className }: LoadingDotsProps) {
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return (
      <div role="status" aria-label="加载中" className={cn('flex items-center gap-1', className)}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-2 h-2 bg-text-muted rounded-full opacity-70"
          />
        ))}
      </div>
    );
  }

  return (
    <div role="status" aria-label="加载中" className={cn('flex items-center gap-1', className)}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-2 h-2 bg-text-muted rounded-full animate-typing-dot"
          style={{
            animationDelay: `${i * 150}ms`,
          }}
        />
      ))}
    </div>
  );
}

interface LoadingPulseProps {
  className?: string;
}

export function LoadingPulse({ className }: LoadingPulseProps) {
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return (
      <div role="status" aria-label="加载中" className={cn('flex items-center gap-2', className)}>
        <div className="relative">
          <div className="w-3 h-3 bg-blue-500 rounded-full" />
        </div>
        <span className="text-text-muted text-sm">处理中...</span>
      </div>
    );
  }

  return (
    <div role="status" aria-label="加载中" className={cn('flex items-center gap-2', className)}>
      <div className="relative">
        <div className="w-3 h-3 bg-blue-500 rounded-full animate-ping" />
        <div className="w-3 h-3 bg-blue-500 rounded-full absolute inset-0" />
      </div>
      <span className="text-text-muted text-sm">处理中...</span>
    </div>
  );
}

interface LoadingBarProps {
  className?: string;
  width?: string | number;
}

export function LoadingBar({ className, width = '100%' }: LoadingBarProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div
      className={cn(
        'h-1 bg-bg-surface2 rounded-full overflow-hidden',
        className
      )}
      style={{ width: typeof width === 'number' ? `${width}px` : width }}
    >
      <div 
        className={cn(
          'h-full bg-blue-500 rounded-full',
          !reducedMotion && 'animate-shimmer'
        )}
        style={reducedMotion ? {} : { 
          background: 'linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.5), transparent)',
          backgroundSize: '200% 100%',
        }} 
      />
    </div>
  );
}
