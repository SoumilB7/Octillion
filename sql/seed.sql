-- Sample data. Timestamps are relative to now() so the history always looks recent.
SELECT setseed(0.42);

-- 1. Product ----------------------------------------------------------------
INSERT INTO products (slug, name, tagline, description, category, version, released_at, docs_url, features, pricing_tiers, integrations)
VALUES (
  'tracelight',
  'Tracelight',
  'Observability and debugging for LLM apps and agents',
  'Tracelight captures every run of your LLM application as a structured trace: agent steps, model calls, tool invocations and retrievals, with tokens, latency and cost on every span. Developers use it to debug failing runs, compare prompt versions, and keep production agents fast and affordable.',
  'Developer Tools / Observability',
  '3.4.1',
  '2024-03-12',
  'https://docs.example.com/tracelight',
  '[
    {"name": "Run tracing", "description": "Nested spans for agent steps, LLM calls, tools and retrievals with one-line SDK setup."},
    {"name": "Cost & token analytics", "description": "Per-run and per-span token counts and spend, rolled up by workflow, model and environment."},
    {"name": "Failure triage", "description": "Group errors and timeouts by root-cause span and jump straight to the failing step."},
    {"name": "Prompt diffing", "description": "Compare two runs side by side to see what changed in prompts, inputs and outputs."},
    {"name": "Evals", "description": "Score runs with LLM-as-judge or code checks and track quality over time."},
    {"name": "Alerts", "description": "Notify Slack or PagerDuty when error rate, latency or spend crosses a threshold."}
  ]',
  '[
    {"plan": "free", "price_usd_month": 0, "trace_quota": 5000, "seats": 1, "highlights": ["7-day retention", "Community support"]},
    {"plan": "pro", "price_usd_month": 39, "trace_quota": 100000, "seats": 3, "highlights": ["30-day retention", "Evals", "Email support"]},
    {"plan": "team", "price_usd_month": 199, "trace_quota": 1000000, "seats": 15, "highlights": ["90-day retention", "Alerts", "SSO"]},
    {"plan": "enterprise", "price_usd_month": null, "trace_quota": null, "seats": null, "highlights": ["Custom retention", "VPC deploy", "Dedicated support"]}
  ]',
  ARRAY['Python SDK', 'TypeScript SDK', 'OpenTelemetry', 'LangChain', 'LlamaIndex', 'Vercel AI SDK', 'Slack', 'PagerDuty']
);

-- 2. User accounts ----------------------------------------------------------
INSERT INTO user_accounts (product_id, email, full_name, org_name, role, plan, status, seats, monthly_trace_quota, primary_language, region, created_at, last_active_at) VALUES
  (1, 'priya@acme.dev',        'Priya Raman',     'Acme Robotics',   'ML Engineer',        'team',       'active',    12, 1000000, 'Python',     'APAC',          now() - interval '410 days', now() - interval '2 hours'),
  (1, 'marco@finlytics.io',    'Marco Bianchi',   'Finlytics',       'Backend Engineer',   'pro',        'active',     3,  100000, 'TypeScript', 'Europe',        now() - interval '220 days', now() - interval '1 day'),
  (1, 'sam@nimbuslabs.ai',     'Sam Okafor',      'Nimbus Labs',     'Founding Engineer',  'enterprise', 'active',    40, 5000000, 'Python',     'North America', now() - interval '530 days', now() - interval '30 minutes'),
  (1, 'lena@quickcart.com',    'Lena Fischer',    'QuickCart',       'Platform Engineer',  'team',       'active',     8, 1000000, 'Go',         'Europe',        now() - interval '160 days', now() - interval '5 hours'),
  (1, 'diego@solo.dev',        'Diego Morales',   'Independent',     'Full-stack Developer','free',      'active',     1,    5000, 'TypeScript', 'Latin America', now() - interval '45 days',  now() - interval '3 days'),
  (1, 'aiko@kumo.jp',          'Aiko Tanaka',     'Kumo Systems',    'Data Scientist',     'pro',        'trialing',   2,  100000, 'Python',     'APAC',          now() - interval '9 days',   now() - interval '6 hours'),
  (1, 'jordan@helpdeskhq.com', 'Jordan Lee',      'HelpdeskHQ',      'AI Engineer',        'team',       'active',     6, 1000000, 'Python',     'North America', now() - interval '300 days', now() - interval '20 minutes'),
  (1, 'ola@payrails.ng',       'Ola Adeyemi',     'Payrails',        'Staff Engineer',     'pro',        'suspended',  3,  100000, 'Java',       'Africa',        now() - interval '260 days', now() - interval '40 days');

-- 3. Developer population breakdown -----------------------------------------
INSERT INTO developer_segments (product_id, dimension, segment, developer_count, active_30d, as_of) VALUES
  (1, 'role', 'AI / ML Engineer',       18420, 12110, current_date),
  (1, 'role', 'Backend Engineer',       14950,  8870, current_date),
  (1, 'role', 'Full-stack Developer',   11230,  6040, current_date),
  (1, 'role', 'Data Scientist',          7310,  4120, current_date),
  (1, 'role', 'Platform / DevOps',       4880,  3010, current_date),
  (1, 'role', 'Other',                   2210,   780, current_date),

  (1, 'language', 'Python',             31240, 19240, current_date),
  (1, 'language', 'TypeScript',         19870, 11420, current_date),
  (1, 'language', 'Go',                  3460,  2150, current_date),
  (1, 'language', 'Java / Kotlin',       2610,  1240, current_date),
  (1, 'language', 'Rust',                1080,   690, current_date),
  (1, 'language', 'Other',                740,   190, current_date),

  (1, 'region', 'North America',        22350, 14020, current_date),
  (1, 'region', 'Europe',               16480,  9910, current_date),
  (1, 'region', 'APAC',                 13120,  7340, current_date),
  (1, 'region', 'Latin America',         4170,  2160, current_date),
  (1, 'region', 'Africa',                1830,   940, current_date),
  (1, 'region', 'Middle East',           1050,   560, current_date),

  (1, 'experience', '0-2 years',         9840,  4610, current_date),
  (1, 'experience', '3-5 years',        19260, 11530, current_date),
  (1, 'experience', '6-10 years',       18110, 11240, current_date),
  (1, 'experience', '10+ years',        11790,  7550, current_date),

  (1, 'company_size', 'Solo / hobby',   12650,  4980, current_date),
  (1, 'company_size', '2-50',           17930, 11020, current_date),
  (1, 'company_size', '51-500',         15480, 10140, current_date),
  (1, 'company_size', '501-5000',        8210,  5320, current_date),
  (1, 'company_size', '5000+',           4730,  3470, current_date);

-- 4. Agent sessions + trace runs (last 30 days) ----------------------------
-- Accounts are weighted so bigger plans produce more sessions; the suspended account has none.
INSERT INTO agent_sessions (id, account_id, agent_name, environment, status, end_user_id, started_at, metadata)
SELECT
  'ses_' || lpad(g::text, 5, '0'),
  acct,
  agent,
  env,
  'completed',
  'user_' || (100 + floor(random() * 400)::int),
  CASE WHEN acct = 6 THEN now() - (random() * interval '9 days')   -- trialing account signed up 9 days ago
       ELSE now() - (random() * interval '30 days') END,
  jsonb_build_object('turns_planned', 1 + floor(random() * 6)::int)
FROM (
  SELECT
    g,
    (ARRAY[1,1,1,2,3,3,3,3,4,4,5,6,7,7,7])[1 + floor(random() * 15)::int] AS acct,
    (ARRAY['support-agent', 'rag-qa', 'code-review-bot', 'invoice-extractor', 'sql-copilot'])[1 + floor(random() * 5)::int] AS agent,
    (ARRAY['production', 'production', 'production', 'staging', 'dev'])[1 + floor(random() * 5)::int] AS env
  FROM generate_series(1, 260) AS g
) s;

-- Each session is a sequence of runs (turns) a few seconds to minutes apart.
INSERT INTO trace_runs (id, session_id, account_id, langfuse_trace_id, name, environment, status, started_at, duration_ms, tokens_in, tokens_out, cost_usd, error_message, tags)
SELECT
  'run_' || lpad((row_number() OVER (ORDER BY t.started_at))::text, 5, '0'),
  t.session_id, t.account_id,
  md5(t.session_id || ':' || t.turn),
  t.agent_name, t.environment, t.status, t.started_at,
  CASE WHEN t.status = 'timeout' THEN 60000 + (random() * 2000)::int ELSE (600 + random() * 9000)::int END,
  t.tin, t.tout,
  round(((t.tin * 0.000003) + (t.tout * 0.000015))::numeric, 4),
  CASE t.status
    WHEN 'error'   THEN (ARRAY['Tool "search_orders" raised: 502 Bad Gateway', 'LLM response failed JSON schema validation', 'RateLimitError: 429 from model provider', 'Retriever returned 0 documents'])[1 + floor(random() * 4)::int]
    WHEN 'timeout' THEN 'Run exceeded 60s deadline'
  END,
  ARRAY[t.environment, t.agent_name]
FROM (
  SELECT
    s.id AS session_id, s.account_id, s.agent_name, s.environment, c.turn,
    s.started_at + (c.turn - 1) * (interval '20 seconds' + random() * interval '3 minutes') AS started_at,
    CASE WHEN random() < 0.08 THEN 'error' WHEN random() < 0.03 THEN 'timeout' ELSE 'ok' END AS status,
    (800 + random() * 14000)::int AS tin,
    (150 + random() * 2200)::int AS tout
  FROM agent_sessions s
  CROSS JOIN LATERAL generate_series(1, (s.metadata->>'turns_planned')::int) AS c(turn)
) t;

-- Derive session status/end from its runs: a failed last run fails the session; very recent sessions are still active.
UPDATE agent_sessions s SET
  ended_at = CASE WHEN x.last_end > now() - interval '15 minutes' THEN NULL ELSE x.last_end END,
  status = CASE
    WHEN x.last_end > now() - interval '15 minutes' THEN 'active'
    WHEN x.last_status <> 'ok' THEN 'failed'
    ELSE 'completed' END
FROM (
  SELECT DISTINCT ON (session_id) session_id,
         started_at + duration_ms * interval '1 millisecond' AS last_end,
         status AS last_status
  FROM trace_runs ORDER BY session_id, started_at DESC
) x
WHERE x.session_id = s.id;
