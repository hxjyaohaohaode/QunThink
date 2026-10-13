import type { Message } from '../types';

export function messageIdentityKeys(message: Message): string[] {
  return [message.id, message.tempId, (message as Message & { client_message_id?: string }).client_message_id]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

// Older pages are prepended; they are not new conversation activity. Comparing
// counts misclassifies the existing tail whenever history is inserted/deleted.
export function appendedMessages(previous: Message[], current: Message[], activityIds?: ReadonlySet<string>): Message[] {
  // Ordered history and live events can both insert before a pending tail (or
  // before a higher live sequence). Only the admitting source knows the intent.
  const identities = new Set(previous.flatMap(messageIdentityKeys));
  if (activityIds) return current.filter(message => activityIds.has(message.id) &&
    !messageIdentityKeys(message).some(id => identities.has(id)));
  if (!previous.length) return current.filter(message => message.status === 'sending');
  const known = new Set(previous.map(message => message.id));
  let lastKnown = -1;
  for (let index = current.length - 1; index >= 0; index--) {
    if (known.has(current[index].id)) { lastKnown = index; break; }
  }
  const lastTimestamp = Date.parse(previous[previous.length - 1].created_at);
  return current.filter((message, index) => !known.has(message.id) &&
    (lastKnown >= 0 ? index > lastKnown : Date.parse(message.created_at) > lastTimestamp));
}
