import { getDb } from "./db.js";

// Span-level traces live in Langfuse. Links are only emitted when a project id is configured.
const LANGFUSE_HOST = (process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/$/, "");
const LANGFUSE_PROJECT = process.env.LANGFUSE_PROJECT_ID;
export const langfuse = {
  trace: (traceId: string) => (LANGFUSE_PROJECT ? `${LANGFUSE_HOST}/project/${LANGFUSE_PROJECT}/traces/${traceId}` : null),
  session: (sessionId: string) => (LANGFUSE_PROJECT ? `${LANGFUSE_HOST}/project/${LANGFUSE_PROJECT}/sessions/${sessionId}` : null),
};

// ---------- 1. DevTools product description ----------

export async function getProduct(slug?: string) {
  const db = await getDb();
  const [product] = await db.query(
    slug
      ? "SELECT * FROM products WHERE slug = $1"
      : "SELECT * FROM products ORDER BY id LIMIT 1",
    slug ? [slug] : [],
  );
  if (!product) throw new Error(`No product found${slug ? ` with slug "${slug}"` : ""}`);

  const [stats] = await db.query(
    `SELECT
       (SELECT count(*) FROM user_accounts WHERE product_id = $1)                         AS accounts,
       (SELECT sum(developer_count) FROM developer_segments WHERE product_id = $1 AND dimension = 'role') AS developers,
       (SELECT count(*) FROM trace_runs r JOIN user_accounts a ON a.id = r.account_id
         WHERE a.product_id = $1 AND r.started_at > now() - interval '30 days')           AS runs_30d`,
    [product.id],
  );
  return { view: "product" as const, product, stats };
}

// ---------- 2. User account ----------

export async function listAccounts() {
  const db = await getDb();
  const accounts = await db.query(
    `SELECT a.id, a.email, a.full_name, a.org_name, a.plan, a.status, a.last_active_at,
            count(r.id) FILTER (WHERE r.started_at > now() - interval '30 days') AS runs_30d
       FROM user_accounts a LEFT JOIN trace_runs r ON r.account_id = a.id
      GROUP BY a.id ORDER BY a.last_active_at DESC`,
  );
  return { view: "accounts" as const, accounts };
}

export async function getAccount(email: string) {
  const db = await getDb();
  const [account] = await db.query("SELECT * FROM user_accounts WHERE lower(email) = lower($1)", [email]);
  if (!account) throw new Error(`No account found for ${email}`);

  const [usage] = await db.query(
    `SELECT
       count(*) FILTER (WHERE started_at >= date_trunc('month', now()))        AS runs_this_month,
       count(*) FILTER (WHERE started_at > now() - interval '30 days')         AS runs_30d,
       count(*) FILTER (WHERE started_at > now() - interval '30 days' AND status <> 'ok') AS failed_30d,
       coalesce(sum(cost_usd) FILTER (WHERE started_at > now() - interval '30 days'), 0) AS cost_30d,
       coalesce(sum(tokens_in + tokens_out) FILTER (WHERE started_at > now() - interval '30 days'), 0) AS tokens_30d
     FROM trace_runs WHERE account_id = $1`,
    [account.id],
  );
  const workflows = await db.query(
    `SELECT name, count(*) AS runs, count(*) FILTER (WHERE status <> 'ok') AS failed
       FROM trace_runs WHERE account_id = $1 AND started_at > now() - interval '30 days'
      GROUP BY name ORDER BY runs DESC`,
    [account.id],
  );
  const recentSessions = await db.query(
    `SELECT s.id, s.agent_name, s.environment, s.status, s.started_at, count(r.id) AS runs
       FROM agent_sessions s LEFT JOIN trace_runs r ON r.session_id = s.id
      WHERE s.account_id = $1 GROUP BY s.id ORDER BY s.started_at DESC LIMIT 8`,
    [account.id],
  );
  return { view: "account" as const, account, usage, workflows, recentSessions };
}

// ---------- 3. Developer population breakdown ----------

export const DIMENSIONS = ["role", "language", "region", "experience", "company_size"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export async function getPopulation(dimension?: Dimension) {
  const db = await getDb();
  const rows = await db.query<{
    dimension: Dimension; segment: string; developer_count: number; active_30d: number; as_of: string;
  }>(
    `SELECT dimension, segment, developer_count, active_30d, as_of::text
       FROM developer_segments
      WHERE as_of = (SELECT max(as_of) FROM developer_segments)
        AND ($1::text IS NULL OR dimension = $1)
      ORDER BY dimension, developer_count DESC`,
    [dimension ?? null],
  );

  const breakdown: Record<string, { segment: string; developers: number; active30d: number; share: number }[]> = {};
  for (const dim of DIMENSIONS.filter((d) => rows.some((r) => r.dimension === d))) {
    const seg = rows.filter((r) => r.dimension === dim);
    const total = seg.reduce((s, r) => s + r.developer_count, 0);
    breakdown[dim] = seg.map((r) => ({
      segment: r.segment,
      developers: r.developer_count,
      active30d: r.active_30d,
      share: total ? r.developer_count / total : 0,
    }));
  }
  // Every dimension partitions the same population, so any one gives the totals.
  const first = Object.values(breakdown)[0] ?? [];
  return {
    view: "population" as const,
    asOf: rows[0]?.as_of ?? null,
    totalDevelopers: first.reduce((s, r) => s + r.developers, 0),
    active30d: first.reduce((s, r) => s + r.active30d, 0),
    selected: dimension ?? null,
    breakdown,
  };
}

// ---------- 4. Trace runs history ----------

export interface TraceFilter {
  email?: string;
  session_id?: string;
  status?: "ok" | "error" | "timeout";
  environment?: "production" | "staging" | "dev";
  workflow?: string;
  days?: number;
  limit?: number;
}

export async function listTraceRuns(f: TraceFilter = {}) {
  const db = await getDb();
  const days = f.days ?? 14;
  const where = `
    r.started_at > now() - make_interval(days => $1::int)
    AND ($2::text IS NULL OR lower(a.email) = lower($2))
    AND ($3::text IS NULL OR r.status = $3)
    AND ($4::text IS NULL OR r.environment = $4)
    AND ($5::text IS NULL OR r.name = $5)
    AND ($6::text IS NULL OR r.session_id = $6)`;
  const params = [days, f.email ?? null, f.status ?? null, f.environment ?? null, f.workflow ?? null, f.session_id ?? null];
  const from = "FROM trace_runs r JOIN user_accounts a ON a.id = r.account_id";

  const [summary] = await db.query(
    `SELECT count(*) AS runs,
            count(*) FILTER (WHERE r.status = 'ok')      AS ok,
            count(*) FILTER (WHERE r.status = 'error')   AS error,
            count(*) FILTER (WHERE r.status = 'timeout') AS timeout,
            coalesce(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.duration_ms), 0)::int AS p50_ms,
            coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms), 0)::int AS p95_ms,
            coalesce(sum(r.cost_usd), 0) AS cost_usd,
            coalesce(sum(r.tokens_in + r.tokens_out), 0) AS tokens
       ${from} WHERE ${where}`,
    params,
  );
  const daily = await db.query(
    `SELECT d::date::text AS day,
            count(r.id) FILTER (WHERE r.status = 'ok')      AS ok,
            count(r.id) FILTER (WHERE r.status = 'error')   AS error,
            count(r.id) FILTER (WHERE r.status = 'timeout') AS timeout
       FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
       LEFT JOIN (SELECT r.* ${from} WHERE ${where}) r ON r.started_at::date = d::date
      GROUP BY d ORDER BY d`,
    params,
  );
  const runs = await db.query(
    `SELECT r.id, r.session_id, r.langfuse_trace_id, r.name, r.environment, r.status, r.started_at, r.duration_ms,
            r.tokens_in + r.tokens_out AS tokens, r.cost_usd, r.error_message, a.email
       ${from} WHERE ${where}
      ORDER BY r.started_at DESC LIMIT $7`,
    [...params, f.limit ?? 25],
  );
  return {
    view: "traces" as const,
    filters: { ...f, days },
    summary,
    daily,
    runs: runs.map((r) => ({ ...r, langfuse_url: langfuse.trace(r.langfuse_trace_id as string) })),
  };
}

interface SessionRow {
  id: string; account_id: number; agent_name: string; environment: string; status: string;
  end_user_id: string | null; started_at: Date; ended_at: Date | null; metadata: Record<string, unknown>;
  email: string; org_name: string; runs: number; failed_runs: number;
  tokens_in: number; tokens_out: number; cost_usd: number; busy_ms: number;
}
interface SessionRunRow {
  id: string; langfuse_trace_id: string; status: string; started_at: Date; duration_ms: number;
  tokens_in: number; tokens_out: number; cost_usd: number; error_message: string | null;
}

export async function getAgentSession(sessionId: string) {
  const db = await getDb();
  const [session] = await db.query<SessionRow>(
    `SELECT s.*, a.email, a.org_name,
            count(r.id) AS runs,
            count(r.id) FILTER (WHERE r.status <> 'ok') AS failed_runs,
            coalesce(sum(r.tokens_in), 0) AS tokens_in,
            coalesce(sum(r.tokens_out), 0) AS tokens_out,
            coalesce(sum(r.cost_usd), 0) AS cost_usd,
            coalesce(sum(r.duration_ms), 0) AS busy_ms
       FROM agent_sessions s
       JOIN user_accounts a ON a.id = s.account_id
       LEFT JOIN trace_runs r ON r.session_id = s.id
      WHERE s.id = $1
      GROUP BY s.id, a.email, a.org_name`,
    [sessionId],
  );
  if (!session) throw new Error(`No agent session ${sessionId}`);
  const runs = await db.query<SessionRunRow>(
    `SELECT id, langfuse_trace_id, status, started_at, duration_ms, tokens_in, tokens_out, cost_usd, error_message
       FROM trace_runs WHERE session_id = $1 ORDER BY started_at`,
    [sessionId],
  );
  return {
    view: "session" as const,
    session: { ...session, langfuse_url: langfuse.session(sessionId) },
    runs: runs.map((r) => ({ ...r, langfuse_url: langfuse.trace(r.langfuse_trace_id as string) })),
  };
}
