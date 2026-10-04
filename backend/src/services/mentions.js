// Match a known identity before interpreting the remainder as conversation text.
// Names may contain spaces, punctuation, non-Latin characters or emoji.
export function mentionedModelIds(text, members, getName, aliases = {}) {
  if (typeof text !== 'string') return [];
  if (/@所有人(?:\s|$|[，。！？,:：!?])/u.test(text)) return [...members];
  return members.filter(id => [getName(id), id, ...(aliases[id] || [])].filter(Boolean).some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@${escaped}(?=$|[\\s，。！？、,.:：!?;；])`, 'iu').test(text);
  }));
}
