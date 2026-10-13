// Native-browser regression harness only: actual components/storage/crypto with
// synthetic transport. No sign-in, provider calls, or real user data.
import React from 'react';
import '../src/index.css';
import { createRoot } from 'react-dom/client';
import { MessageList } from '../src/components/Chat/MessageList';
import { MessageInput } from '../src/components/Chat/MessageInput';
import { useMessagesStore, resetMessagesModuleState } from '../src/stores/messagesStore';
import { useGroupsStore } from '../src/stores/groupsStore';
import { useUIStore } from '../src/stores/uiStore';
import { axiosInstance, confirmAuthIdentity } from '../src/services/api';
import { setCacheUserId, saveCacheWithDurability, loadCacheAsync } from '../src/utils/cacheUtils';
import { setIndexedDBUserId, saveMessagesWithDurability, loadMessagesFromIndexedDB } from '../src/utils/indexedDB';
import type { Group, Message } from '../src/types';

const generation = '00000000-0000-4000-8000-000000000001';
const room = new URLSearchParams(location.search).get('group') || 'f07-room';
let owner = localStorage.getItem('f07_synthetic_owner') || 'f07-synthetic-alice';
const requests: { method?: string; url?: string }[] = [];
let readMode: 'success' | 'upgrade' = 'success';
let active = true;
const group = { id: room, name: 'Synthetic F07 regression', ai_members: [], space_category: 'work' } as unknown as Group;
axiosInstance.defaults.adapter = async config => {
  requests.push({ method: config.method, url: config.url });
  if (config.method !== 'get') throw new Error('Unexpected write in the synthetic F07 native fixture');
  if (readMode === 'upgrade') throw Object.assign(new Error('消息分页协议已更新'), {
    config, response: { config, status: 428, headers: {}, data: { code: 'MESSAGE_CURSOR_REQUIRED', error: '消息分页协议已更新' } },
  });
  const after_cursor = btoa(JSON.stringify({ v: 1, owner, group: room, generation, kind: 'after', at: '0' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { config, status: 200, statusText: 'OK', headers: {}, data: { messages: [], hasMore: false, order: 'sequence_v1', generation, high_watermark: '0', consumed_through: '0', before_cursor: null, after_cursor } };
};
function scope(nextOwner: string) {
  owner = nextOwner;
  localStorage.setItem('f07_synthetic_owner', owner);
  resetMessagesModuleState();
  setCacheUserId(owner); setIndexedDBUserId(owner); confirmAuthIdentity(owner);
  useGroupsStore.setState({ currentGroup: { ...group }, groups: [group], chatStatus: new Map(), debateStatus: new Map() });
  useUIStore.setState({ connectionStatus: 'connected', replyingTo: [], typingIndicators: {} });
}
scope(owner);
const root = createRoot(document.getElementById('root')!);
function render() { root.render(<div style={{ height: 700, display: 'flex', flexDirection: 'column' }}><MessageList isActive={active} /><MessageInput /></div>); }
Object.assign(window, { __f07: {
  requests,
  scope(nextOwner: string) { scope(nextOwner); render(); },
  mode(mode: 'success' | 'upgrade') { readMode = mode; },
  active(value: boolean) { active = value; render(); },
  rebuild: () => useMessagesStore.getState().resumeOrderedMessages(room),
  state: () => useMessagesStore.getState(),
  saveDraft: (text: string) => saveCacheWithDurability(`message_draft_${owner}_${room}`, text),
  loadDraft: () => loadCacheAsync(`message_draft_${owner}_${room}`),
  saveOutbox: (rows: Message[]) => saveMessagesWithDurability(rows),
  loadOutbox: () => loadMessagesFromIndexedDB(room),
} });
render();
