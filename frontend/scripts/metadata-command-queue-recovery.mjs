// Native-test orchestration only. The visible recovery queue may legitimately
// start with either request; never infer command identity from tab or position.
export async function settleKnownMetadataQueue({ winner, loser, ownerId, taskId, observe, act, waitForAdvance }) {
  if (!winner?.client_request_id || !loser?.client_request_id || winner.client_request_id === loser.client_request_id || winner.expected_revision !== loser.expected_revision || !ownerId || !taskId) throw new Error('Two distinct bound metadata commands are required');
  const completed = new Set(); let loserClosed = false;
  for (let step = 0; step <= 2; step++) {
    const state = await observe();
    if (state.kind === 'ready') {
      if (!loserClosed) throw new Error('Re-edit appeared before the exact rejected command was closed');
      return [...completed];
    }
    if (state.kind !== 'pending' || ![winner.client_request_id, loser.client_request_id].includes(state.id)) throw new Error('Unknown visible metadata request; no recovery action');
    if (step === 2 || completed.has(state.id)) throw new Error('Metadata queue repeated a settled command or exceeded its two known requests');
    const close = state.id === loser.client_request_id;
    const path = `/api/tasks/${taskId}/metadata/commands/${state.id}${close ? '/close' : ''}`;
    const result = await act({ id: state.id, operation: close ? 'close' : 'verify', path });
    const receipt = result?.body?.receipt, task = result?.body?.task;
    if (result?.status !== 200 || result.method !== (close ? 'POST' : 'GET') || result.path !== path || result.ownerId !== ownerId || (close && JSON.stringify(result.requestBody) !== '{}') || !receipt || receipt.id !== state.id || receipt.task_id !== taskId || receipt.operation !== 'metadata' || receipt.status !== (close ? 'cancelled' : 'succeeded') || receipt.committed_revision !== (close ? null : winner.expected_revision + 1) || task?.id !== taskId || task.metadata_revision !== winner.expected_revision + 1 || result.body.task_deleted) throw new Error('Metadata recovery response does not match the exact owner, task, command and revision');
    completed.add(state.id); if (close) loserClosed = true;
    // Wait for the completed request to leave the actual rendered head before
    // inspecting the next head. No snapshot count, automatic write retry or poll
    // that can click twice; the adapter uses the original test's bounded wait.
    await waitForAdvance(state.id);
  }
  throw new Error('Metadata queue did not reach deliberate re-edit');
}
