import 'dotenv/config';
// Stop and drain every application writer before invoking this offline entry.
import { initializeEmptyInstallation, migrateLegacyUserDatabase, migrateExistingData, restoreAccountGenerations } from '../src/models/db.js';
import { closeSupabaseConnection } from '../src/models/supabaseAdapter.js';
import { closeMongoConnection } from '../src/models/mongoAdapter.js';

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  if (['prepare-restore-rotation', 'apply-restore-rotation', 'verify-restore-rotation'].includes(command)) {
    const [owner, planFile, ...flags] = args, operation = command.split('-')[0];
    const valid = operation === 'apply' ? flags.length === 3 && flags[0] === '--apply' && /^[0-9a-f]{64}$/.test(flags[1]) && flags[2] === '--writers-stopped'
      : flags.length === 1 && flags[0] === '--writers-stopped';
    if (!valid) throw Object.assign(new Error('Explicit stopped-writer confirmation and exact plan hash are required'), { code: 'RESTORE_OPTIONS_INVALID' });
    result = await restoreAccountGenerations(owner, { operation, planFile, writersStopped: true, ...(operation === 'apply' ? { expectedPlanSha: flags[1] } : {}) });
    if (result.outcome === 'unconfirmed') process.exitCode = 2;
  } else if (command === 'init-empty' && args.length === 0) result = await initializeEmptyInstallation();
  else if (command === 'migrate-account' || command === 'import-legacy') {
    let userId;
    if (command === 'migrate-account') userId = args.shift();
    const options = {};
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--apply' || !/^[0-9a-f]{64}$/.test(args[1])) throw new Error('Use --apply SOURCE_HASH from dry-run');
      options.apply = true; options.expectedSourceHash = args[1];
    }
    result = command === 'migrate-account' ? await migrateLegacyUserDatabase(userId, options) : await migrateExistingData(options);
  } else throw new Error('Usage: node scripts/account-store-maintenance.mjs init-empty | migrate-account USER_ID [--apply SOURCE_HASH] | import-legacy [--apply SOURCE_HASH]');
  console.log(JSON.stringify(result));
} catch (error) {
  const restoration = command?.endsWith('-restore-rotation');
  console.error(JSON.stringify({ code: typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'MAINTENANCE_FAILED',
    message: restoration ? 'Restore rotation not confirmed. Keep writers stopped and inspect the original plan and receipt.' : error.message }));
  process.exitCode = 1;
} finally { await closeSupabaseConnection(); await closeMongoConnection(); }
