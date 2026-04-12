/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#f5f5f5',
          surface: '#ffffff',
          surface2: '#f0f0f0',
          surface3: '#e8e8e8',
        },
        text: {
          primary: '#000000',
          secondary: '#666666',
          muted: '#999999',
        },
        user: '#07c160',
        deepseek: '#fd9744',
        'deepseek-reasoner': '#f97316',
        glm: '#34d399',
        mimo: '#f59e0b',
        qwen: '#a78bfa',
        success: '#07c160',
        warning: '#f59e0b',
        error: '#ef4444',
        link: '#07c160',
      },
      fontFamily: {
        sans: ['Noto Sans SC', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      fontSize: {
        'title': '20px',
        'subtitle': '16px',
        'body': '14px',
        'caption': '12px',
        'timestamp': '11px',
      },
      spacing: {
        'message-padding': '10px 14px',
        'message-gap': '12px',
        'section-padding': '16px 22px',
        'panel-padding': '20px 18px',
      },
      borderRadius: {
        'card': '12px',
        'message': '18px',
        'button': '10px',
      },
      animation: {
        'message-in': 'messageIn 300ms ease',
        'typing-dot': 'typingDot 1400ms ease infinite',
        'fade-in': 'fadeIn 150ms ease',
        'slide-in': 'slideIn 200ms ease',
        'button-press': 'buttonPress 100ms ease',
      },
      keyframes: {
        messageIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        typingDot: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-4px)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        buttonPress: {
          '0%': { transform: 'scale(1)' },
          '100%': { transform: 'scale(0.95)' },
        },
      },
    },
  },
  plugins: [],
}