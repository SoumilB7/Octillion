# devtools-mcp

A Postgres-backed MCP server with an interactive MCP-UI (MCP Apps) dashboard for four contexts:

| Context | Tables | MCP tool(s) |
|---|---|---|
| DevTools product description | `products` | `get_product_overview` |
| User account | `user_accounts` | `get_user_account` (omit `email` to list all) |
| Developer population breakdown | `developer_segments` | `get_developer_population` |
| Trace runs history | `agent_sessions`, `trace_runs` | `list_trace_runs`, `get_agent_session` |

Span-level trace detail stays in **Langfuse**. Postgres keeps agent sessions plus run-level summaries (status, latency, tokens, cost, error). Each run stores its `langfuse_trace_id`, and each session id doubles as its Langfuse session id. When `LANGFUSE_PROJECT_ID` is set, the UI and tool output include deep links.

Every tool returns two things: a text summary plus JSON for the model, and `structuredContent` for the UI. All tools point at one UI resource, `ui://devtools/dashboard.html` (`text/html;profile=mcp-app`). It's built with `@mcp-ui/server` and the MCP Apps adapter enabled. The widget picks its view from the tool result. It can also call tools itself: clicking a run opens its session, clicking a session opens its run timeline, and filter changes refetch the data.

## Run it

```bash
npm install
npm run smoke        # end-to-end MCP test of every tool + the UI resource
npm start            # stdio MCP server
npm run start:http   # Streamable HTTP at http://127.0.0.1:3333/mcp + browser preview at /preview
```

### boat.dev sandbox tools

The main MCP server exposes Boat sandbox tools through the official `@boatdev/sdk` TypeScript client. Set `BOAT_MCP_ENABLED=true` and `BOAT_API_KEY` in the ignored local `.env`; create a key in the Boat dashboard or with `boat api-key create`. `BOAT_BASE_URL` defaults to `https://boat.dev/api/v1`. Keys are read from the process environment and are never stored in source control. The router provides account/limit inspection, sandbox lifecycle, command and file operations, agent prompts, prompt status, events, and usage.

Boat sandboxes use billable compute. Stop archives a sandbox so it can be resumed later; delete irreversibly removes a sandbox and its snapshots and requires repeating its ID for confirmation. Treat API keys, secrets, and returned desktop URLs as sensitive. Use a least-privilege Boat API key. See the [Boat TypeScript SDK guide](https://docs.boat.dev/sdks/typescript) for current SDK authentication and operations.

Pi.dev is integrated as the agent client/runtime, replacing the embedded Python MCP bridge. The project config at `.pi/mcp.json` starts Octillion over stdio and exposes its tools through Pi codemode; scripts can compose calls and filter results before returning summaries to the model. This reduces model context and orchestration overhead while Octillion remains the API/data server. Pi project resources include the `/boat` and `/traces` prompt commands plus Octillion and Boat skills. Install Pi using the [Pi quickstart](https://pi.dev/docs/latest/quickstart), run `pi` from the repository, trust the project resources, and use `/mcp` to inspect the Octillion connection. See the [Pi MCP guide](https://pi.dev/docs/latest/mcp) for exposure behavior.

### Database

- **No setup (default):** if `DATABASE_URL` is unset, the server uses embedded [PGlite](https://pglite.dev), which is real Postgres compiled to WASM, stored in `.pglite/`. Only one process can open that directory at a time, so don't run `start` and `start:http` together on it.
- **Real Postgres:** `cp .env.example .env`, then `npm run db:up` (docker compose, Postgres 17).

Either way, the schema and seed data load automatically the first time the database is empty. Run `npm run db:reset` to drop and reseed. The seed timestamps are relative to `now()`, so the history always looks recent.

### Connect a host

Add the server to any MCP host that renders MCP Apps / MCP-UI (e.g. Claude, VS Code, Goose, MCPJam). See `mcp.example.json`:

```json
{ "mcpServers": { "devtools": { "command": "npx", "args": ["tsx", "/abs/path/to/src/stdio.ts"] } } }
```

You can also point the host at `http://127.0.0.1:3333/mcp`. To look at the UI without a host, open `http://127.0.0.1:3333/preview/<tool>?<args>`, e.g. `/preview/get_agent_session?session_id=ses_00091`.

## Layout

```
sql/schema.sql      tables for the four contexts
sql/seed.sql        sample data (product "Tracelight", 8 accounts, population segments, ~260 sessions / ~900 runs)
src/db.ts           pg or PGlite behind one query() interface; auto-seeds
src/queries.ts      one query module per context + Langfuse link builder
src/server.ts       MCP tools + UI resource registration
src/boat-tools.ts     boat.dev sandbox tools
src/ui/widget.html  the MCP-UI dashboard (product, accounts, population, runs, session views)
src/stdio.ts        stdio transport
src/http.ts         Streamable HTTP transport + local preview
scripts/smoke.ts    end-to-end test through an MCP client
```
