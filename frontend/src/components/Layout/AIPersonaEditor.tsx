import { useState, useEffect, useRef } from 'react';
import { usePersonasStore, PersonaConfig } from '../../stores/personasStore';
import { AI_NAMES, AI_STATUS_COLORS } from '../../types';

interface AIPersonaEditorProps {
  aiId: string;
  isOpen: boolean;
  onClose: () => void;
}

const defaultPersona: PersonaConfig = {
  name: '',
  style: '',
  replyStyle: '',
  personality: '',
  typicalPhrases: [],
  color: undefined,
  avatar_url: null
};

export function AIPersonaEditor({ aiId, isOpen, onClose }: AIPersonaEditorProps) {
  const { personas, fetchPersonas, updatePersona, resetPersona } = usePersonasStore();
  const [form, setForm] = useState<PersonaConfig>(defaultPersona);
  const [phrasesText, setPhrasesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      fetchPersonas();
    }
  }, [isOpen, fetchPersonas]);

  useEffect(() => {
    const persona = personas[aiId] || defaultPersona;
    setForm(persona);
    setPhrasesText(persona.typicalPhrases.join('\n'));
    setAvatarPreview(persona.avatar_url || null);
  }, [aiId, personas]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await updatePersona(aiId, {
        ...form,
        typicalPhrases: phrasesText.split('\n').filter(p => p.trim()),
        avatar_url: avatarPreview
      });
      onClose();
    } catch (error) {
      console.error('Failed to save persona:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await resetPersona(aiId);
      setAvatarPreview(null);
      onClose();
    } catch (error) {
      console.error('Failed to reset persona:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件');
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      alert('图片大小不能超过2MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setAvatarPreview(result);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAvatar = () => {
    setAvatarPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const defaultColor = AI_STATUS_COLORS[aiId] || '#6b7280';
  const currentColor = form.color || defaultColor;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-96 shadow-xl animate-fade-in max-h-[80vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-text-primary mb-4">
          编辑 {AI_NAMES[aiId] || aiId} 设置
        </h3>

        <div className="space-y-4">
          {/* 头像设置 */}
          <div className="border-b pb-4">
            <label className="block text-caption text-text-secondary mb-2">头像设置</label>
            
            <div className="flex items-center gap-4 mb-3">
              {/* 头像预览 */}
              <div 
                className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-lg overflow-hidden flex-shrink-0"
                style={{ 
                  backgroundColor: avatarPreview ? 'transparent' : currentColor,
                  backgroundImage: avatarPreview ? `url(${avatarPreview})` : 'none',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {!avatarPreview && (AI_NAMES[aiId]?.[0] || aiId[0]).toUpperCase()}
              </div>
              
              <div className="flex-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  上传图片
                </button>
                {avatarPreview && (
                  <button
                    onClick={handleRemoveAvatar}
                    className="ml-2 px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    移除
                  </button>
                )}
              </div>
            </div>

            {/* 颜色选择器 */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-600">头像颜色:</label>
              <input
                type="color"
                value={currentColor}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
                className="w-10 h-10 rounded cursor-pointer border border-gray-200"
              />
              <span className="text-sm text-gray-500">{currentColor}</span>
            </div>
          </div>

          <div>
            <label className="block text-caption text-text-secondary mb-1">昵称</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="输入昵称..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary mb-1">风格标签</label>
            <input
              type="text"
              value={form.style}
              onChange={(e) => setForm({ ...form, style: e.target.value })}
              placeholder="如：博学派、综合派..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary mb-1">回复方式</label>
            <input
              type="text"
              value={form.replyStyle}
              onChange={(e) => setForm({ ...form, replyStyle: e.target.value })}
              placeholder="如：横向联想、总结归纳..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary mb-1">性格描述</label>
            <input
              type="text"
              value={form.personality}
              onChange={(e) => setForm({ ...form, personality: e.target.value })}
              placeholder="描述AI的性格..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary mb-1">典型用语（每行一个）</label>
            <textarea
              value={phrasesText}
              onChange={(e) => setPhrasesText(e.target.value)}
              placeholder="每行输入一个典型用语..."
              rows={4}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 resize-none"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={handleReset}
            disabled={saving}
            className="px-4 py-2 border border-gray-200 rounded-lg text-text-secondary hover:bg-gray-50 transition-all duration-200 disabled:opacity-50"
          >
            重置
          </button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-200 rounded-lg text-text-secondary hover:bg-gray-50 transition-all duration-200"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-user text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all duration-200"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
