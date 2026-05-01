import React from 'react';

interface Props { children: React.ReactNode }
interface State { hasError: boolean; error: Error | null }

async function reportError(error: Error, errorInfo: React.ErrorInfo): Promise<void> {
  try {
    const payload = {
      type: 'react_error',
      message: error.message,
      stack: error.stack?.slice(0, 2000),
      componentStack: errorInfo.componentStack?.slice(0, 2000),
      url: window.location.href,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };

    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/api/monitoring/errors', blob);
    } else {
      fetch('/api/monitoring/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    }
  } catch {}
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    reportError(error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (<div className="flex items-center justify-center h-full p-8"><div className="text-center"><div className="mb-4 flex justify-center"><svg className="w-12 h-12 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg></div><h2 className="text-lg font-semibold text-text-primary mb-2">出了点问题</h2><p className="text-text-muted mb-4">页面发生了错误，请尝试刷新</p><button onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }} className="px-4 py-2 bg-user text-white rounded-lg hover:opacity-90 transition-opacity">刷新页面</button></div></div>);
    }
    return this.props.children;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    try {
      const payload = {
        type: 'runtime_error',
        message: event.message?.slice(0, 500),
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        url: window.location.href,
        timestamp: new Date().toISOString(),
      };
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/monitoring/errors', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      }
    } catch {}
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const payload = {
        type: 'unhandled_promise_rejection',
        message: String(event.reason?.message || event.reason)?.slice(0, 500),
        url: window.location.href,
        timestamp: new Date().toISOString(),
      };
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/monitoring/errors', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      }
    } catch {}
  });
}
