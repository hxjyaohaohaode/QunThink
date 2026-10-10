# Deployment configuration audit — 2026-10-10

## Scope and safety

This is a local-only candidate copied from the supplied QunThink snapshot. No provider configuration was applied, no deployment or restart was triggered, and no credential or production database was read. Existing Render plan, backend region, disk, environment declarations, deploy triggers and Nginx routes are preserved. Actual provider settings can differ from these files.

## Corrected QunThink contracts

- `render.yaml`: use `runtime: node` instead of deprecated `env: node`; declare the frontend as `type: web`, `runtime: static`; omit frontend `region`. The documentation describes `env` as a deprecated alias, while the current official JSON Schema strictly requires `runtime` and rejects `env`. This does not prove an existing legacy service is invalid.
- `docker-compose.yml`: frontend build context is now the repository root, with `frontend/Dockerfile`. The Dockerfile copies `frontend/package*.json`, `shared/`, `frontend/` and `frontend/nginx.conf`, so the old `./frontend` context cannot supply those paths.
- Existing same-origin Docker routing remains `/api` and `/ws` to `backend:3002`, with both services on the existing Compose network. No backend hostname was invented.
- `frontend/vercel.json` retains its unresolved backend-host placeholder. The new offline preflight rejects it explicitly. The preflight is a manual read-only diagnostic, not proof of provider readiness and not wired into an existing release job.

Run from the repository root:

    node --test backend/test/deployment-config-contract.test.js backend/test/deploy-workflow-contract.test.js
    node backend/scripts/deployment-preflight.mjs render
    node backend/scripts/deployment-preflight.mjs compose
    node backend/scripts/deployment-preflight.mjs vercel

The last command is expected to exit 1 until the actual Vercel/backend routing contract is verified and approved. It never reads `.env`, logs a configuration destination, or contacts a provider. Missing/malformed configuration and unsupported targets also fail closed.

## Evidence

- Original configuration with the final new tests: 15 passed, 3 failed, exit 1.
- Corrected configuration: 18 new tests passed; combined with existing deployment workflow regression: 51 passed, 0 failed.
- Complete official Render JSON Schema validation with Python `jsonschema` Draft202012Validator: original invalid (3 top-level errors); fixed valid (0 errors).
- Official schema: https://render.com/schema/render.yaml.json, retrieved 2026-10-10, SHA-256 `8a3fb8da6b4f55fe686fbefa790e011d3dd7895f013f355953c572a21ab6494a`.
- The small checked-in schema fixture contains selected service-shape fields and source provenance. Its Node tests are targeted contracts, not a full JSON Schema engine. Full validation receipts are separate audit evidence.
- Docker executable is absent in this execution environment. No image build, container startup, production smoke or native browser check is claimed.

## Remaining three-project findings

YouTrace `render.yaml:19,23,41` still specifies free-tier SQLite without a disk and runs migrations during build. Lines 34–35 allow `https://youtrace.onrender.com`, while repository recovery context identifies `https://youtrace-ezu4.onrender.com`. Dashboard overrides remain distinct from source. Verify ownership, running storage and consistent backups before changing the database path, adding storage, migrating, restarting or redeploying. For a disk-backed SQLite target, migration must occur only when the actual mounted data is accessible, with a reviewed backup/restore gate; a build or pre-deploy command cannot access Render persistent disks. Do not simply move this migration to pre-deploy.

Lidian local candidate is commit `2d058397a3a0111892662315b79be901b941400f`, tree `c759bedff5637d3ff562f06dd910ac3fdd065a69`. Its `vercel.json:5–6` disables Git deployments for two branches, but fetching this file from actual GitHub main returned 404. That local control is not proven active remotely. Docker uses Python 3.13, Node 22, `/data`, UID 10001 and port 8000. `server/config.py:26–27` intentionally requires an HTTPS APP_ORIGIN and a registration code at least 16 characters long in production; no values were read. `server/app.py:136–141` needs one process, writable SQLite and its vault under the configured data directory. Health `/api/health` executes `SELECT 1`. This architecture requires explicit durable storage and backup verification, not a claim that a generic static deployment provides the backend.

## TLS diagnosis boundary

QunThink provider logs report a PostgreSQL TLS certificate-chain failure. Keep certificate validation enabled. The repository's `rejectUnauthorized: true` is a security requirement, not a defect to disable. Supabase documents downloading the project database root certificate and explicitly configuring the driver to trust it. Verify the actual trusted CA source, hostname and Node launch configuration before planning a repair. Render's connected tool interface exposes no environment-name read/list capability, so the presence/path of NODE_EXTRA_CA_CERTS is unverified. No environment values or credentials were requested.

## Official references

- https://render.com/docs/blueprint-spec
- https://render.com/docs/disks
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/platform/ssl-enforcement
- https://nodejs.org/download/release/v22.17.0/docs/api/cli.html

None of these findings establishes that any deployment is irreparable or safe to delete.
