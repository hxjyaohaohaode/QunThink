import fs from 'fs/promises';
import path from 'path';
import { safeLog } from '../../utils/logger.js';
import { fileURLToPath } from 'url';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import { parse } from 'csv-parse/sync';
import { getUploadsDir } from '../../models/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function parseFile(filePath, mimeType) {
  const resolvedPath = path.resolve(filePath);
  const allowedBaseDir = path.resolve(getUploadsDir());
  if (!resolvedPath.startsWith(allowedBaseDir)) {
    throw new Error('Invalid file path: path traversal detected');
  }

  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === '.pdf') {
      return await parsePDF(filePath);
    } else if (ext === '.doc' || ext === '.docx') {
      return await parseWord(filePath);
    } else if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') {
      return await parseSpreadsheet(filePath, ext);
    } else if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.xml' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini' || ext === '.env' || ext === '.dockerfile' || ext === '.csv') {
      return await parseText(filePath);
    } else if (['.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss', '.less', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua', '.r', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.vue', '.svelte'].includes(ext)) {
      return await parseCode(filePath, ext);
    } else if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
      return await parseImage(filePath, ext, mimeType);
    } else if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'].includes(ext)) {
      return await parseAudio(filePath, ext, mimeType);
    } else if (['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'].includes(ext)) {
      return await parseVideo(filePath, ext, mimeType);
    } else if (['.ppt', '.pptx'].includes(ext)) {
      return await parsePresentation(filePath, ext);
    } else {
      return `[文件类型: ${mimeType || ext}]`;
    }
  } catch (error) {
    safeLog('error', 'File parsing error', { error: error?.message || error });
    return `[文件解析失败: ${error.message}]`;
  }
}

async function parseImage(filePath, ext, mimeType) {
  try {
    const buffer = await fs.readFile(filePath);
    const stats = await fs.stat(filePath);
    const fileSizeKB = (stats.size / 1024).toFixed(1);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSize = stats.size > 1024 * 1024 ? `${fileSizeMB}MB` : `${fileSizeKB}KB`;

    let dimensions = '';
    try {
      const sharp = (await import('sharp')).default;
      const metadata = await sharp(buffer).metadata();
      if (metadata.width && metadata.height) {
        dimensions = ` · ${metadata.width}x${metadata.height}px`;
        if (metadata.format) ext = metadata.format;
      }
    } catch { }

    return `[图片文件] 名称=${path.basename(filePath)} · 格式=${ext.toUpperCase()} · 大小=${fileSize}${dimensions}`;
  } catch (error) {
    return `[图片解析失败: ${error.message}]`;
  }
}

async function parseAudio(filePath, ext, mimeType) {
  try {
    const stats = await fs.stat(filePath);
    const fileSizeKB = (stats.size / 1024).toFixed(1);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSize = stats.size > 1024 * 1024 ? `${fileSizeMB}MB` : `${fileSizeKB}KB`;

    return `[音频文件] 名称=${path.basename(filePath)} · 格式=${ext.toUpperCase()} · 大小=${fileSize}`;
  } catch (error) {
    return `[音频解析失败: ${error.message}]`;
  }
}

async function parseVideo(filePath, ext, mimeType) {
  try {
    const stats = await fs.stat(filePath);
    const fileSizeKB = (stats.size / 1024).toFixed(1);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSize = stats.size > 1024 * 1024 ? `${fileSizeMB}MB` : `${fileSizeKB}KB`;

    return `[视频文件] 名称=${path.basename(filePath)} · 格式=${ext.toUpperCase()} · 大小=${fileSize}`;
  } catch (error) {
    return `[视频解析失败: ${error.message}]`;
  }
}

async function parsePresentation(filePath, ext) {
  try {
    if (ext === '.pptx') {
      try {
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(filePath);
        const slideEntries = zip.getEntries()
          .filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/i))
          .sort((a, b) => {
            const na = parseInt(a.entryName.match(/slide(\d+)/i)?.[1] || '0');
            const nb = parseInt(b.entryName.match(/slide(\d+)/i)?.[1] || '0');
            return na - nb;
          });

        if (slideEntries.length > 0) {
          let result = '';
          for (const entry of slideEntries) {
            const xmlContent = entry.getData().toString('utf-8');
            const texts = [];
            const textRegex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
            let match;
            while ((match = textRegex.exec(xmlContent)) !== null) {
              if (match[1].trim()) texts.push(match[1].trim());
            }
            const slideNum = entry.entryName.match(/slide(\d+)/i)?.[1] || '?';
            if (texts.length > 0) {
              result += `--- 幻灯片 ${slideNum} ---\n${texts.join('\n')}\n\n`;
            }
          }
          if (result.trim()) return result.trim();
        }
      } catch {
        // .pptx XML解析失败，降级到占位文本
      }
    }

    // .ppt 和 .pptx 统一降级占位文本
    return `[PPT文件: ${path.basename(filePath)}, 格式: ${ext.toUpperCase()}]`;
  } catch (error) {
    safeLog('error', 'Presentation parse error', { error: error?.message || error });
    return `[PPT解析失败: ${error.message}]`;
  }
}

async function parsePDF(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdf(dataBuffer);
    return data.text || '';
  } catch (error) {
    safeLog('error', 'PDF parse error', { error: error?.message || error });
    return '[PDF解析失败]';
  }
}

async function parseWord(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  } catch (error) {
    safeLog('error', 'Word parse error', { error: error?.message || error });
    return '[Word文档解析失败]';
  }
}

async function parseSpreadsheet(filePath, ext) {
  try {
    const buffer = await fs.readFile(filePath);
    const workbook = xlsx.read(buffer);
    const MAX_ROWS = 10000;

    let result = '';
    let totalRows = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = xlsx.utils.sheet_to_csv(sheet);
      const lines = csv.split('\n');
      totalRows += lines.length;

      if (totalRows > MAX_ROWS) {
        const remaining = MAX_ROWS - (totalRows - lines.length);
        if (remaining > 0) {
          const truncated = lines.slice(0, remaining).join('\n');
          result += `--- Sheet: ${sheetName} ---\n${truncated}\n\n`;
        }
        result = `解析表格（共${totalRows}行，仅显示前${MAX_ROWS}行）：\n${result}`;
        return result;
      }

      result += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
    }

    return result;
  } catch (error) {
    safeLog('error', 'Spreadsheet parse error', { error: error?.message || error });
    return '[表格解析失败]';
  }
}

async function parseText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    safeLog('error', 'Text parse error', { error: error?.message || error });
    return '[文本解析失败]';
  }
}

async function parseCode(filePath, ext) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return `\`\`\`${ext.slice(1)}\n${content}\n\`\`\``;
  } catch (error) {
    safeLog('error', 'Code parse error', { error: error?.message || error });
    return '[代码解析失败]';
  }
}

export { parsePDF, parseWord, parseSpreadsheet, parseText, parseCode, parseImage, parseAudio, parseVideo, parsePresentation };
