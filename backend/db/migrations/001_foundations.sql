-- Applied only by the explicit migrate-foundations command. All statements run
-- in one transaction in a dedicated schema selected by the migration runner.
CREATE TABLE principals (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE spaces (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('personal', 'team', 'community')),
  owner_id text NOT NULL REFERENCES principals(id),
  policy_epoch bigint NOT NULL DEFAULT 0 CHECK (policy_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  space_id text NOT NULL REFERENCES spaces(id),
  actor_id text NOT NULL REFERENCES principals(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  PRIMARY KEY (space_id, actor_id),
  CHECK ((active AND disabled_at IS NULL) OR (NOT active AND disabled_at IS NOT NULL))
);
CREATE INDEX memberships_active_by_actor ON memberships(actor_id, space_id) WHERE active;

CREATE TABLE objects (
  space_id text NOT NULL REFERENCES spaces(id),
  id text NOT NULL,
  kind text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'stale', 'deleted')),
  created_by text NOT NULL REFERENCES principals(id),
  PRIMARY KEY (space_id, id)
);
CREATE INDEX objects_active_by_kind ON objects(space_id, kind) WHERE lifecycle = 'active';

CREATE TABLE object_revisions (
  space_id text NOT NULL,
  object_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, object_id, revision),
  FOREIGN KEY (space_id, object_id) REFERENCES objects(space_id, id)
);

CREATE TABLE object_acl (
  space_id text NOT NULL,
  object_id text NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  actions text[] NOT NULL CHECK (cardinality(actions) > 0 AND actions <@ ARRAY['read','write','share','delete']::text[]),
  granted_epoch bigint NOT NULL CHECK (granted_epoch >= 0),
  revoked_at timestamptz,
  PRIMARY KEY (space_id, object_id, actor_id),
  FOREIGN KEY (space_id, object_id) REFERENCES objects(space_id, id)
);
CREATE INDEX object_acl_active_by_actor ON object_acl(space_id, actor_id, object_id) WHERE revoked_at IS NULL;

CREATE TABLE commands (
  space_id text NOT NULL REFERENCES spaces(id),
  actor_id text NOT NULL REFERENCES principals(id),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, actor_id, request_key)
);

CREATE TABLE domain_events (
  space_id text NOT NULL REFERENCES spaces(id),
  id text NOT NULL,
  aggregate_kind text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision >= 0),
  event_type text NOT NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  payload_ref text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, id),
  UNIQUE (space_id, aggregate_kind, aggregate_id, aggregate_revision, event_type)
);
CREATE INDEX domain_events_by_aggregate ON domain_events(space_id, aggregate_kind, aggregate_id, aggregate_revision);

CREATE TABLE outbox (
  space_id text NOT NULL,
  event_id text NOT NULL,
  delivered_at timestamptz,
  lease_owner text,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (space_id, event_id),
  FOREIGN KEY (space_id, event_id) REFERENCES domain_events(space_id, id)
);
CREATE INDEX outbox_due ON outbox(space_id, lease_until, event_id) WHERE delivered_at IS NULL;

CREATE TABLE consumer_inbox (
  space_id text NOT NULL,
  consumer text NOT NULL,
  event_id text NOT NULL,
  handled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, consumer, event_id),
  FOREIGN KEY (space_id, event_id) REFERENCES domain_events(space_id, id)
);

-- Space policy is a second boundary. Runtime queries and commands must also
-- check current membership, object ACL and delegation. The runtime DB role
-- must not own these tables or have BYPASSRLS.
ALTER TABLE spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE spaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON spaces
  USING (id = current_setting('app.space_id', true))
  WITH CHECK (id = current_setting('app.space_id', true));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'memberships','objects','object_revisions','object_acl','commands',
    'domain_events','outbox','consumer_inbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I USING (space_id = current_setting(''app.space_id'', true)) WITH CHECK (space_id = current_setting(''app.space_id'', true))',
      table_name
    );
  END LOOP;
END $$;
