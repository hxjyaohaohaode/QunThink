import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import { parse } from 'csv-parse/sync';

export async function parseFile(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      return await parsePDF(filePath);
    } else if (ext === '.doc' || ext === '.docx') {
      return await parseWord(filePath);
    } else if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') {
      return await parseSpreadsheet(filePath, ext);
    } else if (ext === '.txt' || ext === '.md' || ext === '.json') {
      return await parseText(filePath);
    } else if (['.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.java', '.c', '.cpp', '.go', '.rs'].includes(ext)) {
      return await parseCode(filePath, ext);
    } else {
      return `[文件类型: ${ext}]`;
    }
  } catch (error) {
    console.error('File parsing error:', error);
    return `[文件解析失败: ${error.message}]`;
  }
}

async function parsePDF(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdf(dataBuffer);
    return data.text || '';
  } catch (error) {
    console.error('PDF parse error:', error);
    return '[PDF解析失败]';
  }
}

async function parseWord(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  } catch (error) {
    console.error('Word parse error:', error);
    return '[Word文档解析失败]';
  }
}

async function parseSpreadsheet(filePath, ext) {
  try {
    const buffer = await fs.readFile(filePath);
    const workbook = xlsx.read(buffer);
    
    let result = '';
    
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = xlsx.utils.sheet_to_csv(sheet);
      result += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
    }
    
    return result;
  } catch (error) {
    console.error('Spreadsheet parse error:', error);
    return '[表格解析失败]';
  }
}

async function parseText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    console.error('Text parse error:', error);
    return '[文本解析失败]';
  }
}

async function parseCode(filePath, ext) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return `\`\`\`${ext.slice(1)}\n${content}\n\`\`\``;
  } catch (error) {
    console.error('Code parse error:', error);
    return '[代码解析失败]';
  }
}
