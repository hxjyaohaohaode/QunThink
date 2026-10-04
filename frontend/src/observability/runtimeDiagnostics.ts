/** Deliberately volatile and local-only. Never store input, text, URLs, IDs or error messages. */
export const surfaces = ['app', 'workspace', 'models', 'goals', 'memory', 'chat', 'agents', 'settings', 'task-composer', 'task-card', 'diagnostics'] as const;
export type Surface = typeof surfaces[number];
export type DiagnosticKind = 'view' | 'interaction' | 'request' | 'runtime' | 'task';
export type DiagnosticOutcome = 'started' | 'succeeded' | 'failed' | 'unknown';
export interface DiagnosticEvent { sequence: number; at: string; kind: DiagnosticKind; surface: Surface; outcome: DiagnosticOutcome; durationMs?: number; }
const kinds = new Set(['view', 'interaction', 'request', 'runtime', 'task']);
const outcomes = new Set(['started', 'succeeded', 'failed', 'unknown']);
const listeners = new Set<() => void>();
let events: readonly DiagnosticEvent[] = [];
let sequence = 0;
let enabled = true;
let scope = 'app' as Surface;
let revision = 0;
const MAX_EVENTS = 200;
export function recordDiagnostic(kind: DiagnosticKind, surface: Surface, outcome: DiagnosticOutcome, durationMs?: number) {
  if (!enabled || !kinds.has(kind) || !surfaces.includes(surface) || !outcomes.has(outcome)) return;
  const event: DiagnosticEvent = { sequence: ++sequence, at: new Date().toISOString(), kind, surface, outcome };
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) event.durationMs = Math.min(3_600_000, Math.max(0, Math.round(durationMs)));
  events = [...events.slice(-(MAX_EVENTS - 1)), Object.freeze(event)];
  revision++;
  listeners.forEach(listener => listener());
}
export function setDiagnosticSurface(surface: Surface) { scope = surface; recordDiagnostic('view', surface, 'succeeded'); }
export function getDiagnosticSurface() { return scope; }
export function clearDiagnostics() { events = []; sequence = 0; revision++; listeners.forEach(listener => listener()); }
export function setDiagnosticsEnabled(value: boolean) { enabled = value; clearDiagnostics(); }
export function diagnosticsEnabled() { return enabled; }
export function getDiagnosticEvents() { return events; }
export function getDiagnosticRevision() { return revision; }
export function subscribeDiagnostics(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function exportDiagnostics() { return JSON.stringify({ format: 'qunthink.local-diagnostics.v1', retention: 'current-tab-only', events }, null, 2); }
export function observeInteractions(root: Document = document) {
  const onClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('button, a, summary, [role="button"]')) return;
    const named = target.closest('[data-observe]')?.getAttribute('data-observe');
    const surface = surfaces.includes(named as Surface) ? named as Surface : scope;
    if (surface !== 'diagnostics') recordDiagnostic('interaction', surface, 'succeeded');
  };
  root.addEventListener('click', onClick, true);
  return () => root.removeEventListener('click', onClick, true);
}
