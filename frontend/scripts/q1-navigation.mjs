// Test-only routing after actual, visible application state is known. A loading
// app is not evidence that the chat Back button exists. Never change app state
// through URL/store injection to compensate for an unready observation.
export function pickWorkspaceNavigationState(state, mobile) {
  if (state.workspace) return 'workspace';
  if (state.sessionRetry) return 'session-retry';
  if (state.writingClose) return 'close-writing';
  if (mobile && state.mobileWorkspace) return 'mobile-home';
  if (mobile && state.mobileBack) return 'mobile-chat';
  if (!mobile && state.desktopBack) return 'desktop-chat';
  return 'waiting';
}

// Source context contains per-material disclosures. Select the context's own
// direct summary, never all nested summaries or an arbitrary first match.
export const CONTEXT_DISCLOSURE = ':scope > summary';

// Both responsive layouts expose this exact destination in their main nav.
// Do not bind to a removed decorative glyph or the desktop logo's title.
export function primaryWorkspaceControl(page) {
  return page.getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '工作台', exact: true });
}

// Workspace and the conversation both legitimately render TaskResultEditor.
// An exiting workspace must never stand in for the destination writing panel.
export function conversationResultEditor(page, narrow) {
  return page.getByRole(narrow ? 'dialog' : 'complementary', { name: '会话文稿', exact: true })
    .getByTestId('task-result-editor');
}

// Respect the server's bounded Retry-After observation without bypassing its
// limiter or inventing a default delay when the response did not provide one.
export function sessionRetryAt(value, now) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : null;
  const at = seconds === null ? Date.parse(value) : now + seconds * 1000;
  return Number.isFinite(at) && at >= now && at <= now + 120000 ? at : null;
}
