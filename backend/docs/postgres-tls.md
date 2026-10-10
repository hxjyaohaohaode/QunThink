# PostgreSQL TLS contract

The production Supabase adapter always verifies the server certificate chain and
hostname. Its Node hostname verifier is explicitly bound to the parsed effective
host, including IP addresses when pg omits SNI. There is no production plaintext/test-mode exception.

`SUPABASE_DB_URL` is parsed once into allowlisted connection options; the original
URI is never passed back to `pg`. `sslmode=verify-full`, `require`, `prefer`, and
`verify-ca` all mean full verification in this application. This preserves the
current pg 8 behavior even if a future parser gives those aliases weaker meanings.
`ssl=true` and `ssl=1` also retain strict verification. Explicit downgrade modes,
`uselibpqcompat`, nested `connectionString`, and other URI `ssl*` parameters fail
closed. Standard database identity, application, encoding, options, replication,
and timeout fields are preserved; unrelated query keys are not passed to Pool.

## Trust configuration

Without `SUPABASE_DB_CA_FILE`, Node's normal CA trust applies. A verified public
Supabase project CA can be added using `NODE_EXTRA_CA_CERTS=/absolute/path/ca.pem`,
set before Node starts. Changing it after startup does not update the trust store.
This expands trust for other Node TLS clients in the process too.

For database-only trust, set `SUPABASE_DB_CA_FILE` to a readable file containing one
PEM CA certificate obtained from the correct Supabase project's Database settings.
The application rejects malformed certificates, leaf certificates, and bundles.
Do not supply a private key or client certificate. This explicit `ssl.ca` replaces
Node's default/extra CA list for this database connection, so
`NODE_EXTRA_CA_CERTS` will not supplement it. Keep this certificate current across
provider certificate rotations. URI `sslrootcert` is intentionally unsupported;
use this explicit option instead.

Neither option alone proves it is the correct trust anchor for a live endpoint.
Verify the project/endpoint and trusted certificate provenance before a deployment.
A previously observed certificate-chain error is not proof of the live URL's
contents or the exact missing certificate. Never fix it by disabling verification.
Configuration and connection errors are generic, retain a safe diagnostic code,
and omit original messages/causes that could expose a URI, credentials, or path.

## Tests

`node --test test/postgres-tls.unit.test.js test/loopback-pg-fixture.unit.test.js`
checks parsing, downgrade rejection, CA preservation, error redaction, and fixture
scoping without contacting external services.

Real PostgreSQL application tests use a separate test-only preload. It accepts only
the explicitly supplied disposable `fixture@127.0.0.1:<port>/qunthink_fixture`
(with no password), or the exact existing CI fixture profile from the workflow
(`postgres:ci_test_only@127.0.0.1:5432/qunthink_ci`, a synthetic test password), removes its test URL's `sslmode=disable`, then substitutes
plaintext transport only for that exact parsed destination with the ordinary
strict SSL options with the expected host-bound verification callback
(including positive IP-SAN and negative DNS-only identity probes). Explicit CA tests and other destinations retain
TLS. The preload is propagated to those tests' child processes and is never
imported by production code. These plaintext fixture tests establish application
behavior, not live TLS correctness; certificate/hostname tests require a separate
TLS-enabled fixture.

Official references:
- https://node-postgres.com/features/ssl
- https://nodejs.org/download/release/v22.17.0/docs/api/cli.html#node_extra_ca_certsfile
- https://supabase.com/docs/guides/database/connecting-to-postgres
