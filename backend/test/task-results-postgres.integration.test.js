import test, { after } from 'node:test';
if (!process.env.QUNTHINK_TEST_PG_URL) {
  test('real PgLow result versions require isolated QUNTHINK_TEST_PG_URL', { skip: true }, () => {});
} else {
  const { configureLoopbackPgFixture } = await import('./helpers/loopbackPgFixture.js');
  configureLoopbackPgFixture();
  await import('./task-results.integration.test.js');
  const { closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  after(async () => closeSupabaseConnection());
}
