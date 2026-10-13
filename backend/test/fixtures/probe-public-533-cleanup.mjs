// Runs in a dedicated test process. Manipulates only its own fresh fixture child.
// Signals are lifecycle fault injection, not model/service calls or user state.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2];
if (!['ipc-error', 'timeout', 'spawn-error', 'cleanup-error'].includes(mode)) throw new Error('Unknown lifecycle probe mode');
const actualFork = childProcess.fork;
let worker, actualKill;
childProcess.fork = (...args) => {
  if (mode === 'spawn-error') args[2] = { ...args[2], execPath: '/fixture-nonexistent-node-executable' };
  worker = actualFork(...args);
  actualKill = worker.kill.bind(worker);
  if (worker.pid) {
    process.kill(worker.pid, 'SIGSTOP');
    if (mode === 'cleanup-error') worker.kill = () => false;
    if (mode === 'ipc-error' || mode === 'cleanup-error') worker.disconnect();
  }
  return worker;
};
syncBuiltinESMExports();
const { createPublic533LegacySample } = await import(pathToFileURL(process.argv[3]));
const started = performance.now();
let returnedSample = false, reported, observation;
try {
  try { await createPublic533LegacySample(); returnedSample = true; }
  catch (error) { reported = error.message; }
  let alive = false;
  if (worker?.pid) {
    try { process.kill(worker.pid, 0); alive = true; } catch {}
  }
  observation = { mode, elapsedMs: Math.round(performance.now() - started), returnedSample,
    fixedFailure: reported === 'Legacy fixture producer failed; runtime sample output is suppressed',
    explicitCleanupFailure: reported === 'Legacy fixture producer cleanup failed; exit not confirmed; runtime sample output is suppressed',
    liveAtRejection: alive, spawned: !!worker?.pid,
    exitConfirmed: worker?.exitCode !== null || worker?.signalCode !== null,
    killedWithSIGKILL: worker?.signalCode === 'SIGKILL' };
} finally {
  // Keep even a failing regression test from leaving a stopped process behind.
  if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, 'exit'); actualKill('SIGKILL'); await exited;
  }
}
process.stdout.write(JSON.stringify({ ...observation,
  probeCleanupConfirmed: !worker?.pid || worker.exitCode !== null || worker.signalCode !== null }));
