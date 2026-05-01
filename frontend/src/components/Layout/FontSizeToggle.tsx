import React, { useState, useEffect, useRef } from 'react';
import { useFontSizeStore, type FontSizeLevel, getFontSizeLabel } from '../../stores/fontSizeStore';

const fontSizeOptions: { value: FontSizeLevel; label: string; icon: React.ReactNode }[] = [
  {
    value: 'small',
    label: '小',
    icon: <span className="text-[10px] font-bold">A</span>,
  },
  {
    value: 'normal',
    label: '标准',
    icon: <span className="text-xs font-bold">A</span>,
  },
  {
    value: 'large',
    label: '大',
    icon: <span className="text-sm font-bold">A</span>,
  },
  {
    value: 'extra-large',
    label: '超大',
    icon: <span className="text-base font-bold">A</span>,
  },
];

export function FontSizeToggle() {
  const { fontSize, setFontSize } = useFontSizeStore();
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = (size: FontSizeLevel) => {
    setFontSize(size);
    setIsOpen(false);
  };

  const currentLabel = getFontSizeLabel(fontSize);

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-caption text-text-secondary">字体</span>
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          className="h-6 px-1.5 rounded-md flex items-center justify-center gap-0.5 text-text-muted hover:text-text-primary hover:bg-sidebar-hover transition-all duration-150 text-[11px] font-medium"
          title={`字体大小: ${currentLabel}`}
        >
          <span className="text-[9px] font-bold leading-none">A</span>
          <span className="text-[12px] font-bold leading-none">A</span>
        </button>

        {isOpen && (
          <div
            ref={popoverRef}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-32 bg-bg-surface border border-border-subtle rounded-xl shadow-lg overflow-hidden z-50 settings-theme-transition settings-card"
          >
            {fontSizeOptions.map((option) => {
              const isActive = fontSize === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => handleSelect(option.value)}
                  className={`w-full flex items-center justify-between px-3 py-2 transition-colors ${
                    isActive ? 'bg-accent-subtle text-text-primary' : 'text-text-secondary hover:bg-sidebar-hover'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full flex items-center justify-center bg-bg-surface2">
                      {option.icon}
                    </span>
                    <span className="text-sm">{option.label}</span>
                  </div>
                  {isActive && (
                    <svg className="w-4 h-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function FontSizeSelector() {
  const { fontSize, setFontSize } = useFontSizeStore();
  const [isThemeChanging, setIsThemeChanging] = useState(false);

  const handleFontSizeSelect = (size: FontSizeLevel) => {
    if (fontSize !== size) {
      setIsThemeChanging(true);
      setFontSize(size);
      setTimeout(() => {
        setIsThemeChanging(false);
      }, 300);
    }
  };

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden divide-y divide-border/30 settings-theme-transition settings-card">
      {fontSizeOptions.map((option, index) => (
        <button
          key={option.value}
          onClick={() => handleFontSizeSelect(option.value)}
          className={`w-full flex items-center justify-between p-3 ${
            fontSize === option.value ? 'selected bg-bg-primary/50' : ''
          }`}
          style={{ animationDelay: `${index * 50}ms` }}
        >
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center bg-bg-surface2 settings-theme-transition">
              <span
                className={`font-medium settings-theme-transition ${
                  option.value === 'small' ? 'text-[10px]' :
                  option.value === 'normal' ? 'text-xs' :
                  option.value === 'large' ? 'text-sm' :
                  'text-base'
                } ${isThemeChanging && fontSize === option.value ? 'theme-icon-rotate' : ''}`}
              >
                A
              </span>
            </div>
            <div className="flex flex-col items-start">
              <span className="text-sm text-text-primary settings-theme-transition">
                {option.label}
              </span>
              <span
                className="text-xs text-text-secondary settings-theme-transition"
                style={{
                  fontSize: option.value === 'small' ? '10px' :
                           option.value === 'normal' ? '12px' :
                           option.value === 'large' ? '14px' :
                           '16px'
                }}
              >
                预览文字
              </span>
            </div>
          </div>
          {fontSize === option.value && (
            <svg
              className="w-5 h-5 text-user animate-checkmark settings-theme-transition"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path className="animate-draw-check" d="M20 6L9 17l-5-5" />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}
