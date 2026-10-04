import pg from 'pg';
import { applyFoundationsMigration } from '../src/foundations/migrate.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--schema' || !process.env.QUNTHINK_PG_URL) {
  console.error('Set QUNTHINK_PG_URL in the environment, then run: node scripts/migrate-foundations.mjs --schema <name>');
  process.exitCode = 2;
} else {
  const pool = new pg.Pool({ connectionString: process.env.QUNTHINK_PG_URL, max: 2, connectionTimeoutMillis: 10000 });
  try {
    const result = await applyFoundationsMigration(pool, { schema: args[1] });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Foundation migration failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
