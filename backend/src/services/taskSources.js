import { createHash } from 'node:crypto';
import { readableSourceGroups, readableSourceMessages } from './memory/persistentMemory.js';

export function sourceMessages(db, groupId) {
  return groupId ? (db.data.messages || []).filter(m => m.group_id === groupId) : [];
}

export function linkedFile(db, message, attachment) {
  return (db.data.files || []).find(file => file.id === attachment?.id && file.group_id === message.group_id) || null;
}

export function sourceHash(messages, db, version = 2) {
  return createHash('sha256').update(JSON.stringify(messages.map(m => ({
    id: m.id, content: m.content, content_type: m.content_type,
    ...(version >= 2 ? { sender_type: m.sender_type } : {}),
    attachments: (m.attachments || []).map(attachment => {
      const file = linkedFile(db, m, attachment);
      return { id: attachment.id, file: file ? {
        filename: file.filename, parsed_content: file.parsed_content,
        media_description: file.media_description, parse_status: file.parse_status
      } : null };
    }),
    revision: m.revision, edited_at: m.edited_at,
    deleted_at: m.deleted_at
  })))).digest('hex');
}

export async function sourceSnapshot(userId, db) {
  const groups = await readableSourceGroups(userId, db);
  const messages = await readableSourceMessages(userId, db);
  return { groupIds: new Set(groups.map(group => group.id)), messages };
}

export async function taskSourceMessages(userId, db, groupId) {
  return groupId ? (await readableSourceMessages(userId, db, sourceMessages(db, groupId))).slice(-40) : [];
}

export function isTaskInputSourceStale(task, db, snapshot) {
  if (!task.source_message_id) return false;
  if (!task.group_id || !snapshot?.groupIds.has(task.group_id)) return true;
  const source = snapshot.messages.find(message => message.id === task.source_message_id && message.group_id === task.group_id);
  return !source || !task.source_input_hash || sourceHash([source], db) !== task.source_input_hash;
}

export function isRunSourceStale(task, run, db, snapshot) {
  if (!task.group_id) return false;
  if (!snapshot?.groupIds.has(task.group_id)) return true;
  const messages = snapshot.messages.filter(message => message.group_id === task.group_id).slice(-40);
  return !run?.source_hash || sourceHash(messages, db, run.source_hash_version || 1) !== run.source_hash;
}

export function isResultSourceStale(task, db, snapshot) {
  const head = task.result_editor?.versions?.find(version => version.id === task.result_editor.head_version_id);
  // Manual-only documents have no run UUID. Their saved source binding still
  // controls the workspace summary, including after an accepted source edit.
  if (head && task.group_id) {
    if (!snapshot?.groupIds.has(task.group_id)) return true;
    const messages = snapshot.messages.filter(message => message.group_id === task.group_id).slice(-40);
    return !head.source_hash || sourceHash(messages, db, head.source_hash_version || 1) !== head.source_hash;
  }
  if (!task.result_run_id) return false;
  return isRunSourceStale(task, task.history?.find(item => item.id === task.result_run_id), db, snapshot);
}
