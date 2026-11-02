import { Effect } from "effect";
import { loadSearchSettings } from "@src/harness/websearch/settings";
import type { WebResult } from "@src/harness/websearch/types";
import { fromRetrievalOperation, type RetrievalError } from "@src/harness/websearch/errors";

const SERPER_URL = "https://google.serper.dev/search";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

const BRIGHTDATA_URL = "https://api.brightdata.com/serp/req";

const LINKUP_URL = "https://api.linkup.so/v1/search";

const TAVILY_URL = "https://api.tavily.com/search";

const EXA_URL = "https://api.exa.ai/search";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://127.0.0.1:8888/search";

interface RawEntry {
  title?: string;
  url?: string;
  snippet: string | null;
}

interface SearchApiPayload {
  organic?: RawEntry[];
  web?: { results?: RawEntry[] };
  results?: RawEntry[];
  data?: RawEntry[];
}

const collect = (entries: RawEntry[], limit: number): WebResult[] => {
  const results: WebResult[] = [];
  for (const entry of entries) {
    if (!entry.title || !entry.url || !entry.url.startsWith("http")) {
      continue;
    }
    results.push({ title: entry.title, url: entry.url, snippet: entry.snippet });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
};

const requireKey = (key: string | null, name: string): string => {
  if (!key) {
    throw new Error(`${name} not configured (Settings → Web search)`);
  }
  return key;
};

const getJson = async (label: string, url: string, init: RequestInit): Promise<SearchApiPayload> => {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${label} returned ${res.status}`);
  }
  return (await res.json()) as SearchApiPayload;
};

const raw = (organic?: RawEntry[]) => (organic ?? []).map((e) => ({ title: e.title, url: e.url, snippet: e.snippet }));

export const fetchSerperResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(
    Effect.promise(() => loadSearchSettings()),
    (settings) =>
      fromRetrievalOperation(async () => {
        const key = requireKey(settings.serperApiKey, "serperApiKey");
        const data = await getJson("serper", SERPER_URL, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: { "X-API-KEY": key, "Content-Type": "application/json" },
          body: JSON.stringify({ q: query, num: Math.min(limit, 20) }),
        });
        return collect(raw(data.organic), limit);
      }),
  );

export const fetchBraveResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(
    Effect.promise(() => loadSearchSettings()),
    (settings) =>
      fromRetrievalOperation(async () => {
        const key = requireKey(settings.braveApiKey, "braveApiKey");
        const data = await getJson(
          "brave",
          `${BRAVE_URL}?${new URLSearchParams({ q: query, count: String(Math.min(limit, 20)), country: "id", search_lang: "id" })}`,
          {
            signal: AbortSignal.timeout(15_000),
            headers: { "X-Subscription-Token": key, Accept: "application/json" },
          },
        );
        return collect(raw(data.web?.results), limit);
      }),
  );

export const fetchBrightDataResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(
    Effect.promise(() => loadSearchSettings()),
    (settings) =>
      fromRetrievalOperation(async () => {
        const key = requireKey(settings.brightdataSerpApiKey, "brightdataSerpApiKey");
        const data = await getJson("brightdata", BRIGHTDATA_URL, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            zone: settings.brightdataSerpZone ?? "serp",
            url: `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=id&hl=id&num=${Math.min(limit, 20)}`,
            format: "json",
          }),
        });
        return collect(raw(data.organic), limit);
      }),
  );

export const fetchLinkupResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(
    Effect.promise(() => loadSearchSettings()),
    (settings) =>
      fromRetrievalOperation(async () => {
        const key = requireKey(settings.linkupApiKey, "linkupApiKey");
        const data = await getJson("linkup", LINKUP_URL, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ q: query, depth: "standard", outputType: "searchResults", maxResults: Math.min(limit, 20) }),
        });
        return collect(raw(data.results), limit);
      }),
  );

export const fetchTavilyResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(
    Effect.promise(() => loadSearchSettings()),
    (settings) =>
      fromRetrievalOperation(async () => {
        const key = requireKey(settings.tavilyApiKey, "tavilyApiKey");
        const data = await getJson("tavily", TAVILY_URL, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: key, query, max_results: Math.min(limit, 20), search_depth: "basic" }),
        });
        return collect(raw(data.results), limit);
      }),
  );

export const fetchExaResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  Effect.flatMap(
    Effect.promise(() => loadSearchSettings()),
    (settings) =>
      fromRetrievalOperation(async () => {
        const key = requireKey(settings.exaApiKey, "exaApiKey");
        const data = await getJson("exa", EXA_URL, {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: { "x-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ query, numResults: Math.min(limit, 20), type: "auto", contents: { text: false } }),
        });
        return collect(raw(data.results), limit);
      }),
  );

export const fetchSearxResults = (query: string, limit: number): Effect.Effect<WebResult[], RetrievalError> =>
  fromRetrievalOperation(async () => {
    const res = await fetch(`${SEARXNG_URL}?${new URLSearchParams({ q: query, format: "json" })}`, {
      signal: AbortSignal.timeout(12_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`searxng returned ${res.status}`);
    }
    const data = (await res.json()) as SearchApiPayload;
    return collect(raw(data.results), limit);
  });
