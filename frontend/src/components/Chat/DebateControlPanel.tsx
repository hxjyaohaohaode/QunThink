import { useEffect, useMemo, useState } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { AI_AVATAR_LETTERS, AI_COLORS, AI_NAMES, DebateRole } from '../../types';
import { useToast } from '../Common';

interface DebateControlPanelProps {
  groupId: string;
  isOpen: boolean;
  onClose: () => void;
}

type DebateRoleSelection = DebateRole | 'auto';

function getAiName(aiId: string, personas: Record<string, { name?: string; color?: string; avatar_url?: string | null }>) {
  return personas[aiId]?.name || AI_NAMES[aiId] || aiId;
}

export function DebateControlPanel({ groupId, isOpen, onClose }: DebateControlPanelProps) {
  const {
    groups,
    currentGroup,
    debateStatus,
    startFormalDebate,
    stopFormalDebate,
    getFormalDebateStatus,
    updateDebateStatus,
  } = useGroupsStore();
  const { personas } = usePersonasStore();
  const { showToast, Toast } = useToast();

  const group = groups.find((item) => item.id === groupId) || currentGroup;
  const currentStatus = debateStatus.get(groupId);
  const isRunning = currentStatus?.isRunning === true || currentStatus?.status === 'running';

  const [topic, setTopic] = useState('');
  const [debateLevel, setDebateLevel] = useState<number>(2);
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([]);
  const [manualRoles, setManualRoles] = useState<Record<string, DebateRoleSelection>>({});
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedParticipants(group?.ai_members ? [...group.ai_members] : []);
  }, [isOpen, group?.ai_members]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !groupId) return;
    setRefreshing(true);
    getFormalDebateStatus(groupId).finally(() => setRefreshing(false));
  }, [getFormalDebateStatus, groupId, isOpen]);

  const rolePreview = useMemo(() => {
    const proponents: string[] = [];
    const opponents: string[] = [];
    const audience: string[] = [];
    let judge: string | null = null;
    const auto = selectedParticipants.filter((id) => !manualRoles[id] || manualRoles[id] === 'auto');

    for (const participantId of selectedParticipants) {
      const role = manualRoles[participantId];
      if (role === 'proponent') proponents.push(participantId);
      if (role === 'opponent') opponents.push(participantId);
      if (role === 'audience') audience.push(participantId);
      if (role === 'judge' && !judge) judge = participantId;
    }

    const remaining = [...auto];
    if (!judge && remaining.length >= 3) {
      judge = remaining.pop() || null;
    }

    remaining.forEach((participantId, index) => {
      if (index % 2 === 0) proponents.push(participantId);
      else opponents.push(participantId);
    });

    return { proponents, opponents, audience, judge };
  }, [manualRoles, selectedParticipants]);

  if (!isOpen) return null;

  const refreshStatus = async () => {
    setRefreshing(true);
    try {
      await getFormalDebateStatus(groupId);
    } finally {
      setRefreshing(false);
    }
  };

  const toggleParticipant = (participantId: string) => {
    setSelectedParticipants((prev) => {
      if (prev.includes(participantId)) {
        const next = prev.filter((id) => id !== participantId);
        setManualRoles((current) => {
          const copy = { ...current };
          delete copy[participantId];
          return copy;
        });
        return next;
      }
      return [...prev, participantId];
    });
  };

  const handleStart = async () => {
    if (!topic.trim()) {
      showToast({ message: '请输入辩题。', type: 'error' });
      return;
    }
    if (selectedParticipants.length < 2) {
      showToast({ message: '请至少选择两位 AI 参与者。', type: 'error' });
      return;
    }

    const rolePreferences = Object.fromEntries(
      Object.entries(manualRoles).filter(([, role]) => role && role !== 'auto')
    );

    setStarting(true);
    try {
      await startFormalDebate(groupId, topic.trim(), rolePreferences, debateLevel, selectedParticipants);
      updateDebateStatus(groupId, {
        ...currentStatus,
        isRunning: true,
        status: 'running',
        topic: topic.trim(),
        debateLevel,
        selectedParticipants,
      });
      showToast({ message: '辩论已开始。', type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '开始辩论失败。';
      showToast({ message, type: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await stopFormalDebate(groupId);
      updateDebateStatus(groupId, { ...currentStatus, isRunning: false, status: 'stopped' });
      showToast({ message: '辩论已停止。', type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '停止辩论失败。';
      showToast({ message, type: 'error' });
    } finally {
      setStopping(false);
    }
  };

  const handleAudienceComment = async () => {
    if (rolePreview.audience.length === 0) {
      showToast({ message: '当前没有可触发的观众成员。', type: 'warning' });
      return;
    }
    try {
      await useGroupsStore.getState().triggerAudienceComment(groupId, rolePreview.audience);
      showToast({ message: '已触发观众评论。', type: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '触发观众评论失败。';
      showToast({ message, type: 'error' });
    }
  };

  const renderParticipant = (participantId: string) => {
    const name = getAiName(participantId, personas);
    const color = personas[participantId]?.color || AI_COLORS[participantId] || '#6b7280';
    const letter = AI_AVATAR_LETTERS[participantId] || name[0]?.toUpperCase() || '?';
    const active = selectedParticipants.includes(participantId);

    return (
      <div key={participantId} className="rounded-xl border border-border-subtle bg-bg-surface2 p-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => toggleParticipant(participantId)}
            className={`h-5 w-5 rounded border ${active ? 'border-accent bg-accent' : 'border-border-subtle bg-transparent'}`}
            aria-label={`Toggle ${name}`}
          />
          <div className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ backgroundColor: color }}>
            {letter}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-primary">{name}</div>
            <div className="text-xs text-text-muted">{participantId}</div>
          </div>
          <select
            value={manualRoles[participantId] || 'auto'}
            onChange={(event) => setManualRoles((prev) => ({ ...prev, [participantId]: event.target.value as DebateRoleSelection }))}
            className="rounded-lg border border-border-subtle bg-bg-surface px-2 py-1 text-xs text-text-primary"
            disabled={!active}
          >
            <option value="auto">自动分配</option>
            <option value="proponent">正方</option>
            <option value="opponent">反方</option>
            <option value="judge">评审</option>
            <option value="audience">观众</option>
          </select>
        </div>
      </div>
    );
  };

  const participantPool = group?.ai_members || [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 md:items-center" onClick={(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); } }}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-t-2xl border border-border-subtle bg-bg-surface shadow-2xl md:rounded-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-center pt-2 md:hidden">
          <div className="w-10 h-1 rounded-full bg-border-subtle" />
        </div>
        <div className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-text-primary">正式辩论</h3>
            <p className="text-sm text-text-muted">配置辩题、参与成员和角色偏好。</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-surface2 hover:text-text-primary">
            关闭
          </button>
        </div>

        <div className="grid gap-6 overflow-y-auto p-6 md:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-5">
            <section className="rounded-xl border border-border-subtle bg-bg-surface2 p-4">
              <label className="mb-2 block text-sm font-medium text-text-primary">辩题</label>
              <textarea
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                rows={3}
                placeholder="请输入辩题"
                className="w-full rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              />
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-sm text-text-primary">
                  <span>辩论强度</span>
                  <span className="text-text-muted">{debateLevel}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={1}
                  value={debateLevel}
                  onChange={(event) => setDebateLevel(Number(event.target.value))}
                  className="w-full"
                />
              </div>
            </section>

            <section className="rounded-xl border border-border-subtle bg-bg-surface2 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-text-primary">参与成员</h4>
                  <p className="text-xs text-text-muted">请至少选择两位 AI 成员。</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setSelectedParticipants([...participantPool])} className="rounded-lg border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
                    全选
                  </button>
                  <button onClick={() => { setSelectedParticipants([]); setManualRoles({}); }} className="rounded-lg border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
                    清空
                  </button>
                </div>
              </div>
              <div className="space-y-3">
                {participantPool.length > 0 ? participantPool.map(renderParticipant) : <p className="text-sm text-text-muted">当前群聊没有 AI 成员。</p>}
              </div>
            </section>
          </div>

          <div className="space-y-5">
            <section className="rounded-xl border border-border-subtle bg-bg-surface2 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h4 className="text-sm font-medium text-text-primary">当前状态</h4>
                <button onClick={refreshStatus} className="rounded-lg border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:text-text-primary">
                  {refreshing ? '刷新中...' : '刷新'}
                </button>
              </div>
              <div className="space-y-2 text-sm text-text-secondary">
                <div className="flex justify-between"><span>运行中</span><span>{isRunning ? '是' : '否'}</span></div>
                <div className="flex justify-between"><span>辩题</span><span className="max-w-[180px] truncate">{currentStatus?.topic || topic || '-'}</span></div>
                <div className="flex justify-between"><span>阶段</span><span>{currentStatus?.phaseName || currentStatus?.currentPhase || '-'}</span></div>
                <div className="flex justify-between"><span>已选成员</span><span>{selectedParticipants.length}</span></div>
              </div>
            </section>

            <section className="rounded-xl border border-border-subtle bg-bg-surface2 p-4">
              <h4 className="mb-3 text-sm font-medium text-text-primary">角色预览</h4>
              <div className="space-y-3 text-sm text-text-secondary">
                <div>
                  <div className="font-medium text-text-primary">正方</div>
                  <div>{rolePreview.proponents.map((id) => getAiName(id, personas)).join(', ') || '-'}</div>
                </div>
                <div>
                  <div className="font-medium text-text-primary">反方</div>
                  <div>{rolePreview.opponents.map((id) => getAiName(id, personas)).join(', ') || '-'}</div>
                </div>
                <div>
                  <div className="font-medium text-text-primary">评审</div>
                  <div>{rolePreview.judge ? getAiName(rolePreview.judge, personas) : '-'}</div>
                </div>
                <div>
                  <div className="font-medium text-text-primary">观众</div>
                  <div>{rolePreview.audience.map((id) => getAiName(id, personas)).join(', ') || '-'}</div>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-border-subtle bg-bg-surface2 p-4">
              <div className="grid gap-3">
                <button onClick={handleStart} disabled={starting || stopping} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {starting ? '启动中...' : '开始辩论'}
                </button>
                <button onClick={handleStop} disabled={starting || stopping || !isRunning} className="rounded-xl border border-border-subtle px-4 py-2 text-sm font-medium text-text-primary disabled:opacity-50">
                  {stopping ? '停止中...' : '停止辩论'}
                </button>
                <button onClick={handleAudienceComment} disabled={rolePreview.audience.length === 0} className="rounded-xl border border-border-subtle px-4 py-2 text-sm font-medium text-text-primary disabled:opacity-50">
                  触发观众评论
                </button>
              </div>
            </section>
          </div>
        </div>
        {Toast}
      </div>
    </div>
  );
}
