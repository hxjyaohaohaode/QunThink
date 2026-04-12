import React, { useState } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { AI_NAMES, AI_STATUS_COLORS, AI_AVATAR_LETTERS } from '../../types';
import { AIPersonaEditor } from './AIPersonaEditor';
import { UserProfileEditor } from './UserProfileEditor';

const AI_LIST = ['deepseek', 'deepseek_reasoner', 'glm', 'mimo', 'qwen'];

export function Sidebar() {
  const { groups, currentGroup, selectGroup, fetchGroups, createGroup, deleteGroup, pinGroup, getOrCreatePrivateChat } = useGroupsStore();
  const { personas } = usePersonasStore();
  const [showNewGroupModal, setShowNewGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [editingAiId, setEditingAiId] = useState<string | null>(null);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [selectedAiMembers, setSelectedAiMembers] = useState<string[]>(AI_LIST);

  React.useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  // 分离置顶和非置顶群组
  const pinnedGroups = groups.filter(g => g.pinned || g.is_private);
  const unpinnedGroups = groups.filter(g => !g.pinned && !g.is_private);

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    if (selectedAiMembers.length < 2) return;

    try {
      await createGroup(newGroupName, newGroupDesc || '新的对话', selectedAiMembers);
      setShowNewGroupModal(false);
      setNewGroupName('');
      setNewGroupDesc('');
      setSelectedAiMembers(AI_LIST);
    } catch (error) {
      console.error('创建对话失败:', error);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteGroup(groupId);
      setShowDeleteConfirm(null);
    } catch (error) {
      console.error('删除对话失败:', error);
    }
  };

  const handlePinGroup = async (groupId: string, pinned: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await pinGroup(groupId, pinned);
    } catch (error) {
      console.error('置顶操作失败:', error);
    }
  };

  const handleStartPrivateChat = async (aiId: string) => {
    try {
      await getOrCreatePrivateChat(aiId);
    } catch (error) {
      console.error('创建私聊失败:', error);
    }
  };

  const toggleAiMember = (aiId: string) => {
    setSelectedAiMembers(prev => {
      if (prev.includes(aiId)) {
        if (prev.length <= 2) return prev;
        return prev.filter(id => id !== aiId);
      }
      return [...prev, aiId];
    });
  };

  return (
    <div className="w-64 h-full bg-bg-surface border-r border-gray-200 flex flex-col">
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-title font-bold text-text-primary">AI 群聊</h1>
            <p className="text-caption text-text-secondary mt-1">大模型辩论场</p>
          </div>
          <button
            onClick={() => setShowNewGroupModal(true)}
            className="w-8 h-8 rounded-full bg-user text-white flex items-center justify-center hover:opacity-90 transition-all duration-200 active:scale-95"
            title="新建对话"
          >
            +
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2" style={{ height: '480px' }}>
        {/* 置顶群组 */}
        {pinnedGroups.length > 0 && (
          <div className="mb-4">
            <h2 className="text-caption text-text-muted px-2 mb-2 uppercase tracking-wider flex items-center gap-1">
              <span>📌</span> 置顶
            </h2>
            <div className="space-y-1">
              {pinnedGroups.map((group) => (
                <div
                  key={group.id}
                  className={`group relative rounded-button transition-all duration-200 ${
                    currentGroup?.id === group.id
                      ? 'bg-bg-surface3'
                      : 'hover:bg-bg-surface2'
                  }`}
                >
                  <button
                    onClick={() => selectGroup(group.id)}
                    className="w-full text-left px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      {group.is_private && <span className="text-xs">🔒</span>}
                      <span className="font-medium text-body text-text-primary">{group.name}</span>
                    </div>
                    <div className="text-caption text-text-muted truncate mt-0.5">
                      {group.description}
                    </div>
                  </button>

                  {/* 置顶按钮 */}
                  <button
                    onClick={(e) => handlePinGroup(group.id, false, e)}
                    className="absolute right-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-gray-200 transition-all duration-200"
                    title="取消置顶"
                  >
                    📌
                  </button>

                  {/* 删除按钮 */}
                  {(group.type === 'custom' || group.type === 'private') && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowDeleteConfirm(group.id);
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-red-50 text-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-100 transition-all duration-200"
                      title="删除对话"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 群组 */}
        <div className="mb-4">
          <h2 className="text-caption text-text-muted px-2 mb-2 uppercase tracking-wider">群组</h2>
          <div className="space-y-1">
            {unpinnedGroups.map((group) => (
              <div
                key={group.id}
                className={`group relative rounded-button transition-all duration-200 ${
                  currentGroup?.id === group.id
                    ? 'bg-bg-surface3'
                    : 'hover:bg-bg-surface2'
                }`}
              >
                <button
                  onClick={() => selectGroup(group.id)}
                  className="w-full text-left px-3 py-2"
                >
                  <div className="font-medium text-body text-text-primary">{group.name}</div>
                  <div className="text-caption text-text-muted truncate mt-0.5">
                    {group.description}
                  </div>
                  {group.debate_mode && (
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-xs">⚔️</span>
                      <span className="text-caption text-warning">辩论模式</span>
                    </div>
                  )}
                </button>

                {/* 置顶按钮 */}
                <button
                  onClick={(e) => handlePinGroup(group.id, true, e)}
                  className="absolute right-8 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-gray-200 transition-all duration-200"
                  title="置顶"
                >
                  📌
                </button>

                {group.type === 'custom' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteConfirm(group.id);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-red-50 text-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-100 transition-all duration-200"
                    title="删除对话"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-gray-200">
        <h2 className="text-caption text-text-muted px-2 mb-2 uppercase tracking-wider text-center" style={{ height: '20px' }}>在线成员</h2>
        <div className="space-y-2">
          <div
            className="flex items-center gap-2 px-2 cursor-pointer hover:bg-bg-surface2 rounded-lg py-1 transition-all duration-200"
            onClick={() => setShowProfileEditor(true)}
          >
            <span
              className="w-2 h-2 rounded-full bg-user"
              style={{ backgroundColor: AI_STATUS_COLORS.user }}
            />
            <span className="text-caption text-text-primary">我</span>
          </div>
          {AI_LIST.map((aiId) => {
            const customPersona = personas[aiId];
            const avatarColor = customPersona?.color || AI_STATUS_COLORS[aiId];
            const avatarUrl = customPersona?.avatar_url;
            const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];
            
            return (
              <div
                key={aiId}
                className="flex items-center gap-2 px-2 cursor-pointer hover:bg-bg-surface2 rounded-lg py-1 transition-all duration-200 group"
                onClick={() => handleStartPrivateChat(aiId)}
                title={`点击与 ${AI_NAMES[aiId]} 私聊`}
              >
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-semibold overflow-hidden flex-shrink-0"
                  style={{ 
                    backgroundColor: avatarUrl ? 'transparent' : avatarColor,
                    backgroundImage: avatarUrl ? `url(${avatarUrl})` : 'none',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  }}
                >
                  {!avatarUrl && avatarLetter.toUpperCase()}
                </div>
                <span className="text-caption text-text-secondary flex-1">
                  {AI_NAMES[aiId]}
                </span>
                <span className="text-xs text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  私聊
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingAiId(aiId);
                  }}
                  className="w-5 h-5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
                  title="编辑AI设置"
                >
                  ⚙️
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {showNewGroupModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-80 shadow-xl animate-fade-in">
            <h3 className="text-lg font-semibold text-text-primary mb-4">新建对话</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-caption text-text-secondary mb-1">对话名称</label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="输入对话名称..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-caption text-text-secondary mb-1">描述（可选）</label>
                <input
                  type="text"
                  value={newGroupDesc}
                  onChange={(e) => setNewGroupDesc(e.target.value)}
                  placeholder="输入描述..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20"
                />
              </div>

              <div>
                <label className="block text-caption text-text-secondary mb-1">
                  选择AI成员 <span className="text-gray-400">（至少2个）</span>
                </label>
                <div className="space-y-2">
                  {AI_LIST.map((aiId) => {
                    const customPersona = personas[aiId];
                    const avatarColor = customPersona?.color || AI_STATUS_COLORS[aiId];
                    const avatarUrl = customPersona?.avatar_url;
                    const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];
                    
                    return (
                      <label
                        key={aiId}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedAiMembers.includes(aiId)}
                          onChange={() => toggleAiMember(aiId)}
                          className="w-4 h-4 rounded border-gray-300 text-green-500 focus:ring-green-400"
                        />
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-semibold overflow-hidden flex-shrink-0"
                          style={{ 
                            backgroundColor: avatarUrl ? 'transparent' : avatarColor,
                            backgroundImage: avatarUrl ? `url(${avatarUrl})` : 'none',
                            backgroundSize: 'cover',
                            backgroundPosition: 'center'
                          }}
                        >
                          {!avatarUrl && avatarLetter.toUpperCase()}
                        </div>
                        <span className="text-sm text-text-primary">{AI_NAMES[aiId]}</span>
                      </label>
                    );
                  })}
                </div>
                {selectedAiMembers.length < 2 && (
                  <p className="text-xs text-red-500 mt-1">请至少选择2个AI成员</p>
                )}
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <button
                onClick={() => {
                  setShowNewGroupModal(false);
                  setSelectedAiMembers(AI_LIST);
                }}
                className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-text-secondary hover:bg-gray-50 transition-all duration-200"
              >
                取消
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={!newGroupName.trim() || selectedAiMembers.length < 2}
                className="flex-1 px-4 py-2 bg-user text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-80 shadow-xl animate-fade-in">
            <h3 className="text-lg font-semibold text-text-primary mb-2">确认删除</h3>
            <p className="text-body text-text-secondary mb-6">
              确定要删除这个对话吗？此操作不可撤销。
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(null)}
                className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-text-secondary hover:bg-gray-50 transition-all duration-200"
              >
                取消
              </button>
              <button
                onClick={() => handleDeleteGroup(showDeleteConfirm)}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-all duration-200"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {editingAiId && (
        <AIPersonaEditor
          aiId={editingAiId}
          isOpen={true}
          onClose={() => setEditingAiId(null)}
        />
      )}

      <UserProfileEditor
        isOpen={showProfileEditor}
        onClose={() => setShowProfileEditor(false)}
      />
    </div>
  );
}
