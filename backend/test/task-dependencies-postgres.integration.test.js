import test, { after } from 'node:test';

if (!process.env.QUNTHINK_TEST_PG_URL) {
  test('real PgLow task dependencies require isolated QUNTHINK_TEST_PG_URL', { skip: true }, () => {});
} else {
  // This helper accepts only the known disposable loopback fixture and leaves
  // production TLS verification intact. Its preload also protects child runs.
  const { configureLoopbackPgFixture } = await import('./helpers/loopbackPgFixture.js');
  configureLoopbackPgFixture();
  await import('./task-dependencies.integration.test.js');
  const { closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  after(async () => closeSupabaseConnection());
}
