import { Context, Data, Effect } from "effect";

const MCP_URL = process.env.SCRAPLING_MCP_URL ?? "http://127.0.0.1:9701/mcp";

const MCP_TOKEN = process.env.SCRAPLING_MCP_AUTH_TOKEN ?? "";

const PROXY_HOST = process.env.SCRAPLING_PROXY_URL ?? "warp:1080";

const SESSION = "prospectus-main";

export interface ScrapedPage {
  status: number;
  markdown: string | null;
}

export class ScraplingUnavailableError extends Data.TaggedError("ScraplingUnavailableError")<{
  readonly cause: unknown;
}> {}

export class ScraplingFailedError extends Data.TaggedError("ScraplingFailedError")<{
  readonly url: string;
  readonly status: number;
}> {}

export interface ScraplingService {
  readonly stealthFetch: (
    url: string,
    opts?: { solveCloudflare?: boolean; timeoutMs?: number },
  ) => Effect.Effect<ScrapedPage, ScraplingFailedError | ScraplingUnavailableError>;
  readonly httpFetch: (url: string) => Effect.Effect<ScrapedPage, ScraplingFailedError | ScraplingUnavailableError>;
  readonly healthy: Effect.Effect<boolean>;
}

export const ScraplingService = Context.Service<ScraplingService, ScraplingService>()("scrapling/ScraplingService");

let sessionId: string | null = null;

let rpcId = 0;

interface McpPayloadError {
  error?: { code?: number; message?: string };
  result?: { content?: { text?: string }[]; isError?: boolean };
}

const MCP_BODY_TIMEOUT_MS = 30_000;

const MCP_BODY_MAX_BYTES = 8 * 1024 * 1024;

async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  const deadline = Date.now() + MCP_BODY_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || received >= MCP_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remaining)),
    ]);
    if (done || !value) break;
    chunks.push(value);
    received += value.byteLength;
  }
  let text = "";
  const decoder = new TextDecoder();
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

const rpc = (method: string, params: unknown, isNotification = false): Effect.Effect<unknown, ScraplingUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
      if (!isNotification) {
        body.id = rpcId += 1;
      }
      const res = await fetch(MCP_URL, {
        signal: AbortSignal.timeout(120_000),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {}),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        method: "POST",
        body: JSON.stringify(body),
      });

      const nextSession = res.headers.get("mcp-session-id");
      if (nextSession) {
        sessionId = nextSession;
      }

      if (!res.ok) {
        if (isNotification) {
          throw new Error(`scrapling mcp notification returned ${res.status}`);
        }
        if (sessionId && (res.status === 404 || res.status === 400)) {
          sessionId = null;
          return runRpc(method, params, false);
        }
        throw new Error(`scrapling mcp returned ${res.status}`);
      }

      const text = await readBody(res);
      if (!text.trim() || isNotification) {
        return null;
      }
      const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
      const payload = JSON.parse(dataLine ? dataLine.slice(6) : text) as McpPayloadError;
      if (payload.error) {
        throw new Error(`scrapling mcp error: ${JSON.stringify(payload.error).slice(0, 200)}`);
      }
      return payload.result;
    },
    catch: (cause): ScraplingUnavailableError => new ScraplingUnavailableError({ cause }),
  });

const runRpc = (method: string, params: unknown, isNotification: boolean): Promise<unknown> => Effect.runPromise(rpc(method, params, isNotification));

const ensureSession: Effect.Effect<void, ScraplingUnavailableError> = Effect.suspend(() =>
  sessionId
    ? Effect.void
    : Effect.flatMap(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "prospectus", version: "1.0" } }), () =>
        rpc("notifications/initialized", {}, true),
      ),
);

interface ToolResult {
  content?: { text?: string }[];
  isError?: boolean;
}

interface ToolPayloadJson {
  status?: number;
  content?: string[];
}

function parseToolPayload(result: unknown): { status: number; text: string } | null {
  const tool = result as ToolResult | undefined;
  const raw = tool?.content?.[0]?.text;
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ToolPayloadJson;
    return { status: parsed.status ?? 0, text: parsed.content?.join("\n") ?? "" };
  } catch {
    return { status: 0, text: raw };
  }
}

const pageFromPayload = (payload: unknown): Effect.Effect<ScrapedPage, never> =>
  Effect.sync(() => {
    const parsed = parseToolPayload(payload);
    if (!parsed) {
      return { status: 0, markdown: null };
    }
    if (parsed.status !== 200) {
      return { status: parsed.status, markdown: null };
    }
    return { status: 200, markdown: parsed.text || null };
  });

export const live: ScraplingService = {
  stealthFetch: (url, opts) =>
    Effect.flatMap(ensureSession, () =>
      Effect.flatMap(
        rpc("tools/call", {
          name: "browser_fetch_once",
          arguments: {
            url,
            extraction_type: "markdown",
            proxy: `socks5://${PROXY_HOST}`,
            ...(opts?.solveCloudflare ? { solve_cloudflare: true } : {}),
            timeout: opts?.timeoutMs ?? 90_000,
          },
        }),
        pageFromPayload,
      ),
    ),
  httpFetch: (url) =>
    Effect.flatMap(ensureSession, () =>
      Effect.flatMap(
        rpc("tools/call", {
          name: "make_request",
          arguments: {
            url,
            impersonate: "chrome",
            extraction_type: "markdown",
            proxy: `socks5h://${PROXY_HOST}`,
            follow_redirects: true,
            retries: 1,
          },
        }),
        pageFromPayload,
      ),
    ),
  healthy: Effect.match(ensureSession, { onFailure: () => false, onSuccess: () => true }),
};

export async function scraplingStealthFetch(url: string, opts?: { solveCloudflare?: boolean; timeoutMs?: number }): Promise<ScrapedPage> {
  const exit = await Effect.runPromise(Effect.exit(live.stealthFetch(url, opts)));
  return exit._tag === "Success" ? exit.value : { status: 0, markdown: null };
}

export async function scraplingHttpFetch(url: string): Promise<ScrapedPage> {
  const exit = await Effect.runPromise(Effect.exit(live.httpFetch(url)));
  return exit._tag === "Success" ? exit.value : { status: 0, markdown: null };
}

export async function scraplingHealthy(): Promise<boolean> {
  return Effect.runPromise(live.healthy);
}
