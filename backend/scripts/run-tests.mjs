import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { storageFixturesRequired, assertRequiredStorageFiles, REQUIRED_STORAGE_TESTS,
  runStoragePreflight, verifyRequiredTap } from './ci-storage-fixtures.mjs';
import { writeStorageEvidence, sourceManifest, sanitizeStorageOutput } from './ci-storage-evidence.mjs';

const testDir = path.resolve('test');
const tests = readdirSync(testDir).filter(name => name.endsWith('.test.js')).sort();
if (!tests.includes('platform.integration.test.js')) throw new Error('platform integration test is missing');

const required = storageFixturesRequired();
const requiredFiles = new Set(REQUIRED_STORAGE_TESTS);
const results = [], evidenceErrors = [];
// Evidence I/O must never replace a test/preflight failure or stop later files.
// An incomplete evidence bundle is itself a failing gate, even if tests pass.
async function preserveEvidence(name, value) {
  try {
    await writeStorageEvidence(name, typeof value === 'function' ? await value() : value);
    return true;
  } catch (error) {
    const failure = { file: name, code: error.code || null, error: sanitizeStorageOutput(error.message) };
    evidenceErrors.push(failure);
    process.stderr.write(`[storage evidence failure] ${sanitizeStorageOutput(JSON.stringify(failure))}\n`);
    process.exitCode = 1;
    return false;
  }
}

async function run(label, args) {
  process.stdout.write(`\n[tests] ${label}\n`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), env: process.env, stdio: required ? 'pipe' : 'inherit',
    ...(required ? { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300000 } : {})
  });
  if (!required) {
    if (result.error) throw result.error;
    return result.status === 0;
  }
  // Only report channels are redacted/bounded. Assertions and TAP inspection
  // consume the original child bytes, so redaction cannot turn a test green.
  process.stdout.write(sanitizeStorageOutput(result.stdout || ''));
  process.stderr.write(sanitizeStorageOutput(result.stderr || ''));
  let gateError = null, summary = null;
  try {
    if (result.error) throw result.error;
    if (requiredFiles.has(label)) summary = verifyRequiredTap(label, result.stdout || '', result.status);
  } catch (error) {
    gateError = sanitizeStorageOutput(error.message);
    process.stderr.write(`[storage gate] ${gateError}\n`);
  }
  // Record the original child status before attempting any fallible evidence I/O.
  results.push({ file: label, exitStatus: result.status, signal: result.signal,
    errorCode: result.error?.code || null, required: requiredFiles.has(label), summary, gateError });
  if (requiredFiles.has(label) || result.status !== 0 || gateError) {
    await preserveEvidence(`${label}.log`, sanitizeStorageOutput(`${result.stdout || ''}\n${result.stderr || ''}`));
  }
  return result.status === 0 && !gateError;
}

// Each node:test file gets its own process and a checked exit status. Node 24
// on Windows has intermittently failed to deserialize test-runner IPC for
// different files even when their assertions pass. Direct execution keeps
// isolation and runs every assertion without that IPC channel.
let passed = 0, phase = 'preflight', primaryError = null;
try {
  if (required) {
    assertRequiredStorageFiles(tests);
    await preserveEvidence('source-manifest.json', sourceManifest);
    const readiness = await runStoragePreflight();
    await preserveEvidence('preflight.json', { status: 'passed', readiness });
  }
  phase = 'tests';
  for (const name of tests) {
    if (await run(name, [path.join(testDir, name)])) passed++;
  }
  process.stdout.write(`\n[tests] files passed: ${passed}/${tests.length}\n`);
  process.exitCode = passed === tests.length && evidenceErrors.length === 0 ? 0 : 1;
} catch (error) {
  process.exitCode = 1;
  primaryError = sanitizeStorageOutput(error.message);
  process.stderr.write(`[tests ${phase}] ${primaryError}\n`);
  if (required && phase === 'preflight') await preserveEvidence('preflight.json', { status: 'failed', error: primaryError });
  if (!required) throw error;
} finally {
  if (required) {
    const receipt = { status: process.exitCode || 0, phase, passed, files: tests.length, results, primaryError, evidenceErrors };
    if (!await preserveEvidence('backend-exit.json', receipt)) {
      receipt.status = 1;
      // If the disk cannot accept a receipt, retain the original statuses and
      // both failures in CI console output rather than throwing a replacement.
      process.stderr.write(`[storage receipt fallback] ${sanitizeStorageOutput(JSON.stringify(receipt))}\n`);
    }
    if (evidenceErrors.length) process.exitCode = 1;
  }
}
