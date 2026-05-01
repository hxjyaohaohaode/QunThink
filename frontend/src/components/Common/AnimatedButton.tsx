import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';

interface Ripple {
  id: number;
  x: number;
  y: number;
  size: number;
}

interface AnimatedButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
  showSuccess?: boolean;
  onSuccess?: () => void;
}

export function AnimatedButton({
  variant = 'primary',
  size = 'md',
  children,
  showSuccess = false,
  onSuccess,
  className = '',
  disabled,
  onClick,
  ...props
}: AnimatedButtonProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [showCheckmark, setShowCheckmark] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rippleIdRef = useRef(0);
  const reducedMotion = useReducedMotion();

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg',
  };

  const variantClasses = {
    primary: 'bg-accent hover:bg-accent-hover text-white rounded-[10px]',
    secondary: 'bg-bg-surface2 text-text-primary border border-border hover:bg-bg-surface3 rounded-[10px]',
    ghost: 'bg-transparent text-text-secondary hover:bg-bg-surface2 hover:text-text-primary rounded-[10px]',
  };

  const baseClasses = `
    relative overflow-hidden
    font-medium
    transition-all duration-150 ease-out
    focus:outline-none focus:ring-2 focus:ring-accent/30 focus:ring-offset-2
    disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
    hover:-translate-y-px active:scale-[0.97] transition-transform duration-100
    will-change-transform
  `;

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    
    setIsPressed(true);
    setIsRecovering(false);

    if (reducedMotion) return;

    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const size = Math.max(rect.width, rect.height) * 2;

      const newRipple: Ripple = {
        id: rippleIdRef.current++,
        x,
        y,
        size,
      };

      setRipples(prev => [...prev, newRipple]);
    }
  }, [disabled, reducedMotion]);

  const handleMouseUp = useCallback(() => {
    if (disabled) return;
    
    setIsPressed(false);
    setIsRecovering(true);
    
    setTimeout(() => {
      setIsRecovering(false);
    }, 100);
  }, [disabled]);

  const handleMouseEnter = useCallback(() => {
    if (!disabled) {
      setIsHovered(true);
    }
  }, [disabled]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    setIsPressed(false);
    setIsRecovering(false);
  }, []);

  const handleClick = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    
    if (onClick) {
      onClick(e);
    }
    
    if (showSuccess && onSuccess) {
      onSuccess();
      setShowCheckmark(true);
      setTimeout(() => {
        setShowCheckmark(false);
      }, 1500);
    }
  }, [disabled, onClick, showSuccess, onSuccess]);

  useEffect(() => {
    const cleanup = setTimeout(() => {
      if (ripples.length > 0) {
        setRipples(prev => prev.slice(1));
      }
    }, 500);

    return () => clearTimeout(cleanup);
  }, [ripples]);

  const getTransformStyle = () => {
    if (reducedMotion) return 'none';
    if (isPressed) {
      return 'scale(0.97)';
    }
    if (isRecovering) {
      return 'scale(1)';
    }
    if (isHovered) {
      return 'translateY(-1px)';
    }
    return 'translateY(0)';
  };

  const getShadowStyle = () => {
    if (disabled || reducedMotion) return 'none';
    if (isHovered && !isPressed) {
      return '0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1)';
    }
    return 'none';
  };

  return (
    <button
      ref={buttonRef}
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      style={{
        transform: getTransformStyle(),
        boxShadow: getShadowStyle(),
        transition: reducedMotion 
          ? 'none'
          : isPressed 
            ? 'transform 100ms ease-out' 
            : isRecovering 
              ? 'transform 100ms ease-out'
              : 'transform 150ms ease-out, box-shadow 150ms ease-out, background-color 150ms ease-out',
      }}
      disabled={disabled}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      {...props}
    >
      {ripples.map(ripple => (
        <span
          key={ripple.id}
          className="absolute rounded-full pointer-events-none animate-ripple"
          style={{
            left: ripple.x - ripple.size / 2,
            top: ripple.y - ripple.size / 2,
            width: ripple.size,
            height: ripple.size,
            backgroundColor: variant === 'primary' ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.1)',
          }}
        />
      ))}
      
      <span className="relative z-10 flex items-center justify-center gap-2">
        {showCheckmark ? (
          <CheckmarkIcon reducedMotion={reducedMotion} />
        ) : (
          children
        )}
      </span>
    </button>
  );
}

function CheckmarkIcon({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <svg 
      className={`w-5 h-5 ${reducedMotion ? '' : 'animate-checkmark'}`}
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="3"
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <path 
        d="M5 13l4 4L19 7"
        className={reducedMotion ? '' : 'animate-draw-check'}
      />
    </svg>
  );
}
