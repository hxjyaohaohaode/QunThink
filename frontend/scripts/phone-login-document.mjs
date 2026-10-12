// Test-only observer for this Chrome suite's AppContent history initialization.
// CDP supplies the distinction hidden by Playwright's public framenavigated.
// Only two same-URL historyApi notifications cover this App's StrictMode mount;
// they never excuse a cross-document commit, even an immediate BFCache return.
export async function observePhoneLoginDocument({ page, budget, admitted }) {
  const url = page.url(); let session, originalDocument, frameId, loaderId;
  let invalid = false, disposing = false, disposed = false, detachedSession = false, revision = 0, verified = -1;
  const children = new Set();
  let publicEvents = 0, historyEvents = 0, proof = null;
  const invalidate = () => { invalid = true; revision++; };
  const crossDocument = event => { if (!event?.frame || event.frame.id === frameId || !event.frame.parentId || !children.has(event.frame.id)) invalidate(); };
  const sameDocument = event => {
    if (!event?.frameId || !frameId) return invalidate();
    if (event.frameId !== frameId) { if (!children.has(event.frameId)) invalidate(); return; }
    revision++; historyEvents++;
    if (!admitted() || disposing || event.navigationType !== 'historyApi' || event.url !== url || historyEvents > 2) invalid = true;
  };
  const detached = event => { if (!event?.frameId || !children.has(event.frameId)) invalidate(); };
  const closed = () => { if (!disposing) invalidate(); };
  const listeners = { 'Page.frameNavigated': crossDocument, 'Page.navigatedWithinDocument': sameDocument, 'Page.frameDetached': detached, close: closed };
  const assertCurrent = () => {
    if (invalid || page.url() !== url) throw new Error('Phone login document changed or navigation classification is unknown');
  };
  const detach = async () => {
    if (detachedSession) return;
    disposing = true;
    try { await session?.detach(); } finally { detachedSession = true; }
  };
  const dispose = async () => {
    if (disposed) return;
    try { await detach(); } finally {
      try { await originalDocument?.dispose(); } finally {
        disposed = true;
        for (const [event, listener] of Object.entries(listeners)) session?.off(event, listener);
      }
    }
  };
  try {
    budget(); session = await page.context().newCDPSession(page); budget();
    for (const [event, listener] of Object.entries(listeners)) session.on(event, listener);
    await session.send('Page.enable'); budget();
    const tree = await session.send('Page.getFrameTree'); budget();
    frameId = tree?.frameTree?.frame?.id; loaderId = tree?.frameTree?.frame?.loaderId;
    if (!frameId || !loaderId || tree.frameTree.frame.url !== url) throw new Error('Phone login requires the current CDP main frame');
    const rememberChildren = tree => { for (const child of tree.childFrames ?? []) { children.add(child.frame.id); rememberChildren(child); } };
    rememberChildren(tree.frameTree);
    originalDocument = await page.evaluateHandle(() => document); budget(); assertCurrent();
    return {
      assertCurrent,
      navigate: () => { revision++; publicEvents++; if (!admitted() || disposing || publicEvents > 2) invalid = true; },
      assertNoNavigation: () => { assertCurrent(); if (publicEvents || historyEvents) throw new Error('Navigation cannot authorize another phone submit'); },
      beginProof: () => { assertCurrent(); if (disposed || proof && !proof.done) throw new Error('Phone login document proof is still pending'); proof = null; verified = -1; },
      // Poll a read-only proof; never await an unbounded page RPC inside polling.
      // A missing/unsupported event, stuck proof, or stale revision cannot pass.
      verify: () => {
        assertCurrent();
        if (publicEvents !== historyEvents) return false;
        if (!proof || proof.revision !== revision && proof.done) {
          if (disposed) return false;
          const candidate = { revision, done: false }; proof = candidate;
          Promise.resolve().then(() => page.evaluate(original => original === document, originalDocument)).then(matches => {
            if (!matches) invalidate();
          }, () => invalidate()).finally(() => { candidate.done = true; });
          return false;
        }
        if (!proof.done || proof.revision !== revision) return false;
        verified = revision; return true;
      },
      assertVerified: () => { assertCurrent(); if (!proof?.done || verified !== revision || publicEvents !== historyEvents) throw new Error('Phone login document proof is still pending'); },
      snapshot: () => ({ publicEvents, historyEvents, revision, proofComplete: !!proof?.done, verified: verified === revision, invalid, disposing, disposed }),
      detach, dispose,
    };
  } catch (error) { try { await dispose(); } catch { /* Keep the setup failure. */ } throw error; }
}
