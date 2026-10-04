import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
process.env.NODE_ENV = 'test';
const { default: monitor } = await import('../src/services/monitoring/monitor.js');
test('unavailable network-interface evidence does not erase other diagnostics', async (t) => {
  t.mock.method(os, 'networkInterfaces', () => { throw new Error('restricted OS'); });
  const network = monitor.getNetworkActivity();
  assert.equal(network.activeInterfaces, null);
  assert.equal(typeof network.totalRequests, 'number');
  assert.equal(network.rxBytes, null);
  t.mock.method(monitor, 'getDatabaseStatus', async () => ({ status: 'listing_available' }));
  const metrics = await monitor.collectMetrics();
  assert.equal(metrics.network.activeInterfaces, null);
  assert.equal(metrics.database.status, 'listing_available');
  assert.equal(metrics.meetsAvailabilityRequirement, null);
});
