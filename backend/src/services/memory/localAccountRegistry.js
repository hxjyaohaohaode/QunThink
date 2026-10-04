import { createHash } from 'node:crypto';
import path from 'node:path';
import { createDeletionBarrier } from './deletionBarrier.js';

const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const errorWithCode = (code, message) => Object.assign(new Error(message), { code });
const accountKey = ownerId => createHash('sha256').update(ownerId).digest('hex');
const containsPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/**
 * Local single-process registration journal for account deletion ledgers.
 * It records only owner-ID digests using the independently fsynced deletion
 * barrier format; it contains no memory text or content hash. This directory
 * must be outside the per-account ledger directories and preserved separately
 * from user JSON backups.
 *
 * A missing registry may only be created during a verified fresh deployment.
 * `allowNew` is authority from account creation/migration, never inferred from
 * an empty restored `memoryRecords` array. Once registered, a missing account
 * ledger always fails closed even if that array is empty.
 */
export function createLocalAccountRegistry({ directory, createIfMissing = false, storageKind = 'local' } = {}) {
  const registry = createDeletionBarrier({ directory, createIfMissing, storageKind });
  const registryDirectory = path.resolve(directory);
  let initialized = false;
  let queue = Promise.resolve();

  async function initialize() {
    const status = await registry.initialize();
    initialized = true;
    return status;
  }

  async function openAccount(ownerId, { ledgerDirectory, allowNew = false } = {}) {
    if (!initialized) {
      throw errorWithCode('ACCOUNT_REGISTRY_UNAVAILABLE', 'account registry not initialized');
    }
    if (typeof ownerId !== 'string' || !OWNER_PATTERN.test(ownerId)) {
      throw errorWithCode('INVALID_BARRIER_ID', 'ownerId must be a stable account ID');
    }
    if (typeof ledgerDirectory !== 'string' || !path.isAbsolute(ledgerDirectory) ||
        containsPath(registryDirectory, path.resolve(ledgerDirectory)) ||
        containsPath(path.resolve(ledgerDirectory), registryDirectory)) {
      throw errorWithCode('INVALID_BARRIER_DIRECTORY', 'account ledger must have a separate absolute directory');
    }
    const operation = queue.then(async () => {
      const key = accountKey(ownerId);
      const registered = await registry.isDeleted('account-registry', key);
      if (!registered && !allowNew) {
        throw errorWithCode('ACCOUNT_BARRIER_UNREGISTERED', 'account has no registered deletion ledger');
      }
      // Existing registered accounts can never silently create a replacement
      // ledger. Even an empty old user JSON snapshot must stop here.
      const barrier = createDeletionBarrier({
        directory: ledgerDirectory,
        createIfMissing: !registered && allowNew
      });
      await barrier.initialize();
      if (!registered) {
        // Durable registration is last: a crash before it leaves an unused
        // ledger, while a successful registration always had a valid ledger.
        await registry.markDeleted('account-registry', key);
      }
      return { barrier, newlyRegistered: !registered };
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { initialize, openAccount };
}
