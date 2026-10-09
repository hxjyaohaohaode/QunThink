import fs from 'fs/promises';
import path from 'path';
import { safeLog } from '../../utils/logger.js';
import { fileURLToPath } from 'url';
import pdf from 'pdf-parse';
import { parseBoundedArchive } from './archiveProcess.js';
import { parse } from 'csv-parse/sync';
import { getUploadsDir } from '../../models/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_PARSE_FILE_BYTES = 10 * 1024 * 1024;

const SENSITIVE_TEXT_EXTS = new Set(['.env', '.ini', '.conf', '.cfg', '.properties']);

const SECRET_VALUE_PATTERN = /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|access[_-]?key[_-]?id|secret[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_-]*\s*[=:]\s*)(["']?)[^\s"',;]+\2/gi;
const STANDALONE_SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|AKID[A-Za-z0-9]{10,})\b/g;

function redactSecrets(text) {
  return text
    .replace(SECRET_VALUE_PATTERN, '$1$2[REDACTED]$2')
    .replace(STANDALONE_SECRET_PATTERN, '[REDACTED]');
}

async function assertFileSizeUnder(filePath, maxBytes, label) {
  const stats = await fs.stat(filePath);
  if (stats.size > maxBytes) {
    throw new Error(`${label} 文件过大（${(stats.size / (1024 * 1024)).toFixed(1)}MB），解析上限为 ${(maxBytes / (1024 * 1024))}MB`);
  }
  return stats;
}

export async function parseFile(filePath, mimeType) {
  const resolvedPath = path.resolve(filePath);
  const allowedBaseDir = path.resolve(getUploadsDir());
  const relativeToBase = path.relative(allowedBaseDir, resolvedPath);
  if (!relativeToBase || relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
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
    } else if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.xml' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini' || ext === '.env' || ext === '.dockerfile' || ext === '.rtf' || ext === '.log' || ext === '.conf' || ext === '.cfg' || ext === '.properties' || ext === '.gradle' || ext === '.cmake' || ext === '.makefile' || ext === '.gitignore' || ext === '.editorconfig' || ext === '.prettierrc' || ext === '.eslintrc' || ext === '.babelrc' || ext === '.tsconfig' || ext === '.lock' || ext === '.map') {
      return await parseText(filePath);
    } else if (['.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss', '.less', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua', '.r', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.vue', '.svelte', '.dart', '.zig', '.nim', '.ex', '.exs', '.erl', '.hs', '.ml', '.fs', '.clj', '.lisp', '.el', '.vim', '.proto', '.thrift', '.graphql', '.prisma'].includes(ext)) {
      return await parseCode(filePath, ext);
    } else if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif', '.heic', '.heif'].includes(ext)) {
      return await parseImage(filePath, ext, mimeType);
    } else if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.amr', '.opus'].includes(ext)) {
      return await parseAudio(filePath, ext, mimeType);
    } else if (['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.3gp'].includes(ext)) {
      return await parseVideo(filePath, ext, mimeType);
    } else if (['.ppt', '.pptx'].includes(ext)) {
      return await parsePresentation(filePath, ext);
    } else if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(ext)) {
      return await parseArchive(filePath, ext);
    } else if (['.epub', '.mobi'].includes(ext)) {
      return await parseEpub(filePath, ext);
    } else if (['.odt', '.ods', '.odp'].includes(ext)) {
      return await parseOpenDocument(filePath, ext);
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
  if (ext !== '.pptx') return `[PPT文件: ${path.basename(filePath)}, 格式: ${ext.toUpperCase()}]`;
  try {
    return await parseBoundedArchive(filePath, { format: 'pptx' });
  } catch (error) {
    safeLog('error', 'Presentation parse error', { error: error?.message || error });
    return `[PPT解析失败: ${error.message}]`;
  }
}

async function parsePDF(filePath) {
  try {
    await assertFileSizeUnder(filePath, MAX_PARSE_FILE_BYTES, 'PDF');
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdf(dataBuffer);
    return data.text || '';
  } catch (error) {
    safeLog('error', 'PDF parse error', { error: error?.message || error });
    return `[PDF解析失败: ${error.message}]`;
  }
}

async function parseWord(filePath, options) {
  try {
    return await parseBoundedArchive(filePath, options);
  } catch (error) {
    safeLog('error', 'Word parse error', { error: error?.message || error });
    return /budget|busy|timed out|cancelled/.test(error.message) ? `[Word文档解析失败: ${error.message}]` : '[Word文档解析失败]';
  }
}

async function parseSpreadsheet(filePath, ext) {
  try {
    const MAX_ROWS = 10000;
    const MAX_SHEETS = 20;
    const MAX_COLUMNS = 100;

    // SheetJS (xlsx) has no maintained security release for its prototype
    // pollution/ReDoS advisories.  CSV is parsed with a bounded, synchronous
    // parser and legacy binary XLS is rejected explicitly; callers can ask
    // users to export it as XLSX.  This keeps the parser deterministic and
    // avoids silently reintroducing the vulnerable dependency.
    if (ext === '.xls') {
      return '[暂不支持旧式 XLS 文件，请另存为 XLSX 后重新上传]';
    }

    if (ext === '.csv') {
      const buffer = await fs.readFile(filePath);
      const rows = parse(buffer.toString('utf8'), {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        max_records: MAX_ROWS,
        max_record_size: 1024 * 1024
      });
      const lines = rows.map(row => row.slice(0, MAX_COLUMNS).map(value => String(value ?? '')).join('\t'));
      const truncated = rows.length >= MAX_ROWS ? `\n（仅显示前 ${MAX_ROWS} 行）` : '';
      return `--- CSV ---\n${lines.join('\n')}${truncated}`;
    }

    return await parseBoundedArchive(filePath, { format: 'xlsx' });
  } catch (error) {
    safeLog('error', 'Spreadsheet parse error', { error: error?.message || error });
    return /budget|busy|timed out|cancelled/.test(error.message) ? `[表格解析失败: ${error.message}]` : '[表格解析失败]';
  }
}

async function parseText(filePath) {
  try {
    await assertFileSizeUnder(filePath, MAX_PARSE_FILE_BYTES, '文本');
    let content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    if (SENSITIVE_TEXT_EXTS.has(ext)) {
      content = redactSecrets(content);
    }
    return content;
  } catch (error) {
    safeLog('error', 'Text parse error', { error: error?.message || error });
    return `[文本解析失败: ${error.message}]`;
  }
}

async function parseCode(filePath, ext) {
  try {
    await assertFileSizeUnder(filePath, MAX_PARSE_FILE_BYTES, '代码');
    const content = await fs.readFile(filePath, 'utf-8');
    return `\`\`\`${ext.slice(1)}\n${content}\n\`\`\``;
  } catch (error) {
    safeLog('error', 'Code parse error', { error: error?.message || error });
    return '[代码解析失败]';
  }
}

async function parseArchive(filePath, ext) {
  try {
    const stats = await fs.stat(filePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSize = stats.size > 1024 * 1024 ? `${fileSizeMB}MB` : `${(stats.size / 1024).toFixed(0)}KB`;

    let fileList = '';
    if (ext === '.zip' || ext === '.odt' || ext === '.ods' || ext === '.odp') {
      fileList = await parseBoundedArchive(filePath, { format: 'archive' });
    }

    return `[压缩文件] 名称=${path.basename(filePath)} · 格式=${ext.toUpperCase()} · 大小=${fileSize}${fileList}`;
  } catch (error) {
    safeLog('error', 'Archive parse error', { error: error?.message || error });
    return '[压缩文件解析失败]';
  }
}

async function parseEpub(filePath, ext) {
  try {
    return await parseBoundedArchive(filePath, { format: ext.slice(1) });
  } catch (error) {
    safeLog('error', 'EPUB parse error', { error: error?.message || error });
    return `[电子书解析失败: ${error.message}]`;
  }
}

async function parseOpenDocument(filePath, ext) {
  try {
    return await parseBoundedArchive(filePath, { format: ext.slice(1) });
  } catch (error) {
    safeLog('error', 'OpenDocument parse error', { error: error?.message || error });
    return `[OpenDocument解析失败: ${error.message}]`;
  }
}

export { parsePDF, parseWord, parseSpreadsheet, parseText, parseCode, parseImage, parseAudio, parseVideo, parsePresentation, parseArchive, parseEpub, parseOpenDocument };
