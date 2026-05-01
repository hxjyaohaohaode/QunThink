import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type FontSizeLevel = 'small' | 'normal' | 'large' | 'extra-large';

interface FontSizeState {
  fontSize: FontSizeLevel;
  setFontSize: (size: FontSizeLevel) => void;
}

const fontSizeMap: Record<FontSizeLevel, number> = {
  'small': 13,
  'normal': 15,
  'large': 17,
  'extra-large': 19,
};

export const useFontSizeStore = create<FontSizeState>()(
  persist(
    (set) => ({
      fontSize: 'normal',
      setFontSize: (fontSize) => {
        set({ fontSize });
        applyFontSize(fontSize);
      },
    }),
    { name: 'font-size-storage' }
  )
);

export function applyFontSize(size: FontSizeLevel) {
  const root = document.documentElement;
  const baseSize = fontSizeMap[size];
  const scale = baseSize / 15;

  root.style.setProperty('--font-scale', String(scale));
  root.style.setProperty('--font-size-base', `${baseSize}px`);

  root.style.setProperty('--font-size-xs', `${Math.round(11 * scale * 10) / 10}px`);
  root.style.setProperty('--font-size-sm', `${Math.round(13 * scale * 10) / 10}px`);
  root.style.setProperty('--font-size-md', `${baseSize}px`);
  root.style.setProperty('--font-size-lg', `${Math.round(18 * scale * 10) / 10}px`);
  root.style.setProperty('--font-size-xl', `${Math.round(20 * scale * 10) / 10}px`);
  root.style.setProperty('--font-size-2xl', `${Math.round(24 * scale * 10) / 10}px`);

  const chatMsgSize = Math.round(baseSize * 0.933 * 10) / 10;
  root.style.setProperty('--chat-message-font-size', `${chatMsgSize}px`);
  root.style.setProperty('--chat-message-line-height', `${Math.round(chatMsgSize * 1.6 * 10) / 10}px`);
  root.style.setProperty('--chat-code-font-size', `${Math.round(chatMsgSize * 0.86 * 10) / 10}px`);
  root.style.setProperty('--chat-timestamp-font-size', `${Math.round(chatMsgSize * 0.73 * 10) / 10}px`);

  root.setAttribute('data-font-size', size);
}

export function getFontSizeLabel(size: FontSizeLevel): string {
  const labels: Record<FontSizeLevel, string> = {
    'small': '小',
    'normal': '标准',
    'large': '大',
    'extra-large': '超大',
  };
  return labels[size];
}

export function initFontSize() {
  try {
    const stored = localStorage.getItem('font-size-storage');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.state?.fontSize) {
        applyFontSize(parsed.state.fontSize);
        return;
      }
    }
  } catch {}
  applyFontSize('normal');
}
