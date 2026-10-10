import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Db, Queryable } from "./db.js";
import { getStore } from "./storage.js";
import { indexSealedTranscript, searchEnabled } from "./search.js";

/**
 * Session transcripts are gzipped JSONL in object storage; Postgres keeps the pointer.
 * Keys use Hive-style partition folders so ClickHouse (and lifecycle rules) can prune by path:
 *
 *   streaming: parts/account_id=<id>/date=<yyyy-mm-dd>/env=<env>/agent=<agent>/<session>/part-00001.jsonl.gz
 *              plus a session_transcript_parts row per part.
 *   sealed:    sessions/account_id=<id>/date=<yyyy-mm-dd>/env=<env>/agent=<agent>/<session>.jsonl.gz
 *              (parts compacted and deduped by seq), agent_sessions.transcript_* filled in, parts deleted,
 *              then the events are indexed into ClickHouse for full-text search.
 *
 * Sealed objects and in-flight parts live under different top-level prefixes, so a glob over
 * sessions/** only ever matches complete transcripts. date is the session's UTC start date.
 */
export interface TranscriptEvent {
  seq: number;
  ts: string;
  type: string;
  run_id?: string;
  langfuse_trace_id?: string;
  [key: string]: unknown;
}
export type NewTranscriptEvent = Omit<TranscriptEvent, "seq"> & { seq?: number };

const JSONL_GZ = "application/x-ndjson";

interface SessionKeyRow {
  id: string; account_id: number; agent_name: string; environment: string; started_at: Date; transcript_status: string;
}

async function sessionRow(q: Queryable, sessionId: string): Promise<SessionKeyRow> {
  const [row] = await q.query<SessionKeyRow>(
    "SELECT id, account_id, agent_name, environment, started_at, transcript_status FROM agent_sessions WHERE id = $1",
    [sessionId],
  );
  if (!row) throw new Error(`No agent session ${sessionId}`);
  return row;
}

/** Partition folder values must be path- and Hive-safe. */
const folderValue = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

export function partitionPath(s: Pick<SessionKeyRow, "account_id" | "agent_name" | "environment" | "started_at">): string {
  const date = new Date(s.started_at).toISOString().slice(0, 10);
  return `account_id=${s.account_id}/date=${date}/env=${folderValue(s.environment)}/agent=${folderValue(s.agent_name)}`;
}

const sealedKey = (s: SessionKeyRow) => `sessions/${partitionPath(s)}/${s.id}.jsonl.gz`;
const partKey = (s: SessionKeyRow, partNo: number) =>
  `parts/${partitionPath(s)}/${s.id}/part-${String(partNo).padStart(5, "0")}.jsonl.gz`;

const encode = (events: TranscriptEvent[]) =>
  gzipSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));

const decode = (buf: Buffer): TranscriptEvent[] =>
  gunzipSync(buf).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Append events to a session's transcript as one new part. Events without `seq` are numbered after the last one. */
export async function appendTranscript(db: Db, sessionId: string, events: NewTranscriptEvent[]) {
  if (!events.length) return null;
  const session = await sessionRow(db, sessionId);
  if (session.transcript_status === "sealed" || session.transcript_status === "expired")
    throw new Error(`Transcript for ${sessionId} is ${session.transcript_status}; cannot append`);

  const [{ part_no, last_seq }] = await db.query<{ part_no: number; last_seq: number }>(
    `SELECT coalesce(max(part_no), 0) + 1 AS part_no, coalesce(max(last_seq), 0) AS last_seq
       FROM session_transcript_parts WHERE session_id = $1`,
    [sessionId],
  );
  let next = last_seq;
  const numbered = events.map(({ seq, ...rest }) => ({ seq: seq ?? ++next, ...rest }) as TranscriptEvent);
  const body = encode(numbered);
  const objectKey = partKey(session, part_no);

  // Object first, then the row: a crash in between leaves an orphan object, never a dangling row.
  const store = await getStore();
  await store.put(objectKey, body, JSONL_GZ);
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO session_transcript_parts (session_id, part_no, object_key, first_seq, last_seq, lines, bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, part_no, objectKey, numbered[0].seq, numbered.at(-1)!.seq, numbered.length, body.length],
    );
    await tx.query(
      "UPDATE agent_sessions SET transcript_status = 'streaming' WHERE id = $1 AND transcript_status = 'none'",
      [sessionId],
    );
  });
  return { part_no, object_key: objectKey, lines: numbered.length };
}

async function readParts(q: Queryable, sessionId: string) {
  const parts = await q.query<{ object_key: string }>(
    "SELECT object_key FROM session_transcript_parts WHERE session_id = $1 ORDER BY part_no",
    [sessionId],
  );
  const store = await getStore();
  const bodies = await Promise.all(parts.map((p) => store.get(p.object_key)));
  // Retried appends can repeat a seq; keep the first copy and order by seq.
  const bySeq = new Map<number, TranscriptEvent>();
  for (const e of bodies.flatMap(decode)) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return { keys: parts.map((p) => p.object_key), events: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
}

/**
 * Compact all parts into the final object, record the pointer on agent_sessions, then index it for search.
 * Pass { index: false } when bulk-loading and run reindexTranscripts() once at the end instead.
 */
export async function sealTranscript(db: Db, sessionId: string, { index = true } = {}) {
  const session = await sessionRow(db, sessionId);
  if (session.transcript_status !== "streaming") throw new Error(`Transcript for ${sessionId} is ${session.transcript_status}; nothing to seal`);

  const { keys, events } = await readParts(db, sessionId);
  const body = encode(events);
  const key = sealedKey(session);
  const sha256 = createHash("sha256").update(body).digest("hex");

  const store = await getStore();
  await store.put(key, body, JSONL_GZ);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE agent_sessions
          SET transcript_status = 'sealed', transcript_key = $2, transcript_lines = $3,
              transcript_bytes = $4, transcript_sha256 = $5, transcript_sealed_at = now()
        WHERE id = $1`,
      [sessionId, key, events.length, body.length, sha256],
    );
    await tx.query("DELETE FROM session_transcript_parts WHERE session_id = $1", [sessionId]);
  });
  await store.delete(keys); // after commit; a failure here only leaves orphaned parts

  // Search indexing is best-effort: a failure leaves transcript_indexed_at NULL for `npm run search:reindex`.
  let indexed = false;
  if (index && searchEnabled()) {
    try {
      await indexSealedTranscript(db, sessionId, key);
      indexed = true;
    } catch (err) {
      console.error(`search: failed to index ${sessionId}: ${(err as Error).message}`);
    }
  }
  return { key, lines: events.length, bytes: body.length, sha256, indexed };
}

/** Page through a transcript, whether it's still streaming or sealed. */
export async function readTranscript(db: Db, sessionId: string, offset = 0, limit = 50) {
  const [row] = await db.query<{
    transcript_status: string; transcript_key: string | null; transcript_lines: number | null;
    transcript_bytes: number | null; transcript_sha256: string | null; transcript_sealed_at: Date | null;
  }>(
    `SELECT transcript_status, transcript_key, transcript_lines, transcript_bytes, transcript_sha256, transcript_sealed_at
       FROM agent_sessions WHERE id = $1`,
    [sessionId],
  );
  if (!row) throw new Error(`No agent session ${sessionId}`);

  let events: TranscriptEvent[] = [];
  let downloadUrl: string | null = null;
  if (row.transcript_status === "sealed" && row.transcript_key) {
    const store = await getStore();
    const body = await store.get(row.transcript_key);
    const actual = createHash("sha256").update(body).digest("hex");
    if (row.transcript_sha256 && actual !== row.transcript_sha256)
      throw new Error(`Transcript ${row.transcript_key} failed its sha256 check`);
    events = decode(body);
    downloadUrl = await store.signedUrl(row.transcript_key);
  } else if (row.transcript_status === "streaming") {
    events = (await readParts(db, sessionId)).events;
  }

  return {
    view: "transcript" as const,
    session_id: sessionId,
    status: row.transcript_status,
    key: row.transcript_key,
    bytes: row.transcript_bytes,
    sha256: row.transcript_sha256,
    sealed_at: row.transcript_sealed_at,
    total: events.length,
    offset,
    limit,
    events: events.slice(offset, offset + limit),
    download_url: downloadUrl,
  };
}
