import dns from 'node:dns';
import { after, mock } from 'node:test';

/** DNS is simulated only for mock-transport tests, never for live provider tests. */
export function mockProviderDns(hosts) {
  const allowed = new Set(hosts);
  const original = dns.lookup;
  const replacement = mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (!allowed.has(hostname)) return original.call(dns, hostname, options, callback);
    const done = typeof options === 'function' ? options : callback;
    queueMicrotask(() => {
      if (options?.all) done(null, [{ address: '93.184.216.34', family: 4 }]);
      else done(null, '93.184.216.34', 4);
    });
  });
  after(() => replacement.mock.restore());
}
