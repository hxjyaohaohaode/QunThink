import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The journal is deliberately outside each user's LowDB JSON and its backups.
// It is a single-process local adapter. Do not mount it on a shared filesystem
// or use it from multiple Node processes; production needs a transactional
// database implementation with the same prewrite/read contract.
const HEADER = 'QUNTHINK_MEMORY_DELETIONS_V1\n';
const JOURNAL = 'deletions.v1.log';
const RECEIPTS = 'deletions.v1.receipts';
const ZERO = '0'.repeat(64);
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const digest = value => createHash('sha256').update(value).digest('hex');
const barrierError = (code, detail) => Object.assign(new Error(detail), { code });

function validateId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw barrierError('INVALID_BARRIER_ID', `${label} must be a simple stable ID`);
  }
}

function parseLines(value, label) {
  if (!value.startsWith(HEADER) || !value.endsWith('\n') ||
      Buffer.byteLength(value) > MAX_FILE_BYTES) {
    throw barrierError('DELETION_BARRIER_CORRUPT', `${label} header, terminator or size invalid`);
  }
  const body = value.slice(HEADER.length, -1);
  const lines = body ? body.split('\n') : [];
  if (lines.some(line => !line)) {
    throw barrierError('DELETION_BARRIER_CORRUPT', `${label} has a blank record`);
  }
  return lines.map(line => {
    if (line.length > 512) {
      throw barrierError('DELETION_BARRIER_CORRUPT', `${label} record too large`);
    }
    try { return JSON.parse(line); } catch {
      throw barrierError('DELETION_BARRIER_CORRUPT', `${label} has malformed JSON`);
    }
  });
}

async function regularFile(io, filename) {
  let stat;
  try { stat = await io.lstat(filename); } catch (error) {
    throw barrierError('DELETION_BARRIER_UNAVAILABLE', `${path.basename(filename)} unavailable: ${error.code || error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw barrierError('DELETION_BARRIER_UNAVAILABLE', `${path.basename(filename)} is not a regular file`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw barrierError('DELETION_BARRIER_CORRUPT', `${path.basename(filename)} exceeds maximum size`);
  }
}

async function readJournal(io, directory) {
  const journalFile = path.join(directory, JOURNAL);
  const receiptsFile = path.join(directory, RECEIPTS);
  await regularFile(io, journalFile);
  await regularFile(io, receiptsFile);
  let entries, receipts;
  try {
    [entries, receipts] = await Promise.all([
      io.readFile(journalFile, 'utf8'), io.readFile(receiptsFile, 'utf8')
    ]);
  } catch (error) {
    throw barrierError('DELETION_BARRIER_UNAVAILABLE', `deletion journal unreadable: ${error.code || error.message}`);
  }
  const records = parseLines(entries, JOURNAL);
  const commits = parseLines(receipts, RECEIPTS);
  if (records.length !== commits.length) {
    throw barrierError('DELETION_BARRIER_CORRUPT', 'deletion journal lacks matching durable receipts');
  }
  const deleted = new Map();
  let previous = ZERO;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const receipt = commits[index];
    const expected = digest(`${index + 1}|${record.key}|${previous}`);
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        !receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(record).sort().join(',') !== 'hash,key,previous,sequence' ||
        !/^[a-f0-9]{64}$/.test(record.key) ||
        record.sequence !== index + 1 || record.previous !== previous ||
        record.hash !== expected ||
        Object.keys(receipt).sort().join(',') !== 'hash,sequence' ||
        receipt.sequence !== record.sequence || receipt.hash !== record.hash ||
        deleted.has(record.key)) {
      throw barrierError('DELETION_BARRIER_CORRUPT', 'deletion journal chain or receipt invalid');
    }
    deleted.set(record.key, record.sequence);
    previous = record.hash;
  }
  return { deleted, sequence: records.length, lastHash: previous };
}

async function appendAndSync(io, filename, value) {
  let handle;
  try {
    handle = await io.open(filename, 'a');
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function createFile(io, filename) {
  let handle;
  try {
    handle = await io.open(filename, 'wx');
    await handle.writeFile(HEADER, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

/**
 * Create a local single-process deletion barrier. `directory` is trusted server
 * configuration, never a request parameter; account and memory IDs do not
 * enter any pathname. `createIfMissing` is only for an explicitly fresh store.
 * An existing installation must refuse a missing journal instead of silently
 * treating deleted memories as live. The barrier directory must be included in
 * backup/restore separately from older user JSON snapshots.
 */
export function createDeletionBarrier({ directory, createIfMissing = false, storageKind = 'local', filesystem = fs } = {}) {
  if (storageKind !== 'local') {
    throw barrierError('DELETION_BARRIER_UNSUPPORTED_STORAGE', 'local deletion barrier cannot protect cloud database snapshots');
  }
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw barrierError('INVALID_BARRIER_DIRECTORY', 'deletion barrier directory must be absolute');
  }
  const root = path.resolve(directory);
  let initialized = false;
  let queue = Promise.resolve();

  async function initialize() {
    let dirStat;
    try { dirStat = await filesystem.lstat(root); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let directoryFsync = true;
    if (!dirStat) {
      if (!createIfMissing) {
        throw barrierError('DELETION_BARRIER_UNAVAILABLE', 'deletion barrier is missing; explicit fresh-store initialization required');
      }
      await filesystem.mkdir(root, { recursive: true });
      await createFile(filesystem, path.join(root, JOURNAL));
      await createFile(filesystem, path.join(root, RECEIPTS));
      // Directory fsync is not supported by every Windows filesystem. File
      // fsync is mandatory; initial directory durability must be covered by
      // the installation/backup procedure on such systems.
      try {
        const dirHandle = await filesystem.open(root, 'r');
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      } catch (error) {
        if (process.platform !== 'win32' || !['EINVAL', 'EPERM', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
        directoryFsync = false;
      }
    } else if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw barrierError('DELETION_BARRIER_UNAVAILABLE', 'deletion barrier directory is not a regular directory');
    }
    await readJournal(filesystem, root);
    initialized = true;
    return { directoryFsync };
  }

  async function read() {
    if (!initialized) throw barrierError('DELETION_BARRIER_UNAVAILABLE', 'deletion barrier not initialized');
    let dirStat;
    try { dirStat = await filesystem.lstat(root); } catch (error) {
      throw barrierError('DELETION_BARRIER_UNAVAILABLE', `deletion barrier directory unavailable: ${error.code || error.message}`);
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw barrierError('DELETION_BARRIER_UNAVAILABLE', 'deletion barrier directory was replaced');
    }
    return readJournal(filesystem, root);
  }

  function keyFor(ownerId, memoryId) {
    validateId(ownerId, 'ownerId');
    validateId(memoryId, 'memoryId');
    return digest(JSON.stringify([ownerId, memoryId]));
  }

  async function isDeleted(ownerId, memoryId) {
    const key = keyFor(ownerId, memoryId);
    return (await read()).deleted.has(key);
  }

  async function deletedIds(ownerId, memoryIds) {
    validateId(ownerId, 'ownerId');
    if (!Array.isArray(memoryIds) || memoryIds.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))) {
      throw barrierError('INVALID_BARRIER_ID', 'memoryIds must be stable IDs');
    }
    const state = await read();
    return new Set(memoryIds.filter(id => state.deleted.has(keyFor(ownerId, id))));
  }

  async function markDeleted(ownerId, memoryId) {
    const key = keyFor(ownerId, memoryId);
    const operation = queue.then(async () => {
      const state = await read();
      if (state.deleted.has(key)) {
        return { written: false, sequence: state.deleted.get(key) };
      }
      const sequence = state.sequence + 1;
      const hash = digest(`${sequence}|${key}|${state.lastHash}`);
      const record = { sequence, key, previous: state.lastHash, hash };
      const receipt = { sequence, hash };
      // The user JSON must only be modified after this method resolves.
      // A partial write makes all later reads fail closed until repaired.
      await appendAndSync(filesystem, path.join(root, JOURNAL), `${JSON.stringify(record)}\n`);
      await appendAndSync(filesystem, path.join(root, RECEIPTS), `${JSON.stringify(receipt)}\n`);
      await read();
      return { written: true, sequence };
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { initialize, isDeleted, deletedIds, markDeleted };
}
