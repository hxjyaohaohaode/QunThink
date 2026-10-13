import React, { useEffect } from 'react';
import { useAgentsStore } from '../../stores/agentsStore';
import { Agent } from '../../types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { useConfirm, useToast } from '../Common';
import { avatarBackgroundImageStyle } from '../Common/Avatar';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

interface AgentsPageProps {
  onBack?: () => void;
  onOpenCreate: () => void;
  onSelectAgent: (agentId: string) => void;
}

const AGENT_COLORS = [
  '#f97316', '#8b5cf6', '#06b6d4', '#10b981',
  '#ef4444', '#f59e0b', '#3b82f6', '#ec4899',
];

function getAgentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

export function AgentsPage({ onBack, onOpenCreate, onSelectAgent }: AgentsPageProps) {
  const agents = useAgentsStore(s => s.agents);
  const loading = useAgentsStore(s => s.loading);
  const error = useAgentsStore(s => s.error);
  const fetchAgents = useAgentsStore(s => s.fetchAgents);
  const deleteAgent = useAgentsStore(s => s.deleteAgent);
  const [query, setQuery] = React.useState('');
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const { confirm, ConfirmModal } = useConfirm();
  const { showToast, Toast } = useToast();
  useEffect(() => { void fetchAgents(); }, [fetchAgents]);
  const visible = agents.filter(agent => (agent.name + ' ' + agent.description).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  async function remove(agent: Agent) {
    if (deleting || !await confirm({ title: '删除智能体', description: '确定要删除「' + agent.name + '」及其会话吗？此操作无法恢复。', danger: true })) return;
    setDeleting(agent.id);
    try { await deleteAgent(agent.id); showToast({ message: '智能体已删除', type: 'success' }); }
    catch { showToast({ message: '删除未完成，请检查连接后重试', type: 'error' }); }
    finally { setDeleting(null); }
  }
  return <div className="agent-directory h-full flex flex-col min-h-0 bg-bg-primary" data-testid="agent-directory">
    <header className="page-toolbar">
      <div className="flex items-center gap-3 min-w-0">{onBack && <button className="workspace-button" aria-label="返回" onClick={onBack}>←</button>}<div><h1 className="text-xl font-semibold">智能体</h1></div></div>
      <button className="workspace-primary shrink-0" onClick={onOpenCreate}>添加智能体</button>
    </header>
    <div className="flex-1 min-h-0 overflow-y-auto pb-safe"><div className="page-content">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <p role="status" className="text-sm text-text-secondary">{loading ? '正在更新智能体…' : '共 ' + agents.length + ' 个智能体'}</p>
        <div className="flex items-center gap-2 min-w-0"><input aria-label="搜索智能体" placeholder="搜索名称或用途" className="workspace-input min-w-0" value={query} onChange={event => setQuery(event.target.value)} /><button className="workspace-button" disabled={loading} onClick={() => void fetchAgents()}>刷新</button></div>
      </div>
      {error && <div role="alert" className="workspace-error mb-4">智能体未能完整加载，请检查连接后点击刷新重试。</div>}
      {loading && !agents.length ? <div className="workspace-empty" role="status">正在加载智能体…</div> : !visible.length ? <div className="workspace-empty"><h2 className="text-base font-semibold">{query ? '没有符合条件的智能体' : error ? '暂时无法获取智能体' : '创建你的第一个智能体'}</h2><p className="text-sm text-text-secondary mt-2">{query ? '试试名称或描述中的其他关键词。' : '设定角色与任务用途，连接模型后开始对话。'}</p>{query && <button className="workspace-button mt-4" onClick={() => setQuery('')}>清除筛选</button>}</div> :
        <div className="agent-grid">{visible.map(agent => <article key={agent.id} className="agent-card">
          <button onClick={() => onSelectAgent(agent.id)} className="flex gap-3 items-center w-full text-left rounded-lg" aria-label={'打开智能体：' + agent.name}>
            <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white text-lg font-semibold shrink-0" style={{ backgroundColor: getAgentColor(agent.name), backgroundImage: avatarBackgroundImageStyle(agent.avatar_url), backgroundSize: 'cover', backgroundPosition: 'center' }}>{!agent.avatar_url && agent.name.charAt(0)}</span>
            <span className="min-w-0"><span role="heading" aria-level={2} className="font-semibold text-sm break-words block">{agent.name}</span><span className="text-xs text-text-muted block mt-1">{dayjs(agent.created_at).format('YYYY-MM-DD')}</span></span>
          </button>
          <p className="text-sm text-text-secondary mt-4 line-clamp-3 leading-relaxed break-words">{agent.description}</p>
          <details className="text-xs text-text-secondary mt-3"><summary className="cursor-pointer py-2">查看完整设定</summary><p className="whitespace-pre-wrap break-words leading-relaxed">{agent.description}</p>{agent.opening_message && <p className="whitespace-pre-wrap break-words leading-relaxed mt-3">开场白：{agent.opening_message}</p>}</details>
          <div className="flex flex-wrap justify-between items-center gap-2 mt-4 pt-3 border-t border-border-subtle"><button className="workspace-button" onClick={() => onSelectAgent(agent.id)}>开始对话</button><button className="workspace-button text-red-500" aria-label={'删除智能体：' + agent.name} disabled={!!deleting} onClick={() => void remove(agent)}>{deleting === agent.id ? '删除中…' : '删除'}</button></div>
        </article>)}</div>}
    </div></div>{ConfirmModal}{Toast}
  </div>;
}
