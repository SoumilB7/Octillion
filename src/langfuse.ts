/**
 * Langfuse v4 integration. Span-level traces live in Langfuse; Postgres stores only the trace/session ids.
 *  - write: OTLP/HTTP JSON to /api/public/otel/v1/traces (the native v4 ingestion path)
 *  - read:  /api/public/v2/observations (v4 "events only" deployments disable the legacy /traces API)
 */
const HOST = (process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/$/, "");
const PROJECT = process.env.LANGFUSE_PROJECT_ID;
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;

export const langfuseLinks = {
  trace: (traceId: string) => (PROJECT ? `${HOST}/project/${PROJECT}/traces/${traceId}` : null),
  session: (sessionId: string) => (PROJECT ? `${HOST}/project/${PROJECT}/sessions/${sessionId}` : null),
};

function auth(): string {
  if (!PUBLIC_KEY || !SECRET_KEY)
    throw new Error("Langfuse API is not configured: set LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY");
  return "Basic " + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");
}

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${HOST}${path}`, {
    ...init,
    headers: { authorization: auth(), "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw new Error(`Langfuse unreachable at ${HOST}: ${(err as Error).message}`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Langfuse ${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export interface Observation {
  id: string;
  traceId: string;
  parentObservationId: string | null;
  type: string; // AGENT, SPAN, GENERATION, TOOL, RETRIEVER, EVENT, ...
  name: string;
  startTime: string;
  endTime: string | null;
  level: string; // DEFAULT, DEBUG, WARNING, ERROR
  statusMessage: string | null;
  model?: string | null;
  usageDetails?: Record<string, number>;
  totalCost?: number | null;
}

/** All observations (spans) for one trace, oldest first. */
export async function getTraceObservations(traceId: string): Promise<Observation[]> {
  const out: Observation[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ traceId, fields: "core,basic,usage,model", limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    const page = await request(`/api/public/v2/observations?${qs}`);
    out.push(...(page.data as Observation[]));
    cursor = page.meta?.cursor ?? undefined;
  } while (cursor);
  return out.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** Queue deletion of whole traces (all their observations). Langfuse processes this asynchronously. */
export async function deleteTraces(traceIds: string[]): Promise<void> {
  for (let i = 0; i < traceIds.length; i += 500) {
    await request("/api/public/traces", { method: "DELETE", body: JSON.stringify({ traceIds: traceIds.slice(i, i + 500) }) });
  }
}

// ---------- OTLP export ----------

type AttrValue = string | number | boolean | string[];
export interface OtelSpan {
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  parentSpanId?: string;
  name: string;
  start: Date;
  end: Date;
  error?: string;
  attributes: Record<string, AttrValue | undefined>;
}

function otlpValue(v: AttrValue) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: v };
}

const nanos = (d: Date) => (BigInt(d.getTime()) * 1_000_000n).toString();

/** Send spans to Langfuse over OTLP/HTTP JSON. Langfuse queues them; they show up within a few seconds. */
export async function exportSpans(spans: OtelSpan[], serviceName = "tracelight"): Promise<void> {
  if (!spans.length) return;
  await request("/api/public/otel/v1/traces", {
    method: "POST",
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [{
          scope: { name: "devtools-mcp" },
          spans: spans.map((s) => ({
            traceId: s.traceId,
            spanId: s.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name,
            kind: 1,
            startTimeUnixNano: nanos(s.start),
            endTimeUnixNano: nanos(s.end),
            attributes: Object.entries<AttrValue | undefined>({
              ...s.attributes,
              ...(s.error ? { "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": s.error } : {}),
            })
              .filter((e): e is [string, AttrValue] => e[1] !== undefined)
              .map(([key, v]) => ({ key, value: otlpValue(v) })),
            status: s.error ? { code: 2, message: s.error } : { code: 1 },
          })),
        }],
      }],
    }),
  });
}
