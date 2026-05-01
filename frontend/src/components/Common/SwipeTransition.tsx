import React, { useState, useRef, useCallback, useMemo } from 'react';
import { durations, cubicBezier, prefersReducedMotion } from '../../utils/animations';

interface SwipeTransitionProps {
  children: React.ReactNode;
  onBack?: () => void;
  onForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  threshold?: number;
  className?: string;
}

interface TouchState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  isDragging: boolean;
  direction: 'left' | 'right' | 'none';
}

export function SwipeTransition({
  children,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  threshold = 50,
  className = '',
}: SwipeTransitionProps) {
  const [touchState, setTouchState] = useState<TouchState>({
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    isDragging: false,
    direction: 'none',
  });
  const [isTransitioning, setIsTransitioning] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (reducedMotion || isTransitioning) return;
    
    const touch = e.touches[0];
    setTouchState({
      startX: touch.clientX,
      startY: touch.clientY,
      currentX: touch.clientX,
      currentY: touch.clientY,
      isDragging: true,
      direction: 'none',
    });
  }, [reducedMotion, isTransitioning]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchState.isDragging || reducedMotion || isTransitioning) return;
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchState.startX;
    const deltaY = touch.clientY - touchState.startY;
    
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      e.preventDefault();
      
      let direction: 'left' | 'right' | 'none' = 'none';
      if (deltaX > 0) {
        direction = 'right';
      } else if (deltaX < 0) {
        direction = 'left';
      }
      
      setTouchState(prev => ({
        ...prev,
        currentX: touch.clientX,
        currentY: touch.clientY,
        direction,
      }));
    }
  }, [touchState, reducedMotion, isTransitioning]);

  const handleTouchEnd = useCallback(() => {
    if (!touchState.isDragging || reducedMotion || isTransitioning) return;
    
    const deltaX = touchState.currentX - touchState.startX;
    const absDeltaX = Math.abs(deltaX);
    
    if (absDeltaX > threshold) {
      if (deltaX > 0 && canGoBack && onBack) {
        setIsTransitioning(true);
        onBack();
      } else if (deltaX < 0 && canGoForward && onForward) {
        setIsTransitioning(true);
        onForward();
      }
    }
    
    setTouchState(prev => ({
      ...prev,
      isDragging: false,
      direction: 'none',
    }));
    
    setTimeout(() => {
      setIsTransitioning(false);
    }, durations.normal);
  }, [touchState, threshold, canGoBack, canGoForward, onBack, onForward, reducedMotion, isTransitioning]);

  const transformStyle = useMemo(() => {
    if (reducedMotion || !touchState.isDragging) {
      return {};
    }
    
    const deltaX = touchState.currentX - touchState.startX;
    const resistance = 0.3;
    const translateX = deltaX * resistance;
    
    return {
      transform: `translateX(${translateX}px)`,
      transition: 'none',
    };
  }, [touchState, reducedMotion]);

  return (
    <div
      ref={containerRef}
      className={`swipe-transition ${className}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        ...transformStyle,
        transition: touchState.isDragging ? 'none' : `transform ${durations.normal}ms ${cubicBezier.decelerate}`,
      }}
    >
      {children}
    </div>
  );
}

export function useSwipeBack(
  onBack: () => void,
  options: {
    threshold?: number;
    enabled?: boolean;
  } = {}
) {
  const { threshold = 120, enabled = true } = options;
  const [isSwiping, setIsSwiping] = useState(false);
  const [swipeProgress, setSwipeProgress] = useState(0);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isHorizontalRef = useRef(false);
  const isSwipingRef = useRef(isSwiping);
  const swipeProgressRef = useRef(swipeProgress);
  isSwipingRef.current = isSwiping;
  swipeProgressRef.current = swipeProgress;
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  const handlers = useMemo(() => {
    if (!enabled || reducedMotion) {
      return {};
    }

    return {
      onTouchStart: (e: React.TouchEvent) => {
        const touch = e.touches[0];
        startXRef.current = touch.clientX;
        startYRef.current = touch.clientY;
        isHorizontalRef.current = false;
        setIsSwiping(true);
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!isSwipingRef.current) return;
        
        const touch = e.touches[0];
        const deltaX = touch.clientX - startXRef.current;
        const deltaY = touch.clientY - startYRef.current;

        if (!isHorizontalRef.current) {
          if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
            setIsSwiping(false);
            setSwipeProgress(0);
            return;
          }
          if (Math.abs(deltaX) > 15 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
            if (startXRef.current > 40) {
              setIsSwiping(false);
              setSwipeProgress(0);
              return;
            }
            isHorizontalRef.current = true;
          }
          return;
        }
        
        if (deltaX > 0) {
          const progress = Math.min(deltaX / threshold, 1);
          setSwipeProgress(progress);
        }
      },
      onTouchEnd: () => {
        if (swipeProgressRef.current > 0.5) {
          onBack();
        }
        setIsSwiping(false);
        setSwipeProgress(0);
        isHorizontalRef.current = false;
      },
    };
  }, [enabled, reducedMotion, threshold, onBack]);

  return {
    handlers,
    isSwiping,
    swipeProgress,
  };
}
