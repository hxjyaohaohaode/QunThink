// The transport receives trusted annotations from its caller. These are
// planning metadata, never provider-visible message fields or authority.
const REQUIRED_KINDS = new Set([
  'rule', 'goal', 'hard_constraint', 'correction', 'current_step', 'unresolved_effect'
]);
const KINDS = new Set([
  ...REQUIRED_KINDS, 'history', 'evidence', 'tool_call', 'tool_result'
]);

function contextError(code, message) {
  return Object.assign(new Error(message), { status: 422, code });
}

function messageCost(message) {
  const content = message.content;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8') + 32;
  if (!Array.isArray(content)) throw contextError('INVALID_CONTEXT', '上下文消息内容无效');
  // Count the serialized representation conservatively. It is not a provider
  // token bill; model-specific image metering still needs separate support.
  let cost = 32;
  for (const part of content) {
    if (!part || typeof part !== 'object') throw contextError('INVALID_CONTEXT', '上下文内容块无效');
    cost += Buffer.byteLength(JSON.stringify(part), 'utf8');
  }
  return cost;
}

function annotation(message, index) {
  const context = message.context === undefined ? {} : message.context;
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
    (context.kind !== undefined && !KINDS.has(context.kind)) ||
    (context.required !== undefined && typeof context.required !== 'boolean') ||
    (context.pending !== undefined && typeof context.pending !== 'boolean') ||
    (context.priority !== undefined && (!Number.isSafeInteger(context.priority) ||
      context.priority < -10 || context.priority > 10)) ||
    (context.sourceIds !== undefined && (!Array.isArray(context.sourceIds) ||
      context.sourceIds.some(id => typeof id !== 'string' || !id))) ||
    (context.id !== undefined && (typeof context.id !== 'string' || !context.id))) {
    throw contextError('INVALID_CONTEXT', '上下文标注无效');
  }
  const paired = context.kind === 'tool_call' || context.kind === 'tool_result';
  if (paired && (typeof context.pairId !== 'string' || !context.pairId)) {
    throw contextError('UNPAIRED_TOOL_CONTEXT', '工具调用缺少配对标识');
  }
  if (!paired && (context.pairId !== undefined || context.pending !== undefined)) {
    throw contextError('INVALID_CONTEXT', '非工具消息不能声明工具配对状态');
  }
  if (context.kind === 'tool_result' && context.pending) {
    throw contextError('INVALID_CONTEXT', '工具结果不能标记为待完成调用');
  }
  return {
    index, kind: context.kind, id: context.id || 'message:' + index,
    pairId: context.pairId, pending: context.pending === true,
    required: context.required === true || REQUIRED_KINDS.has(context.kind),
    priority: context.priority || 0, sourceIds: context.sourceIds || []
  };
}

export function compileContextMessages(messages, { budget, readableSources, onContextAudit } = {}) {
  if (!Number.isSafeInteger(budget) || budget <= 0 || !Array.isArray(messages) || !messages.length) {
    throw contextError('INVALID_CONTEXT', '上下文预算或消息列表无效');
  }
  const annotations = messages.map((message, index) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)) {
      throw contextError('INVALID_CONTEXT', '上下文角色无效');
    }
    messageCost(message);
    const note = annotation(message, index);
    if (message.role === 'system' && (note.sourceIds.length ||
      ['history', 'evidence', 'tool_call', 'tool_result'].includes(note.kind))) {
      throw contextError('UNTRUSTED_SYSTEM_CONTEXT', '外部资料不能作为系统指令发送');
    }
    return note;
  });
  const latest = messages.findLastIndex(message => message.role !== 'system');
  if (latest < 0) throw contextError('INVALID_CONTEXT', '缺少当前交互');

  const grouped = new Map();
  for (const note of annotations) {
    const key = note.pairId ? 'tool:' + note.pairId : 'message:' + note.index;
    const group = grouped.get(key) || { id: note.pairId ? key : note.id, notes: [] };
    group.notes.push(note);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()];
  if (new Set(groups.map(group => group.id)).size !== groups.length) {
    throw contextError('DUPLICATE_CONTEXT_ID', '上下文对象标识重复');
  }
  for (const group of groups) {
    const calls = group.notes.filter(note => note.kind === 'tool_call');
    const results = group.notes.filter(note => note.kind === 'tool_result');
    if (calls.length > 1 || results.length > 1 || results.length > calls.length ||
      (calls.length === 1 && results.length === 0 && !calls[0].pending) ||
      (calls.length === 1 && results.length === 1 &&
        (calls[0].pending || results[0].index < calls[0].index))) {
      throw contextError('UNPAIRED_TOOL_CONTEXT', '工具调用和结果必须成对，待完成调用须明确标记');
    }
    group.required = group.notes.some(note => note.required || note.pending ||
      messages[note.index].role === 'system' || note.index === latest);
    group.priority = Math.max(...group.notes.map(note => note.priority));
    group.lastIndex = Math.max(...group.notes.map(note => note.index));
    group.cost = group.notes.reduce((sum, note) => sum + messageCost(messages[note.index]), 0);
    group.readable = group.notes.every(note => note.sourceIds.every(id =>
      readableSources instanceof Set && readableSources.has(id)));
    if (group.required && !group.readable) {
      throw contextError('MISSING_REQUIRED_CONTEXT', '必需来源当前不可读，不能发送旧上下文');
    }
  }
  const chosen = new Set(groups.filter(group => group.required).map(group => group.id));
  let used = groups.filter(group => group.required).reduce((sum, group) => sum + group.cost, 0);
  if (used > budget) {
    throw contextError('REQUIRED_CONTEXT_OVERFLOW', '必需规则、目标或修正超出窗口；请拆分任务或换用允许的更大模型');
  }
  const optional = groups.filter(group => !group.required && group.readable)
    .sort((a, b) => b.priority - a.priority || b.lastIndex - a.lastIndex);
  for (const group of optional) {
    if (used + group.cost > budget) continue;
    chosen.add(group.id);
    used += group.cost;
  }
  const selected = groups.filter(group => chosen.has(group.id))
    .flatMap(group => group.notes.map(note => note.index));
  const selectedIndices = new Set(selected);
  const system = [], conversation = [];
  messages.forEach((message, index) => {
    if (!selectedIndices.has(index)) return;
    const item = { role: message.role, content: message.content };
    (message.role === 'system' ? system : conversation).push(item);
  });
  // Measure the final provider-visible sequence once more. Never evict a
  // required group in response to an overflow.
  const finalCost = [...system, ...conversation].reduce((sum, message) => sum + messageCost(message), 0);
  if (finalCost > budget) throw contextError('REQUIRED_CONTEXT_OVERFLOW', '上下文最终计量超出窗口');
  const omitted = groups.filter(group => !chosen.has(group.id));
  const audit = {
    included: selectedIndices.size, omitted: messages.length - selectedIndices.size,
    includedIds: groups.filter(group => chosen.has(group.id)).map(group => group.id),
    omittedIds: omitted.map(group => group.id),
    omissionReasons: Object.fromEntries(omitted.map(group => [group.id,
      group.readable ? 'budget' : 'source_unreadable'])),
    estimatedBytes: finalCost, byteAllowance: budget,
    estimateBasis: 'utf8_bytes_conservative_model_window_allowance'
  };
  onContextAudit?.(audit);
  return { system, conversation, audit };
}
