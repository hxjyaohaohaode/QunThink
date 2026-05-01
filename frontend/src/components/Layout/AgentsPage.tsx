import React, { useEffect } from 'react';
import { useAgentsStore } from '../../stores/agentsStore';
import { Agent } from '../../types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { useConfirm, useToast } from '../Common';

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
  const { agents, fetchAgents, deleteAgent } = useAgentsStore();
  const { confirm, ConfirmModal } = useConfirm();
  const { showToast, Toast } = useToast();

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleDelete = async (e: React.MouseEvent, agent: Agent) => {
    e.stopPropagation();
    const confirmed = await confirm({
      title: '删除智能体',
      description: `确定要删除「${agent.name}」吗？此操作无法恢复。`,
      danger: true,
    });
    if (confirmed) {
      try {
        await deleteAgent(agent.id);
        showToast({ message: '智能体已删除', type: 'success' });
      } catch {
        showToast({ message: '删除失败', type: 'error' });
      }
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="flex items-center gap-3 px-4 py-3 bg-bg-surface border-b border-border-subtle">
        {onBack && (
          <button
            onClick={onBack}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-bg-surface2 transition-colors"
          >
            <svg className="w-5 h-5 text-text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
        <h1 className="text-lg font-semibold text-text-primary flex-1">智能体</h1>
      </div>

      <div className="flex-1 overflow-y-auto pb-safe">
        <div className="p-4">
          <button
            onClick={onOpenCreate}
            className="w-full h-32 md:h-40 rounded-2xl border-2 border-dashed border-border-subtle bg-bg-surface hover:border-accent/50 hover:bg-bg-surface2 transition-all duration-300 flex flex-col items-center justify-center gap-3 group"
          >
            <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center group-hover:bg-accent/20 transition-colors">
              <svg className="w-8 h-8 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </div>
            <span className="text-sm text-text-secondary group-hover:text-accent transition-colors">
              添加智能体
            </span>
          </button>
        </div>

        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12">
            <p className="text-text-muted text-sm">
              点击上方按钮创建你的第一个智能体
            </p>
          </div>
        ) : (
          <div className="px-4 pb-4">
            <div className="waterfall-container" style={{ columnCount: 2, columnGap: '1rem' }}>
              {agents.map((agent) => {
                const color = getAgentColor(agent.name);
                return (
                  <div
                    key={agent.id}
                    onClick={() => onSelectAgent(agent.id)}
                    className="waterfall-item relative bg-bg-surface border border-border-subtle rounded-xl p-4 cursor-pointer hover:border-accent/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 group"
                    style={{ breakInside: 'avoid', marginBottom: '1rem' }}
                  >
                    <button
                      onClick={(e) => handleDelete(e, agent)}
                      className="absolute top-2 right-2 w-6 h-6 rounded-full bg-bg-surface2/80 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500/20 transition-all"
                    >
                      <svg className="w-3.5 h-3.5 text-text-muted group-hover:text-red-500 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>

                    <div className="flex items-start gap-3">
                      <div
                        className="w-12 h-12 rounded-full flex items-center justify-center text-white text-lg font-semibold flex-shrink-0 shadow-sm overflow-hidden"
                        style={{
                          backgroundColor: agent.avatar_url ? 'transparent' : color,
                          backgroundImage: agent.avatar_url ? `url(${agent.avatar_url})` : 'none',
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        }}
                      >
                        {!agent.avatar_url && agent.name.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary">
                          {agent.name}
                        </h3>
                        <p className="text-xs text-text-muted mt-0.5">
                          {dayjs(agent.created_at).format('YYYY-MM-DD HH:mm')}
                        </p>
                      </div>
                    </div>

                    <p className="text-xs text-text-secondary mt-3 line-clamp-3 leading-relaxed">
                      {agent.description}
                    </p>

                    {agent.opening_message && (
                      <div className="mt-3 pt-3 border-t border-border-subtle">
                        <p className="text-xs text-text-primary line-clamp-2 italic opacity-80">
                          "{agent.opening_message}"
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {ConfirmModal}
      {Toast}
    </div>
  );
}
