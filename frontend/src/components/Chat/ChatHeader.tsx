import { useState } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { AI_NAMES, AI_STATUS_COLORS, AI_AVATAR_LETTERS } from '../../types';
import { api } from '../../services/api';

const AI_LIST = ['deepseek', 'deepseek_reasoner', 'glm', 'mimo', 'qwen'];

export function ChatHeader() {
  const { currentGroup, toggleDebateMode, setDebateLevel, fetchGroups } = useGroupsStore();
  const { personas } = usePersonasStore();
  const [showAddMember, setShowAddMember] = useState(false);
  const [adding, setAdding] = useState(false);

  if (!currentGroup) {
    return (
      <div className="h-14 bg-bg-surface border-b border-gray-200 flex items-center justify-center">
        <span className="text-text-muted">选择一个群组开始聊天</span>
      </div>
    );
  }

  // 私聊不显示添加成员按钮
  const isPrivateChat = currentGroup.is_private === true;
  const availableAIs = AI_LIST.filter(ai => !currentGroup.ai_members.includes(ai));

  const handleAddMember = async (aiId: string) => {
    setAdding(true);
    try {
      const result = await api.addGroupMember(currentGroup.id, aiId);
      await fetchGroups();
      
      if (result.systemMessage) {
        const messagesStore = (await import('../../stores/messagesStore')).useMessagesStoreInternal;
        messagesStore.getState().addMessage(currentGroup.id, {
          id: result.systemMessage.id,
          group_id: currentGroup.id,
          sender_type: 'system',
          sender_id: 'system',
          content: result.systemMessage.content,
          content_type: 'system',
          created_at: result.systemMessage.created_at,
          metadata: result.systemMessage.metadata
        });
      }
      
      setShowAddMember(false);
    } catch (error) {
      console.error('添加成员失败:', error);
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <div className="h-14 bg-bg-surface border-b border-gray-200 flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <h2 className="text-subtitle font-semibold text-text-primary">
            {currentGroup.name}
          </h2>
          <span className="text-caption text-text-muted">
            {currentGroup.ai_members.length} 位 AI 成员
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* 添加成员按钮 */}
          {!isPrivateChat && availableAIs.length > 0 && (
            <button
              onClick={() => setShowAddMember(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <span>➕</span>
              <span>添加成员</span>
            </button>
          )}

          {/* 辩论模式 - 仅群聊显示 */}
          {!isPrivateChat && (
            <div className="flex items-center gap-2">
              <span className="text-caption text-text-secondary">辩论模式</span>
              <button
                onClick={() => toggleDebateMode(currentGroup.id)}
                className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${
                  currentGroup.debate_mode ? 'bg-success' : 'bg-bg-surface3'
                }`}
              >
                <span
                  className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
                    currentGroup.debate_mode ? 'left-7' : 'left-1'
                  }`}
                />
              </button>

              {currentGroup.debate_mode && (
                <select
                  value={currentGroup.debate_level}
                  onChange={(e) => setDebateLevel(currentGroup.id, parseInt(e.target.value))}
                  className="bg-bg-surface2 text-caption text-text-secondary rounded-button px-2 py-1 border border-gray-200 focus:outline-none focus:border-user/50"
                >
                  <option value={1}>温和</option>
                  <option value={2}>标准</option>
                  <option value={3}>激烈</option>
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 添加成员弹窗 */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-80 shadow-xl animate-fade-in">
            <h3 className="text-lg font-semibold text-text-primary mb-4">添加AI成员</h3>

            <div className="space-y-2 max-h-60 overflow-y-auto">
              {availableAIs.map((aiId) => {
                const customPersona = personas[aiId];
                const avatarColor = customPersona?.color || AI_STATUS_COLORS[aiId];
                const avatarUrl = customPersona?.avatar_url;
                const avatarLetter = AI_AVATAR_LETTERS[aiId] || AI_NAMES[aiId]?.[0] || aiId[0];
                
                return (
                  <button
                    key={aiId}
                    onClick={() => handleAddMember(aiId)}
                    disabled={adding}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors text-left disabled:opacity-50"
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
                    <span className="text-sm text-text-primary">{AI_NAMES[aiId]}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-end mt-4">
              <button
                onClick={() => setShowAddMember(false)}
                className="px-4 py-2 border border-gray-200 rounded-lg text-text-secondary hover:bg-gray-50 transition-all duration-200"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
