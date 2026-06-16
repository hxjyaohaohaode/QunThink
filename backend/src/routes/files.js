import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { getUploadsDir, withWriteLock } from '../models/db.js';
import { parseFile } from '../services/fileParser/index.js';
import { annotateFile, annotateWithoutFile, generateMediaDescription, annotateAndDescribe } from '../services/fileAnnotation/index.js';
import { safeLog } from '../utils/logger.js';

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

const DANGEROUS_EXTENSIONS = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.vbs', '.msi', '.com', '.scr', '.dll', '.pif', '.reg', '.wsf', '.ws'];

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
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(filePath);
    const entryNames = zip.getEntries().map(e => e.entryName);
    if (!entryNames.includes('[Content_Types].xml')) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function toFileResponse(fileRecord) {
  return {
    ...fileRecord,
    original_name: fileRecord.filename,
    url: `/api/files/${fileRecord.id}/download?token=${encodeURIComponent(fileRecord.download_token || '')}&group_id=${encodeURIComponent(fileRecord.group_id)}`,
    media_description: fileRecord.media_description || ''
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
  if (!safeFilePath.startsWith(uploadsRoot)) {
    return null;
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
}, async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  if (req.files.length > 10) {
    return res.status(400).json({ error: '最多只能上传10个文件' });
  }

  const { group_id } = req.body;
  const uploaderId = req.userId;
  const uploadedFiles = [];

  if (!uploaderId) {
    return res.status(401).json({ error: '未认证' });
  }

  if (!group_id || typeof group_id !== 'string') {
    return res.status(400).json({ error: 'group_id is required' });
  }

  const group = db.data.groups.find(entry => entry.id === group_id);
  if (!group) {
    for (const file of req.files) {
      if (file?.path && fs.existsSync(file.path)) {
        await fs.promises.unlink(file.path).catch(() => { });
      }
    }
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
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: `文件内容与声明的类型 ${mimeType} 不匹配` });
      }
      if (!validateExtensionMimeConsistency(fileName, mimeType)) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: `文件扩展名与声明的类型 ${mimeType} 不匹配` });
      }
    } catch (e) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
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

    let searchDescription = '';
    let searchTags = [];
    let mediaDescription = '';
    let annotateError = null;

    try {
      const textContent = typeof parsedContent === 'string' ? parsedContent : '';
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
      } else if (typeof parsedContent === 'string' && parsedContent.length > 0 && !parsedContent.startsWith('[解析失败')) {
        mediaDescription = parsedContent.substring(0, 500);
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
      parsed_content: parsedContent,
      media_description: mediaDescription || '',
      search_description: searchDescription,
      search_tags: searchTags,
      download_token: crypto.randomBytes(16).toString('hex'),
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
});

router.get('/files/:id', async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;
  const { file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  res.json(toFileResponse(file));
});

router.get('/files/:id/content', async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;
  const { file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  res.json({ content: file.parsed_content });
});

router.get('/files/:id/media-description', async (req, res) => {
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
});

router.post('/files/:id/analyze', async (req, res) => {
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
});

router.get('/files/:id/download', async (req, res) => {
  const { id } = req.params;
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;

  if (token) {
    try {
      const db = await req.getUserDb();
      await db.read();
      const file = db.data.files.find(f => f.id === id && f.download_token === token);
      if (file) {
        const safeFilePath = resolveStoredFilePath(file, req.userId || file.uploader_id || file.owner_user_id);
        if (safeFilePath && fs.existsSync(safeFilePath)) {
          const ext = path.extname(file.filename || '').toLowerCase();
          const inlineTypes = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
            '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
            '.mp4', '.webm', '.mov', '.avi', '.mkv',
            '.txt', '.md', '.csv', '.json', '.xml', '.pdf'];
          const isInline = inlineTypes.includes(ext);
          res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
          res.setHeader('Content-Disposition', isInline ? 'inline' : 'attachment');
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.sendFile(safeFilePath);
        }
      }
      return res.status(404).json({ error: 'File not found' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  const { file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  const safeFilePath = resolveStoredFilePath(file, req.userId);
  if (!safeFilePath) {
    return res.status(403).json({ error: '禁止访问' });
  }

  if (!fs.existsSync(safeFilePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const ext = path.extname(file.filename || '').toLowerCase();
  const inlineTypes = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
    '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
    '.mp4', '.webm', '.mov', '.avi', '.mkv',
    '.txt', '.md', '.csv', '.json', '.xml', '.pdf'];
  const isInline = inlineTypes.includes(ext);

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  if (isInline) {
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(safeFilePath);
});

router.delete('/files/:id', async (req, res) => {
  const { id } = req.params;
  const groupId = typeof req.body?.group_id === 'string' ? req.body.group_id : undefined;
  const { db, file, error, status } = await getAccessibleFileRecord(req, id, groupId);
  if (!file) {
    return res.status(status).json({ error });
  }

  await removeStoredFileFromDisk(file, req.userId).catch(() => { });
  db.data.files = (db.data.files || []).filter(entry => entry.id !== id);
  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  res.json({ success: true });
});

router.post('/files/reindex', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();

    const files = db.data.files || [];
    let reindexed = 0;

    for (const file of files) {
      if (file.search_description && file.search_tags && file.media_description) continue;

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

      reindexed++;
    }

    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    res.json({ reindexed, total: files.length });
  } catch (error) {
    safeLog('error', 'File reindex error', { error: error?.message || error });
    res.status(500).json({ error: '重新索引失败' });
  }
});

export default router;
