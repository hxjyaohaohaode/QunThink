import test from 'node:test';
if (!process.env.QUNTHINK_TEST_PG_URL) {
  test('real PgLow command closure requires isolated QUNTHINK_TEST_PG_URL', { skip: true }, () => {});
} else {
  const { configureLoopbackPgFixture } = await import('./helpers/loopbackPgFixture.js');
  configureLoopbackPgFixture();
  await import('./task-command-closure.integration.test.js');
}
