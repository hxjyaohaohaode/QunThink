import pg from 'pg';
import { importLegacySlice, verifyLegacySlice } from '../src/foundations/legacySliceImport.js';

function usage() {
  throw new Error('Usage: node scripts/import-legacy-slice.mjs --snapshot-root <frozen-data-dir> --user <account-id> --schema <schema> [--dry-run | --verify] [--max-items <count>]');
}

function parseArgs(args, switches) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--snapshot-root','--user','--schema','--max-items'].includes(key) || !args[index + 1]) usage();
    if (options[key]) usage();
    options[key] = args[index + 1];
  }
  if (switches.length > 1) usage();
  if (!options['--snapshot-root'] || !options['--user'] || !options['--schema']) usage();
  const maxItems = options['--max-items'] === undefined ? Infinity : Number(options['--max-items']);
  if (maxItems !== Infinity && (!Number.isSafeInteger(maxItems) || maxItems < 0)) usage();
  return {
    snapshotRoot: options['--snapshot-root'], actorId: options['--user'], schema: options['--schema'],
    maxItems, dryRun: switches[0] === '--dry-run', verify: switches[0] === '--verify'
  };
}

const args = process.argv.slice(2);
// Switches can appear anywhere; all other arguments are key/value pairs.
const switches = args.filter(value => value === '--dry-run' || value === '--verify');
const options = parseArgs(args.filter(value => value !== '--dry-run' && value !== '--verify'), switches);
const { verify, ...importOptions } = options;
if (!options.dryRun && !process.env.QUNTHINK_PG_URL) {
  throw new Error('QUNTHINK_PG_URL is required for import or verification');
}
const pool = options.dryRun ? null : new pg.Pool({
  connectionString: process.env.QUNTHINK_PG_URL, max: 3, connectionTimeoutMillis: 10000
});
try {
  const result = verify
    ? await verifyLegacySlice(pool, importOptions)
    : await importLegacySlice(pool, importOptions);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (verify && !result.complete) process.exitCode = 2;
} finally {
  if (pool) await pool.end();
}
