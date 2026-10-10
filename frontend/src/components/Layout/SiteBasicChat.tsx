import { useEffect, useRef, useState } from 'react';
import { axiosInstance, getAuthGeneration } from '../../services/api';
import { getCacheUserId } from '../../utils/cacheUtils';

type Availability = { available: boolean; providerOrigin?: string; model?: string; consentToken?: string };
const field = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
export function SiteBasicChat() {
  const [info, setInfo] = useState<Availability | null>(null);
  const [prompt, setPrompt] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const flight = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const owner = getCacheUserId();
  const authEpoch = getAuthGeneration();
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setInfo(null); setPrompt(''); setConsent(false); setResult(''); setError(''); setPending(false);
    void axiosInstance.get('/site-ai/status', { signal: controller.signal, headers: { 'X-Expected-User-Id': owner || '' } }).then(({ data }) => {
      if (current === generation.current && owner === getCacheUserId() && authEpoch === getAuthGeneration()) setInfo(data);
    }).catch(() => { if (!controller.signal.aborted && current === generation.current) setInfo({ available: false }); });
    return () => { generation.current++; controller.abort(); flight.current?.abort(); flight.current = null; };
  }, [owner, authEpoch]);
  async function send() {
    if (!owner || owner !== getCacheUserId() || authEpoch !== getAuthGeneration() || flight.current || !info?.available || !consent || !prompt.trim()) return;
    const current = generation.current;
    const controller = new AbortController(); flight.current = controller;
    setPending(true); setError(''); setResult('');
    try {
      const { data } = await axiosInstance.post('/site-ai/chat', { prompt, consent: true, consentToken: info.consentToken }, { signal: controller.signal, timeout: 30000, headers: { 'X-Expected-User-Id': owner } });
      if (current === generation.current && owner === getCacheUserId() && authEpoch === getAuthGeneration() && !controller.signal.aborted) setResult(data.content);
    } catch {
      if (current === generation.current && owner === getCacheUserId() && authEpoch === getAuthGeneration() && !controller.signal.aborted) setError('本次请求未完成，可能已发送至服务商。不会自动重试；请核对后再发送。');
    } finally {
      if (flight.current === controller) flight.current = null;
      if (current === generation.current) { setPending(false); setConsent(false); }
    }
  }
  return <details className="rounded-2xl border border-border p-4" onToggle={event => {
    if (!event.currentTarget.open && flight.current) { flight.current.abort(); flight.current = null; generation.current++; setPending(false); setConsent(false); setResult(''); setError('已停止等待；已发出的文本可能仍由服务商处理。'); }
  }}>
    <summary className="cursor-pointer text-sm font-medium text-text-primary">站点基础 AI（单轮聊天）</summary>
    {!info ? <p className="text-xs text-text-muted mt-3">正在检查可用状态…</p> : !info.available ? <p className="text-xs text-text-muted mt-3">站点基础 AI 未启用或暂不可用。你仍可配置自己的模型，并使用非 AI 功能。</p> : <div className="space-y-3 mt-3">
      <p className="text-xs text-text-secondary">本次文本将发送至 {info.providerOrigin}，模型 {info.model}。仅发送下方输入，不附带历史或文件；回复不保存，关闭页面后不保留。不会改变你自己的模型设置或自动切换模型。</p>
      <textarea aria-label="站点基础 AI 输入" className={field} maxLength={4000} rows={4} value={prompt} disabled={pending} onChange={e => setPrompt(e.target.value)} />
      <label className="flex gap-2 text-xs text-text-secondary"><input type="checkbox" checked={consent} disabled={pending} onChange={e => setConsent(e.target.checked)} />我同意将本次输入发送给上述服务商，由站点基础 AI 生成回答</label>
      <button className="rounded-xl border border-border px-3 py-2 text-sm text-text-primary disabled:opacity-40" disabled={pending || !consent || !prompt.trim()} onClick={() => void send()}>{pending ? '正在生成…' : '发送给站点基础 AI'}</button>
      {error && <p role="alert" className="text-xs text-text-secondary">{error}</p>}
      {result && <div role="status" className="rounded-xl bg-bg-surface2 p-3"><p className="text-xs text-text-muted mb-2">AI 生成 · 请核实重要信息</p><p className="text-sm text-text-primary whitespace-pre-wrap break-words">{result}</p></div>}
    </div>}
  </details>;
}
