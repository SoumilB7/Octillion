import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

function toZod(schema: JsonSchema): z.ZodTypeAny {
  let result: z.ZodTypeAny;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];

  if (schema.enum?.length) {
    const choices = schema.enum.map((value) => z.literal(value as never));
    result = choices.length === 1 ? choices[0] : z.union(choices as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if ("const" in schema) {
    result = z.literal(schema.const as never);
  } else if (schema.anyOf?.length || schema.oneOf?.length) {
    const choices = schema.anyOf ?? schema.oneOf ?? [];
    const variants = choices.map(toZod);
    result = variants.length === 1 ? variants[0] : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if (schema.allOf?.length) {
    result = schema.allOf.map(toZod).reduce((left, right) => z.intersection(left, right));
  } else if (types.includes("object") || schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => {
        const field = toZod(value);
        return [key, required.has(key) ? field : field.optional()];
      }),
    );
    result = z.object(fields).passthrough();
  } else if (types.includes("array")) {
    result = z.array(schema.items ? toZod(schema.items) : z.unknown());
    if (schema.minItems !== undefined) result = (result as z.ZodArray<z.ZodTypeAny>).min(schema.minItems);
    if (schema.maxItems !== undefined) result = (result as z.ZodArray<z.ZodTypeAny>).max(schema.maxItems);
  } else if (types.includes("integer")) {
    result = z.number().int();
  } else if (types.includes("number")) {
    result = z.number();
  } else if (types.includes("boolean")) {
    result = z.boolean();
  } else if (types.includes("string")) {
    result = z.string();
    if (schema.minLength !== undefined) result = (result as z.ZodString).min(schema.minLength);
    if (schema.maxLength !== undefined) result = (result as z.ZodString).max(schema.maxLength);
    if (schema.pattern) result = (result as z.ZodString).regex(new RegExp(schema.pattern));
  } else {
    result = z.unknown();
  }

  if (schema.minimum !== undefined && result instanceof z.ZodNumber) result = result.min(schema.minimum);
  if (schema.maximum !== undefined && result instanceof z.ZodNumber) result = result.max(schema.maximum);
  return schema.description ? result.describe(schema.description) : result;
}

let clientPromise: Promise<Client> | undefined;

function configuredEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PYTHONPATH"]) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }

  const raw = process.env.PYTHON_MCP_ENV;
  if (!raw) return inherited;
  const configured: unknown = JSON.parse(raw);
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new Error("PYTHON_MCP_ENV must be a JSON object of string values");
  }
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value !== "string") {
      throw new Error("PYTHON_MCP_ENV must be a JSON object of string values");
    }
    inherited[key] = value;
  }
  return inherited;
}

function getPythonClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client({ name: "octillion-python-router", version: "1.0.0" });
      const remoteUrl = process.env.PYTHON_MCP_URL;
      if (remoteUrl) {
        const url = new URL(remoteUrl);
        const token = process.env.PYTHON_MCP_AUTH_TOKEN;
        if (token && url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
          throw new Error("PYTHON_MCP_AUTH_TOKEN requires an HTTPS endpoint (or localhost)");
        }
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        await client.connect(new StreamableHTTPClientTransport(url, {
          requestInit: headers ? { headers } : undefined,
        }));
      } else {
        const command = process.env.PYTHON_MCP_COMMAND;
        if (!command) throw new Error("Set PYTHON_MCP_URL or PYTHON_MCP_COMMAND when PYTHON_MCP_ENABLED=true");
        await client.connect(new StdioClientTransport({
          command,
          args: configuredArgs(),
          env: configuredEnvironment(),
          stderr: "inherit",
        }));
      }
      return client;
    })().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

function configuredArgs(): string[] {
  const raw = process.env.PYTHON_MCP_ARGS;
  if (!raw) return [];
  const args: unknown = JSON.parse(raw);
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("PYTHON_MCP_ARGS must be a JSON array of strings");
  }
  return args;
}

export async function registerPythonTools(server: McpServer): Promise<void> {
  if (process.env.PYTHON_MCP_ENABLED !== "true") return;
  const client = await getPythonClient();
  const { tools } = await client.listTools();
  for (const remoteTool of tools) {
    const name = `python_${remoteTool.name.replace(/^[a-z0-9]+[-_]/i, "")}`;
    server.registerTool(
      name,
      {
        title: remoteTool.title ?? remoteTool.name,
        description: remoteTool.description ?? `Python MCP tool ${remoteTool.name}`,
        inputSchema: toZod(remoteTool.inputSchema as JsonSchema),
        annotations: remoteTool.annotations,
      },
      async (args) => await client.callTool({
        name: remoteTool.name,
        arguments: args as Record<string, unknown>,
      }) as CallToolResult,
    );
  }
}
