// Maintenance metadata lives outside account backups. Never delete uncertain receipts.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { restoreError, restoreDigest, RESTORE_UUID, exactRestoreFields, validateRestorePlan } from './accountGenerationRestore.js';
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2048;
export const restoreAttemptRoot = dataDir => path.join(path.resolve(dataDir), 'account-restore-attempts-v1');
export const restoreOwnerDirectory = (dataDir, owner) => path.join(restoreAttemptRoot(dataDir), restoreDigest(owner));

// Check all path components, then inspect the actual opened descriptor. The
// maintenance tree is trusted operator storage, not an adversarial filesystem.
export async function restoreDirectory(directory, { create = false, io = fs } = {}) {
  const absolute = path.resolve(directory), parent = path.dirname(absolute);
  if (parent !== absolute && !(await restoreDirectory(parent, { create: false, io }))) return false;
  let stat;
  try { stat = await io.lstat(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return false;
    try { await io.mkdir(absolute, { mode: 0o700 }); }
    catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
    stat = await io.lstat(absolute);
    await syncRestoreDirectory(parent, io);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw restoreError('RESTORE_PATH_INVALID');
  return true;
}
export async function syncRestoreDirectory(directory, io = fs) {
  let handle;
  try {
    handle = await io.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isDirectory()) throw restoreError('RESTORE_PATH_INVALID');
    await handle.sync();
  } finally { await handle?.close(); }
}
export async function readRestoreFile(filename, { maxBytes = MAX_PLAN_BYTES, io = fs } = {}) {
  if (!(await restoreDirectory(path.dirname(path.resolve(filename)), { io }))) throw restoreError('RESTORE_PATH_INVALID');
  let handle;
  try {
    handle = await io.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw restoreError('RESTORE_FILE_INVALID');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > maxBytes) throw restoreError('RESTORE_FILE_INVALID');
    return bytes;
  } finally { await handle?.close(); }
}
export async function writeRestoreFile(filename, value, { maxBytes = MAX_PLAN_BYTES, io = fs } = {}) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > maxBytes) throw restoreError('RESTORE_FILE_INVALID');
  const parent = path.dirname(path.resolve(filename));
  if (!(await restoreDirectory(parent, { io }))) throw restoreError('RESTORE_PATH_INVALID');
  let handle;
  try {
    handle = await io.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (!(await handle.stat()).isFile()) throw restoreError('RESTORE_FILE_INVALID');
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle?.close(); }
  await syncRestoreDirectory(parent, io);
  return restoreDigest(bytes);
}
export async function readRestorePlan(filename, owner, expectedSha) {
  const bytes = await readRestoreFile(filename), sha = restoreDigest(bytes);
  if (expectedSha !== undefined && (!/^[0-9a-f]{64}$/.test(expectedSha) || sha !== expectedSha)) throw restoreError('RESTORE_PLAN_HASH_MISMATCH');
  let plan;
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { throw restoreError('RESTORE_PLAN_INVALID'); }
  validateRestorePlan(plan, owner);
  return { plan, sha };
}
function receiptFor(plan, sha) {
  return { version: 1, owner_id: plan.owner_id, request_id: plan.request_id, plan_sha: sha, source_hash: plan.source_hash, target_hash: plan.target_hash };
}
export async function inspectRestoreAttempts(dataDir, owner, selected = null, { io = fs } = {}) {
  const root = restoreAttemptRoot(dataDir);
  if (!(await restoreDirectory(root, { io }))) return false;
  const directory = restoreOwnerDirectory(dataDir, owner);
  if (!(await restoreDirectory(directory, { io }))) return false;
  const names = await io.readdir(directory);
  if (!names.length) return false;
  if (!selected || names.length !== 1 || names[0] !== `${selected.plan.request_id}.json`) throw restoreError('RESTORE_ATTEMPT_EXISTS');
  if (!RESTORE_UUID.test(names[0].slice(0, -5))) throw restoreError('RESTORE_ATTEMPT_INVALID');
  let receipt;
  try { receipt = JSON.parse((await readRestoreFile(path.join(directory, names[0]), { maxBytes: MAX_RECEIPT_BYTES, io })).toString('utf8')); }
  catch (error) { throw restoreError('RESTORE_ATTEMPT_INVALID', error); }
  const expected = receiptFor(selected.plan, selected.sha);
  try { exactRestoreFields(receipt, Object.keys(expected)); }
  catch (error) { throw restoreError('RESTORE_ATTEMPT_INVALID', error); }
  if (Object.keys(expected).some(key => receipt[key] !== expected[key])) throw restoreError('RESTORE_ATTEMPT_INVALID');
  return true;
}
export async function createRestoreAttempt(dataDir, selected, { io = fs } = {}) {
  const { plan, sha } = selected, root = restoreAttemptRoot(dataDir), directory = restoreOwnerDirectory(dataDir, plan.owner_id);
  if (!(await restoreDirectory(root, { create: true, io })) || !(await restoreDirectory(directory, { create: true, io }))) throw restoreError('RESTORE_PATH_INVALID');
  // Sync existing directory entries too: an earlier failed mkdir fsync cannot
  // become presumed durable on this invocation.
  await syncRestoreDirectory(path.dirname(root), io); await syncRestoreDirectory(root, io); await syncRestoreDirectory(directory, io);
  await writeRestoreFile(path.join(directory, `${plan.request_id}.json`), receiptFor(plan, sha), { maxBytes: MAX_RECEIPT_BYTES, io });
}
