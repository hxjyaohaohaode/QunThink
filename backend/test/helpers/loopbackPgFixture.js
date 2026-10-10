import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { buildPostgresTlsConfig } from '../../src/models/postgresTls.js';

let installed = false;
export function configureLoopbackPgFixture() {
  if (installed) return;
  let url;
  try { url = new URL(process.env.QUNTHINK_TEST_PG_URL); }
  catch { throw new Error('Expected a known disposable loopback PostgreSQL fixture'); }
  const privateFixture = url.username === 'fixture' && !url.password && url.pathname === '/qunthink_fixture';
  // Fixed synthetic credentials already declared by .github/workflows/ci.yml.
  const ciFixture = url.username === 'postgres' && url.password === 'ci_test_only'
    && url.pathname === '/qunthink_ci' && url.port === '5432';
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || !url.port
      || !(privateFixture || ciFixture)
      || [...url.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable')) {
    throw new Error('Expected a known disposable loopback PostgreSQL fixture');
  }
  url.searchParams.delete('sslmode');
  const fixtureUrl = url.toString();
  const ProductionPool = pg.Pool;
  const expectedVerifier = buildPostgresTlsConfig(fixtureUrl).ssl.checkServerIdentity;
  function isStrictFixtureTls(ssl) {
    if (!ssl || Object.keys(ssl).sort().join(',') !== 'checkServerIdentity,rejectUnauthorized'
        || ssl.rejectUnauthorized !== true || typeof ssl.checkServerIdentity !== 'function'
        || ssl.checkServerIdentity.toString() !== expectedVerifier.toString()) return false;
    try {
      return ssl.checkServerIdentity('localhost', { subjectaltname: 'IP Address:127.0.0.1' }) === undefined
        && ssl.checkServerIdentity('localhost', { subjectaltname: 'DNS:localhost' })?.code === 'ERR_TLS_CERT_ALTNAME_INVALID';
    } catch { return false; }
  }
  // Test-only transport replacement for this exact private fixture. Production
  // code still validates TLS config; unrelated pools retain their TLS settings.
  pg.Pool = class LoopbackFixturePool extends ProductionPool {
    constructor(config) {
      const fixtureTransport = config && !config.connectionString
        && config.host === '127.0.0.1' && String(config.port) === url.port
        && config.user === url.username && (config.password || '') === url.password
        && config.database === url.pathname.slice(1)
        && isStrictFixtureTls(config.ssl);
      super(fixtureTransport ? { ...config, ssl: false } : config);
    }
  };
  process.env.SUPABASE_DB_URL = fixtureUrl;
  const preload = fileURLToPath(new URL('./loopbackPgPreload.js', import.meta.url));
  const flag = `--import=${JSON.stringify(preload)}`;
  if (!(process.env.NODE_OPTIONS || '').includes(flag)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${flag}`.trim();
  }
  installed = true;
}
