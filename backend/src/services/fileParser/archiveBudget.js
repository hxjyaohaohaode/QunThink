import { inflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';

export const ARCHIVE_LIMITS = Object.freeze({
  inputBytes: 10 * 1024 * 1024,
  entryBytes: 4 * 1024 * 1024,
  expandedBytes: 8 * 1024 * 1024,
  entries: 512,
  outputBytes: 1024 * 1024,
  timeoutMs: 5000,
  concurrency: 2
});
const overBudget = () => { const error = new Error('Document resource budget exceeded'); error.code = 'DOCUMENT_BUDGET'; throw error; };
const fail = () => { throw new Error('Invalid or over-budget document archive'); };
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// Validate actual inflated bytes, not just attacker-controlled ZIP metadata.
// Rebuild the archive so Mammoth cannot interpret a second, conflicting local
// directory, duplicate name, hidden entry, or unvalidated compressed payload.
export function boundedZipArchive(buffer, { requiredEntry, listOnly = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail();
  if (buffer.length > ARCHIVE_LIMITS.inputBytes) overBudget();
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { end = at; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) fail();
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralStart = buffer.readUInt32LE(end + 16);
  if (count > ARCHIVE_LIMITS.entries) overBudget();
  if ((!count && !listOnly) || count !== buffer.readUInt16LE(end + 8) || centralStart + centralSize !== end) fail();
  const names = new Set();
  const originalNames = [];
  const canonical = new AdmZip();
  let central = centralStart;
  const ranges = [];
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (central + 46 > end || buffer.readUInt32LE(central) !== 0x02014b50) fail();
    const flags = buffer.readUInt16LE(central + 8);
    const method = buffer.readUInt16LE(central + 10);
    const crc = buffer.readUInt32LE(central + 16);
    const compressedSize = buffer.readUInt32LE(central + 20);
    const size = buffer.readUInt32LE(central + 24);
    const nameSize = buffer.readUInt16LE(central + 28);
    const extraSize = buffer.readUInt16LE(central + 30);
    const commentSize = buffer.readUInt16LE(central + 32);
    const local = buffer.readUInt32LE(central + 42);
    if (!listOnly && (size > ARCHIVE_LIMITS.entryBytes || expanded + size > ARCHIVE_LIMITS.expandedBytes)) overBudget();
    if (flags & ~0x080e || ![0, 8].includes(method) || buffer.readUInt16LE(central + 34) ||
        central + 46 + nameSize + extraSize + commentSize > end || local + 30 > centralStart) fail();
    const nameBytes = buffer.subarray(central + 46, central + 46 + nameSize);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.includes(':') ||
        name.split('/').some(part => part === '..' || part === '.') || names.has(name.toLowerCase())) fail();
    names.add(name.toLowerCase());
    originalNames.push(name);
    if (buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method) fail();
    const localNameSize = buffer.readUInt16LE(local + 26);
    const start = local + 30 + localNameSize + buffer.readUInt16LE(local + 28);
    if (localNameSize !== nameSize || !buffer.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes) || start + compressedSize > centralStart) fail();
    if (!(flags & 8) && (buffer.readUInt32LE(local + 14) !== crc || buffer.readUInt32LE(local + 18) !== compressedSize || buffer.readUInt32LE(local + 22) !== size)) fail();
    let bytes;
    if (!listOnly) {
      const compressed = buffer.subarray(start, start + compressedSize);
      const remaining = Math.min(ARCHIVE_LIMITS.entryBytes, ARCHIVE_LIMITS.expandedBytes - expanded);
      const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, remaining), info: true });
      bytes = method === 0 ? data : data.buffer;
      if ((method === 8 && data.engine.bytesWritten !== compressedSize) || bytes.length > remaining || bytes.length !== size || crc32(bytes) !== crc) fail();
      expanded += bytes.length;
    }
    let localEnd = start + compressedSize;
    if (flags & 8) {
      if (localEnd + 12 > centralStart) fail();
      if (buffer.readUInt32LE(localEnd) === 0x08074b50) localEnd += 4;
      if (localEnd + 12 > centralStart || buffer.readUInt32LE(localEnd) !== crc || buffer.readUInt32LE(localEnd + 4) !== compressedSize || buffer.readUInt32LE(localEnd + 8) !== size) fail();
      localEnd += 12;
    }
    ranges.push([local, localEnd]);
    if (!listOnly) canonical.addFile(name, bytes);
    central += 46 + nameSize + extraSize + commentSize;
  }
  let localEnd = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start !== localEnd) fail();
    localEnd = end;
  }
  if (central !== end || localEnd !== centralStart || (requiredEntry && !names.has(requiredEntry))) fail();
  return listOnly ? originalNames : canonical.toBuffer();
}

export const boundedDocxArchive = buffer => boundedZipArchive(buffer, { requiredEntry: 'word/document.xml' });
