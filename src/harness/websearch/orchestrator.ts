import { Effect } from "effect";
import { loadSearchSettings } from "@src/harness/websearch/settings";
import type { BackendKey, WebResult } from "@src/harness/websearch/types";
import {
  fetchSerperResults,
  fetchBraveResults,
  fetchBrightDataResults,
  fetchLinkupResults,
  fetchTavilyResults,
  fetchExaResults,
  fetchSearxResults,
} from "@src/harness/websearch/backends";
import { fetchGoogleSerpResults, fetchBingResults, fetchJinaResults } from "@src/harness/websearch/serp-scrape";
import { fetchWebResultsOnce, DDG_RATE_LIMIT_COOLDOWN_MS } from "@src/harness/websearch/ddg";
import { tripBreaker, resumeBreaker, isSuspended, underBudget, recordCall, recordAttempt, classifyOutcome } from "@src/harness/websearch/health";
import { hashQuery, readCache, writeCache, pruneCache } from "@src/harness/websearch/cache";
import { RetrievalTransientError, type RetrievalError } from "@src/harness/websearch/errors";

export const scheduleCachePrune = (): Effect.Effect<void> => Effect.delay(pruneCache(), DurationHours(1));

function DurationHours(hours: number): number {
  return hours * 3_600_000;
}

type BackendFetch = (query: string, limit: number) => Effect.Effect<WebResult[], RetrievalError>;

const backendByKey: Partial<Record<BackendKey, BackendFetch>> = {
  serper: fetchSerperResults,
  brightdata: fetchBrightDataResults,
  linkup: fetchLinkupResults,
  google: fetchGoogleSerpResults,
  bing: fetchBingResults,
  jina: fetchJinaResults,
  exa: fetchExaResults,
  tavily: fetchTavilyResults,
  brave: fetchBraveResults,
  searx: fetchSearxResults,
};

const enabledSlots = (settings: Awaited<ReturnType<typeof loadSearchSettings>>): [BackendKey, boolean][] => [
  ["serper", Boolean(settings.serperApiKey)],
  ["brightdata", Boolean(settings.brightdataSerpApiKey)],
  ["linkup", Boolean(settings.linkupApiKey)],
  ["exa", Boolean(settings.exaApiKey)],
  ["tavily", Boolean(settings.tavilyApiKey)],
  ["brave", Boolean(settings.braveApiKey)],
  ["google", settings.googleScraping],
  ["bing", settings.bingScraping],
  ["jina", Boolean(settings.jinaApiKey)],
  ["searx", true],
];

const runBackend = (key: BackendKey, fetch: BackendFetch, query: string, limit: number): Effect.Effect<WebResult[]> =>
  Effect.flatMap(underBudget(key), (allowed) => {
    if (!allowed) {
      return Effect.succeed([]);
    }
    const startedAt = Date.now();
    return fetch(query, limit).pipe(
      Effect.flatMap((results) =>
        Effect.sync(() => {
          recordAttempt({
            backend: key,
            outcome: results.length > 0 ? "success" : "no_results",
            resultCount: results.length,
            latencyMs: Date.now() - startedAt,
            at: new Date().toISOString(),
          });
          if (results.length > 0) {
            resumeBreaker(key);
          }
          return results;
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          recordAttempt({
            backend: key,
            outcome: classifyOutcome(error.cause),
            resultCount: 0,
            latencyMs: Date.now() - startedAt,
            at: new Date().toISOString(),
          });
          tripBreaker(key, error.cause);
          return [] as WebResult[];
        }),
      ),
    );
  });

const ddgLastResort = (hash: string, query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> => {
  const succeedWith = (results: WebResult[], backend: string): Effect.Effect<WebResult[], RetrievalError> =>
    Effect.as(writeCache(hash, query, backend, results), results);

  const attemptOnce = (): Effect.Effect<WebResult[], RetrievalError> =>
    Effect.flatMap(fetchWebResultsOnce(query, limit), (first): Effect.Effect<WebResult[], RetrievalError> => {
      if (first.results.length > 0 || !first.rateLimited) {
        resumeBreaker("ddg");
        recordCall("ddg");
        recordAttempt({
          backend: "ddg",
          outcome: first.results.length > 0 ? "success" : "no_results",
          resultCount: first.results.length,
          latencyMs: 0,
          at: new Date().toISOString(),
        });
        if (first.results.length > 0) {
          return succeedWith(first.results, "ddg");
        }
        return succeedWith([], "empty");
      }
      return Effect.fail(new RetrievalTransientError({ message: "duckduckgo rate limited", retryAfterMs: null, cause: new Error("duckduckgo rate limited") }));
    });

  const retry = (rateLimitError: RetrievalError): Effect.Effect<WebResult[], RetrievalError> =>
    Effect.flatMap(Effect.sleep(DDG_RATE_LIMIT_COOLDOWN_MS), () =>
      Effect.flatMap(fetchWebResultsOnce(query, limit), (retried): Effect.Effect<WebResult[], RetrievalError> => {
        if (retried.results.length > 0) {
          resumeBreaker("ddg");
          recordCall("ddg");
          recordAttempt({ backend: "ddg", outcome: "success", resultCount: retried.results.length, latencyMs: 0, at: new Date().toISOString() });
          return succeedWith(retried.results, "ddg");
        }
        if (retried.rateLimited) {
          tripBreaker("ddg", new Error("rate limited after retry"));
          recordAttempt({ backend: "ddg", outcome: "rate_limited", resultCount: 0, latencyMs: 0, at: new Date().toISOString() });
          return Effect.fail(
            new RetrievalTransientError({ message: "duckduckgo rate limited after retry and cooldown", retryAfterMs: null, cause: rateLimitError }),
          );
        }
        recordAttempt({ backend: "ddg", outcome: "no_results", resultCount: 0, latencyMs: 0, at: new Date().toISOString() });
        return Effect.succeed(retried.results);
      }),
    );

  return Effect.catch(attemptOnce(), retry);
};

export const fetchWebResultsEffect = (query: string, limit = 10): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(hashQuery(query), (hash) =>
    Effect.flatMap(readCache(hash), (cached) => {
      if (cached) {
        return Effect.succeed(cached);
      }
      return Effect.flatMap(
        Effect.promise(() => loadSearchSettings()),
        (settings) => {
          const backends: [BackendKey, BackendFetch][] = [];
          for (const [key, enabled] of enabledSlots(settings)) {
            const fetch = backendByKey[key];
            if (enabled && fetch && !isSuspended(key)) {
              backends.push([key, fetch]);
            }
          }
          const chain = Effect.reduce(
            backends,
            () => null as WebResult[] | null,
            (winner, [key, fetch]) => {
              if (winner) {
                return Effect.succeed(winner);
              }
              return Effect.map(runBackend(key, fetch, query, limit), (results) => {
                if (results.length > 0) {
                  recordCall(key);
                  void writeCache(hash, query, key, results);
                  return results;
                }
                return null;
              });
            },
          );
          return Effect.flatMap(chain, (winner) => (winner ? Effect.succeed(winner) : ddgLastResort(hash, query, limit)));
        },
      );
    }),
  );

export async function fetchWebResults(query: string, limit = 10): Promise<WebResult[]> {
  try {
    return await Effect.runPromise(fetchWebResultsEffect(query, limit));
  } catch (error) {
    if (error instanceof RetrievalTransientError) {
      throw error.plain;
    }
    throw error;
  }
}
