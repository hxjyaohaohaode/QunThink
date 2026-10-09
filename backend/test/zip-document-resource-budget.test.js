import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { parsePresentation, parseSpreadsheet, parseEpub, parseOpenDocument, parseArchive } from '../src/services/fileParser/index.js';
import { parseBoundedArchive } from '../src/services/fileParser/archiveProcess.js';
import { ARCHIVE_LIMITS } from '../src/services/fileParser/archiveBudget.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-document-budget-test-'));
test.after(() => fs.rm(directory, { recursive: true, force: true }));
async function fixture(name, entryName, content) {
  const zip = new AdmZip(); zip.addFile(entryName, Buffer.from(content));
  const file = path.join(directory, name); await fs.writeFile(file, zip.toBuffer()); return file;
}
const formats = [
  ['pptx', 'ppt/slides/slide1.xml', text => `<p:sld><a:t>${text}</a:t></p:sld>`, parsePresentation, '--- 幻灯片 1 ---\nHello 中文'],
  ['epub', 'OEBPS/chapter.xhtml', text => `<html><p>${text}</p></html>`, parseEpub, 'Hello 中文'],
  ...['odt', 'ods', 'odp'].map(ext => [ext, 'content.xml', text => `<office:document><text:p>${text}</text:p></office:document>`, parseOpenDocument, 'Hello 中文'])
];
for (const [ext, entry, wrap, parse, expected] of formats) {
  test(`${ext}: preserves normal content and rejects actual expansion and excessive output`, async () => {
    const file = await fixture(`normal.${ext}`, entry, wrap('Hello 中文'));
    assert.equal(await parse(file, `.${ext}`), expected);
    const bomb = await fixture(`bomb.${ext}`, entry, wrap('A'.repeat(12 * 1024 * 1024)));
    assert((await fs.stat(bomb)).size < 20000);
    await assert.rejects(parseBoundedArchive(bomb, { format: ext }));
    assert.match(await parse(bomb, `.${ext}`), /解析失败/);
    const output = await fixture(`output.${ext}`, entry, wrap('A'.repeat(ARCHIVE_LIMITS.outputBytes + 1)));
    await assert.rejects(parseBoundedArchive(output, { format: ext }));
  });
}
test('XLSX preserves sheet/cell text; expansion in any member rejects before ExcelJS loads', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Budget test'); sheet.addRow(['Hello 中文', 42]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const file = path.join(directory, 'normal.xlsx'); await fs.writeFile(file, buffer);
  assert.equal(await parseSpreadsheet(file, '.xlsx'), '--- Sheet: Budget test ---\nHello 中文\t42\n\n');
  const zip = new AdmZip(buffer); zip.addFile('xl/bomb.xml', Buffer.alloc(12 * 1024 * 1024, 65));
  const bomb = path.join(directory, 'bomb.xlsx'); await fs.writeFile(bomb, zip.toBuffer());
  await assert.rejects(parseBoundedArchive(bomb, { format: 'xlsx' }));
  assert.match(await parseSpreadsheet(bomb, '.xlsx'), /表格解析失败:.*budget/);
});
test('ZIP listing preserves case, never inflates contents, and bounds entries and input', async () => {
  const empty = path.join(directory, 'empty.zip'); await fs.writeFile(empty, new AdmZip().toBuffer());
  assert.match(await parseArchive(empty, '.zip'), /包含文件:/);
  const file = await fixture('list.zip', 'CaseSensitive.XML', 'A'.repeat(12 * 1024 * 1024));
  assert.match(await parseArchive(file, '.zip'), /包含文件:\nCaseSensitive\.XML/);
  const zip = new AdmZip();
  for (let i = 0; i <= ARCHIVE_LIMITS.entries; i++) zip.addFile(`item${i}`, Buffer.alloc(0));
  const many = path.join(directory, 'many.zip'); await fs.writeFile(many, zip.toBuffer());
  assert.equal(await parseArchive(many, '.zip'), '[压缩文件解析失败]');
  const oversized = path.join(directory, 'big.zip'); await fs.writeFile(oversized, Buffer.alloc(ARCHIVE_LIMITS.inputBytes + 1));
  assert.equal(await parseArchive(oversized, '.zip'), '[压缩文件解析失败]');
});
