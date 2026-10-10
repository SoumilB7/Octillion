import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { getDb } from "./db.js";

// Warm up (and seed, on first run) the database before accepting requests.
const db = await getDb();
await (await createServer()).connect(new StdioServerTransport());
console.error(`devtools-mcp ready on stdio (${db.kind})`);
