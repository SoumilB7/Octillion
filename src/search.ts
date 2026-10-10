import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { Db } from "./db.js";
import { getStore } from "./storage.js";

/**
 * Full-text search over session transcripts, backed by ClickHouse (local or ClickHouse Cloud).
 *
 * Sealed transcripts live in the bucket under Hive-style partition folders:
 *   sessions/account_id=<id>/date=<yyyy-mm-dd>/env=<env>/agent=<agent>/<session>.jsonl.gz
 * The app pushes them into ClickHouse (so a cloud ClickHouse never needs to reach the bucket):
 * a scoped reindex lists only the folders in scope, the partition values come from the key, and
 * each JSONL line becomes one row in devtools.transcript_events, which has a `text` full-text
 * index on a lowercased copy of the searchable text and is partitioned by month like the folders.
 */
const DB = "devtools";
const TABLE = `${DB}.transcript_events`;

interface ClickHouseConfig { url: string; username: string; password: string }

/**
 * Connection settings. Credentials come from CLICKHOUSE_CREDENTIALS_FILE (a gitignored file with
 * "Username: ..." / "Password: ..." lines, optionally "Host: ..." or "URL: ...") or from
 * CLICKHOUSE_USER / CLICKHOUSE_PASSWORD; the URL from CLICKHOUSE_URL or the file.
 */
function config(): ClickHouseConfig | null {
  const file: Record<string, string> = {};
  const credFile = process.env.CLICKHOUSE_CREDENTIALS_FILE;
  if (credFile) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const line of readFileSync(path.resolve(root, credFile), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_ ]+?)\s*[:=]\s*(.*?)\s*$/);
      if (m) file[m[1].toLowerCase()] = m[2];
    }
  }
  const host = file.url ?? file.host;
  const url = process.env.CLICKHOUSE_URL || (host ? (/^https?:\/\//.test(host) ? host : `https://${host}:8443`) : "");
  if (!url) return null;
  return {
    url,
    username: file.username ?? file.user ?? process.env.CLICKHOUSE_USER ?? "default",
    password: file.password ?? process.env.CLICKHOUSE_PASSWORD ?? "",
  };
}

export const searchEnabled = () => config() !== null;

let client: ClickHouseClient | undefined;
let schemaReady: Promise<void> | undefined;

function ch(): ClickHouseClient {
  const cfg = config();
  if (!cfg) throw new Error("Transcript search needs ClickHouse: set CLICKHOUSE_URL (and credentials, e.g. CLICKHOUSE_CREDENTIALS_FILE)");
  client ??= createClient({
    ...cfg,
    request_timeout: 60_000,
    clickhouse_settings: { enable_full_text_index: 1, date_time_input_format: "best_effort" },
  });
  return client;
}

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await ch().command({ query: `CREATE DATABASE IF NOT EXISTS ${DB}` });
    await ch().command({
      query: `
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          account_id        UInt32,
          date              Date,                      -- session start date, from the date= folder
          environment       LowCardinality(String),
          agent             LowCardinality(String),
          session_id        String,
          seq               UInt32,
          ts                DateTime64(3, 'UTC'),
          type              LowCardinality(String),
          run_id            String,
          langfuse_trace_id String,
          text              String,                    -- searchable text pulled out of the event
          text_lc           String MATERIALIZED lower(text),
          raw               String CODEC(ZSTD(3)),     -- the original JSONL line
          object_key        String,
          indexed_at        DateTime DEFAULT now(),
          INDEX text_idx text_lc TYPE text(tokenizer = splitByNonAlpha)
        )
        ENGINE = MergeTree
        PARTITION BY toYYYYMM(date)                    -- mirrors the date= folders in the bucket
        ORDER BY (account_id, date, session_id, seq)`,
    });
  })().catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  return schemaReady;
}

// ---------- bucket layout ----------

const SEALED_KEY = /^sessions\/account_id=(\d+)\/date=(\d{4}-\d{2}-\d{2})\/env=([^/]+)\/agent=([^/]+)\/([^/]+)\.jsonl\.gz$/;

export interface Partition { account_id: number; date: string; env: string; agent: string; session_id: string }

export function parseSealedKey(key: string): Partition | null {
  const m = key.match(SEALED_KEY);
  return m ? { account_id: Number(m[1]), date: m[2], env: m[3], agent: m[4], session_id: m[5] } : null;
}

export interface ReindexScope {
  accountId?: number;
  month?: string; // YYYY-MM
}

/** Sealed transcript keys in scope. The scope narrows the listing prefix, so only those folders are walked. */
async function listSealed(scope: ReindexScope) {
  if (scope.month && !/^\d{4}-\d{2}$/.test(scope.month)) throw new Error(`month must be YYYY-MM, got ${scope.month}`);
  const prefix =
    scope.accountId === undefined ? "sessions/"
    : `sessions/account_id=${Math.trunc(scope.accountId)}/${scope.month ? `date=${scope.month}-` : ""}`;
  const objects = await (await getStore()).list(prefix);
  return {
    prefix,
    objects: objects
      .map((o) => ({ ...o, part: parseSealedKey(o.key) }))
      .filter((o): o is typeof o & { part: Partition } => !!o.part && (!scope.month || o.part.date.startsWith(scope.month))),
  };
}

// ---------- indexing (app pushes rows) ----------

const str = (v: unknown) => (typeof v === "string" ? v : "");
const jsonOrString = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** Turn one sealed transcript object into transcript_events rows. */
async function rowsFor(key: string, part: Partition) {
  const body = gunzipSync(await (await getStore()).get(key)).toString("utf8");
  return body.split("\n").filter(Boolean).map((line) => {
    const e = JSON.parse(line) as Record<string, unknown>;
    return {
      account_id: part.account_id,
      date: part.date,
      environment: part.env,
      agent: part.agent,
      session_id: part.session_id,
      seq: Number(e.seq ?? 0),
      ts: str(e.ts),
      type: str(e.type),
      run_id: str(e.run_id),
      langfuse_trace_id: str(e.langfuse_trace_id),
      text: [str(e.content), str(e.name), str(e.error), str(e.agent), jsonOrString(e.input), jsonOrString(e.output)]
        .filter(Boolean)
        .join(" "),
      raw: line,
      object_key: key,
    };
  });
}

async function insertRows(rows: Awaited<ReturnType<typeof rowsFor>>) {
  for (let i = 0; i < rows.length; i += 10_000)
    await ch().insert({ table: TABLE, values: rows.slice(i, i + 10_000), format: "JSONEachRow" });
}

/** Index one sealed transcript (replacing any earlier rows for the session) and stamp Postgres. */
export async function indexSealedTranscript(db: Db, sessionId: string, key: string): Promise<void> {
  const part = parseSealedKey(key);
  if (!part) throw new Error(`Not a sealed transcript key: ${key}`);
  await ensureSchema();
  const rows = await rowsFor(key, part);
  const [prev] = await db.query<{ transcript_indexed_at: Date | null }>(
    "SELECT transcript_indexed_at FROM agent_sessions WHERE id = $1",
    [sessionId],
  );
  if (prev?.transcript_indexed_at) await removeFromIndex(sessionId);
  await insertRows(rows);
  await db.query("UPDATE agent_sessions SET transcript_indexed_at = now() WHERE id = $1", [sessionId]);
}

/** Drop a session's events from the index (e.g. when its transcript expires or is deleted). */
export async function removeFromIndex(sessionId: string): Promise<void> {
  await ensureSchema();
  await ch().command({ query: `DELETE FROM ${TABLE} WHERE session_id = {id:String}`, query_params: { id: sessionId } });
}

/**
 * Rebuild the index from the bucket for a scope, clearing that scope in ClickHouse first:
 *   {}                       list sessions/                               TRUNCATE
 *   { month: "2026-10" }     list sessions/, keep date=2026-10-*          DROP PARTITION 202610
 *   { accountId: 1, month }  list sessions/account_id=1/date=2026-10-     lightweight DELETE
 */
export async function reindexTranscripts(db: Db, scope: ReindexScope = {}) {
  await ensureSchema();
  const started = Date.now();
  const { prefix, objects } = await listSealed(scope);

  const conds: string[] = [];
  if (scope.accountId !== undefined) conds.push(`account_id = ${Math.trunc(scope.accountId)}`);
  if (scope.month) conds.push(`toYYYYMM(date) = ${scope.month.replace("-", "")}`);
  if (!conds.length) await ch().command({ query: `TRUNCATE TABLE ${TABLE}` });
  else if (scope.accountId === undefined)
    await ch().command({ query: `ALTER TABLE ${TABLE} DROP PARTITION ${scope.month!.replace("-", "")}` });
  else await ch().command({ query: `DELETE FROM ${TABLE} WHERE ${conds.join(" AND ")}` });

  // Read objects with bounded concurrency, insert in large batches.
  let events = 0;
  let batch: Awaited<ReturnType<typeof rowsFor>> = [];
  const queue = [...objects];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let o = queue.shift(); o; o = queue.shift()) {
      const rows = await rowsFor(o.key, o.part);
      events += rows.length;
      batch.push(...rows);
      if (batch.length >= 10_000) {
        const full = batch;
        batch = [];
        await insertRows(full);
      }
    }
  }));
  await insertRows(batch);

  const ids = objects.map((o) => o.part.session_id);
  if (ids.length) await db.query("UPDATE agent_sessions SET transcript_indexed_at = now() WHERE id = ANY($1)", [ids]);
  return { prefix, files: objects.length, sessions: new Set(ids).size, events, ms: Date.now() - started };
}

// ---------- search ----------

export interface SearchParams {
  query: string;
  mode?: "all" | "any" | "phrase";
  accountId?: number;
  agent?: string;
  environment?: string;
  type?: string;
  sessionId?: string;
  days?: number;
  limit?: number;
}

export interface SearchHit {
  account_id: number; agent: string; environment: string; session_id: string; seq: number; ts: string;
  type: string; run_id: string; langfuse_trace_id: string; text: string; object_key: string;
}

export async function searchTranscripts(p: SearchParams) {
  await ensureSchema();
  const q = p.query.trim();
  const mode = p.mode ?? "all";
  const params: Record<string, unknown> = { q: q.toLowerCase() };
  const where: string[] = [];

  if (q) {
    if (mode === "any") where.push("hasAnyTokens(text_lc, {q:String})");
    else where.push("hasAllTokens(text_lc, {q:String})"); // index narrows granules for phrase too
    if (mode === "phrase") where.push("positionCaseInsensitiveUTF8(text, {phrase:String}) > 0"), (params.phrase = q);
  }
  if (p.accountId !== undefined) where.push("account_id = {account:UInt32}"), (params.account = p.accountId);
  if (p.agent) where.push("agent = {agent:String}"), (params.agent = p.agent);
  if (p.environment) where.push("environment = {env:String}"), (params.env = p.environment);
  if (p.type) where.push("type = {type:String}"), (params.type = p.type);
  if (p.sessionId) where.push("session_id = {session:String}"), (params.session = p.sessionId);
  if (p.days) where.push("date >= today() - {days:UInt32}"), (params.days = p.days);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const started = Date.now();
  const hitsRes = await ch().query({
    query: `
      SELECT account_id, agent, environment, session_id, seq, ts, type, run_id, langfuse_trace_id,
             substring(text, 1, 2000) AS text, object_key
        FROM ${TABLE} ${whereSql}
       ORDER BY ts DESC
       LIMIT {limit:UInt32}`,
    query_params: { ...params, limit: p.limit ?? 25 },
    format: "JSONEachRow",
  });
  const hits = await hitsRes.json<SearchHit>();
  const summary = JSON.parse(String(hitsRes.response_headers["x-clickhouse-summary"] ?? "{}"));

  const facetRows = await (await ch().query({
    query: `SELECT agent, type, count() AS n FROM ${TABLE} ${whereSql} GROUP BY agent, type`,
    query_params: params,
    format: "JSONEachRow",
  })).json<{ agent: string; type: string; n: string }>();
  const facet = (key: "agent" | "type") => {
    const m = new Map<string, number>();
    for (const r of facetRows) m.set(r[key], (m.get(r[key]) ?? 0) + Number(r.n));
    return [...m].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  };

  return {
    total: facetRows.reduce((s, r) => s + Number(r.n), 0),
    hits: hits.map((h) => ({ ...h, account_id: Number(h.account_id), seq: Number(h.seq) })),
    facets: { agent: facet("agent"), type: facet("type") },
    stats: { ms: Date.now() - started, rows_read: Number(summary.read_rows ?? 0) },
  };
}

/** Index size and partitions from ClickHouse, plus the bucket's partition folders (from a listing, no data read). */
export async function searchIndexStats() {
  await ensureSchema();
  const rows = async <T>(query: string) => (await (await ch().query({ query, format: "JSONEachRow" })).json<T>());
  const [totals] = await rows<{ events: string; sessions: string }>(
    `SELECT count() AS events, uniqExact(session_id) AS sessions FROM ${TABLE}`,
  );
  const partitions = await rows<{ partition: string; rows: string; bytes: string }>(
    `SELECT partition, sum(rows) AS rows, sum(data_compressed_bytes) AS bytes
       FROM system.parts WHERE database = '${DB}' AND table = 'transcript_events' AND active
      GROUP BY partition ORDER BY partition`,
  );
  const [index] = await rows<{ bytes: string }>(
    `SELECT sum(data_compressed_bytes) AS bytes FROM system.data_skipping_indices
      WHERE database = '${DB}' AND table = 'transcript_events' AND name = 'text_idx'`,
  );

  const folders = new Map<string, { account_id: number; month: string; env: string; agent: string; files: number }>();
  for (const { part } of (await listSealed({})).objects) {
    const month = part.date.slice(0, 7);
    const k = `${part.account_id}/${month}/${part.env}/${part.agent}`;
    const f = folders.get(k) ?? { account_id: part.account_id, month, env: part.env, agent: part.agent, files: 0 };
    f.files++;
    folders.set(k, f);
  }
  return {
    clickhouse: new URL(config()!.url).host,
    events: Number(totals?.events ?? 0),
    sessions: Number(totals?.sessions ?? 0),
    index_bytes: Number(index?.bytes ?? 0),
    partitions: partitions.map((p) => ({ partition: p.partition, rows: Number(p.rows), bytes: Number(p.bytes) })),
    folders: [...folders.values()].sort((a, b) => a.account_id - b.account_id || a.month.localeCompare(b.month)),
  };
}
