import { accountSnapshotSourceView } from './accountSnapshotSources.js';
import { createHash } from 'node:crypto';
import { getUserDb, updateGroupActivityById } from '../models/db.js';
import { commitAccountSnapshot } from './accountSnapshotCommit.js';
import { prepareOrderedAppend, projectMessageOrder, validateMessageOrder } from './messageOrder.js';
import { readableSourceGroups, readableSourceMessages } from './memory/persistentMemory.js';
import { currentUserId } from './userScope.js';

const cancelled = () => Object.assign(new Error('消息来源已撤销或生成已取消'), {
  code: 'MESSAGE_COMMIT_CANCELLED', status: 409, statusCode: 409, isOperational: true
});
const conflict = () => Object.assign(new Error('该消息标识已用于另一创建意图'), {
  code: 'MESSAGE_INTENT_CONFLICT', status: 409, statusCode: 409, isOperational: true
});
const deleted = () => Object.assign(new Error('该消息已删除，不能再次追加'), {
  code: 'MESSAGE_DELETED', status: 410, statusCode: 410, isOperational: true
});

// This domain adapter has no lock, storage retry or model dispatch of its own.
// The single account commit service owns those boundaries. Prepare randomized
// preview ciphertext, identity and time once, before entering that service.
export async function commitBackgroundMessage({ userId, db: suppliedDb, message, context = null,
  sourceMessageId = context?.sourceMessageId || null, sourceSenderType = 'user', updateActivity = true }) {
  const fixedMessage = JSON.parse(JSON.stringify(message));
  if (!fixedMessage.content || !fixedMessage.content.trim()) return null;
  const preview = { id: fixedMessage.group_id };
  if (updateActivity) updateGroupActivityById({ data: { groups: [preview] } }, fixedMessage.group_id, fixedMessage);
  const activity = updateActivity ? { last_message_at: preview.last_message_at, last_message_preview: preview.last_message_preview } : null;
  const creationIntentHash = createHash('sha256').update(JSON.stringify({ userId, message: fixedMessage, activity })).digest('hex');
  const prepared = { message: fixedMessage, activity, creationIntentHash };
  const db = suppliedDb || await getUserDb(userId);
  const confirm = ({ snapshot, prepared }) => {
    const index = validateMessageOrder(snapshot, userId), binding = index.bindings.get(prepared.message.id);
    if (!binding) return null;
    if (binding.groupId !== prepared.message.group_id || binding.creationIntentHash !== prepared.creationIntentHash) throw conflict();
    const stored = snapshot.messages.find(row => row.id === prepared.message.id);
    if (!stored || stored.deleted_at || stored.is_deleted) throw deleted();
    return { confirmed: true, result: projectMessageOrder(stored, index) };
  };
  try {
    const committed = await commitAccountSnapshot({ userId, db, prepared,
      authorize: async ({ snapshot }) => {
        if (currentUserId() !== userId || context?.cancel) throw cancelled();
        // Preserve the actual adapter prototype so ledger-aware source helpers
        // keep their CustomLow/PgLow checks, while all arrays/files are detached.
        const sourceView = accountSnapshotSourceView(db, snapshot);
        const group = (await readableSourceGroups(userId, sourceView)).find(row => row.id === fixedMessage.group_id);
        if (!group || (context?.requireAutonomousSetting &&
            (group.autonomous_chat_enabled !== true || !context.conversationActive))) throw cancelled();
        const readable = sourceMessageId || snapshot.messages.some(row => row.id === fixedMessage.id)
          ? await readableSourceMessages(userId, sourceView) : [];
        if (sourceMessageId && !readable.some(row => row.id === sourceMessageId &&
          row.group_id === fixedMessage.group_id && (!sourceSenderType || row.sender_type === sourceSenderType))) throw cancelled();
        if (snapshot.messages.some(row => row.id === fixedMessage.id) &&
            !readable.some(row => row.id === fixedMessage.id && row.group_id === fixedMessage.group_id)) throw deleted();
        if (context?.cancel) throw cancelled();
      },
      compose: args => {
        const prior = confirm(args);
        if (prior) return { readOnly: true, result: prior.result };
        const { data } = prepareOrderedAppend(args.snapshot, userId, args.prepared.message,
          { creationIntentHash: args.prepared.creationIntentHash });
        if (args.prepared.activity) Object.assign(data.groups.find(row => row.id === args.prepared.message.group_id), args.prepared.activity);
        return { snapshot: data, result: projectMessageOrder(data.messages.at(-1), validateMessageOrder(data, userId)) };
      }, confirm
    });
    // Stopping during I/O cannot undo a possibly durable write. Withhold live
    // publication and leave the same ID for authoritative history reconciliation.
    if (context?.cancel) { context.resultUnknown = true; return null; }
    return committed;
  } catch (error) {
    // A sibling may have committed successfully. A failed paid reply must still
    // stop the shared conversation from starting another model round.
    if (context) {
      context.cancel = true;
      if (error?.code === 'MESSAGE_COMMIT_UNKNOWN') context.resultUnknown = true;
    }
    if (error?.code === 'MESSAGE_COMMIT_CANCELLED') return null;
    throw error;
  }
}
