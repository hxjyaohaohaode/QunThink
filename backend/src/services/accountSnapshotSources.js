// Existing source filters use adapter identity to select the deletion ledger.
// Keep that identity but expose only this detached, disposable authorization view.
export function accountSnapshotSourceView(db, snapshot) {
  const view = Object.create(db);
  const noIo = () => { throw new Error('Snapshot source views cannot perform database I/O'); };
  Object.defineProperties(view, {
    data: { value: snapshot, enumerable: true },
    read: { value: noIo },
    write: { value: noIo },
    create: { value: noIo }
  });
  return view;
}
