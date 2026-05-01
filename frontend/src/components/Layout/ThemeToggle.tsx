import React, { useState, useEffect, useRef } from 'react';
import { useThemeStore, Theme } from '../../stores/themeStore';
import { useReducedMotion } from '../../hooks/useReducedMotion';

const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: '浅色', icon: <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg> },
  { value: 'dark', label: '深色', icon: <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg> },
  { value: 'system', label: '跟随系统', icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg> },
];

export function ThemeToggle() {
  const { theme, setTheme } = useThemeStore();
  const [isAnimating, setIsAnimating] = useState(false);
  const [prevTheme, setPrevTheme] = useState<Theme>(theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (prevTheme !== theme) {
      setIsAnimating(true);
      const timer = setTimeout(() => {
        setIsAnimating(false);
        setPrevTheme(theme);
      }, reducedMotion ? 0 : 300);
      return () => clearTimeout(timer);
    }
  }, [theme, prevTheme, reducedMotion]);

  const handleThemeChange = (newTheme: Theme) => {
    if (newTheme !== theme) {
      setTheme(newTheme);
    }
  };

  const selectedIndex = themeOptions.findIndex(opt => opt.value === theme);

  return (
    <div className="flex items-center gap-2">
      <span className="text-caption text-text-secondary">主题</span>
      <div 
        ref={containerRef}
        className="relative flex items-center gap-1 bg-bg-surface2 rounded-lg p-1"
      >
        <div
          className={`absolute h-[calc(100%-8px)] bg-bg-surface rounded-md shadow-sm ${
            reducedMotion ? '' : 'transition-all duration-200 ease-spring'
          }`}
          style={{
            width: buttonRefs.current[selectedIndex]?.offsetWidth 
              ? `${buttonRefs.current[selectedIndex]!.offsetWidth}px` 
              : 'auto',
            left: buttonRefs.current[selectedIndex]
              ? `${buttonRefs.current[selectedIndex]!.offsetLeft - 4}px`
              : 0,
            transform: isAnimating && !reducedMotion ? 'scale(1.02)' : 'scale(1)',
          }}
        />
        
        {themeOptions.map((option, index) => {
          const isActive = theme === option.value;
          const isTransitioning = isAnimating && (theme === option.value || prevTheme === option.value);
          
          return (
            <button
              key={option.value}
              ref={el => { buttonRefs.current[index] = el; }}
              onClick={() => handleThemeChange(option.value)}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-caption z-10 transition-all duration-200 ${
                isActive
                  ? 'text-text-primary'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
              title={option.label}
            >
              <span 
                className={`inline-block ${
                  reducedMotion ? '' : 'transition-transform duration-300 ease-spring'
                } ${
                  isTransitioning && !reducedMotion ? 'animate-theme-icon-switch' : ''
                }`}
                style={{
                  transform: isActive && isTransitioning && !reducedMotion ? 'rotate(180deg) scale(1.1)' : 
                            isActive ? 'rotate(0deg)' : 
                            'rotate(0deg)'
                }}
              >
                {option.icon}
              </span>
              <span className="hidden sm:inline">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
