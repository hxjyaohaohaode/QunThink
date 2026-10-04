import { useState, useSyncExternalStore } from 'react';
import { clearDiagnostics, diagnosticsEnabled, exportDiagnostics, getDiagnosticEvents, getDiagnosticRevision, setDiagnosticsEnabled, subscribeDiagnostics } from '../../observability/runtimeDiagnostics';
const names = { view: '页面进入', interaction: '操作响应', request: '接口请求', runtime: '运行异常', task: '任务操作' };
const outcomes = { started: '开始', succeeded: '成功', failed: '失败', unknown: '待核验' };
export function RuntimeDiagnostics() {
  useSyncExternalStore(subscribeDiagnostics, getDiagnosticRevision);
  const [copied, setCopied] = useState('');
  const events = getDiagnosticEvents();
  const failures = events.filter(event => event.outcome === 'failed' || event.outcome === 'unknown').length;
  async function copy() {
    try { await navigator.clipboard.writeText(exportDiagnostics()); setCopied('已复制本地诊断记录'); }
    catch { setCopied('剪贴板不可用，请选择下面的记录复制'); }
  }
  return <section data-observe="diagnostics" className="space-y-5" aria-labelledby="diagnostics-title">
    <div><h2 id="diagnostics-title" className="text-xl font-semibold">运行记录</h2><p className="text-sm text-text-secondary mt-2 max-w-2xl">仅记录当前标签页的页面、操作类别、耗时和结果，最多 200 条。没有聊天正文、输入内容、模型密钥、地址或账号标识，不会上传。退出账号、关闭标签页或清除后不再保留。</p></div>
    <div className="flex flex-wrap gap-3 items-center"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={diagnosticsEnabled()} onChange={event => setDiagnosticsEnabled(event.target.checked)} />本标签页记录诊断</label><button className="workspace-button" onClick={clearDiagnostics}>清除记录</button><button className="workspace-button" onClick={() => void copy()}>复制脱敏记录</button><span role="status" className="text-xs text-text-secondary">{copied}</span></div>
    <p className="text-xs text-text-secondary">{events.length} 条记录 · {failures} 条失败或待核验。此记录辅助排查界面问题，不证明业务操作或模型费用已核实。</p>
    <ol className="divide-y divide-border rounded-2xl border border-border overflow-hidden" aria-label="本地运行记录">{[...events].reverse().map(event => <li key={event.sequence} className="px-4 py-3 flex flex-wrap gap-3 text-xs"><time>{new Date(event.at).toLocaleTimeString()}</time><span className="font-medium">{names[event.kind]}</span><span>{event.surface}</span><span className={event.outcome === 'failed' ? 'text-red-500' : 'text-text-secondary'}>{outcomes[event.outcome]}</span>{event.durationMs !== undefined && <span>{event.durationMs} ms</span>}</li>)}{!events.length && <li className="p-8 text-sm text-text-muted">暂无记录。开启后，接下来的操作会显示在这里。</li>}</ol>
    {copied.includes('不可用') && <textarea aria-label="可手动复制的脱敏诊断记录" readOnly rows={6} className="workspace-input font-mono text-xs" value={exportDiagnostics()} />}
  </section>;
}
