import { defaultModelId, resolveModel } from '../ai/catalog.js';
import { requestCompletion } from '../ai/transport.js';
import { currentUserId } from '../userScope.js';
import { safeLog } from '../../utils/logger.js';
import { getSafeExternalRequestOptions } from '../../utils/safeExternalUrl.js';
import path from 'path';
import fs from 'fs/promises';

const VISION_ANNOTATION_PROMPT = `请仔细观察这张图片并生成搜索标注，用于聊天系统中检索。
要求：
1. 描述图片的主要内容、场景、物体、人物、动作、文字等关键信息（40字以内）
2. 提供5-8个搜索关键词标签，要有区分度，包括：核心物体、场景类型、颜色、动作、氛围、图片类型等
3. 如果图片中有文字，务必提取文字内容作为标签
格式严格如下（不要加markdown、换行或额外说明）：
描述:xxx
标签:关键字1,关键字2,关键字3`;

const TEXT_ANNOTATION_PROMPT = `请为以下文件内容生成搜索标注，用于在聊天系统中搜索。
要求：
1. 描述文件的核心主题和关键信息（不超过40字）
2. 提供3-8个搜索关键词标签，包括：主题、关键概念、文件类型用途等
格式严格如下（不要加其他内容）：
描述:xxx
标签:xxx,xxx,xxx

文件名: {filename}
文件类型: {filetype}
内容摘要:
{content}`;

function parseAnnotationResponse(response) {
  if (!response || typeof response !== 'string') return null;

  const descMatch = response.match(/描述[：:]\s*(.+)/);
  const tagsMatch = response.match(/标签[：:]\s*(.+)/);

  const description = descMatch ? descMatch[1].trim().substring(0, 60) : '';
  const tags = tagsMatch
    ? tagsMatch[1].split(/[,，、\s]/).map(t => t.trim()).filter(t => t.length > 0 && t.length <= 10).slice(0, 8)
    : [];

  if (!description && tags.length === 0) return null;

  return { description, tags };
}

function generateFallbackAnnotation(fileName, mimeType, fileSize) {
  const ext = path.extname(fileName).toLowerCase();
  const sizeStr = fileSize > 1024 * 1024
    ? `${(fileSize / (1024 * 1024)).toFixed(1)}MB`
    : `${(fileSize / 1024).toFixed(0)}KB`;

  const typeMap = {
    'image/': { desc: '图片文件', tags: ['图片', '图像'] },
    'audio/': { desc: '音频文件', tags: ['音频', '声音'] },
    'video/': { desc: '视频文件', tags: ['视频', '影像'] },
    'application/pdf': { desc: 'PDF文档', tags: ['PDF', '文档', '资料'] },
    'text/': { desc: '文本文件', tags: ['文本', '笔记'] },
    'application/vnd.openxmlformats-officedocument.wordprocessingml': { desc: 'Word文档', tags: ['Word', '文档', '报告'] },
    'application/vnd.openxmlformats-officedocument.spreadsheetml': { desc: 'Excel表格', tags: ['Excel', '表格', '数据'] },
    'application/vnd.openxmlformats-officedocument.presentationml': { desc: 'PPT演示', tags: ['PPT', '演示', '幻灯片'] },
    'application/zip': { desc: 'ZIP压缩包', tags: ['压缩包', 'ZIP', '归档'] },
    'application/gzip': { desc: 'GZ压缩包', tags: ['压缩包', 'GZ', '归档'] },
    'application/x-tar': { desc: 'TAR归档', tags: ['归档', 'TAR'] },
    'application/x-rar-compressed': { desc: 'RAR压缩包', tags: ['压缩包', 'RAR', '归档'] },
    'application/x-7z-compressed': { desc: '7z压缩包', tags: ['压缩包', '7z', '归档'] },
    'application/epub+zip': { desc: 'EPUB电子书', tags: ['电子书', 'EPUB', '阅读'] },
    'application/rtf': { desc: 'RTF文档', tags: ['RTF', '文档'] },
    'application/vnd.oasis.opendocument.text': { desc: 'ODT文档', tags: ['ODT', '文档', 'LibreOffice'] },
    'application/vnd.oasis.opendocument.spreadsheet': { desc: 'ODS表格', tags: ['ODS', '表格', 'LibreOffice'] },
    'application/vnd.oasis.opendocument.presentation': { desc: 'ODP演示', tags: ['ODP', '演示', 'LibreOffice'] },
  };

  let matched = null;
  for (const [key, val] of Object.entries(typeMap)) {
    if (mimeType.startsWith(key) || mimeType.includes(key)) {
      matched = val;
      break;
    }
  }

  const baseName = path.basename(fileName, ext);
  const nameKeywords = baseName
    .replace(/[_\-\.]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && w.length <= 10)
    .slice(0, 3);

  if (matched) {
    return {
      description: `${matched.desc}: ${baseName} (${sizeStr})`,
      tags: [...matched.tags, ...nameKeywords]
    };
  }

  return {
    description: `文件: ${baseName} (${sizeStr})`,
    tags: [ext.replace('.', ''), ...nameKeywords]
  };
}

function getFileTypeLabel(ext) {
  const labels = {
    '.pdf': 'PDF文档', '.doc': 'Word文档', '.docx': 'Word文档',
    '.xls': 'Excel表格', '.xlsx': 'Excel表格', '.csv': 'CSV数据',
    '.ppt': 'PPT演示', '.pptx': 'PPT演示',
    '.txt': '文本文件', '.md': 'Markdown文档', '.json': 'JSON数据',
    '.py': 'Python代码', '.js': 'JavaScript代码', '.ts': 'TypeScript代码',
    '.html': 'HTML页面', '.css': 'CSS样式表',
    '.zip': 'ZIP压缩包', '.rar': 'RAR压缩包', '.7z': '7z压缩包',
    '.tar': 'TAR归档', '.gz': 'GZ压缩包',
    '.epub': 'EPUB电子书', '.mobi': 'MOBI电子书',
    '.odt': 'ODT文档', '.ods': 'ODS表格', '.odp': 'ODP演示',
    '.rtf': 'RTF文档', '.log': '日志文件',
    '.dart': 'Dart代码', '.zig': 'Zig代码', '.nim': 'Nim代码',
    '.proto': 'Protocol Buffers', '.graphql': 'GraphQL定义',
    '.sql': 'SQL脚本', '.sh': 'Shell脚本',
  };
  return labels[ext] || '文件';
}

function formatFileSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

const MAX_IMAGE_ANNOTATION_BYTES = 20 * 1024 * 1024;
const VISION_TOTAL_DEADLINE_MS = 45 * 1000;

async function compressImageForAnnotation(filePath, mimeType) {
  const stats = await fs.stat(filePath);

  if (stats.size > MAX_IMAGE_ANNOTATION_BYTES) {
    safeLog('warn', '图片超过20MB，跳过压缩与视觉标注，走文本描述兜底', { filePath: path.basename(filePath), size: stats.size });
    return null;
  }

  const maxSize = 512 * 1024;

  if (stats.size <= maxSize) {
    const buffer = await fs.readFile(filePath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  try {
    const sharp = (await import('sharp')).default;
    const buffer = await sharp(filePath)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch {
    const buffer = await fs.readFile(filePath);
    const base64Data = buffer.toString('base64');
    if (base64Data.length > 2 * 1024 * 1024) {
      safeLog('warn', '图片过大跳过视觉标注', { filePath: path.basename(filePath) });
      return null;
    }
    return `data:${mimeType};base64,${base64Data}`;
  }
}

async function callFastAPI(messages, maxTokens = 120, timeout = 8000) {
  const userId = currentUserId();
  if (!userId) return null;
  try {
    const id = await defaultModelId(userId);
    const config = await resolveModel(userId, id, 'chat');
    return await requestCompletion(config, messages, { maxTokens, timeout });
  } catch { return null; }
}

async function annotateWithVision(filePath, mimeType, fileName) {
  const description = await generateImageDescription(filePath, mimeType, fileName);
  return description ? { description, tags: [getFileTypeLabel(path.extname(fileName))], source: 'vision' } : null;
}

async function annotateWithMedia(fileName, fileSize, mediaType) {
  return { description: mediaType + '文件：' + fileName + '（' + formatFileSize(fileSize) + '）；尚未解析媒体内容', tags: [mediaType], source: 'metadata' };
}

async function annotateWithText(fileName, contentSnippet, ext) {
  const snippet = contentSnippet.substring(0, 800);
  const fileType = getFileTypeLabel(ext);
  const prompt = TEXT_ANNOTATION_PROMPT
    .replace('{filename}', fileName)
    .replace('{filetype}', fileType)
    .replace('{content}', snippet);

  const content = await callFastAPI([
    { role: 'system', content: '你是一个文件搜索标注助手。你的任务是为文件生成简洁准确的搜索标注。只输出标注结果，不要多余解释。标签要具体、有区分度，便于用户搜索。' },
    { role: 'user', content: prompt }
  ]);

  return content ? parseAnnotationResponse(content) : null;
}

export async function annotateWithoutFile(fileName, mimeType, fileSize, parsedContent) {
  const ext = path.extname(fileName).toLowerCase();
  const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.amr', '.opus'].includes(ext);
  const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.3gp'].includes(ext);
  const textContent = typeof parsedContent === 'string' ? parsedContent : '';
  const hasTextContent = textContent.length > 20;

  let annotation = null;

  if (isAudio) {
    annotation = await annotateWithMedia(fileName, fileSize, '音频');
    if (!annotation && hasTextContent) {
      annotation = await annotateWithText(fileName, textContent, ext);
    }
  } else if (isVideo) {
    annotation = await annotateWithMedia(fileName, fileSize, '视频');
    if (!annotation && hasTextContent) {
      annotation = await annotateWithText(fileName, textContent, ext);
    }
  } else if (hasTextContent) {
    annotation = await annotateWithText(fileName, textContent, ext);
  }

  if (!annotation) {
    annotation = generateFallbackAnnotation(fileName, mimeType, fileSize);
  }

  if (isAudio && !annotation.tags.some(t => t.includes('音频') || t.includes('声音') || t.includes('音乐'))) {
    annotation.tags.unshift('音频');
  }
  if (isVideo && !annotation.tags.some(t => t.includes('视频') || t.includes('影像') || t.includes('影片'))) {
    annotation.tags.unshift('视频');
  }

  annotation.tags = [...new Set(annotation.tags)].slice(0, 8);
  return annotation;
}

const VISION_DESCRIPTION_PROMPT = `请详细描述这张图片的内容，包括：
1. 图片中的主要物体、人物、场景
2. 文字内容（如有）
3. 颜色、布局、风格等视觉特征
4. 图片传达的信息或情感
请用自然语言详细描述，200字以内。`;

const TEXT_DESCRIPTION_PROMPT = `请为以下文件内容生成详细描述，用于让AI理解文件内容。
文件名: {filename}
文件类型: {filetype}
内容摘要:
{content}

请描述文件的核心内容、关键信息和主要观点，200字以内。`;

async function generateImageDescription(filePath, mimeType, fileName) {
  const userId = currentUserId();
  if (!userId) return null;
  try {
    const id = await defaultModelId(userId, 'vision');
    const config = await resolveModel(userId, id, 'vision');
    const dataUrl = await compressImageForAnnotation(filePath, mimeType);
    if (!dataUrl) return null;
    return await requestCompletion(config, [{ role: 'user', content: [
      { type: 'text', text: VISION_DESCRIPTION_PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }
    ] }], { maxTokens: 500, timeout: 30000 });
  } catch (error) { safeLog('warn', '图片理解不可用', { fileName, error: error.message }); return null; }
}

async function generateAudioDescription(fileName, fileSize) {
  return '音频附件：' + fileName + '（' + formatFileSize(fileSize) + '）。当前未转录音频，无法确认其内容。';
}

async function generateVideoDescription(fileName, fileSize) {
  return '视频附件：' + fileName + '（' + formatFileSize(fileSize) + '）。当前未解析视频帧或音轨，无法确认其内容。';
}

async function generateTextDescription(fileName, contentSnippet, ext) {
  const snippet = contentSnippet.substring(0, 1500);
  const fileType = getFileTypeLabel(ext);
  const prompt = TEXT_DESCRIPTION_PROMPT
    .replace('{filename}', fileName)
    .replace('{filetype}', fileType)
    .replace('{content}', snippet);

  const content = await callFastAPI([
    { role: 'system', content: '你是一个文件内容分析助手。你的任务是为文件生成详细的内容描述，让AI能够理解文件内容。' },
    { role: 'user', content: prompt }
  ], 300, 10000);

  return content && content.trim().length > 0 ? content.trim() : null;
}

export async function generateMediaDescription(filePath, mimeType, fileName, fileSize, parsedContent, imageDescription = undefined) {
  const ext = path.extname(fileName).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif', '.heic', '.heif'].includes(ext);
  const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.amr', '.opus'].includes(ext);
  const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.3gp'].includes(ext);

  const textContent = typeof parsedContent === 'string' ? parsedContent : '';
  const hasTextContent = textContent.length > 20;

  let description = null;

  if (isImage) {
    description = imageDescription === undefined
      ? await generateImageDescription(filePath, mimeType, fileName) : imageDescription;
  } else if (isAudio) {
    description = await generateAudioDescription(fileName, fileSize);
    if (!description && hasTextContent) {
      description = await generateTextDescription(fileName, textContent, ext);
    }
  } else if (isVideo) {
    description = await generateVideoDescription(fileName, fileSize);
    if (!description && hasTextContent) {
      description = await generateTextDescription(fileName, textContent, ext);
    }
  } else if (hasTextContent) {
    description = await generateTextDescription(fileName, textContent, ext);
  }

  if (!description) {
    const sizeStr = formatFileSize(fileSize);
    const baseName = path.basename(fileName, ext);
    if (isImage) {
      description = `一张名为"${baseName}"的${ext}格式图片，文件大小约${sizeStr}`;
    } else if (isAudio) {
      description = `一个名为"${baseName}"的${ext}格式音频文件，文件大小约${sizeStr}`;
    } else if (isVideo) {
      description = `一个名为"${baseName}"的${ext}格式视频文件，文件大小约${sizeStr}`;
    } else {
      description = `一个名为"${baseName}"的文件，文件大小约${sizeStr}`;
    }
  }

  return description;
}

export async function annotateFile(filePath, mimeType, fileName, fileSize, parsedContent, imageDescription = undefined) {
  const ext = path.extname(fileName).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif', '.heic', '.heif'].includes(ext);
  const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.amr', '.opus'].includes(ext);
  const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.3gp'].includes(ext);

  const textContent = typeof parsedContent === 'string' ? parsedContent : '';
  const hasTextContent = textContent.length > 20;

  let annotation = null;

  if (isImage) {
    annotation = imageDescription === undefined
      ? await annotateWithVision(filePath, mimeType, fileName)
      : imageDescription ? { description: imageDescription, tags: [getFileTypeLabel(ext)], source: 'vision' } : null;
  } else if (isAudio) {
    annotation = await annotateWithMedia(fileName, fileSize, '音频');
    if (!annotation && hasTextContent) {
      annotation = await annotateWithText(fileName, textContent, ext);
    }
  } else if (isVideo) {
    annotation = await annotateWithMedia(fileName, fileSize, '视频');
    if (!annotation && hasTextContent) {
      annotation = await annotateWithText(fileName, textContent, ext);
    }
  } else if (hasTextContent) {
    annotation = await annotateWithText(fileName, textContent, ext);
  }

  if (!annotation) {
    annotation = generateFallbackAnnotation(fileName, mimeType, fileSize);
  }

  if (isAudio && !annotation.tags.some(t => t.includes('音频') || t.includes('声音') || t.includes('音乐'))) {
    annotation.tags.unshift('音频');
  }
  if (isVideo && !annotation.tags.some(t => t.includes('视频') || t.includes('影像') || t.includes('影片'))) {
    annotation.tags.unshift('视频');
  }
  if (isImage && !annotation.tags.some(t => t.includes('图片') || t.includes('图像') || t.includes('照片'))) {
    annotation.tags.unshift('图片');
  }

  annotation.tags = [...new Set(annotation.tags)].slice(0, 8);

  return annotation;
}

export async function annotateAndDescribe(filePath, mimeType, fileName, fileSize, parsedContent) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif', '.heic', '.heif'].includes(ext)) {
    const imageDescription = await generateImageDescription(filePath, mimeType, fileName);
    const [annotation, description] = await Promise.all([
      annotateFile(filePath, mimeType, fileName, fileSize, parsedContent, imageDescription),
      generateMediaDescription(filePath, mimeType, fileName, fileSize, parsedContent, imageDescription)
    ]);
    return { annotation, description };
  }
  const [annotation, description] = await Promise.all([
    annotateFile(filePath, mimeType, fileName, fileSize, parsedContent),
    generateMediaDescription(filePath, mimeType, fileName, fileSize, parsedContent)
  ]);
  return { annotation, description };
}
