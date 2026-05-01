import { useState, useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';

export function ConnectionStatus() {
  const connectionStatus = useUIStore(state => state.connectionStatus);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      setIsDismissed(false);
    }
  }, [connectionStatus]);

  if (connectionStatus === 'connected') return null;
  if (isDismissed) return null;

  return (
    <div className="fixed bottom-20 md:bottom-4 left-1/2 -translate-x-1/2 z-[60] animate-fade-in">
      <div className={`
        flex items-center gap-2 px-4 py-2 rounded-full shadow-lg text-white text-sm
        ${connectionStatus === 'connecting'
          ? 'bg-yellow-500'
          : 'bg-red-500'
        }
      `}
      role="alert"
      >
        {connectionStatus === 'connecting' ? (
          <>
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>正在重连...</span>
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span>连接已断开</span>
          </>
        )}
        <button
          onClick={() => setIsDismissed(true)}
          className="ml-1 p-0.5 hover:bg-white/20 rounded-full"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
