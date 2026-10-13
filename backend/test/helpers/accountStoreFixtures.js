import { createHash, randomUUID } from 'node:crypto';
import { prepareOrderedAppend, prepareOrderedGroup } from '../../src/services/messageOrder.js';

// Pure, explicit test-seed operations. They do not patch storage loaders or
// relax validation, and retain every supplied business value byte-for-byte.
export function addFixtureGroups(data, ...groups) {
  for (const group of groups) Object.assign(data, prepareOrderedGroup(
    data, data.message_order.owner_id, group, { generation: randomUUID() }
  ));
  return data;
}

export function appendFixtureMessages(data, ...messages) {
  for (const message of messages) Object.assign(data, prepareOrderedAppend(
    data, data.message_order.owner_id, message,
    { creationIntentHash: createHash('sha256').update(JSON.stringify(message)).digest('hex') }
  ).data);
  return data;
}

// Shared PG wrappers deliberately reuse one named disposable loopback store.
// A valid existing default is read, never rewritten. Only known absence enters
// the explicit empty-install operation, which still rejects all occupied,
// corrupt or inaccessible targets. No setup fallback is installed in a loader.
export async function initializeAccountStoreFixture() {
  if (process.env.SUPABASE_DB_URL) {
    const expected = new URL(process.env.QUNTHINK_TEST_PG_URL);
    const actual = new URL(process.env.SUPABASE_DB_URL);
    const privateFixture = expected.username === 'fixture' && !expected.password
      && expected.pathname === '/qunthink_fixture';
    const ciFixture = expected.username === 'postgres' && expected.password === 'ci_test_only'
      && expected.pathname === '/qunthink_ci' && expected.port === '5432';
    if (expected.protocol !== 'postgresql:' || expected.hostname !== '127.0.0.1'
      || !expected.port || !(privateFixture || ciFixture)
      || [...expected.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable')) {
      throw new Error('Expected the declared disposable loopback account fixture');
    }
    expected.searchParams.delete('sslmode');
    if (actual.toString() !== expected.toString()) {
      throw new Error('Account fixture does not match the declared loopback database');
    }
    const { getUserDb, initializeEmptyInstallation } = await import('../../src/models/db.js');
    try { await getUserDb('default'); return; }
    catch (error) { if (error.code !== 'ACCOUNT_DATA_MISSING') throw error; }
    await initializeEmptyInstallation();
    return;
  }
  const { initializeEmptyInstallation } = await import('../../src/models/db.js');
  await initializeEmptyInstallation();
}
