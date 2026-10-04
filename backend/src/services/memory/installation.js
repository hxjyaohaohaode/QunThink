import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalAccountRegistry } from './localAccountRegistry.js';

const VERSION = 1;

async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function freshLocalData(authDb, dataDir) {
  if (!Array.isArray(authDb.data?.users) || authDb.data.users.length) return false;
  const usersDir = path.join(dataDir, 'users');
  let files;
  try { files = await fs.readdir(usersDir); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (files.some(file => /^db_(?!default\.json$).+\.json$/.test(file))) return false;
  if (!files.includes('db_default.json')) return true;
  const data = JSON.parse(await fs.readFile(path.join(usersDir, 'db_default.json'), 'utf8'));
  return Array.isArray(data.messages) && data.messages.length === 0 &&
    (!Array.isArray(data.memoryRecords) || data.memoryRecords.length === 0);
}

/**
 * Called before the HTTP server accepts requests. A new registry is created
 * automatically only when the local auth and user stores have no user data.
 * Existing installations with a missing registry stay unavailable until an
 * audited migration; an environment toggle cannot erase this distinction.
 */
export async function prepareLocalMemoryRegistry(authDb, { dataDir, root } = {}) {
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(root)) {
    throw new Error('memory data and registry paths must be absolute');
  }
  const resolvedRoot = path.resolve(root);
  const registryDir = path.join(resolvedRoot, 'registry');
  const installed = authDb.data?.memoryBarrierInstallation;
  if (installed && (installed.version !== VERSION || installed.root !== resolvedRoot)) {
    throw new Error('memory barrier installation marker does not match the configured ledger');
  }
  const registryExists = await exists(registryDir);
  let createIfMissing = false;
  if (!registryExists) {
    if (installed || !(await freshLocalData(authDb, dataDir))) {
      return { ready: false, reason: 'migration_required' };
    }
    const entries = (await exists(resolvedRoot)) ? await fs.readdir(resolvedRoot) : [];
    if (entries.length) return { ready: false, reason: 'registry_missing_with_existing_ledgers' };
    createIfMissing = true;
  }
  const registry = createLocalAccountRegistry({ directory: registryDir, createIfMissing });
  await registry.initialize();
  if (!installed) {
    const previous = authDb.data.memoryBarrierInstallation;
    authDb.data.memoryBarrierInstallation = {
      version: VERSION, root: resolvedRoot, installedAt: new Date().toISOString()
    };
    try { await authDb.write(); }
    catch (error) {
      authDb.data.memoryBarrierInstallation = previous;
      throw error;
    }
  }
  return { ready: true, created: createIfMissing };
}
