import { useEffect, useState } from 'react';
import type { ModelCatalog, ModelProvider, CatalogModel, ModelCapability } from '../../../../shared/models';
import { useModelsStore, requestError } from '../../stores/modelsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { axiosInstance } from '../../services/api';

const field = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent/40';
const secondary = 'rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-surface2 disabled:opacity-40';
const capabilityLabels: Record<ModelCapability, string> = { chat: '对话', vision: '图片理解', audio: '音频理解', video: '视频理解', tts: '语音合成' };
const freshId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function ModelCenter() {
  const catalog = useModelsStore(s => s.catalog);
  const load = useModelsStore(s => s.fetch);
  const save = useModelsStore(s => s.save);
  const loading = useModelsStore(s => s.loading);
  const loadError = useModelsStore(s => s.error);
  const [draft, setDraft] = useState<ModelCatalog | null>(catalog);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => { if (!catalog) void load(); }, [catalog, load]);
  useEffect(() => {
    if (catalog && !dirty) { setDraft(catalog); setSelected(id => catalog.providers.some(p => p.id === id) ? id : catalog.providers[0]?.id || ''); }
  }, [catalog, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function change(next: ModelCatalog) { setDraft(next); setDirty(true); setNotice(''); setError(''); }
  function updateProvider(id: string, patch: Partial<ModelProvider>) {
    if (draft) change({ ...draft, providers: draft.providers.map(p => p.id === id ? { ...p, ...patch } : p) });
  }
  function updateModel(id: string, patch: Partial<CatalogModel>) {
    if (draft) change({ ...draft, models: draft.models.map(m => m.id === id ? { ...m, ...patch } : m) });
  }
  function addModel(modelId = '') {
    if (!draft || !selected) return;
    change({ ...draft, models: [...draft.models, { id: freshId('model'), name: modelId || '新模型', model: modelId, providerId: selected, enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 4096, temperature: null, tokenParameter: 'max_tokens', color: '#6366f1' }] });
  }
  async function persist() {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const saved = await save(draft); setDraft(saved); setDirty(false);
      await usePersonasStore.getState().fetchPersonas();
      setNotice('已保存。会话、智能体和任务将使用新的配置。');
    } catch (e) { setError(requestError(e)); } finally { setBusy(false); }
  }
  async function test(id: string, capability: 'chat' | 'vision' | 'tts') {
    setBusy(true); setError(''); setNotice('正在连接所选模型…');
    try {
      const { data } = await axiosInstance.post('/user/model-catalog/test', { modelId: id, capability });
      await load();
      setNotice(`${capabilityLabels[capability]}能力已验证 · ${data.model} · ${data.responseTime} ms。测试可能产生服务商费用；其他能力仍需单独验证。`);
    } catch (e) { setNotice(''); setError(requestError(e)); } finally { setBusy(false); }
  }
  async function discover() {
    setBusy(true); setError(''); setDiscovered([]);
    try {
      const { data } = await axiosInstance.post('/user/model-catalog/discover', { providerId: selected });
      setDiscovered(data.models); setNotice(`找到 ${data.models.length} 个模型，点击即可加入目录。`);
    } catch (e) { setError(requestError(e)); } finally { setBusy(false); }
  }

  if (!draft) return <div className="p-5 text-sm text-text-secondary" role="status">{loading ? '正在读取模型目录…' : loadError || '尚未加载模型目录'}{!loading && <button className={`${secondary} ml-3`} onClick={() => void load()}>重新加载</button>}</div>;
  const provider = draft.providers.find(p => p.id === selected);
  const models = draft.models.filter(m => m.providerId === selected);
  return <section className="space-y-6" aria-label="模型中心">
    <div>
      <p className="text-[10px] tracking-[0.2em] text-accent font-semibold mb-2">MODELS & CONNECTIONS</p>
      <h2 className="text-xl font-semibold text-text-primary">模型中心</h2>
      <p className="text-sm text-text-secondary mt-2 leading-relaxed">连接服务商，自由添加模型。名称由你决定，实际模型 ID 与服务商一致。</p>
    </div>
    <div className="grid grid-cols-3 gap-2">
      {[['服务商', draft.providers.length], ['模型', draft.models.length], ['对话已验证', draft.models.filter(m => m.ready && m.verifiedCapabilities?.includes('chat')).length]].map(([label, count]) => <div key={label} className="rounded-xl bg-bg-surface2/60 p-3"><strong className="block text-xl text-text-primary">{count}</strong><span className="text-xs text-text-secondary">{label}</span></div>)}
    </div>
    <div className="flex flex-wrap gap-2" aria-label="服务商列表">
      {draft.providers.map(p => <button key={p.id} onClick={() => { setSelected(p.id); setDiscovered([]); }} className={`px-3 py-2 rounded-xl text-sm border ${selected === p.id ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-secondary'}`}>{p.name}</button>)}
      <button className={secondary} onClick={() => { const id = freshId('provider'); change({ ...draft, providers: [...draft.providers, { id, name: '自定义服务', protocol: 'openai', baseUrl: '', enabled: true, keyRequired: true }] }); setSelected(id); setDiscovered([]); }}>＋ 服务商</button>
    </div>
    {provider ? <div className="rounded-2xl border border-border p-4 space-y-4 bg-bg-primary/40">
      <div className="flex items-center justify-between gap-3"><h3 className="font-medium text-text-primary">服务连接</h3><label className="text-xs text-text-secondary flex items-center gap-2"><input type="checkbox" checked={provider.enabled} onChange={e => updateProvider(provider.id, { enabled: e.target.checked })} />启用服务商</label></div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs text-text-secondary space-y-1.5">服务商名称<input className={field} value={provider.name} maxLength={80} onChange={e => updateProvider(provider.id, { name: e.target.value })} /></label>
        <label className="text-xs text-text-secondary space-y-1.5">API 协议<select className={field} value={provider.protocol} onChange={e => updateProvider(provider.id, { protocol: e.target.value as ModelProvider['protocol'] })}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option></select></label>
      </div>
      <label className="block text-xs text-text-secondary space-y-1.5">服务地址（Base URL）<input className={field} value={provider.baseUrl} placeholder={provider.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://your-provider.example/v1'} onChange={e => updateProvider(provider.id, { baseUrl: e.target.value })} /></label>
      <label className="block text-xs text-text-secondary space-y-1.5">API Key · {provider.clearApiKey ? '保存后清除' : provider.apiKeyConfigured ? `已配置${provider.keySource === 'environment' ? '（服务器）' : ''}，留空保留` : '尚未配置'}<input className={field} type="password" autoComplete="new-password" value={provider.apiKey || ''} placeholder="密钥仅用于服务连接，保存后不再显示" onChange={e => updateProvider(provider.id, { apiKey: e.target.value, clearApiKey: false })} /></label>
      <div className="flex flex-wrap gap-3 justify-between text-xs text-text-secondary">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!provider.keyRequired} onChange={e => updateProvider(provider.id, { keyRequired: !e.target.checked })} />无需密钥（如本地模型服务）</label>
        <button className="hover:text-red-500" onClick={() => updateProvider(provider.id, { clearApiKey: true, apiKey: '' })}>清除已存密钥</button>
      </div>
      <p className="text-xs text-text-muted leading-relaxed">本地服务须由服务器设置允许的地址。新增模型后保存即可测试；更换地址或协议会清除原密钥，需要为新连接重新填写。</p>
      <div className="flex flex-wrap gap-2"><button className={secondary} disabled={busy || dirty} onClick={() => void discover()}>拉取模型列表</button><button className={secondary} onClick={() => addModel()}>＋ 手动添加模型</button><button className={`${secondary} ml-auto`} disabled={models.length > 0} title="先移除该服务商的模型" onClick={() => { change({ ...draft, providers: draft.providers.filter(p => p.id !== provider.id) }); setSelected(draft.providers.find(p => p.id !== provider.id)?.id || ''); }}>移除服务商</button></div>
      {discovered.length > 0 && <div className="space-y-2"><input aria-label="搜索服务商模型" className={field} value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索模型 ID" /><div className="max-h-44 overflow-y-auto flex flex-wrap gap-2">{discovered.filter(m => m.toLowerCase().includes(search.toLowerCase())).map(m => <button className={secondary} key={m} disabled={models.some(existing => existing.model === m)} onClick={() => addModel(m)}>{m}</button>)}</div></div>}
    </div> : <div className="rounded-xl border border-dashed border-border p-6 text-sm text-text-secondary">添加第一个服务商，开始连接你的 AI。</div>}
    <div className="space-y-3">
      {models.map(m => <details key={m.id} className="rounded-2xl border border-border bg-bg-primary/40" open={!m.model || undefined}>
        <summary className="p-4 cursor-pointer text-sm text-text-primary"><span className="font-medium">{m.name || '未命名模型'}</span><span className="ml-2 text-xs text-text-secondary">{!m.enabled ? '已停用' : !m.ready ? '待连接' : m.verifiedCapabilities?.length ? `已验证：${m.verifiedCapabilities.map(c => capabilityLabels[c]).join(' / ')}` : '已配置，待测试'} · 已声明：{m.capabilities.map(c => capabilityLabels[c]).join(' / ')}</span></summary>
        <div className="p-4 pt-0 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3"><label className="text-xs text-text-secondary space-y-1.5">显示名称<input className={field} value={m.name} onChange={e => updateModel(m.id, { name: e.target.value })} /></label><label className="text-xs text-text-secondary space-y-1.5">模型 ID<input className={field} value={m.model} placeholder="复制服务商提供的实际模型 ID" onChange={e => updateModel(m.id, { model: e.target.value })} /></label></div>
          <div className="flex flex-wrap gap-3">{Object.entries(capabilityLabels).map(([cap, label]) => <label className="text-xs text-text-secondary flex items-center gap-1.5" key={cap}><input type="checkbox" checked={m.capabilities.includes(cap as ModelCapability)} onChange={e => updateModel(m.id, { capabilities: e.target.checked ? [...m.capabilities, cap as ModelCapability] : m.capabilities.filter(c => c !== cap) })} />{label}</label>)}</div>
          <div className="grid grid-cols-2 gap-3"><label className="text-xs text-text-secondary space-y-1.5">上下文窗口（tokens）<input className={field} type="number" min="1024" max="2000000" value={m.contextWindow} onChange={e => updateModel(m.id, { contextWindow: Number(e.target.value) })} /></label><label className="text-xs text-text-secondary space-y-1.5">输出上限（tokens）<input className={field} type="number" min="1" max="131072" value={m.maxTokens} onChange={e => updateModel(m.id, { maxTokens: Number(e.target.value) })} /></label></div>
          <div className="grid sm:grid-cols-2 gap-3"><label className="text-xs text-text-secondary space-y-1.5">温度（留空遵循模型默认）<input className={field} type="number" min="0" max="2" step="0.1" value={m.temperature ?? ''} onChange={e => updateModel(m.id, { temperature: e.target.value === '' ? null : Number(e.target.value) })} /></label><label className="text-xs text-text-secondary space-y-1.5">输出参数<select className={field} value={m.tokenParameter} onChange={e => updateModel(m.id, { tokenParameter: e.target.value as CatalogModel['tokenParameter'] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label></div>
          {m.capabilities.includes('tts') && <label className="block text-xs text-text-secondary space-y-1.5">语音接口<select className={field} value={m.ttsMode || 'speech'} onChange={e => updateModel(m.id, { ttsMode: e.target.value as CatalogModel['ttsMode'] })}><option value="speech">Audio Speech</option><option value="chat-audio">Chat Completions 音频输出</option></select></label>}
          {m.capabilities.includes('tts') && <label className="block text-xs text-text-secondary space-y-1.5">默认音色 ID<input className={field} value={m.ttsVoice || ''} placeholder={m.ttsMode === 'chat-audio' ? 'mimo_default' : 'alloy'} onChange={e => updateModel(m.id, { ttsVoice: e.target.value || null })} /><span>按服务商提供的音色 ID 填写；修改后需重新测试。</span></label>}
          <p className="text-xs text-text-muted">能力测试会向所选服务商发送短请求，可能产生费用。</p>
          <div className="flex flex-wrap gap-3 items-center"><label className="text-xs text-text-secondary flex gap-2"><input type="checkbox" checked={m.enabled} onChange={e => updateModel(m.id, { enabled: e.target.checked })} />启用</label><button className={secondary} disabled={busy || dirty || !m.capabilities.includes('chat')} onClick={() => void test(m.id, 'chat')}>测试对话</button><button className={secondary} disabled={busy || dirty || !m.capabilities.includes('vision')} onClick={() => void test(m.id, 'vision')}>测试图片理解（2 次调用）</button><button className={secondary} disabled={busy || dirty || !m.capabilities.includes('tts')} onClick={() => void test(m.id, 'tts')}>测试语音合成</button><button className={`${secondary} ml-auto`} onClick={() => change({ ...draft, models: draft.models.filter(item => item.id !== m.id), defaults: { chat: draft.defaults.chat === m.id ? null : draft.defaults.chat, vision: draft.defaults.vision === m.id ? null : draft.defaults.vision, tts: draft.defaults.tts === m.id ? null : draft.defaults.tts } })}>移除模型</button></div>
        </div>
      </details>)}
    </div>
    <div className="rounded-2xl border border-border p-4 space-y-3"><h3 className="font-medium text-sm text-text-primary">默认模型</h3><p className="text-xs text-text-secondary">自动选择和明确指定都需要相应能力通过当前连接的测试；会话中的既有成员保留。</p><div className="grid sm:grid-cols-3 gap-3">{(['chat', 'vision', 'tts'] as const).map(cap => <label className="text-xs text-text-secondary space-y-1.5" key={cap}>{capabilityLabels[cap]}<select className={field} value={draft.defaults[cap] || ''} onChange={e => change({ ...draft, defaults: { ...draft.defaults, [cap]: e.target.value || null } })}><option value="">自动选择已验证模型</option>{draft.models.filter(m => m.enabled && m.capabilities.includes(cap)).map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label>)}</div></div>
    <div className="sticky bottom-0 bg-bg-primary/95 backdrop-blur py-3 space-y-2 border-t border-border">
      {(error || loadError) && <p role="alert" className="text-sm text-red-500">{error || loadError}</p>}
      {notice && <p role="status" className="text-sm text-text-secondary">{notice}</p>}
      <div className="flex gap-2 items-center"><button className="rounded-xl bg-accent text-white px-5 py-2.5 text-sm font-medium disabled:opacity-50" disabled={busy || !dirty} onClick={() => void persist()}>{busy ? '处理中…' : '保存并应用'}</button>{dirty && <button className={secondary} disabled={busy} onClick={() => { setDraft(catalog); setDirty(false); setError(''); void load(); }}>放弃修改</button>}<span className="text-xs text-text-muted">{dirty ? '有未保存修改，保存后可测试' : '配置已同步'}</span></div>
    </div>
  </section>;
}
