import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createUIResource } from "@mcp-ui/server";
import { z } from "zod";
import * as q from "./queries.js";

export const WIDGET_URI = "ui://devtools/dashboard.html";
export const WIDGET_HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "ui", "widget.html"),
  "utf8",
);

/** Tool name -> handler. Shared by the MCP server and the local browser preview. */
export const handlers = {
  get_product_overview: (a: { slug?: string }) => q.getProduct(a.slug),
  get_user_account: (a: { email?: string }) => (a.email ? q.getAccount(a.email) : q.listAccounts()),
  get_developer_population: (a: { dimension?: q.Dimension }) => q.getPopulation(a.dimension),
  list_trace_runs: (a: q.TraceFilter) => q.listTraceRuns(a),
  get_agent_session: (a: { session_id: string }) => q.getAgentSession(a.session_id),
  get_session_transcript: (a: { session_id: string; offset?: number; limit?: number }) =>
    q.getSessionTranscript(a.session_id, a.offset, a.limit),
  get_run_trace: (a: { run_id: string }) => q.getRunTrace(a.run_id),
  search_transcripts: ({ session_id, ...a }: q.TranscriptSearchInput & { session_id?: string }) =>
    q.searchSessionTranscripts({ ...a, sessionId: a.sessionId ?? session_id }),
} as const;
export type ToolName = keyof typeof handlers;

/** One-line, model-readable summary placed in the text content next to the structured data. */
function summarize(data: Awaited<ReturnType<(typeof handlers)[ToolName]>>): string {
  switch (data.view) {
    case "product":
      return `${data.product.name} v${data.product.version}: ${data.product.tagline}. ${data.stats.developers} developers, ${data.stats.accounts} accounts, ${data.stats.runs_30d} trace runs in the last 30 days.`;
    case "accounts":
      return `${data.accounts.length} user accounts.`;
    case "account":
      return `${data.account.full_name} (${data.account.email}), ${data.account.plan} plan, ${data.account.status}. ${data.usage.runs_30d} runs in 30d, ${data.usage.failed_30d} failed, $${Number(data.usage.cost_30d).toFixed(2)} spend.`;
    case "population":
      return `${data.totalDevelopers} developers (${data.active30d} active in 30d), broken down by ${Object.keys(data.breakdown).join(", ")}.`;
    case "traces": {
      const s = data.summary;
      return `${s.runs} runs in the last ${data.filters.days} days: ${s.ok} ok, ${s.error} error, ${s.timeout} timeout. p50 ${s.p50_ms}ms, p95 ${s.p95_ms}ms, $${Number(s.cost_usd).toFixed(2)} spend.`;
    }
    case "session": {
      const s = data.session;
      const errors = data.runs.filter((r) => r.error_message).map((r) => `${r.id}: ${r.error_message}`);
      return `Session ${s.id} (${s.agent_name}, ${s.environment}) ${s.status}: ${s.runs} runs, ${s.failed_runs} failed, $${Number(s.cost_usd).toFixed(4)} spend.${errors.length ? ` Errors: ${errors.join("; ")}.` : ""} Transcript: ${s.transcript_status}${s.transcript_lines ? ` (${s.transcript_lines} events)` : ""}. Span-level traces are in Langfuse${s.langfuse_url ? ` (${s.langfuse_url})` : ` under session id ${s.id}`}.`;
    }
    case "transcript":
      return `Transcript for ${data.session_id} (${data.status}): events ${data.total ? data.offset + 1 : 0}-${data.offset + data.events.length} of ${data.total}.${data.download_url ? ` Download: ${data.download_url}` : ""}`;
    case "search": {
      if (!data.results)
        return `Transcript search index: ${data.index.events} events from ${data.index.sessions} sealed sessions across ${data.index.partitions.length} monthly partitions and ${data.index.folders.length} bucket folders (account_id/date/env/agent). Pass a query to search.`;
      const r = data.results;
      const top = r.hits.slice(0, 5).map((h) => `${h.session_id}#${h.seq} (${h.type}, ${h.agent}): ${h.text.slice(0, 120)}`);
      return `${r.total} transcript events match "${data.query}" (${data.filters.mode}).${top.length ? ` Top: ${top.join(" | ")}` : ""}`;
    }
    case "trace": {
      const errs = data.observations.filter((o) => o.level === "ERROR").map((o) => `${o.name}: ${o.statusMessage}`);
      return `Run ${data.run.id} (${data.run.name}) ${data.run.status}: ${data.observations.length} spans in Langfuse trace ${data.trace.id}.${errs.length ? ` Errors: ${errs.join("; ")}.` : ""}`;
    }
  }
}

/** Run a handler and shape its output as an MCP tool result (text for the model, structured data for the UI). */
export async function runTool(name: ToolName, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const data = await (handlers[name] as (a: unknown) => ReturnType<(typeof handlers)[ToolName]>)(args);
    // JSON round-trip turns Date objects into ISO strings.
    const structured = JSON.parse(JSON.stringify(data));
    return {
      content: [{ type: "text", text: `${summarize(data)}\n\n${JSON.stringify(structured)}` }],
      structuredContent: structured,
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "devtools-mcp", version: "1.0.0" });

  registerAppResource(
    server,
    "DevTools dashboard",
    WIDGET_URI,
    { description: "Interactive views for product, accounts, developer population and trace runs", mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const ui = createUIResource({
        uri: WIDGET_URI,
        content: { type: "rawHtml", htmlString: WIDGET_HTML },
        encoding: "text",
        adapters: { mcpApps: { enabled: true } },
      });
      return { contents: [ui.resource] };
    },
  );

  const ui = { ui: { resourceUri: WIDGET_URI } };
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  registerAppTool(server, "get_product_overview", {
    title: "DevTools product overview",
    description: "Describe the DevTools product: what it does, features, pricing tiers, integrations and headline usage stats.",
    inputSchema: { slug: z.string().optional().describe("Product slug; defaults to the primary product") },
    annotations: readOnly,
    _meta: ui,
  }, (a) => runTool("get_product_overview", a));

  registerAppTool(server, "get_user_account", {
    title: "User account",
    description: "Look up a user account by email: profile, plan, quota usage, 30-day run stats, workflows and recent runs. Omit email to list all accounts.",
    inputSchema: { email: z.string().email().optional().describe("Account email, e.g. priya@acme.dev") },
    annotations: readOnly,
    _meta: ui,
  }, (a) => runTool("get_user_account", a));

  registerAppTool(server, "get_developer_population", {
    title: "Developer population breakdown",
    description: "Break down the developer population using the product by role, language, region, experience or company size, with 30-day active counts.",
    inputSchema: { dimension: z.enum(q.DIMENSIONS).optional().describe("Limit to one dimension; omit for all") },
    annotations: readOnly,
    _meta: ui,
  }, (a) => runTool("get_developer_population", a));

  registerAppTool(server, "list_trace_runs", {
    title: "Trace runs history",
    description: "Trace run history with summary stats (failure rate, p50/p95 latency, spend), runs per day by status, and the latest runs. Filter by account email, status, environment, workflow and time window.",
    inputSchema: {
      email: z.string().optional().describe("Only runs from this account"),
      session_id: z.string().optional().describe("Only runs in this agent session, e.g. ses_00042"),
      status: z.enum(["ok", "error", "timeout"]).optional(),
      environment: z.enum(["production", "staging", "dev"]).optional(),
      workflow: z.string().optional().describe("Workflow name, e.g. support-agent"),
      days: z.number().int().min(1).max(90).optional().describe("Look-back window in days (default 14)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max runs to list (default 25)"),
    },
    annotations: readOnly,
    _meta: ui,
  }, (a) => runTool("list_trace_runs", a));

  registerAppTool(server, "get_agent_session", {
    title: "Agent session",
    description: "One agent session: status, totals and the timeline of trace runs (turns) in it, with errors. Span-level detail lives in Langfuse; runs carry their Langfuse trace ids and links.",
    inputSchema: { session_id: z.string().describe("Session id, e.g. ses_00042") },
    annotations: readOnly,
    _meta: ui,
  }, (a) => runTool("get_agent_session", a));

  registerAppTool(server, "get_session_transcript", {
    title: "Agent session transcript",
    description: "Read an agent session's JSONL transcript (user/assistant messages, tool calls and results, run boundaries) from object storage, a page at a time. Works for sealed and still-streaming sessions.",
    inputSchema: {
      session_id: z.string().describe("Session id, e.g. ses_00042"),
      offset: z.number().int().min(0).optional().describe("Index of the first event (default 0)"),
      limit: z.number().int().min(1).max(500).optional().describe("Events per page (default 50)"),
    },
    annotations: readOnly,
    _meta: ui,
  }, (a) => runTool("get_session_transcript", a));

  registerAppTool(server, "search_transcripts", {
    title: "Search session transcripts",
    description: "Full-text search across all sealed agent-session transcripts (user and assistant messages, tool calls and results, errors), backed by a ClickHouse full-text index fed from the transcript bucket. Case-insensitive. mode 'all' needs every word, 'any' needs one, 'phrase' needs the exact phrase. Omit query to see index stats and the bucket's partition folders.",
    inputSchema: {
      query: z.string().optional().describe("Words to search for, e.g. 'RateLimitError' or 'parental leave'"),
      mode: z.enum(["all", "any", "phrase"]).optional().describe("Default 'all'"),
      email: z.string().optional().describe("Only this account's sessions"),
      agent: z.string().optional().describe("Agent name, e.g. support-agent"),
      environment: z.enum(["production", "staging", "dev"]).optional(),
      type: z.enum(["user_message", "assistant_message", "tool_call", "tool_result", "run_end", "session_start", "session_end"]).optional(),
      session_id: z.string().optional(),
      days: z.number().int().min(1).max(365).optional().describe("Only sessions started in the last N days"),
      limit: z.number().int().min(1).max(200).optional().describe("Max hits (default 25)"),
    },
    annotations: readOnly,
    _meta: ui,
  }, (a) => runTool("search_transcripts", a));

  registerAppTool(server, "get_run_trace", {
    title: "Run trace (Langfuse)",
    description: "Fetch a run's span tree live from Langfuse (agent steps, LLM generations with model/tokens, tool calls, retrievals, errors) and show it as a waterfall.",
    inputSchema: { run_id: z.string().describe("Run id, e.g. run_00042") },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: ui,
  }, (a) => runTool("get_run_trace", a));

  return server;
}
