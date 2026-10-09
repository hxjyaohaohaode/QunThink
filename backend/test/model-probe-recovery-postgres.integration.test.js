import test, { after } from 'node:test';

if (!process.env.QUNTHINK_TEST_PG_URL) {
  test('real PgLow probe effects require isolated QUNTHINK_TEST_PG_URL', { skip: true }, () => {});
} else {
  const url = new URL(process.env.QUNTHINK_TEST_PG_URL);
  url.searchParams.set('sslmode', 'disable');
  process.env.SUPABASE_DB_URL = url.toString();
  // Run the same HTTP faults and killed-worker cases against actual PgLow CAS,
  // in addition to separate-process admission races below.
  await import('./model-probe-recovery.integration.test.js');
  const { closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  after(async () => closeSupabaseConnection());
}
