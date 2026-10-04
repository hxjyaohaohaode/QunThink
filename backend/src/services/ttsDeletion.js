import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataDir, getUserDb, listUserDatabases, withWriteLock } from '../models/db.js';

const ttsDir = path.join(getDataDir(), 'tts');
const validFilename = filename => typeof filename === 'string' &&
  /^tts_[a-zA-Z0-9_-]+\.(wav|mp3|ogg|flac|aac|m4a)$/.test(filename);

// Call inside the same user write transaction that removes the messages.
// Client supplied message metadata never grants ownership of a disk file.
export function revokeTtsForMessages(data, messageIds) {
  const ids = new Set(messageIds);
  const registered = data.ttsAudioFiles || [];
  const revoked = registered.filter(audio => ids.has(audio.messageId) && validFilename(audio.filename));
  // Old records had no ownership registry. Only queue files whose name
  // contains the exact server-issued message UUID and matches its metadata.
  const legacy = (data.messages || []).filter(message => ids.has(message.id) &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(message.id))
    .map(message => {
      const filename = path.basename(message.metadata?.tts?.audioUrl || '');
      return filename.startsWith(`tts_${message.id}_`) &&
        /^tts_[\da-f-]{36}_[a-z0-9]{8}\.(wav|mp3|ogg|flac|aac|m4a)$/i.test(filename) &&
        message.metadata.tts.audioUrl === `/api/tts/audio/${filename}` ? filename : null;
    }).filter(Boolean);
  const filenames = [...new Set([...revoked.map(audio => audio.filename), ...legacy])];
  if (!filenames.length) return [];
  data.ttsAudioFiles = registered.filter(audio => !ids.has(audio.messageId));
  data.ttsPendingDeletes = [...new Set([...(data.ttsPendingDeletes || []), ...filenames])];
  return filenames;
}

export async function drainTtsPendingDeletes(userId) {
  const db = await getUserDb(userId);
  await db.read();
  let pending = 0;
  for (const filename of [...(db.data.ttsPendingDeletes || [])]) {
    if (!validFilename(filename)) { pending += 1; continue; }
    try {
      await withWriteLock(userId, async () => {
        await db.read();
        if (!(db.data.ttsPendingDeletes || []).includes(filename)) return;
        if (db.data.ttsAudioFiles?.some(audio => audio.filename === filename)) {
          pending += 1;
          return;
        }
        try { await fs.unlink(path.join(ttsDir, filename)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        db.data.ttsPendingDeletes = (db.data.ttsPendingDeletes || []).filter(item => item !== filename);
        await db.write();
      });
    } catch (error) {
      pending += 1;
      console.error('[TTS] 音频磁盘删除待重试:', { userId, filename, error: error?.message });
    }
  }
  return pending;
}

export async function drainAllTtsPendingDeletes() {
  for (const userId of await listUserDatabases()) {
    try { await drainTtsPendingDeletes(userId); }
    catch (error) { console.error('[TTS] 待删音频恢复失败:', { userId, error: error?.message }); }
  }
}
