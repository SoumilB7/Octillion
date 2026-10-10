-- DevTools MCP schema: four contexts
--   1. products            - DevTools product description
--   2. user_accounts       - user account
--   3. developer_segments  - developer population breakdown
--   4. agent_sessions / trace_runs - trace runs history
-- Span-level trace detail lives in Langfuse; rows here carry the Langfuse ids to link out.

DROP TABLE IF EXISTS trace_spans;
DROP TABLE IF EXISTS trace_runs;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS developer_segments;
DROP TABLE IF EXISTS user_accounts;
DROP TABLE IF EXISTS products;

CREATE TABLE products (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  tagline       TEXT NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL,
  version       TEXT NOT NULL,
  released_at   DATE NOT NULL,
  docs_url      TEXT,
  features      JSONB NOT NULL DEFAULT '[]',   -- [{name, description}]
  pricing_tiers JSONB NOT NULL DEFAULT '[]',   -- [{plan, price_usd_month, trace_quota, seats, highlights[]}]
  integrations  TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE user_accounts (
  id              SERIAL PRIMARY KEY,
  product_id      INT NOT NULL REFERENCES products(id),
  email           TEXT UNIQUE NOT NULL,
  full_name       TEXT NOT NULL,
  org_name        TEXT NOT NULL,
  role            TEXT NOT NULL,
  plan            TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
  status          TEXT NOT NULL CHECK (status IN ('active', 'trialing', 'suspended')),
  seats           INT NOT NULL DEFAULT 1,
  monthly_trace_quota INT NOT NULL,
  primary_language TEXT NOT NULL,
  region          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  last_active_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE developer_segments (
  id              SERIAL PRIMARY KEY,
  product_id      INT NOT NULL REFERENCES products(id),
  dimension       TEXT NOT NULL CHECK (dimension IN ('role', 'language', 'region', 'experience', 'company_size')),
  segment         TEXT NOT NULL,
  developer_count INT NOT NULL,
  active_30d      INT NOT NULL,
  as_of           DATE NOT NULL,
  UNIQUE (product_id, dimension, segment, as_of)
);

CREATE TABLE agent_sessions (
  id            TEXT PRIMARY KEY,               -- e.g. ses_00042; also used as the Langfuse session id
  account_id    INT NOT NULL REFERENCES user_accounts(id),
  agent_name    TEXT NOT NULL,                  -- e.g. support-agent
  environment   TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'dev')),
  status        TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
  end_user_id   TEXT,                           -- the account's own end user, if they pass one
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,                    -- NULL while active
  metadata      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX agent_sessions_account_started_idx ON agent_sessions (account_id, started_at DESC);

CREATE TABLE trace_runs (
  id            TEXT PRIMARY KEY,               -- e.g. run_000123
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  account_id    INT NOT NULL REFERENCES user_accounts(id),
  langfuse_trace_id TEXT NOT NULL,
  name          TEXT NOT NULL,                  -- workflow / agent name
  environment   TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'dev')),
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout')),
  started_at    TIMESTAMPTZ NOT NULL,
  duration_ms   INT NOT NULL,
  tokens_in     INT NOT NULL DEFAULT 0,
  tokens_out    INT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10, 4) NOT NULL DEFAULT 0,
  error_message TEXT,
  tags          TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX trace_runs_account_started_idx ON trace_runs (account_id, started_at DESC);
CREATE INDEX trace_runs_started_idx ON trace_runs (started_at DESC);
CREATE INDEX trace_runs_session_idx ON trace_runs (session_id, started_at);
