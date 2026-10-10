import { BoatApi, Configuration } from "@boatdev/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

let api: BoatApi | undefined;

function boat(): BoatApi {
  if (api) return api;
  const apiKey = process.env.BOAT_API_KEY;
  if (!apiKey) throw new Error("Set BOAT_API_KEY to a Boat API key to use Boat tools");
  api = new BoatApi(new Configuration({
    basePath: process.env.BOAT_BASE_URL ?? "https://boat.dev/api/v1",
    accessToken: apiKey,
  }));
  return api;
}

async function result(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await action();
    const structured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured,
    };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true };
const changesState = { readOnlyHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export function registerBoatTools(server: McpServer): void {
  if (process.env.BOAT_MCP_ENABLED !== "true") return;

  server.registerTool("boat_account", {
    title: "Boat account",
    description: "Show the authenticated Boat account and sandbox limits. Does not expose API key secrets.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => result(async () => ({ account: await boat().me(), limits: await boat().limits() })));

  server.registerTool("boat_list_sandboxes", {
    title: "List Boat sandboxes",
    description: "List Boat sandboxes, optionally filtered by state. Use this before operating on an existing sandbox.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      state: z.string().optional(),
    },
    annotations: readOnly,
  }, async (args) => result(() => boat().sandboxes(args)));

  server.registerTool("boat_create_sandbox", {
    title: "Create Boat sandbox",
    description: "Create a billable Boat sandbox. Defaults to the standard machine and one-hour auto-stop. Use no_env=true to withhold account secrets from the sandbox.",
    inputSchema: {
      type: z.enum(["small", "default", "large"]).optional(),
      ttl_seconds: z.number().int().min(60).max(604800).optional(),
      no_env: z.boolean().optional(),
      setup_script: z.string().max(65536).optional(),
      name: z.string().min(1).max(80).optional(),
    },
    annotations: changesState,
  }, async ({ type, ttl_seconds, no_env, setup_script, name }) => result(async () => {
    const created = await boat().create({
      createSandboxRequest: {
        ...(type ? { type } : {}),
        ...(ttl_seconds !== undefined ? { ttlSeconds: ttl_seconds } : {}),
        ...(no_env !== undefined ? { noEnv: no_env } : {}),
        ...(setup_script ? { setupScript: setup_script } : {}),
      },
    });
    if (name) return boat().update({ sandboxId: created.sandbox.id, updateSandboxRequest: { name } });
    return created;
  }));

  server.registerTool("boat_get_sandbox", {
    title: "Get Boat sandbox",
    description: "Get the current state and connection details for a Boat sandbox.",
    inputSchema: { sandbox_id: z.string().min(1) },
    annotations: readOnly,
  }, async ({ sandbox_id }) => result(() => boat().get({ sandboxId: sandbox_id })));

  server.registerTool("boat_sandbox_usage", {
    title: "Boat sandbox usage",
    description: "Get billable runtime and cost for one Boat sandbox.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      since: z.string().optional(),
      until: z.string().optional(),
    },
    annotations: readOnly,
  }, async ({ sandbox_id, since, until }) => result(() => boat().usage({ sandboxId: sandbox_id, since, until })));

  server.registerTool("boat_resume_sandbox", {
    title: "Resume Boat sandbox",
    description: "Resume a stopped or archived sandbox. This starts billable compute. Omit ttl_seconds to retain the existing auto-stop setting.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      ttl_seconds: z.number().int().min(60).max(604800).optional(),
      no_env: z.boolean().optional(),
    },
    annotations: changesState,
  }, async ({ sandbox_id, ttl_seconds, no_env }) => result(() => boat().resume({
    sandboxId: sandbox_id,
    resumeRequest: {
      ...(ttl_seconds !== undefined ? { ttlSeconds: ttl_seconds } : {}),
      ...(no_env !== undefined ? { noEnv: no_env } : {}),
    },
  })));

  server.registerTool("boat_stop_sandbox", {
    title: "Pause Boat sandbox",
    description: "Stop active work and snapshot/archive the sandbox so it can be resumed later. This ends any agent run still executing in that sandbox; only call after the run is done or when explicitly requested.",
    inputSchema: { sandbox_id: z.string().min(1) },
    annotations: destructive,
  }, async ({ sandbox_id }) => result(() => boat().stop({ sandboxId: sandbox_id })));

  server.registerTool("boat_fork_sandbox", {
    title: "Fork Boat sandbox",
    description: "Create a new sandbox from an existing sandbox's saved state. The source is unchanged; the fork is billable and defaults to a one-hour auto-stop.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      type: z.enum(["small", "default", "large"]).optional(),
      ttl_seconds: z.number().int().min(60).max(604800).optional(),
      no_env: z.boolean().optional(),
    },
    annotations: changesState,
  }, async ({ sandbox_id, type, ttl_seconds, no_env }) => result(() => boat().fork({
    sandboxId: sandbox_id,
    forkRequest: {
      ...(type ? { type } : {}),
      ...(ttl_seconds !== undefined ? { ttlSeconds: ttl_seconds } : {}),
      ...(no_env !== undefined ? { noEnv: no_env } : {}),
    },
  })));

  server.registerTool("boat_delete_sandbox", {
    title: "Permanently delete Boat sandbox",
    description: "Irreversibly delete a sandbox and its snapshots. This cannot be undone. The confirmation must exactly match the sandbox id.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      confirm_sandbox_id: z.string().min(1).describe("Repeat sandbox_id exactly to confirm permanent deletion"),
    },
    annotations: destructive,
  }, async ({ sandbox_id, confirm_sandbox_id }) => {
    if (confirm_sandbox_id !== sandbox_id) {
      return { isError: true, content: [{ type: "text", text: "Confirmation must exactly match sandbox_id" }] };
    }
    return result(() => boat().deleteSandbox({ sandboxId: sandbox_id, xAsciiConfirmDelete: sandbox_id }));
  });

  server.registerTool("boat_exec_command", {
    title: "Run command in Boat sandbox",
    description: "Run a bounded shell command in a running Boat sandbox. Commands execute with that sandbox user's privileges.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeout_seconds: z.number().int().min(1).max(600).optional(),
      detached: z.boolean().optional(),
    },
    annotations: changesState,
  }, async ({ sandbox_id, command, cwd, timeout_seconds, detached }) => result(() => boat().command({
    sandboxId: sandbox_id,
    commandRequest: {
      command,
      ...(cwd ? { cwd } : {}),
      ...(timeout_seconds !== undefined ? { timeoutSeconds: timeout_seconds } : {}),
      ...(detached !== undefined ? { detached } : {}),
    },
  })));

  server.registerTool("boat_command_status", {
    title: "Get Boat command status",
    description: "Read output and completion state for a detached command running in a Boat sandbox.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      process_id: z.number().int().positive(),
      tail_bytes: z.number().int().min(0).max(1000000).optional(),
    },
    annotations: readOnly,
  }, async ({ sandbox_id, process_id, tail_bytes }) => result(() => boat().commandStatus({
    sandboxId: sandbox_id,
    processId: process_id,
    ...(tail_bytes !== undefined ? { tailBytes: tail_bytes } : {}),
  })));

  server.registerTool("boat_read_file", {
    title: "Read Boat sandbox file",
    description: "Read a text or base64 file by path from a Boat sandbox.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      path: z.string().min(1),
      encoding: z.enum(["utf8", "base64"]).optional(),
    },
    annotations: readOnly,
  }, async ({ sandbox_id, path, encoding }) => result(() => boat().readFile({ sandboxId: sandbox_id, path, encoding })));

  server.registerTool("boat_write_file", {
    title: "Write Boat sandbox file",
    description: "Write UTF-8 or base64 content to a file in a Boat sandbox. Files are limited to 5 MiB after decoding.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      path: z.string().min(1),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).optional(),
    },
    annotations: changesState,
  }, async ({ sandbox_id, path, content, encoding }) => result(() => boat().writeFile({
    sandboxId: sandbox_id,
    fileWriteRequest: { path, content, encoding },
  })));

  server.registerTool("boat_prompt", {
    title: "Prompt Boat sandbox agent",
    description: "Queue an agent prompt in a Boat sandbox. Configure the selected provider in the Boat account first. Use new_conversation to start a fresh conversation or conversation_id to continue one.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      provider: z.enum(["codex", "claude-code", "pi", "opencode", "prime-agent", "kimi", "mistral"]),
      prompt: z.string().min(1),
      new_conversation: z.boolean().optional(),
      conversation_id: z.string().optional(),
      model: z.string().optional(),
      reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
    },
    annotations: changesState,
  }, async ({ sandbox_id, provider, prompt, new_conversation, conversation_id, model, reasoning_effort }) => result(() => boat().prompt({
    sandboxId: sandbox_id,
    promptRequest: {
      provider,
      prompt,
      ...(new_conversation !== undefined ? { _new: new_conversation } : {}),
      ...(conversation_id ? { conversationId: conversation_id } : {}),
      ...(model ? { model } : {}),
      ...(reasoning_effort ? { reasoningEffort: reasoning_effort } : {}),
    },
  })));

  server.registerTool("boat_prompt_status", {
    title: "Get Boat prompt status",
    description: "Check the status of a previously queued Boat agent prompt.",
    inputSchema: { sandbox_id: z.string().min(1), prompt_id: z.string().min(1) },
    annotations: readOnly,
  }, async ({ sandbox_id, prompt_id }) => result(() => boat().promptRunStatus({ sandboxId: sandbox_id, promptId: prompt_id })));

  server.registerTool("boat_events", {
    title: "Read Boat sandbox events",
    description: "Read paginated event history, optionally filtered by event types or conversation.",
    inputSchema: {
      sandbox_id: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
      cursor: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      type: z.string().optional(),
      conversation: z.string().optional(),
    },
    annotations: readOnly,
  }, async ({ sandbox_id, limit, cursor, sort, type, conversation }) => result(() => boat().events({
    sandboxId: sandbox_id,
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
    ...(sort ? { sort } : {}),
    ...(type ? { type } : {}),
    ...(conversation ? { conversation } : {}),
  })));

  server.registerTool("boat_interrupt", {
    title: "Interrupt Boat agent",
    description: "Stop the current agent run in a Boat sandbox. Pass conversation_id to scope the interruption; omit to interrupt all conversations.",
    inputSchema: { sandbox_id: z.string().min(1), conversation_id: z.string().optional() },
    annotations: destructive,
  }, async ({ sandbox_id, conversation_id }) => result(() => boat().interrupt({
    sandboxId: sandbox_id,
    ...(conversation_id ? { conversation: conversation_id } : {}),
  })));
}
