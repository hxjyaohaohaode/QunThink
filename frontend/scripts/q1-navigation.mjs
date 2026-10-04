// Test-only routing after actual, visible application state is known. A loading
// app is not evidence that the chat Back button exists. Never change app state
// through URL/store injection to compensate for an unready observation.
export function pickWorkspaceNavigationState(state, mobile) {
  if (state.workspace) return 'workspace';
  if (state.writingClose) return 'close-writing';
  if (mobile && state.mobileWorkspace) return 'mobile-home';
  if (mobile && state.mobileBack) return 'mobile-chat';
  if (!mobile && state.desktopBack) return 'desktop-chat';
  return 'waiting';
}

// Source context contains per-material disclosures. Select the context's own
// direct summary, never all nested summaries or an arbitrary first match.
export const CONTEXT_DISCLOSURE = ':scope > summary';
