import { cn } from '../../utils/cn';
import { useReducedMotion } from '../../hooks/useReducedMotion';

export type SkeletonVariant = 'rectangular' | 'circular' | 'text' | 'avatar' | 'message';

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: string | number;
  height?: string | number;
  className?: string;
  animate?: boolean;
  count?: number;
  gap?: number;
}

const variantStyles: Record<SkeletonVariant, string> = {
  rectangular: 'rounded-[10px]',
  circular: 'rounded-full',
  text: 'rounded-[10px] h-4',
  avatar: 'rounded-full w-10 h-10',
  message: 'rounded-[10px]',
};

export function Skeleton({
  variant = 'rectangular',
  width,
  height,
  className,
  animate = true,
  count = 1,
  gap = 8,
}: SkeletonProps) {
  const reducedMotion = useReducedMotion();
  const shouldAnimate = animate && !reducedMotion;
  
  const baseStyle = 'bg-bg-surface3 relative overflow-hidden';
  const shimmerStyle = shouldAnimate
    ? 'before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-white/10 before:to-transparent'
    : '';

  const style: React.CSSProperties = {
    width: width ? (typeof width === 'number' ? `${width}px` : width) : undefined,
    height: height ? (typeof height === 'number' ? `${height}px` : height) : undefined,
  };

  if (count > 1) {
    return (
      <div className="flex flex-col" style={{ gap: `${gap}px` }}>
        {Array.from({ length: count }).map((_, index) => (
          <div
            key={index}
            className={cn(
              baseStyle,
              shimmerStyle,
              variantStyles[variant],
              className
            )}
            style={style}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        baseStyle,
        shimmerStyle,
        variantStyles[variant],
        className
      )}
      style={style}
    />
  );
}

export function MessageSkeleton() {
  return (
    <div className="flex gap-3 p-3 animate-fade-in">
      <Skeleton variant="circular" width={40} height={40} />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton variant="text" width={80} height={14} />
          <Skeleton variant="text" width={60} height={12} />
        </div>
        <Skeleton variant="rectangular" width="60%" height={20} />
      </div>
    </div>
  );
}

export function ChatItemSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border/30 animate-fade-in">
      <Skeleton variant="circular" width={48} height={48} />
      <div className="flex-1 space-y-2">
        <div className="flex items-center justify-between">
          <Skeleton variant="text" width={100} height={14} />
          <Skeleton variant="text" width={40} height={12} />
        </div>
        <Skeleton variant="text" width="70%" height={12} />
      </div>
    </div>
  );
}

export function MessageListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {Array.from({ length: count }).map((_, index) => (
        <MessageSkeleton key={index} />
      ))}
    </div>
  );
}

export function ChatListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: count }).map((_, index) => (
        <ChatItemSkeleton key={index} />
      ))}
    </div>
  );
}
