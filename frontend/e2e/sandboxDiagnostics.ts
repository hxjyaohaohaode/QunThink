// Read-only diagnostics for the installed Linux Chrome used by dependency E2E.
// Field names/DOM IDs follow Chrome 154's version and sandbox status pages:
// https://chromium.googlesource.com/chromium/src/+/154.0.8037.97/chrome/browser/resources/sandbox_internals/sandbox_internals.ts
export function readVersionDiagnostics(document: Document | void = globalThis.document) {
  const pageDocument = document || globalThis.document;
  return {
    executable: pageDocument.querySelector('#executable_path')?.textContent?.trim() ?? null,
    commandLine: pageDocument.querySelector('#command_line')?.textContent?.trim() ?? null,
  };
}

export function readSandboxDiagnostics(document: Document | void = globalThis.document) {
  const pageDocument = document || globalThis.document;
  return {
    rows: Array.from(pageDocument.querySelectorAll('#sandbox-status tr'), row =>
      Array.from(row.querySelectorAll('td'), cell => cell.textContent?.trim() ?? '')),
    evaluation: pageDocument.querySelector('#evaluation')?.textContent?.trim() ?? null,
  };
}

export function assertLinuxBrowserSandbox(
  version: ReturnType<typeof readVersionDiagnostics>,
  sandbox: ReturnType<typeof readSandboxDiagnostics>,
) {
  const fail = (message: string): never => { throw new Error(`Browser sandbox unverified: ${message}`); };
  if (!version.executable?.startsWith('/')) fail('missing/invalid executable path');
  if (!version.commandLine?.includes(version.executable!)) fail('missing/invalid command line');
  if (/--(?:no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox)(?:\s|=|$)/.test(version.commandLine!)) {
    fail('sandbox-disabling launch option');
  }
  const fields: Record<string, string> = {};
  for (const row of sandbox.rows) {
    if (row.length !== 2 || !row[0] || !row[1] || Object.hasOwn(fields, row[0])) fail('invalid/duplicate status row');
    fields[row[0]!] = row[1]!;
  }
  if (!['Namespace', 'SUID'].includes(fields['Layer 1 Sandbox']!)) fail('layer 1 sandbox absent or inactive');
  for (const label of ['PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox', 'Seccomp-BPF sandbox supports TSYNC']) {
    if (fields[label] !== 'Yes') fail(`${label} absent or inactive`);
  }
  // Chrome can report non-broker Yama as No when namespace isolation supplies
  // that protection. Record both actual values, rather than inventing a Yes.
  for (const label of ['Ptrace Protection with Yama LSM (Broker)', 'Ptrace Protection with Yama LSM (Non-broker)']) {
    if (!['Yes', 'No'].includes(fields[label]!)) fail(`${label} absent or unknown`);
  }
  if (sandbox.evaluation !== 'You are adequately sandboxed.') fail('overall sandbox status absent or inadequate');
  return { executable: version.executable, fields, evaluation: sandbox.evaluation };
}
