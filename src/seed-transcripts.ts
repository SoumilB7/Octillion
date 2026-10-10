import type { Db } from "./db.js";
import { getStore } from "./storage.js";
import { reindexTranscripts, searchEnabled } from "./search.js";
import { appendTranscript, sealTranscript, type NewTranscriptEvent } from "./transcripts.js";

// Sample conversations per agent: [user prompt, tool name, tool input, tool output, assistant reply]
export const SCRIPTS: Record<string, [string, string, unknown, unknown, string][]> = {
  "support-agent": [
    ["Where is my order #48213? It was supposed to arrive yesterday.", "search_orders", { order_id: "48213" }, { status: "in_transit", carrier: "UPS", eta: "tomorrow" }, "Your order #48213 is in transit with UPS and should arrive tomorrow. I've sent you the tracking link."],
    ["Can I change the shipping address?", "update_order", { order_id: "48213", field: "address" }, { ok: false, reason: "already shipped" }, "It has already shipped, so I can't change the address, but you can redirect it from the UPS link."],
    ["Thanks, can you also refund the shipping fee?", "issue_refund", { order_id: "48213", amount: 7.99 }, { ok: true, refund_id: "rf_9921" }, "Done. I've refunded the $7.99 shipping fee (refund rf_9921)."],
  ],
  "rag-qa": [
    ["What's our parental leave policy for contractors?", "retrieve_context", { query: "parental leave contractors", k: 5 }, { documents: ["hr/leave-policy.md#contractors"] }, "Contractors aren't covered by the parental leave policy; their agency agreement governs leave."],
    ["Does that change after 12 months?", "retrieve_context", { query: "contractor conversion 12 months", k: 5 }, { documents: ["hr/contractor-conversion.md"] }, "Yes. Contractors converted to employees after 12 months become eligible from their conversion date."],
  ],
  "code-review-bot": [
    ["Review PR #1742: add retry to payment webhook handler", "lint_diff", { pr: 1742 }, { findings: 2 }, "Two issues: the retry loop has no backoff, and the idempotency key isn't checked before re-processing."],
    ["I pushed a fix, can you re-check?", "lint_diff", { pr: 1742, commit: "a91f3c2" }, { findings: 0 }, "Looks good now. Exponential backoff is in place and duplicate deliveries are skipped."],
  ],
  "invoice-extractor": [
    ["Extract fields from invoice INV-2026-0912.pdf", "ocr_document", { file: "INV-2026-0912.pdf" }, { pages: 2 }, '{"vendor":"Northwind Supplies","total":1284.50,"currency":"USD","due":"2026-11-01"}'],
    ["Now do INV-2026-0913.pdf", "ocr_document", { file: "INV-2026-0913.pdf" }, { pages: 1 }, '{"vendor":"Contoso Ltd","total":312.00,"currency":"EUR","due":"2026-10-30"}'],
  ],
  "sql-copilot": [
    ["How many signups did we get last week by country?", "run_sql", { sql: "SELECT country, count(*) FROM signups WHERE created_at > now() - interval '7 days' GROUP BY 1" }, { rows: 14 }, "1,284 signups across 14 countries; the US (412) and India (233) lead."],
    ["Break the US down by plan.", "run_sql", { sql: "SELECT plan, count(*) FROM signups WHERE country = 'US' GROUP BY 1" }, { rows: 3 }, "US signups: free 301, pro 88, team 23."],
  ],
};

interface SeedRun {
  id: string; langfuse_trace_id: string; status: string; started_at: Date; duration_ms: number;
  tokens_in: number; tokens_out: number; error_message: string | null;
}

/** Turn a session's runs into transcript events (one user turn per run). */
export function buildEvents(session: { id: string; agent_name: string; end_user_id: string | null; started_at: Date }, runs: SeedRun[]) {
  const script = SCRIPTS[session.agent_name] ?? SCRIPTS["rag-qa"];
  const at = (d: Date | number, plusMs = 0) => new Date(new Date(d).getTime() + plusMs).toISOString();
  const turns: NewTranscriptEvent[][] = runs.map((r, i) => {
    const [prompt, tool, input, output, reply] = script[i % script.length];
    const ids = { run_id: r.id, langfuse_trace_id: r.langfuse_trace_id };
    const step = r.duration_ms / 4;
    const events: NewTranscriptEvent[] = [
      { ts: at(r.started_at), type: "user_message", ...ids, content: prompt },
      { ts: at(r.started_at, step), type: "tool_call", ...ids, name: tool, input },
    ];
    if (r.status === "error") {
      events.push({ ts: at(r.started_at, step * 2), type: "tool_result", ...ids, name: tool, error: r.error_message });
    } else {
      events.push(
        { ts: at(r.started_at, step * 2), type: "tool_result", ...ids, name: tool, output },
        ...(r.status === "ok"
          ? [{ ts: at(r.started_at, step * 3), type: "assistant_message", ...ids, content: reply,
               model: r.tokens_out % 2 ? "claude-sonnet-5-5" : "claude-haiku-5-5",
               usage: { input_tokens: r.tokens_in, output_tokens: r.tokens_out } }]
          : []),
      );
    }
    events.push({ ts: at(r.started_at, r.duration_ms), type: "run_end", ...ids, status: r.status, duration_ms: r.duration_ms,
                  ...(r.error_message ? { error: r.error_message } : {}) });
    return events;
  });
  const start: NewTranscriptEvent = { ts: at(session.started_at), type: "session_start", session_id: session.id,
                                      agent: session.agent_name, end_user_id: session.end_user_id };
  return { start, turns };
}

/** Write a transcript for every seeded session: one part per run, sealed unless the session is still active. */
export async function seedTranscripts(db: Db): Promise<void> {
  const store = await getStore();
  await store.deletePrefix("sessions/");
  await store.deletePrefix("parts/");

  const sessions = await db.query<{ id: string; agent_name: string; status: string; end_user_id: string | null; started_at: Date; ended_at: Date | null }>(
    "SELECT id, agent_name, status, end_user_id, started_at, ended_at FROM agent_sessions ORDER BY id",
  );
  const allRuns = await db.query<SeedRun & { session_id: string }>(
    `SELECT session_id, id, langfuse_trace_id, status, started_at, duration_ms, tokens_in, tokens_out, error_message
       FROM trace_runs ORDER BY session_id, started_at`,
  );
  const runsBySession = new Map<string, SeedRun[]>();
  for (const r of allRuns) runsBySession.set(r.session_id, [...(runsBySession.get(r.session_id) ?? []), r]);

  const queue = [...sessions];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const { start, turns } = buildEvents(s, runsBySession.get(s.id) ?? []);
      for (const [i, turn] of turns.entries()) await appendTranscript(db, s.id, i === 0 ? [start, ...turn] : turn);
      if (s.status !== "active") {
        await appendTranscript(db, s.id, [{ ts: new Date(s.ended_at ?? Date.now()).toISOString(), type: "session_end", status: s.status }]);
        await sealTranscript(db, s.id, { index: false }); // indexed in one pass below
      }
    }
  };
  // PGlite is single-connection, so parallelism mostly helps the object store round-trips.
  await Promise.all(Array.from({ length: db.kind === "pglite" ? 4 : 8 }, worker));

  if (searchEnabled()) {
    const r = await reindexTranscripts(db);
    console.error(`search: indexed ${r.events} events from ${r.sessions} sealed transcripts (${r.files} files under ${r.prefix}) in ${r.ms}ms`);
  }
}
