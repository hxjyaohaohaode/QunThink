import { useEffect, useRef, useState } from 'react';
import type { ModelProvider, CatalogModel, ModelCapability } from '../../../../shared/models';
import { useModelsStore } from '../../stores/modelsStore';
import { probeKey, probeUnresolved } from '../../services/modelProbes';
import type { ModelProbeCapability } from '../../services/modelProbes';

const field = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60';
const secondary = 'rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 motion-reduce:transition-none';
const capabilityLabels: Record<ModelCapability, string> = { chat: '对话', vision: '图片理解', audio: '音频理解', video: '视频理解', tts: '语音合成' };
const freshId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const testedCapabilities = ['chat', 'vision', 'tts'] as const;

export function ModelCenter() {
  const { catalog, draft, selected, dirty, saving, loading, error: loadError, saveError, conflict, notice, discovery, probes,
    fetch: load, save, setDraft: change, selectProvider: setSelected, discardDraft, rebaseDraft, discover, test, queryProbe, resubmitProbe } = useModelsStore();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState('');
  const modelRefs = useRef<Record<string, HTMLDetailsElement | null>>({});
  const discovered = discovery.providerId === selected ? discovery.models : [];

  useEffect(() => { if (!catalog) void load(); }, [catalog, load]);
  useEffect(() => { setSearch(''); }, [selected]);
  useEffect(() => { if (expanded) modelRefs.current[expanded]?.querySelector('summary')?.focus(); }, [expanded, selected]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function updateProvider(id: string, patch: Partial<ModelProvider>) {
    if (!draft) return;
    change({ ...draft, providers: draft.providers.map(p => {
      if (p.id !== id) return p;
      const moved = (patch.baseUrl !== undefined && patch.baseUrl !== p.baseUrl) || (patch.protocol !== undefined && patch.protocol !== p.protocol);
      return { ...p, ...patch, ...(moved ? { apiKey: '', apiKeyConfigured: false, ready: false } : {}) };
    }) });
  }
  function updateModel(id: string, patch: Partial<CatalogModel>) {
    if (draft) change({ ...draft, models: draft.models.map(m => m.id === id ? { ...m, ...patch } : m) });
  }
  function addModel(modelId = '') {
    if (!draft || !selected) return;
    const id = freshId('model');
    change({ ...draft, models: [...draft.models, { id, name: modelId || '新模型', model: modelId, providerId: selected, enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 4096, temperature: null, tokenParameter: 'max_tokens', color: '#6366f1' }] });
    setExpanded(id);
  }
  async function persist() {
    if (!draft) return;
    try { await save(draft); } catch { /* The account-scoped store owns the actionable error and draft. */ }
  }
  function viewModel(model: CatalogModel) {
    setSelected(model.providerId); setExpanded(model.id);
    const element = modelRefs.current[model.id];
    if (element) { element.open = true; element.querySelector('summary')?.focus(); }
  }
  function probeButton(model: CatalogModel, capability: ModelProbeCapability) {
    const probe = probes[probeKey(model.id, capability)];
    const blocked = probe && (probe.pending || probe.checking || probeUnresolved(probe));
    const label = capability === 'vision' ? '测试图片理解（2 次调用）' : `测试${capabilityLabels[capability]}`;
    return <button key={capability} className={secondary} disabled={saving || dirty || !model.enabled || !model.ready || !model.capabilities.includes(capability) || Boolean(blocked)}
      onClick={() => void test(model.id, capability)}>{probe?.pending ? `${capabilityLabels[capability]}测试中…` : label}</button>;
  }

  if (!draft) return <div className="p-5 text-sm text-text-secondary" role="status">{loading ? '正在读取模型目录…' : loadError || '尚未加载模型目录'}{!loading && <button className={`${secondary} ml-3`} onClick={() => void load()}>重新加载</button>}</div>;
  const provider = draft.providers.find(p => p.id === selected);
  const models = draft.models.filter(m => m.providerId === selected);
  const unresolvedProbes = Object.entries(probes).filter(([, probe]) => probeUnresolved(probe) || !draft.models.some(m => m.id === probe.modelId));
  return <section className="space-y-6" aria-label="模型中心" data-observe="models">
    <div>
      <p className="text-[10px] tracking-[0.2em] text-accent font-semibold mb-2">MODELS & CONNECTIONS</p>
      <h2 className="text-xl font-semibold text-text-primary">模型中心</h2>
      <p className="text-sm text-text-secondary mt-2 leading-relaxed">平台不预置 AI，也不提供共享密钥。请连接你自己的服务商并添加模型；名称由你决定，实际模型 ID 与服务商一致。保存不会发起付费测试；更改连接、模型参数或音色后，需手动重新测试。</p>
    </div>
    <ol className="grid sm:grid-cols-3 gap-2 text-xs text-text-secondary" aria-label="连接步骤">
      <li className="rounded-xl border border-border p-3">1. 填写服务地址和密钥</li>
      <li className="rounded-xl border border-border p-3">2. 添加模型并保存配置</li>
      <li className="rounded-xl border border-border p-3">3. 测试所需能力，再开始使用</li>
    </ol>
    <p className="text-xs text-text-muted">未保存草稿只保留在当前标签页内，切换页面后可继续；刷新或退出账号会清除，API Key 不写入浏览器存储。</p>
    <div className="grid grid-cols-3 gap-2">
      {[['服务商', draft.providers.length], ['模型', draft.models.length], ['对话已验证', (catalog?.models || []).filter(m => m.ready && m.verifiedCapabilities?.includes('chat')).length]].map(([label, count]) => <div key={label} className="rounded-xl bg-bg-surface2/60 p-3"><strong className="block text-xl text-text-primary">{count}</strong><span className="text-xs text-text-secondary">{label}</span></div>)}
    </div>
    {unresolvedProbes.length > 0 && <div className="rounded-xl border border-amber-500/40 p-3 text-xs text-text-secondary space-y-2" aria-label="待核验测试">
      <p role="status">测试请求号只保留在当前标签页，刷新前请记下。待确认结果请核验原请求，不会自动重发。</p>
      {unresolvedProbes.map(([key, probe]) => {
        const model = draft.models.find(m => m.id === probe.modelId);
        return <div key={key} className="flex flex-wrap items-center gap-2"><span>{model?.name || '已移除模型'} · {capabilityLabels[probe.capability]}</span>
          {model ? <button className={secondary} onClick={() => viewModel(model)}>查看本次测试</button> : <><span className="break-all">{probe.requestId}</span>{probeUnresolved(probe) ? <button className={secondary} disabled={probe.pending || probe.checking} onClick={() => void queryProbe(key)}>{probe.checking ? '正在核验…' : '查询原请求状态'}</button> : <span role="status">{probe.status === 'failed' ? `测试失败：${probe.error || '未通过验证'}` : '已取得原测试结果；该模型已移除，不能验证当前配置。'}</span>}{probe.queryError && <p role="alert">{probe.queryError}</p>}</>}
        </div>;
      })}
    </div>}
    <fieldset disabled={saving} className="space-y-6 min-w-0" aria-label="模型配置" aria-busy={saving}>
    <div className="flex flex-wrap gap-2" role="group" aria-label="服务商列表">
      {draft.providers.map(p => <button key={p.id} aria-pressed={selected === p.id} onClick={() => setSelected(p.id)} className={`px-3 py-2 rounded-xl text-sm border ${selected === p.id ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-secondary'}`}>{p.name}</button>)}
      <button className={secondary} onClick={() => { const id = freshId('provider'); change({ ...draft, providers: [...draft.providers, { id, name: '自定义服务', protocol: 'openai', baseUrl: '', enabled: true, keyRequired: true }] }); setSelected(id); }}>＋ 服务商</button>
    </div>
    {provider ? <div className="rounded-2xl border border-border p-4 space-y-4 bg-bg-primary/40">
      <div className="flex items-center justify-between gap-3"><h3 className="font-medium text-text-primary">服务连接</h3><label className="text-xs text-text-secondary flex items-center gap-2"><input type="checkbox" checked={provider.enabled} onChange={e => updateProvider(provider.id, { enabled: e.target.checked })} />启用服务商</label></div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs text-text-secondary space-y-1.5">服务商名称<input className={field} value={provider.name} maxLength={80} onChange={e => updateProvider(provider.id, { name: e.target.value })} /></label>
        <label className="text-xs text-text-secondary space-y-1.5">API 协议<select className={field} value={provider.protocol} onChange={e => updateProvider(provider.id, { protocol: e.target.value as ModelProvider['protocol'] })}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic Messages</option></select></label>
      </div>
      <label className="block text-xs text-text-secondary space-y-1.5">服务地址（Base URL）<input className={field} value={provider.baseUrl} placeholder={provider.protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://your-provider.example/v1'} onChange={e => updateProvider(provider.id, { baseUrl: e.target.value })} /></label>
      <label className="block text-xs text-text-secondary space-y-1.5">API Key · {provider.clearApiKey ? '保存后清除' : provider.apiKeyConfigured ? '已配置，留空保留' : '尚未配置'}<input className={field} type="password" autoComplete="new-password" value={provider.apiKey || ''} placeholder="密钥仅用于服务连接，保存后不再显示" onChange={e => updateProvider(provider.id, { apiKey: e.target.value, clearApiKey: false })} /></label>
      <div className="flex flex-wrap gap-3 justify-between text-xs text-text-secondary">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!provider.keyRequired} onChange={e => updateProvider(provider.id, { keyRequired: !e.target.checked })} />无需密钥（如本地模型服务）</label>
        <button className="hover:text-red-500" onClick={() => updateProvider(provider.id, { clearApiKey: true, apiKey: '' })}>清除已存密钥</button>
      </div>
      <p className="text-xs text-text-muted leading-relaxed">本地服务须由服务器设置允许的地址。新增模型后保存即可测试；更换地址或协议会清除原密钥，需要为新连接重新填写。</p>
      <div className="flex flex-wrap gap-2"><button className={secondary} disabled={saving || dirty || discovery.loading || !provider.enabled || !provider.ready} onClick={() => void discover()}>{discovery.loading ? '正在拉取…' : '拉取模型列表'}</button><button className={secondary} onClick={() => addModel()}>＋ 手动添加模型</button><button className={`${secondary} ml-auto`} disabled={models.length > 0} title="先移除该服务商的模型" onClick={() => { change({ ...draft, providers: draft.providers.filter(p => p.id !== provider.id) }); setSelected(draft.providers.find(p => p.id !== provider.id)?.id || ''); }}>移除服务商</button></div>
      {dirty && <p className="text-xs text-text-secondary">请先保存连接配置，再拉取模型列表或测试能力。</p>}
      {!dirty && !provider.ready && <p className="text-xs text-text-secondary">连接尚未就绪：检查服务地址、启用状态和密钥后保存；也可先手动添加模型。</p>}
      {discovery.error && <p role="alert" className="text-sm text-red-500">{discovery.error} 可检查连接后重新拉取，或手动添加服务商提供的模型 ID。</p>}
      {discovery.complete && <p role="status" className="text-xs text-text-secondary">{discovered.length ? `找到 ${discovered.length} 个模型。添加后仍需保存并测试能力。` : '没有返回可用模型 ID，请手动添加，或检查服务商是否支持模型列表。'}</p>}
      {discovered.length > 0 && <div className="space-y-2"><input aria-label="搜索服务商模型" className={field} value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索模型 ID" /><div className="max-h-44 overflow-y-auto flex flex-wrap gap-2">{discovered.filter(m => m.toLowerCase().includes(search.toLowerCase())).map(m => <button className={secondary} key={m} disabled={models.some(existing => existing.model === m)} onClick={() => addModel(m)}>{m}</button>)}</div>{search && !discovered.some(m => m.toLowerCase().includes(search.toLowerCase())) && <p className="text-xs text-text-secondary">没有匹配的模型 <button className={secondary} onClick={() => setSearch('')}>清除搜索</button></p>}</div>}
    </div> : <div className="rounded-xl border border-dashed border-border p-6 text-sm text-text-secondary">当前没有服务商。点击“＋ 服务商”，填写你自己的服务地址和密钥，再添加模型并测试能力。未连接模型时，可以查看历史会话和进行人工写作。</div>}
    <div className="space-y-3">
      {provider && models.length === 0 && <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">此服务商还没有模型。拉取列表或点击“手动添加模型”，填入实际模型 ID。</p>}
      {models.map(m => <details key={m.id} ref={node => { modelRefs.current[m.id] = node; }} className="rounded-2xl border border-border bg-bg-primary/40" open={expanded === m.id || !m.model || undefined}>
        <summary className="p-4 cursor-pointer text-sm text-text-primary"><span className="font-medium">{m.name || '未命名模型'}</span><span className="ml-2 text-xs text-text-secondary">{dirty ? '有未保存配置，保存后核对能力' : !m.enabled ? '已停用' : !m.ready ? '待连接' : m.verifiedCapabilities?.length ? `已验证：${m.verifiedCapabilities.map(c => capabilityLabels[c]).join(' / ')}` : '已配置，待测试'} · 已声明：{m.capabilities.map(c => capabilityLabels[c]).join(' / ')}</span></summary>
        <div className="p-4 pt-0 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3"><label className="text-xs text-text-secondary space-y-1.5">显示名称<input className={field} value={m.name} onChange={e => updateModel(m.id, { name: e.target.value })} /></label><label className="text-xs text-text-secondary space-y-1.5">模型 ID<input className={field} value={m.model} placeholder="复制服务商提供的实际模型 ID" onChange={e => updateModel(m.id, { model: e.target.value })} /></label></div>
          <div className="flex flex-wrap gap-3">{Object.entries(capabilityLabels).map(([cap, label]) => <label className="text-xs text-text-secondary flex items-center gap-1.5" key={cap}><input type="checkbox" checked={m.capabilities.includes(cap as ModelCapability)} onChange={e => updateModel(m.id, { capabilities: e.target.checked ? [...m.capabilities, cap as ModelCapability] : m.capabilities.filter(c => c !== cap) })} />{label}</label>)}</div>
          <div className="grid grid-cols-2 gap-3"><label className="text-xs text-text-secondary space-y-1.5">上下文窗口（tokens）<input className={field} type="number" min="1024" max="2000000" value={m.contextWindow} onChange={e => updateModel(m.id, { contextWindow: Number(e.target.value) })} /></label><label className="text-xs text-text-secondary space-y-1.5">输出上限（tokens）<input className={field} type="number" min="1" max="131072" value={m.maxTokens} onChange={e => updateModel(m.id, { maxTokens: Number(e.target.value) })} /></label></div>
          <div className="grid sm:grid-cols-2 gap-3"><label className="text-xs text-text-secondary space-y-1.5">温度（留空遵循模型默认）<input className={field} type="number" min="0" max="2" step="0.1" value={m.temperature ?? ''} onChange={e => updateModel(m.id, { temperature: e.target.value === '' ? null : Number(e.target.value) })} /></label><label className="text-xs text-text-secondary space-y-1.5">输出参数<select className={field} value={m.tokenParameter} onChange={e => updateModel(m.id, { tokenParameter: e.target.value as CatalogModel['tokenParameter'] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label></div>
          {m.capabilities.includes('tts') && <label className="block text-xs text-text-secondary space-y-1.5">语音接口<select className={field} value={m.ttsMode || 'speech'} onChange={e => updateModel(m.id, { ttsMode: e.target.value as CatalogModel['ttsMode'] })}><option value="speech">Audio Speech</option><option value="chat-audio">Chat Completions 音频输出</option></select></label>}
          {m.capabilities.includes('tts') && <label className="block text-xs text-text-secondary space-y-1.5">默认音色 ID<input className={field} value={m.ttsVoice || ''} placeholder={m.ttsMode === 'chat-audio' ? 'mimo_default' : 'alloy'} onChange={e => updateModel(m.id, { ttsVoice: e.target.value || null })} /><span>按服务商提供的音色 ID 填写；修改后需重新测试。</span></label>}
          <p className="text-xs text-text-muted">能力声明不等于验证通过。测试会向所选服务商发送短请求，可能产生费用；图片理解需要 2 次调用。</p>
          {(m.capabilities.includes('audio') || m.capabilities.includes('video')) && <p className="text-xs text-amber-700 dark:text-amber-300">音频理解和视频理解目前不能验证，附件只提供元数据，不支持真实转写或视频内容理解。勾选不会启用这些能力。</p>}
          <div className="flex flex-wrap gap-3 items-center"><label className="text-xs text-text-secondary flex gap-2"><input type="checkbox" checked={m.enabled} onChange={e => updateModel(m.id, { enabled: e.target.checked })} />启用</label>{testedCapabilities.map(cap => probeButton(m, cap))}<button className={`${secondary} ml-auto`} onClick={() => change({ ...draft, models: draft.models.filter(item => item.id !== m.id), defaults: { chat: draft.defaults.chat === m.id ? null : draft.defaults.chat, vision: draft.defaults.vision === m.id ? null : draft.defaults.vision, tts: draft.defaults.tts === m.id ? null : draft.defaults.tts } })}>移除模型</button></div>
          {testedCapabilities.map(cap => {
            const key = probeKey(m.id, cap), probe = probes[key];
            if (!probe) return null;
            return <div key={key} className="rounded-xl bg-bg-surface2 p-3 space-y-2 text-xs text-text-secondary" aria-label={`${capabilityLabels[cap]}测试结果`}>
              <p role={probe.status === 'failed' ? 'alert' : 'status'}>{capabilityLabels[cap]}：{probe.pending ? '正在测试，请勿重复提交。' : probeUnresolved(probe) ? '结果待核验。仅查询原请求，不会自动重发付费测试。' : (probe.stale || probe.catalogRevision !== catalog?.revision) ? '配置已变化，本次结果不能验证当前配置。请保存并重新测试。' : probe.status === 'succeeded' && probe.healthy ? `测试通过${probe.responseTime == null ? '' : ` · ${probe.responseTime} ms`}。` : probe.status === 'failed' ? `测试失败：${probe.error || '请检查地址、密钥、模型 ID 与能力声明。'}` : '结果待核验。仅查询原请求，不会自动重发付费测试。'}</p>
              {probe.possibleCharge && <p>本次请求可能已产生服务商费用，请核对用量。</p>}
              <p className="break-all">请求号：{probe.requestId}</p>
              {probe.queryError && <p role="alert">{probe.queryError}</p>}
              {probe.notFound && <div className="space-y-2"><p>明确补交同一个请求号：若服务端尚未收到原请求，将开始测试，可能产生费用；已收到的请求不会再次执行。</p><button className={secondary} disabled={saving || dirty || probe.pending || probe.checking || probe.catalogRevision !== catalog?.revision} onClick={() => void resubmitProbe(key)}>重新提交原测试请求</button>{probe.catalogRevision !== catalog?.revision && <p>配置版本已变化，不能补交原测试。请继续查询原请求状态。</p>}</div>}
              {probeUnresolved(probe) && <button className={secondary} disabled={probe.pending || probe.checking} onClick={() => void queryProbe(key)}>{probe.checking ? '正在核验…' : '查询原请求状态'}</button>}
            </div>;
          })}
        </div>
      </details>)}
    </div>
    <div className="rounded-2xl border border-border p-4 space-y-3">
      <h3 className="font-medium text-sm text-text-primary">默认模型</h3>
      <p className="text-xs text-text-secondary">自动选择只会使用已验证模型。明确指定的模型若未就绪或未通过对应测试，请求会停止，不会偷偷改用其他模型；可测试该模型或改回自动选择。</p>
      <div className="grid sm:grid-cols-3 gap-3">{testedCapabilities.map(cap => {
        const chosen = draft.models.find(m => m.id === draft.defaults[cap]);
        const available = draft.models.filter(m => m.enabled && m.capabilities.includes(cap));
        const unavailable = draft.defaults[cap] && (!chosen?.enabled || !chosen.ready || !chosen.capabilities.includes(cap) || !chosen.verifiedCapabilities?.includes(cap) || !draft.providers.find(p => p.id === chosen.providerId)?.enabled);
        return <div className="space-y-2" key={cap}>
          <label className="block text-xs text-text-secondary space-y-1.5">{capabilityLabels[cap]}
            <select className={field} value={draft.defaults[cap] || ''} onChange={e => change({ ...draft, defaults: { ...draft.defaults, [cap]: e.target.value || null } })}>
              <option value="">自动选择已验证模型</option>
              {draft.defaults[cap] && !available.some(m => m.id === draft.defaults[cap]) && <option value={draft.defaults[cap]!}>{chosen?.name || '原模型'}（不可用）</option>}
              {available.map(m => <option value={m.id} key={m.id}>{m.name}{m.ready && m.verifiedCapabilities?.includes(cap) ? '' : '（待验证）'}</option>)}
            </select>
          </label>
          {unavailable && <p className="text-xs text-amber-700 dark:text-amber-300">指定模型未通过当前能力验证，保存后仍会阻止请求。{chosen && <button className={`${secondary} mt-2`} onClick={() => viewModel(chosen)}>查看并测试{capabilityLabels[cap]}</button>}</p>}
        </div>;
      })}</div>
    </div>
    </fieldset>
    <div className="sticky bottom-0 bg-bg-primary/95 backdrop-blur py-3 space-y-2 border-t border-border">
      {loadError && <p role="alert" className="text-sm text-red-500">目录同步失败：{loadError} <button className={secondary} disabled={loading} onClick={() => void load()}>重新读取目录</button></p>}
      {saveError && <p role="alert" className="text-sm text-red-500">保存失败：{saveError}。你的草稿仍保留。</p>}
      {conflict && <div className="text-xs text-text-secondary space-y-2"><p>请先核对最新配置。合并会保留未修改的远端字段；同一字段冲突时保留你的值，检查后再保存。仍被使用的模型需要先更换引用，或改为禁用。</p><button className={secondary} disabled={saving || loading} onClick={() => void rebaseDraft()}>合并最新配置，保留我的修改</button></div>}
      {notice && <p role="status" className="text-sm text-text-secondary">{notice}</p>}
      <div className="flex flex-wrap gap-2 items-center"><button className="rounded-xl bg-accent text-white px-5 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50" disabled={saving || !dirty || conflict} onClick={() => void persist()}>{saving ? '正在保存…' : '保存并应用'}</button>{dirty && <button className={secondary} disabled={saving} onClick={discardDraft}>放弃修改</button>}<span role="status" className="text-xs text-text-muted">{saving ? '正在保存此版本，编辑暂时锁定' : dirty ? '有未保存修改，保存后可测试' : '当前配置已保存'}</span></div>
    </div>
  </section>;
}
