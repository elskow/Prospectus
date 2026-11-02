import { createInterface } from "node:readline";
import { z } from "zod";
import { ToolError } from "./errors";
import { runCampaignTools } from "./tools";
import { runLlmTools } from "./llm-tools";
import { findPrompt, promptList, promptMessages } from "./prompts";

interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (input: unknown) => Promise<unknown>;
}

const registry: ToolDefinition[] = [];

function tool(def: ToolDefinition): void {
  registry.push(def);
}

const JSONRPC_VERSION = "2.0";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

let initialized = false;

function respond(id: unknown, result: unknown): void {
  write({ jsonrpc: JSONRPC_VERSION, id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  write({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const READ_ONLY_TOOLS = new Set([
  "list_campaigns",
  "campaign_stats",
  "search_prospects",
  "list_markets",
  "run_status",
  "campaign_metrics",
  "campaign_health",
  "agent_brief",
  "list_runs",
  "check_contacts",
  "lookup_company",
  "export_prospects",
  "ingest_status",
  "wait_for_run",
  "suggest_markets",
  "llm_status",
  "llm_test",
]);

const DESTRUCTIVE_TOOLS = new Set(["delete_campaign", "retire_market", "llm_remove_provider"]);

function annotationsFor(name: string) {
  if (READ_ONLY_TOOLS.has(name)) return { readOnlyHint: true, destructiveHint: false };
  if (DESTRUCTIVE_TOOLS.has(name)) return { readOnlyHint: false, destructiveHint: true };
  return { readOnlyHint: false, destructiveHint: false };
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  const params = (message.params ?? {}) as Record<string, unknown>;

  if (method === "initialize") {
    const requested = String(params.protocolVersion ?? "");
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
    respond(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: "prospectus", version: "1.0.0" },
      instructions:
        "Prospectus runs lead-generation campaigns. A campaign has a niche, an area, a daily goal counted in companies with an email on file, and a queue of markets (city × sector). Runs are durable background jobs: start_run returns a queueId immediately and run_status reports progress. Companies become 'ready' prospects only when an email is attached.",
    });
    return;
  }

  if (method === "notifications/initialized") {
    initialized = true;
    return;
  }

  if (method === "ping") {
    respond(id, {});
    return;
  }

  if (method === "tools/list") {
    respond(id, {
      tools: registry.map((entry) => ({
        name: entry.name,
        description: entry.description,
        inputSchema: z.toJSONSchema(entry.schema, { io: "input" }),
        annotations: annotationsFor(entry.name),
      })),
    });
    return;
  }

  if (method === "prompts/list") {
    respond(id, { prompts: promptList() });
    return;
  }

  if (method === "prompts/get") {
    const name = String(params.name ?? "");
    const prompt = findPrompt(name);
    if (!prompt) {
      respondError(id, -32602, `unknown prompt: ${name}`);
      return;
    }

    const rawArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const args = Object.fromEntries(Object.entries(rawArgs).map(([key, value]) => [key, String(value)]));
    respond(id, { description: prompt.description, messages: promptMessages(prompt, args) });
    return;
  }

  if (method === "tools/call") {
    if (!initialized) respondError(id, -32002, "server not initialized");
    const name = String(params.name ?? "");
    const entry = registry.find((candidate) => candidate.name === name);
    if (!entry) {
      respondError(id, -32602, `unknown tool: ${name}`);
      return;
    }

    try {
      const parsed = entry.schema.parse(params.arguments ?? {});
      const result = await entry.handler(parsed);
      respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
    } catch (error) {
      respond(id, {
        content: [{ type: "text", text: JSON.stringify(toToolError(error), null, 2) }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) respondError(id, -32601, `method not found: ${method}`);
}

for (const definition of await runCampaignTools()) tool(definition);
for (const definition of await runLlmTools()) tool(definition);

function toToolError(error: unknown): { code: string; message: string } {
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) {
    return {
      code: "INVALID_ARGUMENTS",
      message: error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "),
    };
  }
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

let queue: Promise<void> = Promise.resolve();
const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    process.stderr.write("[mcp] dropped malformed JSON line\n");
    return;
  }
  queue = queue.then(() =>
    handle(message).catch((error) => {
      process.stderr.write(`[mcp] handler failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }),
  );
});
