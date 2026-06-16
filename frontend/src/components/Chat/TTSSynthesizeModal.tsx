import { useState, useCallback, useEffect } from 'react';
import { api } from '../../services/api';
import { MessageTTSAudio } from '../../types';

interface TTSSynthesizeModalProps {
  text: string;
  messageId: string;
  onClose: () => void;
  onSynthesized: (audio: MessageTTSAudio) => void;
}

interface TTSVoice {
  id: string;
  name: string;
  desc: string;
  gender: 'male' | 'female';
  tone: string;
}

interface TTSTone {
  id: string;
  name: string;
  desc: string;
  speed: number;
  pitch: number;
  emotion: string;
}

const DEFAULT_VOICES: TTSVoice[] = [
  { id: 'mimo_default', name: '默认音色', desc: 'MiMo 默认音色', gender: 'female', tone: 'default' },
  { id: 'default_zh', name: '中文女声', desc: 'MiMo 中文女声', gender: 'female', tone: 'zh' },
  { id: 'default_en', name: '英文女声', desc: 'MiMo 英文女声', gender: 'female', tone: 'en' }
];

const DEFAULT_TONES: TTSTone[] = [
  { id: 'normal', name: '正常', desc: '标准语调和语速', speed: 1.0, pitch: 1.0, emotion: 'neutral' },
  { id: 'slow_gentle', name: '缓慢温柔', desc: '语速较慢，语调温柔', speed: 0.8, pitch: 0.9, emotion: 'gentle' },
  { id: 'fast_excited', name: '快速兴奋', desc: '语速较快，充满活力', speed: 1.2, pitch: 1.1, emotion: 'excited' },
  { id: 'calm', name: '平静舒缓', desc: '语速均匀，语调平稳', speed: 0.9, pitch: 1.0, emotion: 'calm' },
  { id: 'emotional', name: '情感丰富', desc: '语调变化大，情感充沛', speed: 1.0, pitch: 1.2, emotion: 'emotional' }
];

export function TTSSynthesizeModal({ text, messageId, onClose, onSynthesized }: TTSSynthesizeModalProps) {
  const [voices, setVoices] = useState<TTSVoice[]>(DEFAULT_VOICES);
  const [tones, setTones] = useState<TTSTone[]>(DEFAULT_TONES);
  const [selectedVoice, setSelectedVoice] = useState('mimo_default');
  const [selectedTone, setSelectedTone] = useState('normal');
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSynthesizing) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSynthesizing, onClose]);

  useEffect(() => {
    let active = true;

    const loadVoices = async () => {
      setIsLoadingConfig(true);
      try {
        const response = await api.getTTSVoices();
        if (!active) {
          return;
        }

        const nextVoices: TTSVoice[] = Array.isArray(response?.voices) && response.voices.length > 0 ? response.voices : DEFAULT_VOICES;
        const nextTones: TTSTone[] = Array.isArray(response?.tones) && response.tones.length > 0 ? response.tones : DEFAULT_TONES;

        setVoices(nextVoices);
        setTones(nextTones);
        if (!nextVoices.some(voice => voice.id === selectedVoice)) {
          setSelectedVoice(nextVoices[0]?.id || DEFAULT_VOICES[0].id);
        }
        if (!nextTones.some(tone => tone.id === selectedTone)) {
          setSelectedTone(nextTones[0]?.id || DEFAULT_TONES[0].id);
        }
      } catch (err: any) {
        if (!active) {
          return;
        }
        setVoices(DEFAULT_VOICES);
        setTones(DEFAULT_TONES);
        setError(err?.message || '音色配置加载失败，已回退到默认配置');
      } finally {
        if (active) {
          setIsLoadingConfig(false);
        }
      }
    };

    loadVoices();

    return () => {
      active = false;
    };
  }, []);

  const handleSynthesize = useCallback(async () => {
    setIsSynthesizing(true);
    setError(null);
    try {
      const result = await api.synthesizeSpeech(text, selectedVoice, selectedTone, messageId);
      
      if (result.success) {
        const audio: MessageTTSAudio = {
          id: result.audio_id,
          audioUrl: result.audio_url,
          duration: result.duration,
          voiceId: selectedVoice,
          toneId: selectedTone,
          createdAt: new Date().toISOString(),
          transcript: result.transcript || text,
          format: result.format
        };
        onSynthesized(audio);
        onClose();
      } else {
        setError('语音合成失败');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || '语音合成失败，请稍后重试');
    } finally {
      setIsSynthesizing(false);
    }
  }, [text, selectedVoice, selectedTone, messageId, onSynthesized, onClose]);

  const isLongText = text.length > 500;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-bg-surface rounded-2xl p-5 w-full max-w-md shadow-2xl animate-fade-in border border-border" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-accent flex items-center justify-center">
            <span className="text-white text-lg">🔊</span>
          </div>
          <div>
            <h3 className="text-base font-semibold text-text-primary">转换为语音</h3>
            <p className="text-xs text-text-muted">选择音色和语气</p>
          </div>
        </div>

        <div className="mb-4">
          <div className="bg-bg-surface2 rounded-xl p-3 mb-4 max-h-32 overflow-y-auto">
            <p className="text-xs text-text-secondary">{text.length > 300 ? text.substring(0, 300) + '...' : text}</p>
            <p className="text-xs text-text-muted mt-1">
              原文共 {text.length} 字
              {isLongText ? '（长文本，可能需要更长时间合成）' : '，将朗读全文'}
            </p>
          </div>

          {isSynthesizing && (
            <div className="mb-4">
              <div className="flex items-center justify-center gap-2 py-3">
                <svg className="animate-spin w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="text-sm text-text-muted">正在合成语音...</span>
              </div>
            </div>
          )}

          <label className="block text-sm font-medium text-text-primary mb-2">音色</label>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {voices.map(voice => (
              <button
                key={voice.id}
                onClick={() => setSelectedVoice(voice.id)}
                disabled={isSynthesizing || isLoadingConfig}
                className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all ${
                  selectedVoice === voice.id
                    ? 'border-accent bg-accent/10 dark:bg-accent/15'
                    : 'border-border hover:bg-bg-surface2'
                } disabled:opacity-50`}
              >
                <span className="text-lg">{voice.gender === 'female' ? '👩' : '👨'}</span>
                <div>
                  <div className="text-sm font-medium text-text-primary">{voice.name}</div>
                  <div className="text-xs text-text-muted">{voice.desc}</div>
                </div>
              </button>
            ))}
          </div>

          <label className="block text-sm font-medium text-text-primary mb-2">语气</label>
          <div className="flex flex-wrap gap-2 mb-4">
            {tones.map(tone => (
              <button
                key={tone.id}
                onClick={() => setSelectedTone(tone.id)}
                disabled={isSynthesizing || isLoadingConfig}
                className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                  selectedTone === tone.id
                    ? 'bg-accent text-white'
                    : 'bg-bg-surface2 text-text-secondary hover:bg-bg-surface3'
                } disabled:opacity-50`}
              >
                {tone.name}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 rounded-xl text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={isSynthesizing || isLoadingConfig}
            className="flex-1 px-4 py-2 border border-border rounded-xl text-text-secondary hover:bg-bg-surface2 transition-all text-sm font-medium disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSynthesize}
            disabled={isSynthesizing || isLoadingConfig}
            className="flex-1 px-4 py-2 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all text-sm font-medium shadow-md"
          >
            {isLoadingConfig ? <><svg className="w-4 h-4 animate-spin inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg> 加载中...</> : isSynthesizing ? <><svg className="w-4 h-4 animate-spin inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" /></svg> 合成中...</> : <><svg className="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66A2.25 2.25 0 0019.5 12.553V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" /></svg> 合成语音</>}
          </button>
        </div>
      </div>
    </div>
  );
}
