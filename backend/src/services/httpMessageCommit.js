import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { updateGroupActivity, readCommittedUserDb } from '../models/db.js';
import encryptionUtils from '../utils/encryption.js';
import { commitAccountSnapshot } from './accountSnapshotCommit.js';
import { accountSnapshotSourceView } from './accountSnapshotSources.js';
import { prepareOrderedAppend, validateMessageOrder, projectMessageOrder } from './messageOrder.js';
import { readableSourceGroups, readableSourceMessages, readableSourceFiles } from './memory/persistentMemory.js';

export function orderedHttpError(status, message, code) {
  return Object.assign(new Error(message), { status, statusCode: status, code, isOperational: true });
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const creationIntentHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const fileIdentity = file => file && ({ id: file.id, group_id: file.group_id,
  owner_user_id: file.owner_user_id || null, uploader_id: file.uploader_id || null,
  media_description: file.media_description || '', parsed_content: file.parsed_content || '' });

// Cryptography, original IDs and timestamps are fixed before entering the
// persistence retry boundary. Attachment derivations are frozen and checked
// again against the authorized snapshot, never silently re-enriched on a CAS.
export async function commitUserHttpMessage({ userId, db, groupId, body, clientMessageId, requestHash }) {
  body = structuredClone(body);
  const attachments = body.attachments || [];
  const files = attachments.length ? await readCommittedUserDb(db, data => data.files || []) : [];
  const fileMap = new Map(files.map(file => [file.id, file]));
  const attachmentRecords = attachments.map(attachment => fileIdentity(fileMap.get(attachment.id)) || null);
  const enriched = attachments.map((attachment, index) => {
    const file = attachmentRecords[index];
    return file && file.group_id === groupId ? { ...attachment,
      media_description: file.media_description || attachment.media_description || '', parsed_content: file.parsed_content } : attachment;
  });
  const time = new Date().toISOString(), type = body.content_type || 'text';
  const message = { id: uuidv4(), group_id: groupId, sender_type: 'user', sender_id: userId,
    content: type === 'text' ? encryptionUtils.encryptText(body.content) : body.content,
    content_type: type, reply_to: body.reply_to, attachments: enriched, client_message_id: clientMessageId,
    metadata: { ...(body.metadata || {}), encryption: type === 'text' ? {
      encrypted: true, encryption_version: 'aes-256-gcm-v1', encryption_timestamp: time } : null }, created_at: time };
  const activity = {}; updateGroupActivity(activity, { ...message, content: body.content });
  const prepared = { message, attachmentRecords, requestHash, activity, intentHash: creationIntentHash({ userId, message, requestHash }) };
  function result(snapshot, record) {
    return { message: projectMessageOrder(record, validateMessageOrder(snapshot, userId)) };
  }
  function prior(snapshot, authorization, intent) {
    const entry = clientMessageId && (snapshot.messageIdempotency || []).find(row => row.client_message_id === clientMessageId);
    if (!entry) return null;
    if (entry.request_hash !== intent.requestHash || entry.group_id !== groupId) throw orderedHttpError(409, 'clientMessageId 已用于不同消息');
    const original = authorization.messages.find(row => row.id === entry.message_id && row.group_id === groupId);
    if (!original) throw orderedHttpError(410, '原消息已删除，不能重复发送');
    return result(snapshot, original);
  }
  return commitAccountSnapshot({ userId, db, prepared,
    authorize: async ({ snapshot, prepared: intent }) => {
      const view = accountSnapshotSourceView(db, snapshot);
      if (!(await readableSourceGroups(userId, view, snapshot.groups)).some(group => group.id === groupId)) throw orderedHttpError(404, 'Group not found');
      const messages = await readableSourceMessages(userId, view, snapshot.messages);
      const authorization = { messages };
      // Preserve historical idempotency semantics, including a readable old
      // message whose attachment has since been revoked and is now filtered.
      if (prior(snapshot, authorization, intent)) return authorization;
      const currentFiles = new Map((await readableSourceFiles(userId, view, snapshot.files || []))
        .filter(file => (!file.owner_user_id || file.owner_user_id === userId) && (!file.uploader_id || file.uploader_id === userId)).map(file => [file.id, file]));
      for (let index = 0; index < intent.message.attachments.length; index++) {
        const attachment = intent.message.attachments[index], file = currentFiles.get(attachment.id);
        if (!file || file.group_id !== groupId) throw orderedHttpError(404, '附件不存在或已撤销');
        if (canonical(fileIdentity(file)) !== canonical(intent.attachmentRecords[index])) throw orderedHttpError(409, '附件已变化，请核验后重新发送', 'MESSAGE_ATTACHMENT_CHANGED');
      }
      return authorization;
    },
    compose: ({ snapshot, prepared: intent, authorization }) => {
      const previous = prior(snapshot, authorization, intent);
      if (previous) return { readOnly: true, result: previous };
      const { data } = prepareOrderedAppend(snapshot, userId, intent.message, { creationIntentHash: intent.intentHash });
      if (clientMessageId) data.messageIdempotency = [...(data.messageIdempotency || []), {
        client_message_id: clientMessageId, request_hash: intent.requestHash,
        message_id: intent.message.id, group_id: groupId, created_at: intent.message.created_at
      }];
      Object.assign(data.groups.find(group => group.id === groupId), intent.activity);
      return { snapshot: data, result: result(data, intent.message) };
    },
    confirm: ({ snapshot, prepared: intent, authorization }) => {
      const index = validateMessageOrder(snapshot, userId), binding = index.bindings.get(intent.message.id);
      if (binding && (binding.groupId !== groupId || binding.creationIntentHash !== intent.intentHash)) throw orderedHttpError(409, '消息标识已用于不同请求', 'MESSAGE_ORDER_ID_BOUND');
      const previous = prior(snapshot, authorization, intent);
      if (previous) {
        // An existing same-client receipt is also authoritative when another
        // process won the initial CAS; never allocate or dispatch a replacement.
        return { confirmed: true, result: previous };
      }
      if (!binding) return null;
      const original = authorization.messages.find(row => row.id === intent.message.id && row.group_id === groupId);
      if (!original) throw orderedHttpError(410, '原消息已删除，不能重复发送');
      return { confirmed: true, result: result(snapshot, original) };
    }
  });
}
