#!/usr/bin/env bash
set -euo pipefail
# Only disposable GitHub-hosted Linux/x64 services. No local server/download path.
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux && "${RUNNER_ARCH:-}" == X64 ]]
[[ "${CI_POSTGRES_CONTAINER:-}" =~ ^[a-f0-9]{12,64}$ ]]
[[ "${CI_MONGO_CONTAINER:-}" =~ ^[a-f0-9]{12,64}$ ]]
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}" "${QUNTHINK_STORAGE_EVIDENCE_DIR:?}"
umask 077
mkdir -p "$QUNTHINK_STORAGE_EVIDENCE_DIR"
tls_dir=$(mktemp -d "$RUNNER_TEMP/qunthink-storage-tls.XXXXXX")
# Files belong only to this ephemeral fixture. Never touch existing user keys.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj '/CN=Qunthink synthetic CI CA' -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$tls_dir/ca.key" -out "$tls_dir/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=127.0.0.1' \
  -keyout "$tls_dir/server.key" -out "$tls_dir/server.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=IP:127.0.0.1,DNS:localhost' 'extendedKeyUsage=serverAuth' 'basicConstraints=critical,CA:FALSE' > "$tls_dir/server.ext"
openssl x509 -req -in "$tls_dir/server.csr" -CA "$tls_dir/ca.crt" -CAkey "$tls_dir/ca.key" \
  -CAcreateserial -days 1 -sha256 -extfile "$tls_dir/server.ext" -out "$tls_dir/server.crt" 2>/dev/null
chmod 600 "$tls_dir"/*
container_tls="/tmp/qunthink-ci-tls-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
docker exec "$CI_POSTGRES_CONTAINER" mkdir -m 700 "$container_tls"
docker cp "$tls_dir/server.key" "$CI_POSTGRES_CONTAINER:$container_tls/server.key"
docker cp "$tls_dir/server.crt" "$CI_POSTGRES_CONTAINER:$container_tls/server.crt"
docker exec "$CI_POSTGRES_CONTAINER" chown -R postgres:postgres "$container_tls"
docker exec "$CI_POSTGRES_CONTAINER" chmod 600 "$container_tls/server.key" "$container_tls/server.crt"
pg_sql() { docker exec --user postgres "$CI_POSTGRES_CONTAINER" psql -U postgres -d qunthink_ci -v ON_ERROR_STOP=1 -c "$1"; }
pg_sql "ALTER SYSTEM SET ssl = 'on'"
pg_sql "ALTER SYSTEM SET ssl_cert_file = '$container_tls/server.crt'"
pg_sql "ALTER SYSTEM SET ssl_key_file = '$container_tls/server.key'"
pg_sql "ALTER SYSTEM SET ssl_min_protocol_version = 'TLSv1.3'"
pg_sql 'SELECT pg_reload_conf()'
# The current service already creates qunthink_ci; all other named DBs must be new.
for database in qunthink_memory qunthink_ledger qunthink_lifecycle qunthink_lifecycle_ledger qunthink_wrapper qunthink_wrapper_ledger qunthink_paging qunthink_paging_ledger qunthink_restore qunthink_restore_ledger; do
  pg_sql "CREATE DATABASE $database"
done
for key in QUNTHINK_TEST_MEMORY_TLS_CA QUNTHINK_TEST_LIFECYCLE_PG_CA QUNTHINK_TEST_COMMIT_PG_CA QUNTHINK_TEST_PAGING_PG_CA QUNTHINK_TEST_RESTORE_PG_CA; do
  printf '%s=%s\n' "$key" "$tls_dir/ca.crt" >> "$GITHUB_ENV"
done
# Only image identity metadata, never full container inspect/env, keys or volumes.
for service in postgres mongo; do
  if [[ "$service" == postgres ]]; then container=$CI_POSTGRES_CONTAINER; else container=$CI_MONGO_CONTAINER; fi
  image_id=$(docker inspect --format '{{.Image}}' "$container")
  docker image inspect --format '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}},"architecture":{{json .Architecture}},"os":{{json .Os}}}' "$image_id" > "$QUNTHINK_STORAGE_EVIDENCE_DIR/$service-image.json"
done
node --input-type=module -e '
  import fs from "node:fs";
  const root=process.env.QUNTHINK_STORAGE_EVIDENCE_DIR;
  for(const service of ["postgres","mongo"]) {
    const row=JSON.parse(fs.readFileSync(`${root}/${service}-image.json`,"utf8"));
    if(row.architecture!=="amd64"||row.os!=="linux") throw new Error(`Wrong ${service} fixture platform`);
    if(service==="mongo"&&!row.repoDigests?.includes("mongodb/mongodb-community-server@sha256:65ca4eddc5dbeae94350b4a3889f2c1194e2b940f968e0341cccc2a5c98c666c")) throw new Error("Mongo digest mismatch");
  }
'
printf '%s\n' 'Synthetic CI TLS, 11 named PostgreSQL databases, and image identities prepared.'
