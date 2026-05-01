import React, { useState, useCallback, useRef, useMemo } from 'react';
import { useEdgeSwipe } from '../../hooks/useGesture';
import { durations, cubicBezier, prefersReducedMotion } from '../../utils/animations';

interface SwipeableSidebarProps {
  children: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  width?: number;
  edgeThreshold?: number;
}

export function SwipeableSidebar({
  children,
  isOpen,
  onClose,
  onOpen: _onOpen,
  width = 280,
  edgeThreshold = 30,
}: SwipeableSidebarProps) {
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const currentXRef = useRef(0);
  const velocityRef = useRef(0);
  const lastTimeRef = useRef(0);
  const lastXRef = useRef(0);

  const { handlers: edgeSwipeHandlers } = useEdgeSwipe({
    edgeWidth: edgeThreshold,
    threshold: 50,
    velocityThreshold: 0.4,
  });

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (reducedMotion || !isOpen) return;

      const touch = e.touches[0];
      startXRef.current = touch.clientX;
      currentXRef.current = touch.clientX;
      lastXRef.current = touch.clientX;
      lastTimeRef.current = Date.now();
      setIsDragging(true);
      setDragOffset(0);
    },
    [isOpen, reducedMotion]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging || reducedMotion || !isOpen) return;

      const touch = e.touches[0];
      const now = Date.now();
      const deltaX = touch.clientX - startXRef.current;
      const timeDelta = now - lastTimeRef.current;

      if (timeDelta > 0) {
        velocityRef.current =
          (touch.clientX - lastXRef.current) / timeDelta;
      }

      currentXRef.current = touch.clientX;
      lastXRef.current = touch.clientX;
      lastTimeRef.current = now;

      if (deltaX < 0) {
        const resistance = 0.8;
        const offset = Math.max(deltaX * resistance, -width);
        setDragOffset(offset);
      }
    },
    [isDragging, isOpen, reducedMotion, width]
  );

  const handleTouchEnd = useCallback(() => {
    if (!isDragging || reducedMotion) return;

    const velocity = velocityRef.current;
    const shouldClose =
      Math.abs(dragOffset) > width * 0.4 || velocity < -0.5;

    if (shouldClose) {
      onClose();
    }

    setDragOffset(0);
    setIsDragging(false);
    velocityRef.current = 0;
  }, [isDragging, dragOffset, width, onClose, reducedMotion]);

  const sidebarStyle = useMemo(() => {
    const baseOffset = isOpen ? 0 : -width;
    const totalOffset = baseOffset + dragOffset;

    if (reducedMotion) {
      return {
        transform: `translateX(${isOpen ? 0 : -width}px)`,
      };
    }

    return {
      transform: `translateX(${totalOffset}px)`,
      transition: isDragging
        ? 'none'
        : `transform ${durations.normal}ms ${cubicBezier.decelerate}`,
    };
  }, [isOpen, dragOffset, isDragging, width, reducedMotion]);

  const overlayStyle = useMemo(() => {
    const baseOpacity = isOpen ? 0.5 : 0;
    const dragProgress = Math.abs(dragOffset) / width;
    const openProgress = isOpen ? 1 - dragProgress : dragProgress;
    const opacity = baseOpacity * openProgress;

    if (reducedMotion) {
      return {
        opacity: isOpen ? 0.5 : 0,
        pointerEvents: (isOpen
          ? 'auto'
          : 'none') as React.CSSProperties['pointerEvents'],
      };
    }

    return {
      opacity,
      pointerEvents: (isOpen && !isDragging
        ? 'auto'
        : 'none') as React.CSSProperties['pointerEvents'],
      transition: isDragging
        ? 'none'
        : `opacity ${durations.normal}ms ${cubicBezier.decelerate}`,
    };
  }, [isOpen, dragOffset, isDragging, width, reducedMotion]);

  return (
    <>
      <div
        className="fixed inset-0 bg-black z-40 md:hidden"
        style={overlayStyle}
        onClick={onClose}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
      <div
        className="fixed left-0 top-0 bottom-0 z-50 md:hidden"
        style={{
          width,
          ...sidebarStyle,
        }}
        {...edgeSwipeHandlers}
      >
        {children}
      </div>
    </>
  );
}
