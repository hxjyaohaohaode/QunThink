import { v4 as uuidv4 } from 'uuid';
import { updateGroupActivity, sanitizeGroupForClient } from '../models/db.js';
import { commitAccountSnapshot } from './accountSnapshotCommit.js';
import { accountSnapshotSourceView } from './accountSnapshotSources.js';
import { prepareOrderedAppend, prepareOrderedGroup, projectMessageOrder, validateMessageOrder } from './messageOrder.js';
import { readableSourceGroups, readableSourceMessages } from './memory/persistentMemory.js';
import { getCatalogData } from './ai/catalog.js';
import { orderedHttpError, creationIntentHash } from './httpMessageCommit.js';

function allowedModels(snapshot, ids) {
  const allowed = new Set(getCatalogData(snapshot).models.filter(model => model.enabled && model.capabilities.includes('chat')).map(model => model.id));
  if (ids.some(id => !allowed.has(id))) throw orderedHttpError(400, 'ai_members 包含无效或已停用的AI标识');
}

export async function commitCreatedGroup({ userId, db, group, existingKind }) {
  const prepared = { group, generation: uuidv4(), existingKind: existingKind || null };
  const matches = (candidate, intent) => intent.existingKind === 'private'
    ? candidate.is_private === true && candidate.ai_members?.length === 1 && candidate.ai_members[0] === intent.group.ai_members[0]
    : intent.existingKind === 'ai_private' && candidate.type === 'ai_private' && candidate.ai_members?.length === intent.group.ai_members.length && intent.group.ai_members.every(id => candidate.ai_members.includes(id));
  const result = record => ({ group: sanitizeGroupForClient(record) });
  return commitAccountSnapshot({ userId, db, prepared,
    authorize: async ({ snapshot }) => ({ groups: await readableSourceGroups(userId, accountSnapshotSourceView(db, snapshot), snapshot.groups) }),
    compose: ({ snapshot, prepared: intent, authorization }) => {
      const existing = authorization.groups.find(candidate => matches(candidate, intent));
      if (existing) return { readOnly: true, result: result(existing) };
      allowedModels(snapshot, intent.group.ai_members || []);
      const data = prepareOrderedGroup(snapshot, userId, intent.group, { generation: intent.generation });
      return { snapshot: data, result: result(intent.group) };
    },
    confirm: ({ snapshot, prepared: intent, authorization }) => {
      const index = validateMessageOrder(snapshot, userId), identity = index.groups.get(intent.group.id);
      if (identity && identity.generation !== intent.generation) throw orderedHttpError(409, '群标识已用于不同请求', 'MESSAGE_ORDER_ID_BOUND');
      if (!identity) return null;
      const confirmed = authorization.groups.find(candidate => candidate.id === intent.group.id);
      if (!confirmed) throw orderedHttpError(404, 'Group not found');
      return { confirmed: true, result: result(confirmed) };
    }
  });
}

export async function commitGroupMemberChange({ userId, db, groupId, aiId, name, remove = false }) {
  const message = { id: uuidv4(), group_id: groupId, sender_type: 'system', sender_id: 'system',
    content: remove ? `${name || aiId} 已被移出群聊` : `邀请了 ${name || aiId} 加入群聊`, content_type: 'text',
    metadata: remove ? { type: 'member_removed', removedMember: aiId } : { type: 'member_joined', newMember: aiId }, created_at: new Date().toISOString() };
  const activity = {}; updateGroupActivity(activity, message);
  const prepared = { message, activity, aiId, remove, intentHash: creationIntentHash({ userId, message, aiId, remove }) };
  const result = (snapshot, original) => ({ group: sanitizeGroupForClient(snapshot.groups.find(group => group.id === groupId)),
    systemMessage: projectMessageOrder(original, validateMessageOrder(snapshot, userId)) });
  return commitAccountSnapshot({ userId, db, prepared,
    authorize: async ({ snapshot }) => {
      const view = accountSnapshotSourceView(db, snapshot);
      if (!(await readableSourceGroups(userId, view, snapshot.groups)).some(group => group.id === groupId)) throw orderedHttpError(404, 'Group not found');
      return { messages: await readableSourceMessages(userId, view, snapshot.messages) };
    },
    compose: ({ snapshot, prepared: intent }) => {
      const group = snapshot.groups.find(candidate => candidate.id === groupId);
      if (group.is_private) throw orderedHttpError(400, intent.remove ? '不能从私聊中移除成员' : '不能向私聊添加成员');
      const members = group.ai_members || [];
      if (intent.remove) {
        if (!members.includes(intent.aiId)) throw orderedHttpError(400, '该AI不在群聊中');
        if (members.length <= 2) throw orderedHttpError(400, '群聊至少需要保留2个AI成员');
      } else {
        allowedModels(snapshot, [intent.aiId]);
        if (members.includes(intent.aiId)) throw orderedHttpError(400, '该AI已在群聊中');
      }
      const { data } = prepareOrderedAppend(snapshot, userId, intent.message, { creationIntentHash: intent.intentHash });
      const changed = data.groups.find(candidate => candidate.id === groupId);
      changed.ai_members = intent.remove ? members.filter(id => id !== intent.aiId) : [...members, intent.aiId];
      Object.assign(changed, intent.activity);
      return { snapshot: data, result: result(data, intent.message) };
    },
    confirm: ({ snapshot, prepared: intent, authorization }) => {
      const binding = validateMessageOrder(snapshot, userId).bindings.get(intent.message.id);
      if (!binding) return null;
      if (binding.groupId !== groupId || binding.creationIntentHash !== intent.intentHash) throw orderedHttpError(409, '消息标识已用于不同请求', 'MESSAGE_ORDER_ID_BOUND');
      const original = authorization.messages.find(candidate => candidate.id === intent.message.id);
      if (!original) throw orderedHttpError(410, '原消息已删除');
      return { confirmed: true, result: result(snapshot, original) };
    }
  });
}
