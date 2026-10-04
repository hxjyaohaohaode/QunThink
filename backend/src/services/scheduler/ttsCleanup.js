import fs from 'fs/promises';
import path from 'path';
import { getDataDir, getUserDb, listUserDatabases } from '../../models/db.js';
import { drainAllTtsPendingDeletes } from '../ttsDeletion.js';

const TTS_DIR = path.join(getDataDir(), 'tts');
const MAX_AGE_DAYS = 7;

export async function cleanupOldTTSFiles() {
  try {
    const files = await fs.readdir(TTS_DIR);
    const now = Date.now();
    const active = new Set();
    const expiredOrphans = new Set();
    // If an owner database cannot be read, do not guess which files are safe
    // to delete. A message attachment may be older than seven days.
    for (const userId of await listUserDatabases()) {
      const db = await getUserDb(userId);
      await db.read();
      const messages = new Map((db.data.messages || []).map(message =>
        [message.id, message.metadata?.tts?.audioUrl]));
      for (const audio of db.data.ttsAudioFiles || []) {
        if (audio.messageId ? messages.get(audio.messageId) === `/api/tts/audio/${audio.filename}` :
          Number.isSafeInteger(audio.createdAt) && now - audio.createdAt < 24 * 60 * 60 * 1000) {
          active.add(audio.filename);
        } else if (!audio.messageId && Number.isSafeInteger(audio.createdAt)) {
          expiredOrphans.add(audio.filename);
        }
      }
    }
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(TTS_DIR, file);
      const stats = await fs.stat(filePath);
      const ageDays = (now - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

      if ((expiredOrphans.has(file) || ageDays > MAX_AGE_DAYS) && !active.has(file)) {
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
  const maintain = async () => {
    await drainAllTtsPendingDeletes();
    await cleanupOldTTSFiles();
  };
  void maintain();

  _cleanupTimer = setInterval(() => { void maintain(); }, 24 * 60 * 60 * 1000);
  console.log('🧹 TTS文件清理定时任务已启动');
}

export function cleanup() {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
    console.log('🧹 TTS文件清理定时器已清理');
  }
}
