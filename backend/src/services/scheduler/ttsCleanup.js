import fs from 'fs/promises';
import path from 'path';
import { getDataDir } from '../../models/db.js';

const TTS_DIR = path.join(getDataDir(), 'tts');
const MAX_AGE_DAYS = 7;

export async function cleanupOldTTSFiles() {
  try {
    const files = await fs.readdir(TTS_DIR);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(TTS_DIR, file);
      const stats = await fs.stat(filePath);
      const ageDays = (now - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

      if (ageDays > MAX_AGE_DAYS) {
        await fs.unlink(filePath);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      console.log(`🧹 TTS清理: 删除了 ${deletedCount} 个过期文件`);
    }
  } catch (error) {
    console.error('TTS文件清理失败:', error);
  }
}

let _cleanupTimer = null;

export function startTTSCleanupScheduler() {
  cleanupOldTTSFiles();

  _cleanupTimer = setInterval(cleanupOldTTSFiles, 24 * 60 * 60 * 1000);
  console.log('🧹 TTS文件清理定时任务已启动');
}

export function cleanup() {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
    console.log('🧹 TTS文件清理定时器已清理');
  }
}
