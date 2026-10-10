// End-to-end check: connect an MCP client to the server and exercise every tool + the UI resource.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, WIDGET_URI } from "../src/server.js";
import { getDb } from "../src/db.js";

const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await createServer().connect(serverT);
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(clientT);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
for (const t of tools) {
  const meta = t._meta as { ui?: { resourceUri?: string } } | undefined;
  assert.equal(meta?.ui?.resourceUri, WIDGET_URI, `${t.name} links the UI resource`);
}

const res = await client.readResource({ uri: WIDGET_URI });
const ui = res.contents[0] as { mimeType: string; text: string };
assert.equal(ui.mimeType, "text/html;profile=mcp-app");
assert.ok(ui.text.includes("McpAppsAdapter") || ui.text.includes("mcp-apps"), "MCP Apps adapter injected");
console.log(`resource: ${WIDGET_URI} (${ui.mimeType}, ${ui.text.length} bytes)`);

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} failed: ${JSON.stringify(r.content)}`);
  const data = r.structuredContent as Record<string, any>;
  console.log(`✓ ${name} ${JSON.stringify(args)} -> ${(r.content as any)[0].text.split("\n")[0]}`);
  return data;
}

assert.equal((await call("get_product_overview")).view, "product");
assert.equal((await call("get_user_account")).view, "accounts");
assert.equal((await call("get_user_account", { email: "priya@acme.dev" })).view, "account");
const pop = await call("get_developer_population", { dimension: "language" });
assert.deepEqual(Object.keys(pop.breakdown), ["language"]);
const traces = await call("list_trace_runs", { days: 7, status: "error" });
assert.ok(traces.runs.every((r: any) => r.status === "error"));
assert.equal(traces.daily.length, 7);
const session = await call("get_agent_session", { session_id: traces.runs[0].session_id });
assert.ok(session.runs.some((r: any) => r.id === traces.runs[0].id), "session contains the run");
assert.equal(session.session.runs, session.runs.length);
const inSession = await call("list_trace_runs", { session_id: session.session.id, days: 31 });
assert.equal(inSession.runs.length, session.runs.length);

// Transcripts: sealed (compacted object) and streaming (live parts)
assert.equal(session.session.transcript_status === "sealed" || session.session.transcript_status === "streaming", true);
const sealed = await call("get_session_transcript", { session_id: "ses_00001", limit: 5 });
assert.equal(sealed.status, "sealed");
assert.equal(sealed.events.length, 5);
assert.equal(sealed.events[0].type, "session_start");
assert.ok(sealed.events.every((e: any, i: number) => e.seq === i + 1), "events ordered by seq");
const page2 = await call("get_session_transcript", { session_id: "ses_00001", offset: 5, limit: 5 });
assert.equal(page2.events[0].seq, 6);
const live = await call("get_session_transcript", { session_id: "ses_00042" });
assert.equal(live.status, "streaming");
assert.ok(live.total > 0 && live.key === null);

// Append -> seal round trip on a throwaway session, including a retried (duplicate seq) part
{
  const { getDb } = await import("../src/db.js");
  const { getStore } = await import("../src/storage.js");
  const { appendTranscript, sealTranscript } = await import("../src/transcripts.js");
  const { removeFromIndex, searchEnabled } = await import("../src/search.js");
  const db = await getDb();
  const id = `ses_smoke_${Date.now()}`;
  const token = `quokka${Date.now()}`; // unique word to find via search
  await db.query(
    "INSERT INTO agent_sessions (id, account_id, agent_name, environment, status, started_at) VALUES ($1, 1, 'smoke', 'dev', 'active', now())",
    [id],
  );
  try {
    const ts = new Date().toISOString();
    await appendTranscript(db, id, [{ ts, type: "session_start" }, { ts, type: "user_message", content: `smoke ping ${token}` }]);
    await appendTranscript(db, id, [{ seq: 2, ts, type: "user_message", content: `smoke ping ${token}` }]); // retried write
    await appendTranscript(db, id, [{ ts, type: "session_end", status: "completed" }]);
    const sealedNow = await sealTranscript(db, id);
    const after = await call("get_session_transcript", { session_id: id, limit: 500 });
    assert.equal(after.status, "sealed");
    assert.deepEqual(after.events.map((e: any) => e.seq), [1, 2, 3], "duplicate seq dropped, order kept");
    assert.equal(after.total, sealedNow.lines);
    const [{ parts }] = await db.query<{ parts: number }>("SELECT count(*) AS parts FROM session_transcript_parts WHERE session_id = $1", [id]);
    assert.equal(parts, 0, "parts removed after seal");
    await assert.rejects(appendTranscript(db, id, [{ ts, type: "user_message" }]), /sealed/, "sealed transcripts are read-only");
    assert.match(sealedNow.key, /^sessions\/account_id=1\/date=\d{4}-\d{2}-\d{2}\/env=dev\/agent=smoke\//, "partitioned key");
    if (searchEnabled()) {
      assert.ok(sealedNow.indexed, "indexed on seal");
      const found = await call("search_transcripts", { query: token.toUpperCase() });
      assert.equal(found.results.total, 1, "sealed transcript searchable right away (dedupe kept one copy)");
      assert.equal(found.results.hits[0].session_id, id);
    }
    await (await getStore()).delete([sealedNow.key]);
  } finally {
    if (searchEnabled()) await removeFromIndex(id);
    await db.query("DELETE FROM agent_sessions WHERE id = $1", [id]);
  }
}

// Full-text search over transcripts (ClickHouse), when configured
if ((await import("../src/search.js")).searchEnabled()) {
  const overview = await call("search_transcripts", {});
  assert.ok(overview.index.events > 0 && overview.index.folders.length > 0, "index stats + bucket folders");
  assert.ok(overview.index.folders.every((f: any) => f.account_id > 0 && f.env && f.agent), "folder columns from hive paths");
  const all = await call("search_transcripts", { query: "ratelimiterror" });
  assert.ok(all.results.total > 0);
  assert.ok(all.results.hits.every((h: any) => /ratelimiterror/i.test(h.text)), "every hit contains the token");
  const phrase = await call("search_transcripts", { query: "model provider", mode: "phrase" });
  const reversed = await call("search_transcripts", { query: "provider model", mode: "phrase" });
  assert.ok(phrase.results.total > 0 && reversed.results.total === 0, "phrase respects word order");
  const any = await call("search_transcripts", { query: "northwind contoso", mode: "any" });
  const both = await call("search_transcripts", { query: "northwind contoso", mode: "all" });
  assert.ok(any.results.total > both.results.total, "any >= all");
  const scoped = await call("search_transcripts", { query: "ratelimiterror", email: "priya@acme.dev", type: "run_end" });
  assert.ok(scoped.results.hits.every((h: any) => h.email === "priya@acme.dev" && h.type === "run_end"), "filters applied");
} else {
  console.log("- search_transcripts skipped (ClickHouse not configured)");
}

// Langfuse: live span tree for a run (only when the Langfuse API is configured)
if (process.env.LANGFUSE_PUBLIC_KEY) {
  const trace = await call("get_run_trace", { run_id: session.runs[0].id });
  assert.ok(trace.observations.length >= 3, "Langfuse returned spans");
  assert.ok(trace.observations.some((o: any) => o.type === "GENERATION" && o.model), "generation has a model");
  assert.equal(trace.observations.filter((o: any) => !o.parentObservationId).length, 1, "single root span");
} else {
  console.log("- get_run_trace skipped (LANGFUSE_PUBLIC_KEY not set)");
}

const missing = await client.callTool({ name: "get_agent_session", arguments: { session_id: "ses_nope" } });
assert.ok(missing.isError, "unknown session returns isError");
console.log("✓ unknown session_id -> isError");

await client.close();
await (await getDb()).close();
console.log("smoke test passed");
