// Test-only response barrier. It validates real reads; it never supplies data,
// sends a request, retries, changes timers, or performs a browser interaction.
export function createCommandReadGate({ ownerId, origins }) {
  let binding, released = false, disposed = false, failure, release, dispose;
  const cleanupError = new Error('Create-read gate disposed during test cleanup');
  const barrier = new Promise((resolve, reject) => { release = resolve; dispose = reject; });
  // Cleanup can precede every read; do not create an unhandled rejection.
  void barrier.catch(() => {});
  const entries = [];
  const check = (condition, message) => { if (failure) throw failure; if (!condition) { failure = new Error(`Create-read gate: ${message}`); throw failure; } };
  const taskMatches = task => task && task.id === binding?.taskId && task.client_request_id === binding?.key && Object.hasOwn(task, 'priority') && task.priority === binding.priority && Object.hasOwn(task, 'estimated_minutes') && task.estimated_minutes === binding.estimatedMinutes && task.metadata_revision === 0;
  const entry = ticket => { check(Number.isInteger(ticket) && entries[ticket], 'unknown read ticket'); return entries[ticket]; };
  return {
    bind(value) {
      check(!binding && value.key && value.taskId && value.priority === 'high' && value.estimatedMinutes === 0, 'invalid or duplicate original creation binding');
      binding = { ...value };
    },
    begin(request) {
      check(!disposed, 'read attempted after disposal');
      const url = new URL(request.url);
      check(request.method === 'GET' && origins.includes(url.origin) && !url.search && !url.hash && request.ownerId === ownerId, 'unexpected method, origin, owner or URL suffix');
      const kind = url.pathname === '/api/tasks' ? 'list' : 'query';
      check(kind === 'list' || binding && url.pathname === `/api/tasks/commands/${binding.key}`, 'wrong command UUID or path');
      check(entries.filter(value => value.kind === kind).length < (kind === 'list' ? 4 : 1), 'unexpected extra read');
      entries.push({ kind, origin: url.origin, path: url.pathname, ownerId: request.ownerId, startedAfterRelease: released, verified: false, delivered: false }); return entries.length - 1;
    },
    verify(ticket, { status, body }) {
      const item = entry(ticket); check(!item.verified && status === 200, 'duplicate verification or non-200 response');
      if (item.kind === 'list') check(Array.isArray(body) && body.length <= 1 && body.every(taskMatches), 'unexpected task in real list projection');
      else check(body?.operation === 'create' && body.status === 'succeeded' && body.client_request_id === binding.key && body.task_id === binding.taskId && body.task_deleted === false && taskMatches(body.task), 'incomplete or mismatched authoritative create receipt');
      item.response = item.kind === 'list' ? { status, taskCount: body.length, taskIds: body.map(task => task.id) } : { status, operation: body.operation, requestId: body.client_request_id, taskId: body.task_id, deleted: body.task_deleted, priority: body.task.priority, estimatedMinutes: body.task.estimated_minutes, metadataRevision: body.task.metadata_revision };
      item.verified = true;
    },
    async wait(ticket) { check(entry(ticket).verified, 'cannot hold an unverified response'); await barrier; check(released && !disposed, 'response released without completed click'); },
    releaseAfterClick() { check(!released && !disposed && binding && entries.filter(value => value.kind === 'query' && value.verified).length === 1, 'release requires one verified original manual query'); released = true; release(); },
    delivered(ticket) { const item = entry(ticket); check(released && item.verified && !item.delivered, 'response delivered early or twice'); item.delivered = true; },
    snapshot() { if (failure) throw failure; return { lists: entries.filter(value => value.kind === 'list').length, queries: entries.filter(value => value.kind === 'query').length, verifiedQueries: entries.filter(value => value.kind === 'query' && value.verified).length, postReleaseListsDelivered: entries.filter(value => value.kind === 'list' && value.startedAfterRelease && value.delivered).length, verified: entries.filter(value => value.verified).length, delivered: entries.filter(value => value.delivered).length, total: entries.length, released }; },
    evidence() { return entries.map(value => ({ ...value })); },
    isCleanupError(error) { return error === cleanupError; },
    cleanup() { if (!released && !disposed) { disposed = true; dispose(cleanupError); } },
    assertComplete() { check(released && entries.some(value => value.kind === 'list') && entries.filter(value => value.kind === 'query').length === 1 && entries.every(value => value.verified && value.delivered), 'read sequence is incomplete'); },
  };
}

export async function disposeCreateReadGate(gate, unrouteAll, completed) {
  gate.cleanup();
  // A disposed handler cannot fulfill its held route. Waiting for the SDK's
  // handledPromise would hang and hide the original test failure.
  if (completed) await unrouteAll({ behavior: 'wait' });
  else {
    // The test already failed. A closed-page teardown must not replace it.
    try { await unrouteAll({ behavior: 'ignoreErrors' }); } catch {}
  }
}
