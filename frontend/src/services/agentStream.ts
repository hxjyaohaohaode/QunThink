/** Agent route protocol: JSON content/error events followed by an explicit [DONE]. */
export async function readAgentStream(response: Response, onContent: (content: string) => void): Promise<string> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error.slice(0, 1000) : `发送请求未被接受（${response.status}）`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('未收到回复流，结果尚未确认');
  const decoder = new TextDecoder();
  let buffer = '', content = '', completed = false;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || completed) return;
    if (data === '[DONE]') { completed = true; return; }
    let event: { content?: unknown; error?: unknown };
    try { event = JSON.parse(data); }
    catch { throw new Error('回复数据无法解析，结果未完成'); }
    if (!event || typeof event !== 'object') throw new Error('回复格式异常，结果未完成');
    if (typeof event.content === 'string') { content += event.content; onContent(content); }
    if (typeof event.error === 'string') throw new Error(event.error.slice(0, 1000) || '服务端未能完成回复');
  };
  try {
    while (!completed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('回复连接超时，结果尚未确认')), 30000); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) consume(line.replace(/\r$/, ''));
      if (result.done) { if (buffer.trim()) consume(buffer.replace(/\r$/, '')); break; }
    }
    if (!completed) throw new Error('回复连接中断，未收到完成确认');
    if (!content.trim()) throw new Error('未收到回复正文，结果尚未确认');
    return content;
  } finally {
    // Cancel/release the reader on errors and after the terminal event. Do not retry.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
