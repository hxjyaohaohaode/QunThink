import 'dotenv/config';
import fs from 'node:fs/promises';
import pg from 'pg';
import { buildPostgresTlsConfig } from '../src/models/postgresTls.js';
import { installPostgresLedger } from '../src/services/memory/postgresLedgerInstallation.js';

// Run with ALL application instances stopped and backups preserved.
const [mode, filename] = process.argv.slice(2);
if (!['--fresh', '--import-verified-history'].includes(mode) ||
    (mode === '--import-verified-history' && !filename)) {
  console.error('Usage: node scripts/install-postgres-memory-ledger.mjs --fresh | --import-verified-history manifest.json');
  process.exit(2);
}
const pools = [];
try {
  if (process.env.MEMORY_DELETION_CONNECTION_MODE !== 'session') throw new Error('Session/direct connection must be explicitly selected');
  const businessPool = new pg.Pool(buildPostgresTlsConfig(process.env.SUPABASE_DB_URL, process.env.SUPABASE_DB_CA_FILE));
  const ledgerPool = new pg.Pool(buildPostgresTlsConfig(process.env.MEMORY_DELETION_DATABASE_URL, process.env.MEMORY_DELETION_DATABASE_CA_FILE));
  pools.push(businessPool, ledgerPool);
  const manifest = mode === '--fresh' ? null : JSON.parse(await fs.readFile(filename, 'utf8'));
  console.log(await installPostgresLedger({ businessPool, ledgerPool,
    installationId: process.env.MEMORY_DELETION_INSTALLATION_ID, manifest }));
} catch (error) {
  // Never print DSNs, parser errors, manifest contents or raw driver messages.
  console.error('Ledger initialization failed; preserve existing data and investigate configuration/history.', error.code || 'INITIALIZATION_FAILED');
  process.exitCode = 1;
} finally { await Promise.all(pools.map(pool => pool.end())); }
