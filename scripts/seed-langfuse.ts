// Send a span tree for every seeded trace run to Langfuse, using the run's langfuse_trace_id and
// session id from Postgres, so the dashboard's Langfuse links and waterfall resolve.
// Re-runnable: Langfuse v4 keys events by start time too, and seed timestamps move on every
// db:reset, so existing traces for these ids are deleted (and awaited) before re-sending.
import { createHash } from "node:crypto";
import { getDb } from "../src/db.js";
import { deleteTraces, exportSpans, getTraceObservations, type OtelSpan } from "../src/langfuse.js";
import { SCRIPTS } from "../src/seed-transcripts.js";

interface Row {
  id: string; session_id: string; turn: number; langfuse_trace_id: string; name: string; environment: string;
  status: "ok" | "error" | "timeout"; started_at: Date; duration_ms: number; tokens_in: number; tokens_out: number;
  error_message: string | null; email: string; end_user_id: string | null;
}

const spanId = (runId: string, i: number) => createHash("md5").update(`${runId}:${i}`).digest("hex").slice(0, 16);

function spansFor(r: Row): OtelSpan[] {
  const script = SCRIPTS[r.name] ?? SCRIPTS["rag-qa"];
  const [prompt, tool, toolInput, toolOutput, reply] = script[(r.turn - 1) % script.length];
  const t = (frac: number) => new Date(new Date(r.started_at).getTime() + r.duration_ms * frac);
  const model = r.tokens_out % 2 ? "claude-sonnet-5-5" : "claude-haiku-5-5";
  const common = { "langfuse.session.id": r.session_id, "langfuse.environment": r.environment };
  const root = spanId(r.id, 0);

  const spans: OtelSpan[] = [{
    traceId: r.langfuse_trace_id, spanId: root, name: r.name, start: t(0), end: t(1),
    error: r.status === "ok" ? undefined : (r.error_message ?? r.status),
    attributes: {
      ...common,
      "langfuse.observation.type": "agent",
      "langfuse.trace.name": r.name,
      "langfuse.user.id": r.end_user_id ?? undefined,
      "langfuse.trace.tags": [r.environment, r.name],
      "langfuse.trace.metadata.run_id": r.id,
      "langfuse.trace.metadata.account": r.email,
      "langfuse.trace.input": prompt,
      "langfuse.trace.output": r.status === "ok" ? reply : undefined,
    },
  }, {
    traceId: r.langfuse_trace_id, spanId: spanId(r.id, 1), parentSpanId: root, name: "plan", start: t(0.01), end: t(0.24),
    attributes: {
      ...common,
      "langfuse.observation.type": "generation",
      "gen_ai.request.model": model,
      "gen_ai.usage.input_tokens": Math.round(r.tokens_in * 0.3),
      "gen_ai.usage.output_tokens": Math.round(r.tokens_out * 0.2),
      "langfuse.observation.input": prompt,
    },
  }, {
    traceId: r.langfuse_trace_id, spanId: spanId(r.id, 2), parentSpanId: root, name: tool, start: t(0.26), end: t(0.55),
    error: r.status === "error" ? (r.error_message ?? "tool failed") : undefined,
    attributes: {
      ...common,
      "langfuse.observation.type": tool === "retrieve_context" ? "retriever" : "tool",
      "langfuse.observation.input": JSON.stringify(toolInput),
      "langfuse.observation.output": r.status === "error" ? undefined : JSON.stringify(toolOutput),
    },
  }];
  if (r.status !== "error") {
    spans.push({
      traceId: r.langfuse_trace_id, spanId: spanId(r.id, 3), parentSpanId: root, name: "compose_answer",
      start: t(0.58), end: t(r.status === "timeout" ? 1 : 0.98),
      error: r.status === "timeout" ? "Generation cancelled at run deadline" : undefined,
      attributes: {
        ...common,
        "langfuse.observation.type": "generation",
        "gen_ai.request.model": model,
        "gen_ai.usage.input_tokens": Math.round(r.tokens_in * 0.7),
        "gen_ai.usage.output_tokens": Math.round(r.tokens_out * 0.8),
        "langfuse.observation.output": r.status === "ok" ? reply : undefined,
      },
    });
  }
  return spans;
}

const db = await getDb();
const runs = await db.query<Row>(
  `SELECT r.id, r.session_id, r.langfuse_trace_id, r.name, r.environment, r.status, r.started_at, r.duration_ms,
          r.tokens_in, r.tokens_out, r.error_message, a.email, s.end_user_id,
          row_number() OVER (PARTITION BY r.session_id ORDER BY r.started_at)::int AS turn
     FROM trace_runs r
     JOIN user_accounts a ON a.id = r.account_id
     JOIN agent_sessions s ON s.id = r.session_id
    ORDER BY r.started_at`,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const samples = [runs[0], runs[Math.floor(runs.length / 2)], runs.at(-1)!].map((r) => r.langfuse_trace_id);
const anyExist = async () => (await Promise.all(samples.map(getTraceObservations))).some((o) => o.length);

if (await anyExist()) {
  process.stdout.write("Deleting previously seeded traces from Langfuse");
  await deleteTraces(runs.map((r) => r.langfuse_trace_id));
  for (let attempt = 1; await anyExist(); attempt++) {
    if (attempt === 90) throw new Error("Langfuse did not finish deleting old traces; check the langfuse-worker logs");
    process.stdout.write(".");
    await sleep(2000);
  }
  console.log(" done");
}

const BATCH = 40;
for (let i = 0; i < runs.length; i += BATCH) {
  await exportSpans(runs.slice(i, i + BATCH).flatMap(spansFor));
  process.stdout.write(`\rsent ${Math.min(i + BATCH, runs.length)}/${runs.length} runs`);
}
console.log();

// Ingestion is queued; wait until the most recent run is queryable.
const probe = runs.at(-1)!;
for (let attempt = 1; ; attempt++) {
  const obs = await getTraceObservations(probe.langfuse_trace_id);
  if (obs.length) {
    console.log(`Langfuse has ${probe.id}'s trace (${obs.length} spans). Open ${process.env.LANGFUSE_HOST ?? ""}/project/${process.env.LANGFUSE_PROJECT_ID ?? ""}/sessions`);
    break;
  }
  if (attempt === 30) throw new Error("Spans were accepted but never became queryable; check the langfuse-worker logs");
  await sleep(2000);
}
await db.close();
