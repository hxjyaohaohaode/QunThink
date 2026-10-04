import React from 'react';
import { recordDiagnostic, getDiagnosticSurface } from '../../observability/runtimeDiagnostics';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode | ((ctx: { reset: () => void }) => React.ReactNode);
}
interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch() {
    recordDiagnostic('runtime', getDiagnosticSurface(), 'failed');
  }
  private reset = () => {
    this.setState({ hasError: false, error: null });
  };
  render() {
    if (this.state.hasError) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback({ reset: this.reset });
      }
      if (fallback !== undefined) {
        return fallback;
      }
      return (<div className="flex items-center justify-center h-full p-8"><div className="text-center"><div className="mb-4 flex justify-center"><svg className="w-12 h-12 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg></div><h2 className="text-lg font-semibold text-text-primary mb-2">出了点问题</h2><p className="text-text-muted mb-4">当前页面暂时无法显示。先尝试重新打开，已保存的数据不会被清除。</p><button onClick={this.reset} className="px-4 py-2 bg-user text-white rounded-lg hover:opacity-90 transition-opacity">重新打开页面</button></div></div>);
    }
    return this.props.children;
  }
}

// Local categorical diagnostics only; errors may contain private input or credentials.
if (typeof window !== 'undefined') {
  window.addEventListener('error', () => recordDiagnostic('runtime', getDiagnosticSurface(), 'failed'));
  window.addEventListener('unhandledrejection', () => recordDiagnostic('runtime', getDiagnosticSurface(), 'failed'));
}
