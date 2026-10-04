import type { Message } from '../types';

/** Pair a server echo only with the exact local send that created it. */
export function findMatchingLocalMessage(messages: Message[], clientMessageId?: string): Message | undefined {
  if (!clientMessageId) return undefined;
  return messages.find(message => message.sender_type === 'user' && message.tempId === clientMessageId &&
    (message.status === 'sending' || message.status === 'failed'));
}
