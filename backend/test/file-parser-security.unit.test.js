import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseSpreadsheet } from '../src/services/fileParser/index.js';

test('spreadsheet parser handles bounded XLSX without vulnerable SheetJS', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunxiang-parser-'));
  const filePath = path.join(tempDir, 'sample.xlsx');
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('安全测试');
    sheet.addRow(['标题', '值']);
    sheet.addRow(['hello', 42]);
    await fs.writeFile(filePath, await workbook.xlsx.writeBuffer());

    const parsed = await parseSpreadsheet(filePath, '.xlsx');
    assert.match(parsed, /安全测试/);
    assert.match(parsed, /hello/);
    assert.match(parsed, /42/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('legacy binary XLS is rejected with an actionable conversion message', async () => {
  const parsed = await parseSpreadsheet('legacy.xls', '.xls');
  assert.match(parsed, /另存为 XLSX/);
});
