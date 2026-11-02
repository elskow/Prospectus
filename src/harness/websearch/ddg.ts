import { Effect } from "effect";
import { stripTags, sleep, type WebResult } from "@src/harness/websearch/types";
import { retrievalError, type RetrievalError } from "@src/harness/websearch/errors";

const DDG_TIMEOUT_MS = 10_000;

const DDG_URL = "https://html.duckduckgo.com/html/";

export const DDG_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DDG_MIN_INTERVAL_MS = 2_500;

export const DDG_RATE_LIMIT_COOLDOWN_MS = 20_000;

let lastDdgRequestAt = 0;

export const throttleDdg = (): Effect.Effect<void> =>
  Effect.suspend(() => {
    const wait = lastDdgRequestAt + DDG_MIN_INTERVAL_MS - Date.now();
    return wait > 0
      ? Effect.flatMap(Effect.sleep(wait), () =>
          Effect.sync(() => {
            lastDdgRequestAt = Date.now();
          }),
        )
      : Effect.sync(() => {
          lastDdgRequestAt = Date.now();
        });
  });

function decodeEntitiesHref(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&quot;/g, '"');
}

function resolveDdgUrl(href: string): string {
  const decoded = decodeEntitiesHref(href);
  const match = decoded.match(/[?&]uddg=([^&]+)/);
  if (match?.[1]) {
    {
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return decoded;
    }
  }
  if (decoded.startsWith("//")) {
    return `https:${decoded}`;
  }
  return decoded;
}

export const fetchWebResultsOnce = (query: string, limit: number): Effect.Effect<{ results: WebResult[]; rateLimited: boolean }, RetrievalError> =>
  Effect.flatMap(throttleDdg(), () =>
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(DDG_URL, {
          method: "POST",
          signal: AbortSignal.timeout(DDG_TIMEOUT_MS),
          headers: {
            "User-Agent": DDG_UA,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "text/html",
            "Accept-Language": "id,en;q=0.8",
          },
          body: new URLSearchParams({ q: query, kl: "id-id" }).toString(),
        });
        if (!res.ok) {
          throw new Error(`duckduckgo returned ${res.status}`);
        }
        const html = await res.text();

        if (html.includes("anomaly") && !html.includes("result__a")) {
          return { results: [] as WebResult[], rateLimited: true };
        }

        const results: WebResult[] = [];
        const resultBlocks = html.matchAll(/<div class="result results_links[^"]*">([\s\S]*?)(?=<div class="result results_links|<div class="nav-link|$)/gi);

        for (const blockMatch of resultBlocks) {
          const block = blockMatch[1] ?? "";
          const titleMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
          if (!titleMatch) {
            continue;
          }
          const title = stripTags(titleMatch[2] ?? "");
          if (!title) {
            continue;
          }

          const url = resolveDdgUrl(titleMatch[1] ?? "");
          if (!url.startsWith("http")) {
            continue;
          }

          const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
          const snippet = snippetMatch ? stripTags(snippetMatch[1] ?? "") : null;

          results.push({ title, url, snippet: snippet || null });
          if (results.length >= limit) {
            break;
          }
        }

        return { results, rateLimited: false };
      },
      catch: (cause): RetrievalError => retrievalError("duckduckgo fetch failed", cause),
    }),
  );
