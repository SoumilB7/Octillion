import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, handlers, runTool, WIDGET_HTML, type ToolName } from "./server.js";
import { getDb } from "./db.js";

const PORT = Number(process.env.PORT ?? 3333);
const HOST = process.env.HOST ?? "127.0.0.1";

const db = await getDb();
const app = express();
app.use(express.json());

// Streamable HTTP MCP endpoint (stateless: a fresh server + transport per request).
app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

// ---- Local preview: renders the widget in a browser without an MCP host ----
const isTool = (n: string): n is ToolName => Object.hasOwn(handlers, n);

app.post("/preview/api/tool", async (req, res) => {
  const { name, arguments: args = {} } = req.body ?? {};
  if (!isTool(name)) return void res.status(404).json({ isError: true, content: [{ type: "text", text: `Unknown tool ${name}` }] });
  res.json(await runTool(name, args));
});

app.get(["/", "/preview"], (_req, res) => res.redirect("/preview/get_product_overview"));

app.get("/preview/:tool", async (req, res) => {
  const name = req.params.tool;
  if (!isTool(name)) return void res.status(404).send(`Unknown tool ${name}`);
  const result = await runTool(name, req.query as Record<string, unknown>);
  const boot = JSON.stringify({ toolEndpoint: "/preview/api/tool", data: result.structuredContent ?? null })
    .replace(/</g, "\\u003c");
  res.type("html").send(WIDGET_HTML.replace("<script>", `<script>window.__DEVTOOLS_PREVIEW__ = ${boot};</script>\n<script>`));
});

app.listen(PORT, HOST, () => {
  console.error(`devtools-mcp (${db.kind}) listening:`);
  console.error(`  MCP endpoint  http://${HOST}:${PORT}/mcp`);
  console.error(`  UI preview    http://${HOST}:${PORT}/preview`);
});
