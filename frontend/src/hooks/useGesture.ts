import { useState, useRef, useCallback } from 'react';

interface EdgeSwipeConfig {
  threshold?: number;
  edgeWidth?: number;
  velocityThreshold?: number;
}

interface EdgeSwipeState {
  isSwiping: boolean;
  progress: number;
  direction: 'left' | 'right' | null;
}

export function useEdgeSwipe(config: EdgeSwipeConfig = {}) {
  const { threshold = 50, edgeWidth = 30, velocityThreshold = 0.3 } = config;

  const [state, setState] = useState<EdgeSwipeState>({
    isSwiping: false,
    progress: 0,
    direction: null,
  });

  const touchStartRef = useRef({ x: 0, y: 0, time: 0 });
  const isEdgeSwipeRef = useRef(false);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const { clientX, clientY } = touch;
      touchStartRef.current = { x: clientX, y: clientY, time: Date.now() };

      isEdgeSwipeRef.current =
        clientX <= edgeWidth || clientX >= window.innerWidth - edgeWidth;
    },
    [edgeWidth]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isEdgeSwipeRef.current) return;

      const touch = e.touches[0];
      const { clientX, clientY } = touch;
      const startX = touchStartRef.current.x;
      const deltaX = clientX - startX;
      const deltaY = Math.abs(clientY - touchStartRef.current.y);

      if (deltaY > Math.abs(deltaX)) {
        isEdgeSwipeRef.current = false;
        setState({ isSwiping: false, progress: 0, direction: null });
        return;
      }

      const direction = startX <= edgeWidth ? 'right' : 'left';

      if (
        (direction === 'right' && deltaX > 0) ||
        (direction === 'left' && deltaX < 0)
      ) {
        const progress = Math.min(Math.abs(deltaX) / threshold, 1);
        setState({ isSwiping: true, progress, direction });
      }
    },
    [threshold, edgeWidth]
  );

  const handleTouchEnd = useCallback(() => {
    if (!isEdgeSwipeRef.current) return;

    const elapsed = Date.now() - touchStartRef.current.time;
    const velocity = state.progress / (elapsed || 1);

    const isTriggered =
      state.progress >= 1 || velocity >= velocityThreshold;

    isEdgeSwipeRef.current = false;
    setState({ isSwiping: false, progress: 0, direction: null });

    if (isTriggered && state.direction) {
      return state.direction;
    }

    return null;
  }, [state.progress, state.direction, velocityThreshold]);

  return {
    ...state,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
