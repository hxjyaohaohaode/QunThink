/** Pure local decision: an app reload must not discard live or unresolved writing work. */
export function writingUpdateBlocker(
  results: { briefs?: Record<string, string>; pending: Record<string, unknown>; uncertain: Record<string, unknown>; editors: Record<string, { dirty: boolean }> },
  tasks: { pending: Record<string, unknown>; uncertainCreate: boolean; composerDraft: { title: string; prompt: string } },
  includeDirty = false
): string | null {
  if (Object.keys(results.pending).length || Object.keys(tasks.pending).length) return '还有保存、生成或核验正在处理，请等它完成后再更新';
  if (Object.keys(results.uncertain).length || tasks.uncertainCreate) return '上次请求仍待核验，请先查看原请求记录，再更新应用';
  if (Object.keys(results.briefs || {}).length || tasks.composerDraft.title || tasks.composerDraft.prompt) return '还有未保存的文稿用途，请先保存或明确清空，再更新应用';
  if (includeDirty && Object.values(results.editors).some(editor => editor.dirty)) return '还有未保存的正文，请先回到编辑区处理，再更新应用';
  return null;
}
