// Synthetic protocol contract, never a model-quality evaluation.
export const Q1_ORIGIN = 'http://127.0.0.1:3203';
export const ORIGINAL = 'Q1-NOTE-ORIGINAL: 同事创作交流活动原定于 2026-10-18 14:00，在南楼 201 举行。受众为受邀同事，不公开发布。来源：https://example.invalid/q1/original';
export const CORRECTION = 'Q1-NOTE-CORRECTION: 明确更正：活动日期从 2026-10-18 改为 2026-10-20，14:00、南楼 201 不变。请以本条更正为准。来源：https://example.invalid/q1/correction';
export const LATER_CORRECTION = 'Q1-NOTE-CORRECTION: 再次明确更正：活动日期现改为 2026-10-22，14:00、南楼 201 不变。此前 2026-10-20 已不再适用。来源：https://example.invalid/q1/correction';
export const PURPOSE = 'Q1-INVITATION: 请仅依据本会话原始通知和明确更正，写一封约 300 词的英文活动邀请函，面向受邀同事，不公开发布。使用明确更正后的日期，保留两条来源链接。正文需要可编辑，之后我要人工修改一句话，再确认具体版本。不得把要求摘要当邀请正文。';
export const INVITATION = `Synthetic protocol fixture output. This is a deterministic UI test, not live model reasoning.\n\nDear colleagues,\n\nYou are warmly invited to our creative exchange on 20 October 2026, beginning at 14:00 in Room 201 of the South Building. Please use this corrected date when planning your attendance. The earlier announcement named 18 October, but the later source explicitly replaced that date. The time and meeting room remain unchanged.\n\nThis invitation is intended for the colleagues who have been invited to the event. It is a private draft for review and must not be treated as a public announcement. We hope the session will provide a friendly opportunity to exchange creative ideas, hear different perspectives, and consider possibilities together. Participation details beyond the date, time, location, and audience have not yet been supplied in the source notes.\n\nBefore this invitation is distributed, the organiser should review its wording and confirm any practical details that are still missing. No attendance deadline, registration link, refreshments, formal agenda, or contact person has been confirmed. These should remain open questions rather than being presented as established arrangements. If further information becomes available, it can be added in a later reviewed version.\n\nPlease keep the corrected date visible in any subsequent revision. Anyone retaining the original notice should be told that its date has been superseded, while the original notice remains useful for understanding the history of the change. A future date correction would require this draft to be reviewed again before use.\n\nThank you for considering the invitation. We look forward to an opportunity for thoughtful conversation and shared creativity. This text is ready for the organiser's review, and no message has been sent to colleagues.\n\nSources: [original notice](https://example.invalid/q1/original) and [explicit date correction](https://example.invalid/q1/correction).`;

export function assertQ1CiRuntime(env = process.env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_RUN_ID) {
    throw new Error('Q1 browser/listener execution is restricted to the authorized GitHub CI run. Local browser or listener execution is not permitted.');
  }
}
export function inspectRequest(body) {
  if (!body || typeof body.model !== 'string' || !body.model.startsWith('q1-fixture-') || !Array.isArray(body.messages)) {
    throw new Error('Only the synthetic Q1 model protocol is accepted');
  }
  const texts = body.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  const joined = texts.join('\n');
  const kind = body.stream ? 'chat' : joined.includes('Q1-INVITATION:') ? 'task' : joined === '请回复 OK' ? 'probe' : 'other';
  return { kind, hasOriginal: joined.includes(ORIGINAL), hasCorrection: joined.includes(CORRECTION), hasPurpose: joined.includes(PURPOSE),
    hold: kind === 'task' && joined.includes('Q1-CANCEL-AFTER-DISPATCH'),
    content: kind === 'probe' ? 'OK' : kind === 'task' ? INVITATION : 'Q1 synthetic conversation acknowledgement. No live model reasoning or external action was performed.' };
}
export function completionBody(content) {
  return { id: 'q1-synthetic-protocol-response', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 320, total_tokens: 420 }, synthetic_fixture: true };
}
export function streamBody(content) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`;
}

// MessageList and MessageBubble both identify a message. Actions belong to the
// inner MessageBubble's existing .group element, never an arbitrary first match.
export function messageBubbleSelector(id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('Expected a server message UUID');
  return `.group[data-message-id="${id}"]`;
}

// Observe provider scheduling without repeatedly consuming the application's
// real message-query quota. Content representation is audited separately.
export async function observeNewChatCalls(readCalls, knownCallIds, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  const known = new Set(knownCallIds);
  let calls = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    calls = await readCalls();
    if (calls.some(call => call.kind === 'chat' && !known.has(call.id))) break;
    if (attempt < 3) await wait(1000);
  }
  return calls;
}
