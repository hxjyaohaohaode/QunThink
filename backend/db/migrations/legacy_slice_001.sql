-- Explicit, isolated import staging for one immutable LowDB user snapshot.
-- This is not a live business projection and is never read by existing APIs.
CREATE TABLE legacy_import_meta (
  version integer PRIMARY KEY CHECK (version = 1),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legacy_import_manifests (
  space_id text NOT NULL REFERENCES spaces(id),
  source_account text NOT NULL REFERENCES principals(id),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  barrier_evidence_sha256 text NOT NULL CHECK (barrier_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  registry_sequence integer NOT NULL CHECK (registry_sequence >= 0),
  account_deletion_sequence integer NOT NULL CHECK (account_deletion_sequence >= 0),
  source_group_count integer NOT NULL CHECK (source_group_count >= 0),
  source_message_count integer NOT NULL CHECK (source_message_count >= 0),
  group_count integer NOT NULL CHECK (group_count >= 0),
  message_count integer NOT NULL CHECK (message_count >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, source_account)
);

CREATE TABLE legacy_import_map (
  space_id text NOT NULL,
  source_account text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('group', 'message')),
  source_id text NOT NULL,
  target_id text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_created_at text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, source_account, source_kind, source_id),
  UNIQUE (space_id, target_id),
  FOREIGN KEY (space_id, source_account)
    REFERENCES legacy_import_manifests(space_id, source_account),
  FOREIGN KEY (space_id, target_id) REFERENCES objects(space_id, id)
);
CREATE INDEX legacy_import_map_by_kind
  ON legacy_import_map(space_id, source_account, source_kind);

-- The migration connection is administrative. Runtime readers still need an
-- explicit tenant scope and must not receive broad grants on these tables.
ALTER TABLE legacy_import_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_import_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON legacy_import_manifests
  USING (space_id = current_setting('app.space_id', true))
  WITH CHECK (space_id = current_setting('app.space_id', true));
ALTER TABLE legacy_import_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_import_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON legacy_import_map
  USING (space_id = current_setting('app.space_id', true))
  WITH CHECK (space_id = current_setting('app.space_id', true));
