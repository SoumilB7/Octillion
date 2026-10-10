# devtools-mcp

A Postgres-backed MCP server with an interactive MCP-UI (MCP Apps) dashboard for four contexts:

| Context | Where it lives | MCP tool(s) |
|---|---|---|
| DevTools product description | Postgres `products` | `get_product_overview` |
| User account | Postgres `user_accounts` | `get_user_account` (omit `email` to list all) |
| Developer population breakdown | Postgres `developer_segments` | `get_developer_population` |
| Trace runs history | Postgres `agent_sessions` + `trace_runs` (summaries)<br>Object storage (session transcripts, JSONL)<br>Langfuse (span-level traces) | `list_trace_runs`, `get_agent_session`, `get_session_transcript`, `get_run_trace` |

Every tool returns two things: a text summary plus JSON for the model, and `structuredContent` for the UI. All tools point at one UI resource, `ui://devtools/dashboard.html` (`text/html;profile=mcp-app`). It's built with `@mcp-ui/server` and the MCP Apps adapter enabled. The widget can also call tools itself, so you can click through from runs to a session, its transcript, and a run's span waterfall.

## Where trace data lives

```
agent_sessions ──< trace_runs                          Postgres: what you filter, sort and aggregate
     │                 └─ langfuse_trace_id ──────────▶ Langfuse: span tree per run (OTel)
     ├─ id (= Langfuse session id) ───────────────────▶ Langfuse: session view
     └─ transcript_key ───────────────────────────────▶ Object storage: sessions/acct_<id>/<yyyy>/<mm>/<session>.jsonl.gz
        session_transcript_parts (while streaming) ───▶                    .../<session>/part-00001.jsonl.gz
```

**Session transcripts.** Postgres stores a pointer, not the JSONL:
- **While a session runs** (`transcript_status = 'streaming'`), each append writes a gzipped part plus a `session_transcript_parts` row. Readers can follow a live session by reading the parts in order.
- **On seal**, the parts are merged into one object. Duplicate `seq` values from retried writes are dropped. `transcript_key`, `transcript_lines`, `transcript_bytes` and `transcript_sha256` are recorded, and the parts are deleted.
- **On read**, the sha256 is verified, and S3 backends return a 15-minute presigned download URL.
- The code is in `src/transcripts.ts` (`appendTranscript`, `sealTranscript`, `readTranscript`).

**Langfuse.** Runs are sent as OpenTelemetry spans to `/api/public/otel/v1/traces`. Trace ID = `trace_runs.langfuse_trace_id` and session ID = `agent_sessions.id`. `get_run_trace` reads spans back through `/api/public/v2/observations`; Langfuse v4 disables the older `/api/public/traces` read API.

## Run it

### Full local stack (Postgres + Langfuse + MinIO)

```bash
npm install
cp .env.example .env
npm run setup:local   # docker compose up, seed Postgres + transcripts, send traces to Langfuse
npm run smoke         # end-to-end MCP test of every tool, incl. transcripts and Langfuse
npm start             # stdio MCP server
npm run start:http    # Streamable HTTP at http://127.0.0.1:3333/mcp + browser preview at /preview
```

### boat.dev sandbox tools

The main MCP server exposes Boat sandbox tools through the official `@boatdev/sdk` TypeScript client. Set `BOAT_MCP_ENABLED=true` and `BOAT_API_KEY` in the ignored local `.env`; create a key in the Boat dashboard or with `boat api-key create`. `BOAT_BASE_URL` defaults to `https://boat.dev/api/v1`. Keys are read from the process environment and are never stored in source control. The router provides account/limit inspection, sandbox lifecycle, command and file operations, agent prompts, prompt status, events, and usage.

Boat sandboxes use billable compute. Stop archives a sandbox so it can be resumed later; delete irreversibly removes a sandbox and its snapshots and requires repeating its ID for confirmation. Treat API keys, secrets, and returned desktop URLs as sensitive. Use a least-privilege Boat API key. See the [Boat TypeScript SDK guide](https://docs.boat.dev/sdks/typescript) for current SDK authentication and operations.

Pi.dev is integrated as the agent client/runtime, replacing the embedded Python MCP bridge. The project config at `.pi/mcp.json` starts Octillion over stdio and exposes its tools through Pi codemode; scripts can compose calls and filter results before returning summaries to the model. This reduces model context and orchestration overhead while Octillion remains the API/data server. Pi project resources include the `/boat` and `/traces` prompt commands plus Octillion and Boat skills. Install Pi using the [Pi quickstart](https://pi.dev/docs/latest/quickstart), run `pi` from the repository, trust the project resources, and use `/mcp` to inspect the Octillion connection. See the [Pi MCP guide](https://pi.dev/docs/latest/mcp) for exposure behavior.

### Database
| Service | URL | Login |
|---|---|---|
| Langfuse | http://localhost:3000 | `admin@devtools.local` / `devtools-admin` (project `devtools`) |
| MinIO console | http://localhost:9091 | `minio` / `miniosecret` (buckets `langfuse`, `transcripts`) |
| Postgres | `localhost:5432` | `postgres` / `postgres`, databases `devtools` and `langfuse` |

`docker-compose.yml` is based on Langfuse's official v4 compose file. It shares one Postgres (separate databases) and one MinIO (separate buckets) between Langfuse and this app. All credentials are local-only defaults. Stop it with `npm run stack:down`; add `-v` to `docker compose down` to wipe the data.

After `npm run db:reset`, run `npm run langfuse:seed` again. Seed timestamps are relative to `now()`, and Langfuse v4 treats a re-sent span with a new start time as a new event, so the script first deletes the old traces and waits for that to finish (about 2 minutes).

### Zero setup (no Docker)

Without a `.env`, the server uses embedded [PGlite](https://pglite.dev) (Postgres compiled to WASM, in `.pglite/`) and stores transcripts on disk in `.transcripts/`. Langfuse links and `get_run_trace` are turned off. Only one process can open `.pglite/` at a time.

### Connect a host

Add the server to any MCP host that renders MCP Apps / MCP-UI (e.g. Claude, VS Code, Goose, MCPJam). See `mcp.example.json`, which loads `.env` with `--env-file-if-exists`. Don't use `npm start` as the host command, because npm prints to stdout and breaks the stdio protocol. You can also point the host at `http://127.0.0.1:3333/mcp`. To look at the UI without a host, open `http://127.0.0.1:3333/preview/<tool>?<args>`, e.g. `/preview/get_session_transcript?session_id=ses_00091`.

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
sql/schema.sql            tables for the four contexts + transcript pointer/parts
sql/seed.sql              sample data (product "Tracelight", 8 accounts, segments, 260 sessions / 919 runs)
docker-compose.yml        Postgres + Langfuse v4 (web, worker, ClickHouse, Redis, MinIO)
src/db.ts                 pg or PGlite behind one query()/transaction() interface; auto-seeds
src/storage.ts            S3/MinIO or local-disk object store
src/transcripts.ts        append / seal / read session JSONL
src/langfuse.ts           Langfuse links, OTLP export, v2 observations reads
src/queries.ts            one query per context
src/server.ts             MCP tools + UI resource registration
src/ui/widget.html        the MCP-UI dashboard
src/seed-transcripts.ts   sample transcripts (runs on every DB seed)
scripts/seed-langfuse.ts  send seeded runs to Langfuse as OTel spans
scripts/smoke.ts          end-to-end test through an MCP client
```
