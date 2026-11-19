-- FlowOps schema (PostgreSQL 14+)
-- Applied automatically on server boot when DATABASE_URL is set.

CREATE TABLE IF NOT EXISTS workflows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT FALSE,
  nodes         JSONB   NOT NULL DEFAULT '[]'::jsonb,   -- WorkflowNode[]
  connections   JSONB   NOT NULL DEFAULT '[]'::jsonb,   -- Connection[]
  settings      JSONB   NOT NULL DEFAULT '{}'::jsonb,   -- { errorWorkflow, timezone, ... }
  tags          TEXT[]  NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,            -- openaiApi | geminiApi | headerAuth | postgres | slackWebhook
  data_encrypted TEXT NOT NULL,            -- AES-256-GCM: base64(iv).base64(tag).base64(ciphertext)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS executions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,             -- running | success | error
  mode          TEXT NOT NULL,             -- manual | test | production | retry
  trigger       JSONB,                     -- trigger descriptor { nodeId, type, payload }
  node_runs     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- NodeRun[] with input/output snapshots
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_executions_workflow ON executions (workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_status   ON executions (status);

CREATE TABLE IF NOT EXISTS webhooks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'POST',
  hmac_secret_encrypted TEXT,              -- nullable: empty = no signature validation
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, path)
);

-- Waiting executions (Wait node): when to resume, and the engine state to resume from.
ALTER TABLE executions ADD COLUMN IF NOT EXISTS wait_till    TIMESTAMPTZ;
ALTER TABLE executions ADD COLUMN IF NOT EXISTS resume_state JSONB;
CREATE INDEX IF NOT EXISTS idx_executions_waiting ON executions (wait_till) WHERE status = 'waiting';

-- Saved snapshots of a workflow, written on every save (newest 50 kept per workflow).
CREATE TABLE IF NOT EXISTS workflow_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  nodes         JSONB NOT NULL,
  connections   JSONB NOT NULL,
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workflow_versions ON workflow_versions (workflow_id, created_at DESC);
