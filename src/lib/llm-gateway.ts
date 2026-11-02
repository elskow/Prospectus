import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { APICallError, AISDKError, InvalidResponseDataError, JSONParseError } from "@ai-sdk/provider";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { MastraLanguageModelV3 } from "@mastra/core/llm/model/shared.types";
import { defaultProvider, findProvider, type ResolvedProvider } from "@src/lib/llm-providers";
import { parseModelRef } from "@src/lib/model-ref";

export function isGatewayApiError(error: unknown): error is APICallError {
  return APICallError.isInstance(error);
}

export function isGatewayTransientError(error: unknown): boolean {
  if (AISDKError.isInstance(error)) {
    if (APICallError.isInstance(error)) {
      const status = error.statusCode;
      return status === undefined || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    }
    if (error instanceof JSONParseError || error instanceof InvalidResponseDataError) {
      return true;
    }
    return false;
  }
  if (error instanceof Error) {
    return /abort|timeout|timed out|econn|socket|fetch failed|network/i.test(error.message);
  }
  return false;
}

const gatewayFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => sanitizeJsonBody(input, init), {
  preconnect: fetch.preconnect?.bind(fetch),
});

async function sanitizeJsonBody(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (cause) {
    throw new APICallError({
      message: `gateway fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      url: String(input),
      requestBodyValues: undefined,
      isRetryable: true,
      cause,
    });
  }
  const text = await res.text();

  if (!res.ok) {
    throw new APICallError({
      message: `gateway returned ${res.status}: ${text.slice(0, 300)}`,
      url: String(input),
      requestBodyValues: undefined,
      statusCode: res.status,
      isRetryable: res.status === 408 || res.status === 409 || res.status === 425 || res.status === 429 || res.status >= 500,
      responseBody: text.slice(0, 2000),
    });
  }

  if (!text.startsWith("{")) {
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  let body = text;

  try {
    JSON.parse(text);
  } catch (cause) {
    const last = text.lastIndexOf("}");
    if (last > 0) {
      body = text.slice(0, last + 1);
    } else {
      throw new JSONParseError({ text: text.slice(0, 2000), cause });
    }
  }

  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: { "content-type": "application/json" },
  });
}

const clients = new Map<string, OpenAIProvider>();

function clientFor(provider: ResolvedProvider): OpenAIProvider {
  const cacheKey = `${provider.baseUrl}\u0000${provider.apiKey}\u0000${JSON.stringify(provider.headers)}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const client = createOpenAI({
    name: provider.label,
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
    headers: provider.headers,
    fetch: gatewayFetch,
  });

  clients.set(cacheKey, client);
  return client;
}

export interface ResolvedModel {
  provider: ResolvedProvider;
  model: string;
}

export async function resolveModelProvider(modelRef: string): Promise<ResolvedModel> {
  const parsed = parseModelRef(modelRef);
  const provider = parsed.providerId ? await findProvider(parsed.providerId) : await defaultProvider();

  if (!provider) {
    throw new Error("no LLM provider configured; add one and sync its models");
  }

  if (provider.kind === "9router" && !parsed.model.includes("/")) {
    throw new Error(`model "${parsed.model}" must use the 9Router provider/model form`);
  }

  return { provider, model: parsed.model };
}

export async function gatewayChatModel(modelRef: string): Promise<MastraLanguageModelV3> {
  const { provider, model } = await resolveModelProvider(modelRef);
  return clientFor(provider).chat(model) as unknown as MastraLanguageModelV3;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  jsonSchema: boolean;
  error?: string;
}

export async function probeProvider(provider: ResolvedProvider, model: string, urlPath = "/chat/completions"): Promise<ProbeResult> {
  const startedAt = Date.now();
  const base = provider.baseUrl.replace(/\/$/, "");

  const basic = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with the single word ok" }],
    }),
  });

  const baseLatency = Date.now() - startedAt;

  if (!basic.ok) {
    const text = await basic.text();
    return {
      ok: false,
      latencyMs: baseLatency,
      jsonSchema: false,
      error: `completion failed: HTTP ${basic.status} ${text.slice(0, 200)}`,
    };
  }

  await basic.text();

  const structured = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      messages: [{ role: "user", content: 'Return JSON matching the schema: {"ok": true}' }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "probe",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    jsonSchema: structured.ok,
  };
}

export type { LanguageModelV3 };
