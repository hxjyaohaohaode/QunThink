import axios from 'axios';
import { getAIConfig } from '../ai/index.js';
import { safeLog } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs/promises';

const VISION_ANNOTATION_PROMPT = `请为这张图片生成搜索标注，用于在聊天系统中搜索。
要求：
1. 描述图片的主要内容、场景、物体、文字等关键信息（不超过40字）
2. 提供3-8个搜索关键词标签，包括：物体、场景、颜色、情感、文字内容等
格式严格如下（不要加其他内容）：
描述:xxx
标签:xxx,xxx,xxx`;

const MEDIA_ANNOTATION_PROMPT = `请为以下{mediaType}文件生成搜索标注，用于在聊天系统中搜索。
根据文件名和文件大小推断可能的{mediaType}内容。
要求：
1. 描述{mediaType}的可能内容类型、主题、用途（不超过40字）
2. 提供3-8个搜索关键词标签，包括：内容类型、主题、情感、场景等
格式严格如下（不要加其他内容）：
描述:xxx
标签:xxx,xxx,xxx

文件名: {filename}
文件大小: {fileSize}`;

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
  };
  return labels[ext] || '文件';
}

function formatFileSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

async function compressImageForAnnotation(filePath, mimeType) {
  const stats = await fs.stat(filePath);
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

function getFastAnnotationConfigs() {
  const configs = [
    { key: process.env.GLM_API_KEY, endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
    { key: process.env.MIMO_API_KEY, endpoint: process.env.MIMO_BASE_URL ? `${process.env.MIMO_BASE_URL}/chat/completions` : 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5' },
    { key: process.env.QWEN_API_KEY, endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen3.5-flash' },
    { key: process.env.DEEPSEEK_API_KEY, endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' }
  ];
  return configs.filter(c => c.key);
}

async function callFastAPI(messages, maxTokens = 120, timeout = 8000) {
  const configs = getFastAnnotationConfigs();
  if (configs.length === 0) return null;

  for (const config of configs) {
    try {
      const response = await axios.post(
        config.endpoint,
        {
          model: config.model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.2,
          stream: false
        },
        {
          headers: {
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json'
          },
          timeout
        }
      );
      const content = response.data?.choices?.[0]?.message?.content;
      if (content && content.trim().length > 0) return content;
    } catch (error) {
      safeLog('warn', `快速标注API调用失败(${config.model})`, { error: error.message });
    }
  }
  return null;
}

async function annotateWithVision(filePath, mimeType, fileName) {
  const dataUrl = await compressImageForAnnotation(filePath, mimeType);
  if (!dataUrl) return null;

  const visionModels = ['glm_4v_flash', 'qwen_vl_plus', 'mimo_omni', 'qwen_omni'];
  for (const modelId of visionModels) {
    const config = getAIConfig(modelId);
    if (!config || !config.apiKey) continue;

    try {
      const requestBody = {
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_ANNOTATION_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        max_tokens: 150,
        temperature: 0.2
      };

      const response = await axios.post(config.endpoint, requestBody, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (content) {
        const parsed = parseAnnotationResponse(content);
        if (parsed) return parsed;
      }
    } catch (error) {
      safeLog('warn', `视觉标注失败(${modelId})`, { error: error.message, fileName });
    }
  }
  return null;
}

async function annotateWithMedia(fileName, fileSize, mediaType) {
  const omniModels = ['qwen_omni'];
  for (const modelId of omniModels) {
    const config = getAIConfig(modelId);
    if (!config || !config.apiKey) continue;

    try {
      const prompt = MEDIA_ANNOTATION_PROMPT
        .replace(/\{mediaType\}/g, mediaType)
        .replace('{filename}', fileName)
        .replace('{fileSize}', formatFileSize(fileSize));

      const response = await axios.post(config.endpoint, {
        model: config.model,
        messages: [
          { role: 'system', content: `你是一个文件搜索标注助手。根据文件名和大小推断${mediaType}内容，生成简洁准确的搜索标注。只输出标注结果，不要多余解释。` },
          { role: 'user', content: prompt }
        ],
        max_tokens: 120,
        temperature: 0.2
      }, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (content) {
        const parsed = parseAnnotationResponse(content);
        if (parsed) return parsed;
      }
    } catch (error) {
      safeLog('warn', `媒体标注失败(${modelId})`, { error: error.message });
    }
  }

  const prompt = MEDIA_ANNOTATION_PROMPT
    .replace(/\{mediaType\}/g, mediaType)
    .replace('{filename}', fileName)
    .replace('{fileSize}', formatFileSize(fileSize));

  const content = await callFastAPI([
    { role: 'system', content: `你是一个文件搜索标注助手。根据文件名和大小推断${mediaType}内容，生成简洁准确的搜索标注。只输出标注结果，不要多余解释。` },
    { role: 'user', content: prompt }
  ]);

  return content ? parseAnnotationResponse(content) : null;
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
  const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'].includes(ext);
  const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'].includes(ext);
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

const AUDIO_DESCRIPTION_PROMPT = `这是一个音频文件，请根据文件名和大小推断其可能的内容。
文件名: {filename}
文件大小: {fileSize}
请描述这个音频可能包含的内容，包括：
1. 可能的音频类型（音乐、语音、环境音等）
2. 可能的主题或内容
3. 可能的用途或场景
请用自然语言描述，100字以内。`;

const VIDEO_DESCRIPTION_PROMPT = `这是一个视频文件，请根据文件名和大小推断其可能的内容。
文件名: {filename}
文件大小: {fileSize}
请描述这个视频可能包含的内容，包括：
1. 可能的视频类型（电影片段、教程、动画等）
2. 可能的主题或场景
3. 可能的用途
请用自然语言描述，100字以内。`;

const TEXT_DESCRIPTION_PROMPT = `请为以下文件内容生成详细描述，用于让AI理解文件内容。
文件名: {filename}
文件类型: {filetype}
内容摘要:
{content}

请描述文件的核心内容、关键信息和主要观点，200字以内。`;

async function generateImageDescription(filePath, mimeType, fileName) {
  const dataUrl = await compressImageForAnnotation(filePath, mimeType);
  if (!dataUrl) return null;

  const visionModels = ['glm_4v_flash', 'qwen_vl_plus', 'mimo_omni', 'qwen_omni'];
  for (const modelId of visionModels) {
    const config = getAIConfig(modelId);
    if (!config || !config.apiKey) continue;

    try {
      const requestBody = {
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_DESCRIPTION_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        max_tokens: 300,
        temperature: 0.3
      };

      const response = await axios.post(config.endpoint, requestBody, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (content && content.trim().length > 0) return content.trim();
    } catch (error) {
      safeLog('warn', `图片内容描述生成失败(${modelId})`, { error: error.message, fileName });
    }
  }
  return null;
}

async function generateAudioDescription(fileName, fileSize) {
  const omniModels = ['qwen_omni'];
  for (const modelId of omniModels) {
    const config = getAIConfig(modelId);
    if (!config || !config.apiKey) continue;

    try {
      const prompt = AUDIO_DESCRIPTION_PROMPT
        .replace('{filename}', fileName)
        .replace('{fileSize}', formatFileSize(fileSize));

      const response = await axios.post(config.endpoint, {
        model: config.model,
        messages: [
          { role: 'system', content: '你是一个音频内容分析助手。根据文件信息推断音频内容，生成详细描述。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.3
      }, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (content && content.trim().length > 0) return content.trim();
    } catch (error) {
      safeLog('warn', `音频描述生成失败(${modelId})`, { error: error.message });
    }
  }

  const prompt = AUDIO_DESCRIPTION_PROMPT
    .replace('{filename}', fileName)
    .replace('{fileSize}', formatFileSize(fileSize));

  const content = await callFastAPI([
    { role: 'system', content: '你是一个音频内容分析助手。根据文件信息推断音频内容，生成详细描述。' },
    { role: 'user', content: prompt }
  ], 200, 8000);

  return content && content.trim().length > 0 ? content.trim() : null;
}

async function generateVideoDescription(fileName, fileSize) {
  const omniModels = ['qwen_omni'];
  for (const modelId of omniModels) {
    const config = getAIConfig(modelId);
    if (!config || !config.apiKey) continue;

    try {
      const prompt = VIDEO_DESCRIPTION_PROMPT
        .replace('{filename}', fileName)
        .replace('{fileSize}', formatFileSize(fileSize));

      const response = await axios.post(config.endpoint, {
        model: config.model,
        messages: [
          { role: 'system', content: '你是一个视频内容分析助手。根据文件信息推断视频内容，生成详细描述。' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.3
      }, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (content && content.trim().length > 0) return content.trim();
    } catch (error) {
      safeLog('warn', `视频描述生成失败(${modelId})`, { error: error.message });
    }
  }

  const prompt = VIDEO_DESCRIPTION_PROMPT
    .replace('{filename}', fileName)
    .replace('{fileSize}', formatFileSize(fileSize));

  const content = await callFastAPI([
    { role: 'system', content: '你是一个视频内容分析助手。根据文件信息推断视频内容，生成详细描述。' },
    { role: 'user', content: prompt }
  ], 200, 8000);

  return content && content.trim().length > 0 ? content.trim() : null;
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

export async function generateMediaDescription(filePath, mimeType, fileName, fileSize, parsedContent) {
  const ext = path.extname(fileName).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
  const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'].includes(ext);
  const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'].includes(ext);

  const textContent = typeof parsedContent === 'string' ? parsedContent : '';
  const hasTextContent = textContent.length > 20;

  let description = null;

  if (isImage) {
    description = await generateImageDescription(filePath, mimeType, fileName);
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
      description = `[图片文件: ${baseName}, 格式: ${ext}, 大小: ${sizeStr}]`;
    } else if (isAudio) {
      description = `[音频文件: ${baseName}, 格式: ${ext}, 大小: ${sizeStr}]`;
    } else if (isVideo) {
      description = `[视频文件: ${baseName}, 格式: ${ext}, 大小: ${sizeStr}]`;
    } else {
      description = `[文件: ${baseName}, 大小: ${sizeStr}]`;
    }
  }

  return description;
}

export async function annotateFile(filePath, mimeType, fileName, fileSize, parsedContent) {
  const ext = path.extname(fileName).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
  const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'].includes(ext);
  const isVideo = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv'].includes(ext);

  const textContent = typeof parsedContent === 'string' ? parsedContent : '';
  const hasTextContent = textContent.length > 20;

  let annotation = null;

  if (isImage) {
    annotation = await annotateWithVision(filePath, mimeType, fileName);
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
  const [annotation, description] = await Promise.all([
    annotateFile(filePath, mimeType, fileName, fileSize, parsedContent),
    generateMediaDescription(filePath, mimeType, fileName, fileSize, parsedContent)
  ]);
  return { annotation, description };
}
