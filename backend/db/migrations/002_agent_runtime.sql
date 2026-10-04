-- Goal/run kernel. Apply once in the same schema and transaction as the
-- foundation migration runner. This does not grant any tool permission.
CREATE TABLE goals (
  space_id text NOT NULL,
  id text NOT NULL,
  owner_id text NOT NULL REFERENCES principals(id),
  outcome text NOT NULL CHECK (length(outcome) BETWEEN 1 AND 10000),
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints) = 'array'),
  grant_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(grant_refs) = 'array'),
  budget_limit_micros numeric(20,0) NOT NULL CHECK (budget_limit_micros >= 0),
  budget_reserved_micros numeric(20,0) NOT NULL DEFAULT 0 CHECK (budget_reserved_micros >= 0),
  budget_spent_micros numeric(20,0) NOT NULL DEFAULT 0 CHECK (budget_spent_micros >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','completed','cancelled')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id,id),
  FOREIGN KEY (space_id,id) REFERENCES objects(space_id,id)
);

CREATE TABLE goal_checks (
  space_id text NOT NULL,
  goal_id text NOT NULL,
  check_key text NOT NULL,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  required boolean NOT NULL DEFAULT true,
  validator_id text NOT NULL REFERENCES principals(id),
  PRIMARY KEY (space_id,goal_id,check_key),
  FOREIGN KEY (space_id,goal_id) REFERENCES goals(space_id,id)
);

CREATE TABLE execution_grants (
  space_id text NOT NULL,
  id text NOT NULL,
  goal_id text NOT NULL,
  actor_id text NOT NULL REFERENCES principals(id),
  tool_id text NOT NULL,
  max_quote_micros numeric(20,0) NOT NULL CHECK (max_quote_micros >= 0),
  expires_at timestamptz NOT NULL,
  policy_epoch bigint NOT NULL CHECK (policy_epoch >= 0),
  revoked_at timestamptz,
  created_by text NOT NULL REFERENCES principals(id),
  PRIMARY KEY (space_id,id),
  FOREIGN KEY (space_id,goal_id) REFERENCES goals(space_id,id)
);

CREATE TABLE runs (
  space_id text NOT NULL,
  id text NOT NULL,
  goal_id text NOT NULL,
  goal_revision bigint NOT NULL CHECK (goal_revision >= 0),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','waiting','paused','reconciling','completed','failed','cancelled')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_owner text,
  lease_until timestamptz,
  wait_reason text,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  budget_reserved_micros numeric(20,0) NOT NULL DEFAULT 0 CHECK (budget_reserved_micros >= 0),
  budget_spent_micros numeric(20,0) NOT NULL DEFAULT 0 CHECK (budget_spent_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id,id),
  FOREIGN KEY (space_id,goal_id) REFERENCES goals(space_id,id),
  CHECK ((lease_owner IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX runs_claimable ON runs(space_id,state,lease_until,created_at);

CREATE TABLE steps (
  space_id text NOT NULL,
  run_id text NOT NULL,
  step_key text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 2000),
  input_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(input_refs) = 'array'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','waiting','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  claimed_fence bigint CHECK (claimed_fence >= 0),
  result_ref text,
  PRIMARY KEY (space_id,run_id,step_key),
  UNIQUE (space_id,run_id,position),
  FOREIGN KEY (space_id,run_id) REFERENCES runs(space_id,id)
);

CREATE TABLE effects (
  space_id text NOT NULL,
  run_id text NOT NULL,
  step_key text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  tool_id text NOT NULL,
  grant_id text NOT NULL,
  quote_micros numeric(20,0) NOT NULL CHECK (quote_micros >= 0),
  actual_micros numeric(20,0),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','inflight','unknown','succeeded','failed')),
  fence bigint NOT NULL CHECK (fence >= 0),
  receipt jsonb,
  verified_by text REFERENCES principals(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id,run_id,step_key),
  UNIQUE (space_id,idempotency_key),
  FOREIGN KEY (space_id,run_id,step_key) REFERENCES steps(space_id,run_id,step_key),
  FOREIGN KEY (space_id,grant_id) REFERENCES execution_grants(space_id,id),
  CHECK (actual_micros IS NULL OR actual_micros >= 0),
  CHECK ((state = 'succeeded' AND receipt IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
      OR (state <> 'succeeded' AND verified_at IS NULL))
);

CREATE TABLE artifacts (
  space_id text NOT NULL,
  id text NOT NULL,
  run_id text NOT NULL,
  content_ref text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','stale','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id,id),
  FOREIGN KEY (space_id,id) REFERENCES objects(space_id,id),
  FOREIGN KEY (space_id,run_id) REFERENCES runs(space_id,id)
);

CREATE TABLE run_checks (
  space_id text NOT NULL,
  run_id text NOT NULL,
  check_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','passed','failed')),
  artifact_id text,
  artifact_revision bigint,
  verified_by text REFERENCES principals(id),
  verified_at timestamptz,
  PRIMARY KEY (space_id,run_id,check_key),
  FOREIGN KEY (space_id,run_id) REFERENCES runs(space_id,id),
  FOREIGN KEY (space_id,artifact_id) REFERENCES artifacts(space_id,id),
  CHECK ((state='passed' AND artifact_id IS NOT NULL AND artifact_revision IS NOT NULL
    AND verified_by IS NOT NULL AND verified_at IS NOT NULL) OR state<>'passed')
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goals','goal_checks','execution_grants','runs','steps','effects','artifacts','run_checks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON %I USING (space_id = current_setting(''app.space_id'', true)) WITH CHECK (space_id = current_setting(''app.space_id'', true))',
      table_name
    );
  END LOOP;
END $$;
