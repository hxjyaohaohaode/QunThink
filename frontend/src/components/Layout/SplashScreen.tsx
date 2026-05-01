import { useEffect, useRef } from 'react';

interface SplashScreenProps {
  onComplete: () => void;
}

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const completedRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete();
      }
    }, 2200);
    return () => clearTimeout(t);
  }, [onComplete]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-white select-none overflow-hidden">
      <div className="flex flex-col items-center">
        {/* Logo */}
        <svg width="220" height="160" viewBox="0 0 400 320" className="overflow-visible">
          <defs>
            <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#6C5CE7" />
              <stop offset="100%" stopColor="#A29BFE" />
            </linearGradient>
          </defs>

          <g className="sq-dark">
            <rect
              x="140" y="40" width="90" height="90" rx="20"
              fill="#1A1A2E" opacity="0.9"
              transform="rotate(-12, 185, 85)"
            />
          </g>
          <g className="sq-purple">
            <rect
              x="160" y="35" width="90" height="90" rx="20"
              fill="#6C5CE7" opacity="0.6"
              transform="rotate(8, 205, 80)"
            />
          </g>
          <g className="sq-main">
            <rect
              x="178" y="45" width="90" height="90" rx="20"
              fill="url(#grad)"
            />
          </g>
        </svg>

        {/* Text */}
        <div className="flex flex-col items-center mt-4 text-anim">
          <span
            className="text-[48px] font-extrabold tracking-[6px] text-[#1A1A2E]"
            style={{ fontFamily: "'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif" }}
          >
            群想
          </span>
          <span
            className="text-[15px] font-medium tracking-[8px] uppercase text-[#6C5CE7] mt-1"
            style={{ fontFamily: "'Inter','Helvetica Neue',sans-serif" }}
          >
            Muse aloud
          </span>
          <span
            className="text-[13px] tracking-[4px] text-[#999] mt-3"
            style={{ fontFamily: "'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif" }}
          >
            想，就聊出来
          </span>
        </div>
      </div>

      <style>{`
        .sq-dark {
          animation: sqInDark 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both;
        }
        .sq-purple {
          animation: sqInPurple 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.2s both;
        }
        .sq-main {
          animation: sqInMain 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.35s both;
        }
        .text-anim {
          animation: textIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.9s both;
        }
        @keyframes sqInDark {
          from {
            opacity: 0;
            transform: translateY(30px) scale(0.8);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes sqInPurple {
          from {
            opacity: 0;
            transform: translateY(30px) scale(0.8);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes sqInMain {
          from {
            opacity: 0;
            transform: translateY(30px) scale(0.8);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes textIn {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
