import { getUserDb, listUserDatabases, withWriteLock } from '../models/db.js';
import { encryptApiKeyForStorage } from '../utils/apiConfigSecurity.js';
import { safeLog } from '../utils/logger.js';

export async function migrateApiConfigSecrets() {
  const userIds = new Set(await listUserDatabases());
  userIds.add('default');
  let migratedUsers = 0;
  let migratedKeys = 0;

  for (const userId of userIds) {
    const db = await getUserDb(userId);
    let userKeyCount = 0;
    await withWriteLock(userId, async () => {
      await db.read();
      const configs = db.data.aiApiConfigs;
      if (!configs || typeof configs !== 'object') return;

      for (const config of Object.values(configs)) {
        if (!config || typeof config !== 'object' || config.apiKeyEncrypted || typeof config.apiKey !== 'string' || !config.apiKey.trim()) {
          continue;
        }
        Object.assign(config, encryptApiKeyForStorage(config.apiKey));
        userKeyCount++;
      }

      if (userKeyCount > 0) await db.write();
    });

    if (userKeyCount > 0) {
      migratedUsers++;
      migratedKeys += userKeyCount;
    }
  }

  if (migratedKeys > 0) {
    safeLog('info', '[API配置迁移] 旧版明文密钥已完成加密', { migratedUsers, migratedKeys });
  }
  return { migratedUsers, migratedKeys };
}
