import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { boundedDocxArchive, ARCHIVE_LIMITS } from '../src/services/fileParser/archiveBudget.js';
import { createArchiveParser as makeArchiveParser, parseBoundedArchive } from '../src/services/fileParser/archiveProcess.js';
import { parseWord } from '../src/services/fileParser/index.js';
import { docxFixture } from './helpers/docxFixture.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docx-budget-test-'));
test.after(() => fs.rm(directory, { recursive: true, force: true }));
const snapshotRoot = path.join(directory, 'snapshots');
await fs.mkdir(snapshotRoot);
const createArchiveParser = options => makeArchiveParser({ ...options, snapshotRoot });
async function fixture(name, bytes) { const file = path.join(directory, name); await fs.writeFile(file, bytes); return file; }
async function worker(name, body) { return pathToFileURL(await fixture(`${name}.mjs`, `process.once('message', async ({filePath}) => { ${body} });`)); }
const normal = await fixture('normal.docx', docxFixture('合法文档 🐱 normal content'));
const tempFiles = async () => (await fs.readdir(snapshotRoot)).sort();

test('normal DOCX, empty text and a substantial legitimate document retain exact text', async () => {
  assert.equal((await parseBoundedArchive(normal)).trim(), '合法文档 🐱 normal content');
  assert.equal((await parseBoundedArchive(await fixture('empty.docx', docxFixture()))).trim(), '');
  const content = '群想 valid document.\n'.repeat(12000);
  assert.equal((await parseBoundedArchive(await fixture('large-valid.docx', docxFixture(content)))).trim(), content.trim());
});

test('12MiB compressed amplification is rejected, rather than returned or truncated as success', async () => {
  const bomb = docxFixture('A'.repeat(12 * 1024 * 1024));
  assert(bomb.length < 20000);
  const file = await fixture('bomb.docx', bomb);
  await assert.rejects(parseBoundedArchive(file));
  assert.match(await parseWord(file), /Word文档解析失败:.*budget/);
});

test('output and aggregate expanded budgets reject even when each individual entry fits', async () => {
  await assert.rejects(parseBoundedArchive(await fixture('output.docx', docxFixture('A'.repeat(ARCHIVE_LIMITS.outputBytes + 1)))));
  const zip = new AdmZip(docxFixture('safe'));
  for (let i = 0; i < 3; i++) zip.addFile(`word/part${i}.xml`, Buffer.alloc(3 * 1024 * 1024, 65));
  assert.throws(() => boundedDocxArchive(zip.toBuffer()));
  const entries = new AdmZip(docxFixture('safe'));
  for (let i = 0; i < ARCHIVE_LIMITS.entries; i++) entries.addFile(`word/empty${i}`, Buffer.alloc(0));
  assert.throws(() => boundedDocxArchive(entries.toBuffer()));
});

test('actual inflation is bounded even with forged declared sizes; malformed structure and CRC fail closed', () => {
  const forged = docxFixture('A'.repeat(12 * 1024 * 1024));
  for (let at = 0; at + 46 < forged.length; at++) {
    const sig = forged.readUInt32LE(at);
    if (sig === 0x04034b50 && forged.readUInt32LE(at + 22) > ARCHIVE_LIMITS.entryBytes) forged.writeUInt32LE(1, at + 22);
    if (sig === 0x02014b50 && forged.readUInt32LE(at + 24) > ARCHIVE_LIMITS.entryBytes) forged.writeUInt32LE(1, at + 24);
  }
  assert.throws(() => boundedDocxArchive(forged));
  const valid = docxFixture('safe');
  for (const buffer of [Buffer.from('invalid'), valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from('trailing')])]) assert.throws(() => boundedDocxArchive(buffer));
  const crc = Buffer.from(valid); crc.writeUInt32LE(0, 14);
  assert.throws(() => boundedDocxArchive(crc));
  const mismatch = Buffer.from(valid); mismatch[30] ^= 1;
  assert.throws(() => boundedDocxArchive(mismatch));
});

test('timeouts, cancellation, crashes, oversize stdout and missing workers release capacity and snapshots', async () => {
  const before = await tempFiles();
  const hanging = await worker('hang', 'setInterval(() => {}, 1000);');
  const parse = createArchiveParser({ workerUrl: hanging, timeoutMs: 200, concurrency: 1 });
  const pending = parse(normal);
  await assert.rejects(parse(normal), /busy/);
  await assert.rejects(pending, /timed out/);
  await assert.rejects(parse(normal), /timed out/);
  const controller = new AbortController();
  const cancelled = createArchiveParser({ workerUrl: hanging })(normal, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(parse(normal, { signal: controller.signal }), /cancelled/);
  for (const [name, body, pattern] of [
    ['crash', 'process.exit(3);', /failed/],
    ['overflow', `process.stdout.write('A'.repeat(${ARCHIVE_LIMITS.outputBytes + 100000})); setInterval(() => {}, 1000);`, /output budget/]
  ]) {
    const failing = createArchiveParser({ workerUrl: await worker(name, body), concurrency: 1 });
    await assert.rejects(failing(normal), pattern);
    await assert.rejects(failing(normal), pattern);
  }
  const missing = createArchiveParser({ workerUrl: pathToFileURL(path.join(directory, 'missing.mjs')), concurrency: 1 });
  await assert.rejects(missing(normal));
  await assert.rejects(missing(normal));
  await assert.rejects(parseBoundedArchive(path.join(directory, 'absent.docx')));
  assert.deepEqual(await tempFiles(), before);
  assert.equal((await parseBoundedArchive(normal)).trim(), '合法文档 🐱 normal content');
});

test('child receives only a private snapshot and no application secrets', async () => {
  process.env.DOCX_TEST_SECRET = 'must-not-inherit';
  try {
    const inspect = await worker('inspect', `const fs = await import('node:fs/promises'); if (process.env.DOCX_TEST_SECRET || !filePath.includes('qunthink-docx-') || !filePath.endsWith('input.docx')) process.exit(3); await fs.access(filePath); process.stdout.write('isolated'); process.disconnect();`);
    assert.equal(await createArchiveParser({ workerUrl: inspect })(normal), 'isolated');
  } finally { delete process.env.DOCX_TEST_SECRET; }
});

test('stored ZIP entries, data descriptors and reordered central entries remain compatible', async () => {
  const original = new AdmZip(docxFixture('descriptor document'));
  const locals = [], central = [];
  let offset = 0;
  for (const entry of original.getEntries()) {
    const name = Buffer.from(entry.entryName), data = entry.getData();
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 6); header.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(entry.header.crc, 4); descriptor.writeUInt32LE(data.length, 8); descriptor.writeUInt32LE(data.length, 12);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 8); record.writeUInt32LE(entry.header.crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(header, name, data, descriptor); central.push(Buffer.concat([record, name])); offset += header.length + name.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central.reverse());
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...locals, directory, end]);
  assert.equal((await parseBoundedArchive(await fixture('descriptor.docx', bytes))).trim(), 'descriptor document');
});

 test('nonregular inputs cannot block snapshot admission or retain a slot', async () => {
  const parse = createArchiveParser({ concurrency: 1 });
  await assert.rejects(parse(directory), /regular file/);
  if (process.platform !== 'win32') {
    const link = path.join(directory, 'linked.docx');
    await fs.symlink(normal, link);
    await assert.rejects(parse(link), /regular file/);
    const fifo = path.join(directory, 'pipe.docx');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(parse(fifo), /regular file/);
  }
  assert.equal((await parse(normal)).trim(), '合法文档 🐱 normal content');
});
