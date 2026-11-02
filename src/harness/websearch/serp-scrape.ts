import { Effect } from "effect";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadSearchSettings } from "@src/harness/websearch/settings";
import { throttleDdg } from "@src/harness/websearch/ddg";
import { stripTags, sleep, type WebResult } from "@src/harness/websearch/types";
import { retrievalError, type RetrievalError } from "@src/harness/websearch/errors";

const SERP_WORKER_PATH = resolve(process.cwd(), "workers/google-serp.cjs");

interface SerpSearchResult {
  results: WebResult[];
  warnings: string[];
}

interface JinaResult {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
}

interface JinaSearchResponse {
  data?: JinaResult[];
}

const SERP_REQUEST_TIMEOUT_MS = 60_000;

interface SerpWorkerHandle {
  request: (method: string, payload?: unknown, timeoutMs?: number) => Promise<unknown>;
  stop: () => Promise<void>;
}

let serpWorker: SerpWorkerHandle | null = null;

const ensureSerpWorker = (): Effect.Effect<SerpWorkerHandle, RetrievalError> =>
  Effect.tryPromise({
    try: async () => {
      if (serpWorker) {
        return serpWorker;
      }
      const child = spawn("node", [SERP_WORKER_PATH], {
        env: {
          ...process.env,
          SERP_PROXY_URL: (await loadSearchSettings()).serpProxyUrl ?? "",
          HEADLESS: process.env.HEADLESS ?? "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      let buffer = "";
      const exited = new Promise<never>((_, reject) => {
        child.on("exit", () => {
          serpWorker = null;
          reject(new Error("google serp worker exited"));
        });
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) {
            continue;
          }
          let msg: { id?: string; ok?: boolean; result?: unknown; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const id = msg.id;
          if (id === "__ready__" || !id) {
            continue;
          }
          const entry = pending.get(id);
          if (!entry) {
            continue;
          }
          pending.delete(id);
          clearTimeout(entry.timer);
          if (msg.ok) {
            entry.resolve(msg.result);
          } else {
            entry.reject(new Error(msg.error ?? "serp worker error"));
          }
        }
      });
      child.stdin.write("");
      serpWorker = {
        async request(method: string, payload?: unknown, timeoutMs = SERP_REQUEST_TIMEOUT_MS) {
          const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const { promise, resolve: finish, reject } = Promise.withResolvers<unknown>();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`serp worker "${method}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          pending.set(id, { resolve: finish, reject, timer });
          child.stdin.write(`${JSON.stringify({ v: 1, id, method, payload })}\n`);
          return Promise.race([promise, exited]);
        },
        async stop() {
          child.kill("SIGTERM");
          serpWorker = null;
        },
      };
      await serpWorker.request("ping", undefined, 30_000);
      return serpWorker;
    },
    catch: (cause): RetrievalError => retrievalError("serp worker spawn failed", cause),
  });

export const fetchGoogleSerpResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(ensureSerpWorker(), (worker) =>
    Effect.tryPromise({
      try: async () => {
        const result = (await worker.request("search", { query, limit })) as SerpSearchResult;
        return result.results;
      },
      catch: (cause): RetrievalError => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/captcha|exited/i.test(message)) {
          void serpWorker?.stop();
        }
        return retrievalError("google serp search failed", cause);
      },
    }),
  );

const BING_URL = "https://www.bing.com/search";

function resolveBingUrl(href: string): string | null {
  if (!href.startsWith("http")) {
    return null;
  }
  const clean = href.replace(/&amp;/g, "&");
  if (!clean.includes("bing.com/ck/")) {
    return clean;
  }
  const encoded = clean.match(/[?&]u=a1([^&]+)/)?.[1];
  if (!encoded) {
    return null;
  }
  try {
    return atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

export const fetchBingResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(throttleDdg(), () =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${BING_URL}?q=${encodeURIComponent(query)}&count=${Math.max(limit, 10)}&setlang=id&cc=ID`, {
          signal: AbortSignal.timeout(10_000),
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "id-ID,id;q=0.9,en;q=0.6",
          },
        });
        if (res.status === 429 || res.status === 403) {
          throw new Error(`bing ${res.status}`);
        }
        const html = await res.text();
        if (/challenge|captcha/i.test(html.slice(0, 4000))) {
          throw new Error("bing captcha");
        }
        const results: WebResult[] = [];
        const seen = new Set<string>();
        const anchorRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
        for (const match of html.matchAll(anchorRe)) {
          const href = match[1] ?? "";
          const titleRaw = match[2] ?? "";
          const snippetRaw = match[3] ?? "";
          const url = resolveBingUrl(href);
          if (!url) {
            continue;
          }
          if (seen.has(url)) {
            continue;
          }
          seen.add(url);
          results.push({ title: stripTags(titleRaw), url, snippet: stripTags(snippetRaw).slice(0, 300) || null });
          if (results.length >= limit) {
            break;
          }
        }
        return results;
      },
      catch: (cause): RetrievalError => retrievalError("bing search failed", cause),
    }),
  );

const JINA_SEARCH_URL = "https://s.jina.ai/";

const JINA_MIN_INTERVAL_MS = 700;

let lastJinaRequestAt = 0;

const jinaThrottle = (): Effect.Effect<void> =>
  Effect.promise(async () => {
    const now = Date.now();
    const wait = lastJinaRequestAt + JINA_MIN_INTERVAL_MS - now;
    if (wait > 0) {
      await sleep(wait);
    }
    lastJinaRequestAt = Date.now();
  });

export const fetchJinaResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(jinaThrottle(), () =>
    Effect.flatMap(
      Effect.promise(async () => (await loadSearchSettings()).jinaApiKey),
      (key) =>
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(JINA_SEARCH_URL, {
              method: "POST",
              signal: AbortSignal.timeout(20_000),
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-Respond-With": "no-content",
              },
              body: JSON.stringify({ q: query }),
            });
            if (res.status === 429 || res.status === 402 || res.status === 401) {
              throw new Error(`jina ${res.status}`);
            }
            const data = (await res.json()) as JinaSearchResponse;
            const rows = data.data ?? [];
            return rows
              .filter((row): row is JinaResult & { url: string } => Boolean(row.url))
              .slice(0, limit)
              .map((row) => ({ title: row.title ?? row.url, url: row.url, snippet: (row.description ?? row.content ?? null)?.slice(0, 300) ?? null }));
          },
          catch: (cause): RetrievalError => retrievalError("jina search failed", cause),
        }),
    ),
  );
