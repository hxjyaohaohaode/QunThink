import type { Message } from '../types';

// Older pages are prepended; they are not new conversation activity. Comparing
// counts misclassifies the existing tail whenever history is inserted/deleted.
export function appendedMessages(previous: Message[], current: Message[]): Message[] {
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
