import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const migrations = [
  new URL('../../db/migrations/001_foundations.sql', import.meta.url),
  new URL('../../db/migrations/002_agent_runtime.sql', import.meta.url)
];
export const FOUNDATION_MIGRATION_VERSION = migrations.length;

export function quoteSchema(schema) {
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('Schema must be a lowercase PostgreSQL identifier (1-63 characters)');
  }
  return `"${schema}"`;
}

export async function applyFoundationsMigration(pool, { schema = 'qunthink_core' } = {}) {
  const schemaIdent = quoteSchema(schema);
  const files = await Promise.all(migrations.map(async (url, index) => {
    const sql = await readFile(url, 'utf8');
    return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['qunthink-foundations', schema]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent}`);
    await client.query(`SET LOCAL search_path TO ${schemaIdent}, pg_catalog`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    if (existing.rows.some(row => !files[row.version - 1])) {
      throw new Error('Schema contains an unknown foundation migration version');
    }
    for (const row of existing.rows) {
      if (row.checksum !== files[row.version - 1].checksum) {
        throw new Error('Foundation migration checksum changed after application');
      }
    }
    const applied = existing.rows.length < files.length;
    for (const file of files.slice(existing.rows.length)) {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [file.version, file.checksum]);
    }
    await client.query('COMMIT');
    return { schema, version: FOUNDATION_MIGRATION_VERSION, applied, checksum: files.at(-1).checksum };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
