import test, { after } from 'node:test';
if (!process.env.QUNTHINK_TEST_PG_URL) {
  test('real PgLow result versions require isolated QUNTHINK_TEST_PG_URL', { skip: true }, () => {});
} else {
  const url = new URL(process.env.QUNTHINK_TEST_PG_URL); url.searchParams.set('sslmode', 'disable');
  process.env.SUPABASE_DB_URL = url.toString();
  await import('./task-results.integration.test.js');
  const { closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  after(async () => closeSupabaseConnection());
}
