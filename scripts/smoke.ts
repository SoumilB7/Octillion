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

const missing = await client.callTool({ name: "get_agent_session", arguments: { session_id: "ses_nope" } });
assert.ok(missing.isError, "unknown session returns isError");
console.log("✓ unknown session_id -> isError");

await client.close();
await (await getDb()).close();
console.log("smoke test passed");
