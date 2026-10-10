import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { parse } from 'pg-connection-string';
import { checkServerIdentity } from 'node:tls';

const invalidConfig = () => Object.assign(new Error('Invalid PostgreSQL TLS configuration'), {
  code: 'POSTGRES_TLS_CONFIG_INVALID'
});

// Keep pg's connection-string parser from replacing our strict TLS options.
// No production exception exists for NODE_ENV or a loopback hostname.
export function buildPostgresTlsConfig(connectionString, caFile) {
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw invalidConfig();
    // Validate percent encoding here so pg cannot throw an unredacted parse error.
    for (const part of [url.hostname, url.username, url.password, url.pathname]) decodeURIComponent(part);
    for (const [key, value] of [...url.searchParams]) {
      const name = key.toLowerCase();
      if (name === 'sslmode' && key === name && ['verify-full', 'require', 'prefer', 'verify-ca'].includes(value)) {
        url.searchParams.delete(key);
      } else if (name === 'ssl' && key === name && ['true', '1'].includes(value)) {
        url.searchParams.delete(key);
      } else if (name.startsWith('ssl') || name === 'uselibpqcompat' || name === 'connectionstring') {
        throw invalidConfig();
      }
    }
    const ssl = { rejectUnauthorized: true };
    if (caFile !== undefined && caFile !== '') {
      const ca = readFileSync(caFile, 'utf8');
      // A public CA certificate, never a client key. Reject malformed/leaf input.
      if (!/^\s*-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(ca)
          || ca.match(/-----BEGIN CERTIFICATE-----/g)?.length !== 1
          || !new X509Certificate(ca).ca) throw invalidConfig();
      ssl.ca = ca;
    }
    // Legacy pg 8 aliases retain full verification here, independent of future
    // pg/libpq meanings. Return discrete fields: pg must not reparse the URI.
    const parsed = parse(url.toString());
    // pg does not send SNI for IP hosts; Node can otherwise verify against
    // localhost instead of the intended IP when wrapping pg's existing socket.
    const host = parsed.host;
    ssl.checkServerIdentity = (_hostname, certificate) => checkServerIdentity(host, certificate);
    const fields = ['user', 'password', 'host', 'port', 'database', 'options',
      'application_name', 'fallback_application_name', 'client_encoding', 'replication',
      'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'query_timeout'];
    return { ...Object.fromEntries(fields.filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]])), ssl };
  } catch {
    // URL/parser/fs errors can include passwords or private paths. Drop causes.
    throw invalidConfig();
  }
}
