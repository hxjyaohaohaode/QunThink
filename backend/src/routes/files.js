import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getUploadsDir, getDataDir, getUserDb, withWriteLock } from '../models/db.js';
import { parseFile } from '../services/fileParser/index.js';
import { annotateFile, annotateWithoutFile, generateMediaDescription, annotateAndDescribe } from '../services/fileAnnotation/index.js';
import { safeLog } from '../utils/logger.js';
import { getKey } from '../utils/keyManager.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const uploadBaseDir = getUploadsDir();

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
  'image/tiff', 'image/x-icon', 'image/avif', 'image/heic', 'image/heif',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown', 'text/xml', 'text/json', 'text/html', 'text/css',
  'text/x-python', 'text/x-java', 'text/x-c', 'text/x-cpp', 'text/x-go', 'text/x-rust',
  'text/x-shellscript', 'text/x-yaml', 'text/x-toml', 'text/x-ini', 'text/x-dockerfile',
  'text/x-sql', 'text/x-r', 'text/x-lua', 'text/x-scala', 'text/x-ruby', 'text/x-php', 'text/x-swift',
  'text/x-kotlin', 'text/x-vue', 'text/x-svelte', 'text/x-scss', 'text/x-less',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/x-flv', 'video/x-ms-wmv',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-ms-wma',
  'audio/x-m4a', 'audio/amr', 'audio/opus',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip', 'application/gzip', 'application/x-tar', 'application/x-rar-compressed',
  'application/x-7z-compressed', 'application/x-bzip2', 'application/x-xz',
  'application/javascript', 'application/typescript', 'application/x-python', 'application/x-java-source',
  'application/json', 'application/xml', 'application/yaml', 'application/toml',
  'application/rtf', 'application/epub+zip', 'application/x-mobipocket-ebook',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/x-sql', 'application/x-latex', 'application/x-tex',
  'application/x-protobuf', 'application/x-thrift',
  'application/octet-stream'
];

const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.vbs', '.js', '.mjs', '.cjs', '.msi', '.com', '.scr', '.dll', '.pif', '.reg', '.wsf', '.ws'];

const MAGIC_BYTES_MAP = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif': [[0x47, 0x49, 0x46]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'image/bmp': [[0x42, 0x4D]],
  'image/svg+xml': null,
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
  'application/zip': [[0x50, 0x4B, 0x03, 0x04]],
  'application/gzip': [[0x1F, 0x8B]],
  'application/x-tar': [[0x75, 0x73, 0x74, 0x61, 0x72]],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [[0x50, 0x4B, 0x03, 0x04]],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [[0x50, 0x4B, 0x03, 0x04]],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': [[0x50, 0x4B, 0x03, 0x04]],
  'application/msword': [[0xD0, 0xCF, 0x11, 0xE0]],
  'application/vnd.ms-excel': [[0xD0, 0xCF, 0x11, 0xE0]],
  'application/vnd.ms-powerpoint': [[0xD0, 0xCF, 0x11, 0xE0]],
  'video/mp4': [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]],
  'video/webm': [[0x1A, 0x45, 0xDF, 0xA3]],
  'audio/mpeg': [[0xFF, 0xFB], [0xFF, 0xF3], [0xFF, 0xF2], [0x49, 0x44, 0x33]],
  'audio/wav': [[0x52, 0x49, 0x46, 0x46]],
  'audio/ogg': [[0x4F, 0x67, 0x67, 0x53]],
  'audio/flac': [[0x66, 0x4C, 0x61, 0x43]],
};

const OFFICE_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const OFFICE_ZIP_MAX_BYTES = 50 * 1024 * 1024;
const MAX_PARSED_CONTENT_LENGTH = 100 * 1024;
const DOWNLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;
const REINDEX_MAX_FILES = 50;
const REINDEX_CONCURRENCY = 2;
const REINDEX_INTERVAL_MS = 200;

const EXTENSION_MIME_MAP = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.rar': 'application/x-rar-compressed',
};

let downloadTokenSecret = null;

function getDownloadTokenSecret() {
  if (downloadTokenSecret) {
    return downloadTokenSecret;
  }
  try {
    const key = getKey();
    if (key && key.length >= 32) {
      downloadTokenSecret = key;
      return downloadTokenSecret;
    }
  } catch (error) {
    safeLog('warn', '读取下载令牌签名密钥失败，回退到派生密钥', { error: error?.message });
  }
  console.warn('[Security] keyManager 未初始化，使用 DATA_DIR 派生的静态密钥签署下载令牌');
  downloadTokenSecret = crypto.createHash('sha256').update(`file-download-token:${getDataDir()}`).digest();
  return downloadTokenSecret;
}

function signDownloadToken(fileId, ownerId, expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS) {
  const signature = crypto.createHmac('sha256', getDownloadTokenSecret())
    .update(`${fileId}.${ownerId}.${expiresAt}`)
    .digest('base64url');
  return `${expiresAt}.${Buffer.from(String(ownerId), 'utf-8').toString('base64url')}.${signature}`;
}

function verifyDownloadToken(fileId, token) {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const expiresAt = Number(parts[0]);
  const signature = parts[2];
  let ownerId;
  try {
    ownerId = Buffer.from(parts[1], 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  if (!ownerId || !Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) {
    return null;
  }
  const expected = crypto.createHmac('sha256', getDownloadTokenSecret())
    .update(`${fileId}.${ownerId}.${expiresAt}`)
    .digest('base64url');
  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (givenBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(givenBuffer, expectedBuffer)) {
    return null;
  }
  return ownerId;
}

function validateMagicBytes(buffer, mimeType) {
  const signatures = MAGIC_BYTES_MAP[mimeType];
  if (signatures === null) return true;
  if (!signatures) return true;
  return signatures.some(sig => {
    if (buffer.length < sig.length) return false;
    return sig.every((byte, i) => buffer[i] === byte);
  });
}

function validateExtensionMimeConsistency(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return true;

  const expectedMime = EXTENSION_MIME_MAP[ext];
  if (expectedMime && expectedMime !== mimeType) {
    // Office文档精确匹配：MIME必须与扩展名一一对应
    const OFFICE_MIME_MAP = {
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const officeExpectedMime = OFFICE_MIME_MAP[ext];
    if (officeExpectedMime && mimeType === officeExpectedMime) {
      return true;
    }
    return false;
  }
  return true;
}

async function validateOfficeDocument(filePath, mimeType) {
  if (!OFFICE_MIME_TYPES.has(mimeType)) return true;
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > OFFICE_ZIP_MAX_BYTES) {
      return false;
    }
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(filePath);
    try {
      return zip.getEntries().some(entry => entry.entryName === '[Content_Types].xml');
    } finally {
      zip.entries = {};
    }
  } catch {
    // A document that cannot be structurally inspected must not be accepted
    // as an Office archive.  Failing closed prevents renamed arbitrary ZIPs
    // from reaching the background parser.
    return false;
  }
}

function toFileResponse(fileRecord) {
  return {
    id: fileRecord.id,
    group_id: fileRecord.group_id,
    filename: fileRecord.filename,
    original_name: fileRecord.filename,
    mime_type: fileRecord.mime_type,
    file_size: fileRecord.file_size,
    created_at: fileRecord.created_at,
    parse_status: fileRecord.parse_status,
    parse_error: fileRecord.parse_error || null,
    annotate_error: fileRecord.annotate_error || null,
    search_description: fileRecord.search_description || '',
    search_tags: fileRecord.search_tags || [],
    media_description: fileRecord.media_description || '',
    url: `/api/files/public/${fileRecord.id}?token=${encodeURIComponent(signDownloadToken(fileRecord.id, fileRecord.owner_user_id || fileRecord.uploader_id || 'default'))}&group_id=${encodeURIComponent(fileRecord.group_id)}`
  };
}

function getUploadDir(userId) {
  const userDir = path.join(uploadBaseDir, userId);
  if (!fs.existsSync(userDir)) {
    try {
      fs.mkdirSync(userDir, { recursive: true });
    } catch (err) {
      safeLog('warn', '上传目录创建失败', { error: err.message });
    }
  }
  return userDir;
}

function getStoredFilename(fileRecord) {
  const explicitName = typeof fileRecord.stored_filename === 'string' ? fileRecord.stored_filename : '';
  if (explicitName) {
    return path.basename(explicitName);
  }
  const originalPath = typeof fileRecord.original_path === 'string' ? fileRecord.original_path : '';
  return path.basename(originalPath);
}

function resolveStoredFilePath(fileRecord, currentUserId) {
  const ownerId = fileRecord.owner_user_id || fileRecord.uploader_id || currentUserId;
  const storedFilename = getStoredFilename(fileRecord);
  if (!ownerId || !storedFilename) {
    return null;
  }

  const uploadsRoot = path.resolve(getUploadsDir());
  const safeFilePath = path.resolve(path.join(uploadsRoot, ownerId, storedFilename));
  const relativePath = path.relative(uploadsRoot, safeFilePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  if (fs.existsSync(safeFilePath)) {
    try {
      const realRoot = fs.realpathSync(uploadsRoot);
      const realFile = fs.realpathSync(safeFilePath);
      const realRelative = path.relative(realRoot, realFile);
      if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
    } catch {
      return null;
    }
  }

  return safeFilePath;
}

async function getAccessibleFileRecord(req, fileId, groupId) {
  if (!groupId) {
    return { db: null, file: null, error: 'group_id is required', status: 400 };
  }
  const db = await req.getUserDb();
  await db.read();
  const file = db.data.files.find(f => f.id === fileId);
  if (!file) {
    return { db, file: null, error: 'File not found', status: 404 };
  }
  if (groupId && file.group_id !== groupId) {
    return { db, file: null, error: '文件不属于当前群组', status: 403 };
  }
  if (!file.group_id) {
    return { db, file: null, error: '文件缺少群组归属', status: 403 };
  }
  const group = db.data.groups.find(g => g.id === file.group_id);
  if (!group) {
    return { db, file: null, error: '群组不存在', status: 404 };
  }
  return { db, file, group, status: 200 };
}

async function removeStoredFileFromDisk(fileRecord, currentUserId) {
  const safeFilePath = resolveStoredFilePath(fileRecord, currentUserId);
  if (safeFilePath && fs.existsSync(safeFilePath)) {
    await fs.promises.unlink(safeFilePath);
  }
}

async function cleanupUploadedBatch(files) {
  for (const file of files || []) {
    if (file?.path && fs.existsSync(file.path)) {
      await fs.promises.unlink(file.path).catch(() => { });
    }
  }
}

const INLINE_DOWNLOAD_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
  '.mp4', '.webm', '.mov', '.avi', '.mkv'];

function sendFileDownload(res, file, safeFilePath) {
  const ext = path.extname(file.filename || '').toLowerCase();
  const isInline = INLINE_DOWNLOAD_EXTENSIONS.includes(ext);
  const disposition = isInline ? 'inline' : 'attachment';
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.filename || 'download')}`);
  if (!isInline) res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.sendFile(safeFilePath);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.userId || 'anonymous';
    cb(null, getUploadDir(userId));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DANGEROUS_EXTENSIONS.includes(ext)) {
      return cb(new Error('不允许上传可执行文件'));
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('不允许的文件类型'));
    }

    cb(null, true);
  }
});

router.post('/files/upload', (req, res, next) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '文件大小超过50MB限制' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: '上传文件数量超过10个限制' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  if (req.files.length > 10) {
    await cleanupUploadedBatch(req.files);
    return res.status(400).json({ error: '最多只能上传10个文件' });
  }

  const { group_id } = req.body;
  const uploaderId = req.userId;
  const uploadedFiles = [];

  if (!uploaderId) {
    await cleanupUploadedBatch(req.files);
    return res.status(401).json({ error: '未认证' });
  }

  if (!group_id || typeof group_id !== 'string') {
    await cleanupUploadedBatch(req.files);
    return res.status(400).json({ error: 'group_id is required' });
  }

  const group = db.data.groups.find(entry => entry.id === group_id);
  if (!group) {
    await cleanupUploadedBatch(req.files);
    return res.status(404).json({ error: '群组不存在' });
  }

  for (const file of req.files) {
    const filePath = file.path;
    const fileName = file.originalname;
    const mimeType = file.mimetype;

    try {
      const fd = fs.openSync(filePath, 'r');
      const headerBuf = Buffer.alloc(8);
      fs.readSync(fd, headerBuf, 0, 8, 0);
      fs.closeSync(fd);
      if (!validateMagicBytes(headerBuf, mimeType)) {
        await cleanupUploadedBatch(req.files);
        return res.status(400).json({ error: `文件内容与声明的类型 ${mimeType} 不匹配` });
      }
      if (!validateExtensionMimeConsistency(fileName, mimeType)) {
        await cleanupUploadedBatch(req.files);
        return res.status(400).json({ error: `文件扩展名与声明的类型 ${mimeType} 不匹配` });
      }
      if (!(await validateOfficeDocument(filePath, mimeType))) {
        await cleanupUploadedBatch(req.files);
        return res.status(400).json({ error: 'Office 文件结构校验失败' });
      }
    } catch (e) {
      await cleanupUploadedBatch(req.files);
      return res.status(400).json({ error: '无法读取文件进行验证' });
    }
  }

  for (const file of req.files) {
    const fileId = uuidv4();
    const filePath = file.path;
    const fileName = file.originalname;
    const fileSize = file.size;
    const mimeType = file.mimetype;

    let parsedContent = null;
    let parseError = null;
    try {
      parsedContent = await parseFile(filePath, mimeType);
    } catch (error) {
      safeLog('error', 'File parse error', { error: error?.message || error });
      parseError = error.message;
      parsedContent = `[解析失败: ${error.message}]`;
    }

    let storedParsedContent = parsedContent;
    let parsedTruncated = false;
    if (typeof parsedContent === 'string' && parsedContent.length > MAX_PARSED_CONTENT_LENGTH) {
      storedParsedContent = parsedContent.substring(0, MAX_PARSED_CONTENT_LENGTH);
      parsedTruncated = true;
    }

    let searchDescription = '';
    let searchTags = [];
    let mediaDescription = '';
    let annotateError = null;

    try {
      const textContent = typeof storedParsedContent === 'string' ? storedParsedContent : '';
      const { annotation, description } = await annotateAndDescribe(filePath, mimeType, fileName, fileSize, textContent);
      if (annotation) {
        searchDescription = annotation.description || '';
        searchTags = annotation.tags || [];
      }
      if (description) {
        mediaDescription = description;
      }
    } catch (error) {
      safeLog('error', 'File annotation/description error', { error: error?.message || error });
      annotateError = error.message;
    }

    if (!mediaDescription) {
      const ext = path.extname(fileName).toLowerCase();
      const mediaExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
        '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma',
        '.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'];
      const isMedia = mediaExts.includes(ext);
      if (isMedia) {
        const sizeStr = fileSize > 1024 * 1024
          ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB`
          : `${(fileSize / 1024).toFixed(0)}KB`;
        mediaDescription = `[媒体文件: ${fileName}, 大小: ${sizeStr}]`;
      } else if (typeof storedParsedContent === 'string' && storedParsedContent.length > 0 && !storedParsedContent.startsWith('[解析失败')) {
        mediaDescription = storedParsedContent.substring(0, 500);
      }
    }

    const fileRecord = {
      id: fileId,
      group_id,
      uploader_id: uploaderId,
      owner_user_id: uploaderId,
      filename: fileName,
      stored_filename: path.basename(filePath),
      original_path: filePath,
      file_size: fileSize,
      mime_type: mimeType,
      parsed_content: storedParsedContent,
      parsed_truncated: parsedTruncated,
      media_description: mediaDescription || '',
      search_description: searchDescription,
      search_tags: searchTags,
      parse_status: parseError ? 'error' : 'success',
      parse_error: parseError || null,
      annotate_error: annotateError || null,
      created_at: new Date().toISOString()
    };

    db.data.files.push(fileRecord);
    uploadedFiles.push(toFileResponse(fileRecord));
  }

  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  res.status(201).json(
    uploadedFiles.length === 1
      ? { file: uploadedFiles[0] }
      : { files: uploadedFiles }
  );
}));

router.get('/files/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;
  const { file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  res.json(toFileResponse(file));
}));

router.get('/files/:id/content', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;
  const { file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  res.json({ content: file.parsed_content });
}));

router.get('/files/:id/media-description', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;
  const { file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  res.json({
    id: file.id,
    filename: file.filename,
    mime_type: file.mime_type,
    media_description: file.media_description || '',
    parsed_content: typeof file.parsed_content === 'string' ? file.parsed_content.substring(0, 500) : '',
    search_description: file.search_description || '',
    search_tags: file.search_tags || []
  });
}));

router.post('/files/:id/analyze', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.body?.group_id === 'string' ? req.body.group_id : undefined;
  const { db, file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  try {
    const safeFilePath = resolveStoredFilePath(file, req.userId);
    if (!safeFilePath) {
      return res.status(403).json({ error: '禁止访问' });
    }
    const fileExists = fs.existsSync(safeFilePath);
    let mediaDescription = file.media_description || '';

    if (!mediaDescription && fileExists) {
      mediaDescription = await generateMediaDescription(
        safeFilePath,
        file.mime_type,
        file.filename,
        file.file_size,
        file.parsed_content
      );
      file.media_description = mediaDescription;
      await withWriteLock(req.userId, async () => {
        await db.write();
      });
    } else if (!mediaDescription && typeof file.parsed_content === 'string') {
      mediaDescription = file.parsed_content.substring(0, 500);
      file.media_description = mediaDescription;
      await withWriteLock(req.userId, async () => {
        await db.write();
      });
    }

    res.json({
      id: file.id,
      filename: file.filename,
      media_description: mediaDescription,
      status: 'success'
    });
  } catch (error) {
    safeLog('error', 'File analysis error', { error: error?.message || error });
    res.status(500).json({ error: '文件分析失败' });
  }
}));

// 公开签名下载：仅凭短时效 HMAC token 访问（供 <a download> 等无 cookie 场景使用）。
// 该路径在 auth 中间件白名单中，token 内编码了属主 ID，严格校验签名与时效。
router.get('/files/public/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const token = typeof req.query.token === 'string' ? req.query.token : '';

  const tokenOwnerId = verifyDownloadToken(id, token);
  if (!tokenOwnerId) {
    return res.status(401).json({ error: '下载链接无效或已过期' });
  }

  const db = await getUserDb(tokenOwnerId);
  await db.read();
  const file = db.data.files.find(f => f.id === id) || null;
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  const safeFilePath = resolveStoredFilePath(file, tokenOwnerId);
  if (!safeFilePath || !fs.existsSync(safeFilePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  sendFileDownload(res, file, safeFilePath);
}));

router.get('/files/:id/download', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;

  let file = null;
  let effectiveOwner = req.userId;

  const tokenOwnerId = token ? verifyDownloadToken(id, token) : null;
  if (tokenOwnerId) {
    const db = await getUserDb(tokenOwnerId);
    await db.read();
    file = db.data.files.find(f => f.id === id) || null;
    effectiveOwner = tokenOwnerId;
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
  } else {
    const { file: record, error, status } = await getAccessibleFileRecord(req, id, groupId);
    if (!record) {
      return res.status(status).json({ error });
    }
    const ownerUserId = record.owner_user_id || record.uploader_id;
    if (ownerUserId && ownerUserId !== req.userId) {
      return res.status(403).json({ error: '禁止访问' });
    }
    file = record;
  }

  const safeFilePath = resolveStoredFilePath(file, effectiveOwner);
  if (!safeFilePath) {
    return res.status(403).json({ error: '禁止访问' });
  }

  if (!fs.existsSync(safeFilePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  sendFileDownload(res, file, safeFilePath);
}));

router.delete('/files/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.body?.group_id === 'string' ? req.body.group_id : undefined;
  const { db, file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  db.data.files = (db.data.files || []).filter(entry => entry.id !== id);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  removeStoredFileFromDisk(file, req.userId).catch(unlinkError => {
    safeLog('warn', '删除磁盘文件失败', { fileId: id, error: unlinkError?.message });
  });

  res.json({ success: true });
}));

router.post('/files/reindex', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  const files = db.data.files || [];
  const candidates = [];

  for (const file of files) {
    if (candidates.length >= REINDEX_MAX_FILES) break;
    const hasAnyAnnotation = Boolean(
      file.search_description
      || (Array.isArray(file.search_tags) && file.search_tags.length > 0)
      || file.media_description
    );
    if (hasAnyAnnotation) continue;
    candidates.push(file);
  }

  const processReindexFile = async (file) => {
    let searchDescription = '';
    let searchTags = [];

    try {
      const safeFilePath = resolveStoredFilePath(file, req.userId);
      const fileExists = !!safeFilePath && fs.existsSync(safeFilePath);
      const textContent = typeof file.parsed_content === 'string' ? file.parsed_content : '';
      if (fileExists) {
        const annotation = await annotateFile(safeFilePath, file.mime_type, file.filename, file.file_size, textContent);
        if (annotation) {
          searchDescription = annotation.description || '';
          searchTags = annotation.tags || [];
        }
      } else if (textContent.length > 0) {
        const annotation = await annotateWithoutFile(file.filename, file.mime_type, file.file_size, textContent);
        if (annotation) {
          searchDescription = annotation.description || '';
          searchTags = annotation.tags || [];
        }
      }
    } catch (e) {
      safeLog('error', 'Reindex annotation error', { error: e.message });
    }

    if (!searchDescription && !searchTags.length) {
      const ext = path.extname(file.filename).toLowerCase();
      const sizeStr = file.file_size > 1024 * 1024
        ? `${(file.file_size / (1024 * 1024)).toFixed(1)}MB`
        : `${(file.file_size / 1024).toFixed(0)}KB`;
      const baseName = path.basename(file.filename, ext);
      searchDescription = `文件: ${baseName} (${sizeStr})`;
      searchTags = [ext.replace('.', ''), baseName.substring(0, 10)];
    }

    file.search_description = searchDescription;
    file.search_tags = searchTags;

    if (!file.media_description) {
      try {
        const safeFilePath2 = resolveStoredFilePath(file, req.userId);
        const fileExists2 = !!safeFilePath2 && fs.existsSync(safeFilePath2);
        if (fileExists2) {
          file.media_description = await generateMediaDescription(
            safeFilePath2,
            file.mime_type,
            file.filename,
            file.file_size,
            file.parsed_content
          );
        } else if (typeof file.parsed_content === 'string' && file.parsed_content.length > 0) {
          file.media_description = file.parsed_content.substring(0, 500);
        }
      } catch (e) {
        safeLog('error', 'Reindex media description error', { error: e.message });
        file.media_description = file.search_description || '';
      }
    }
  };

  let cursor = 0;
  const reindexWorker = async () => {
    while (cursor < candidates.length) {
      const file = candidates[cursor];
      cursor += 1;
      await processReindexFile(file);
      if (cursor < candidates.length) {
        await new Promise(resolve => setTimeout(resolve, REINDEX_INTERVAL_MS));
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(REINDEX_CONCURRENCY, candidates.length) }, () => reindexWorker())
  );

  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  res.json({ reindexed: candidates.length, total: files.length });
}));

export default router;
