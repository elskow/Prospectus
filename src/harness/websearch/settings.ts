import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { eq } from "drizzle-orm";
import { open } from "@src/lib/crypto";

export interface SearchBackendSettings {
  serperApiKey: string | null;
  braveApiKey: string | null;
  brightdataSerpApiKey: string | null;
  brightdataSerpZone: string | null;
  linkupApiKey: string | null;
  exaApiKey: string | null;
  tavilyApiKey: string | null;
  jinaApiKey: string | null;
  dailyBudgetUsd: number | null;
  googleScraping: boolean;
  bingScraping: boolean;
  serpProxyUrl: string | null;
  emailVerifierApiKey: string | null;
  emailVerifierProvider: "zerobounce" | "neverbounce";
}

const SEARCH_SETTINGS_ADAPTER = "source:websearch";

let settingsCache: { at: number; value: SearchBackendSettings } | null = null;

const SETTINGS_TTL_MS = 30_000;

export async function loadSearchSettings(): Promise<SearchBackendSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache.value;
  }
  const stored: Record<string, string> = {};
  try {
    const [row] = await db.select({ payload: credentials.payload }).from(credentials).where(eq(credentials.adapterType, SEARCH_SETTINGS_ADAPTER)).limit(1);
    if (row) {
      {
      }
      const values = await open<Record<string, string>>(row.payload);
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string" && value.trim()) {
          stored[key] = value.trim();
        }
      }
    }
  } catch {}
  const value: SearchBackendSettings = {
    serperApiKey: stored.serperApiKey ?? process.env.SERPER_API_KEY ?? null,
    braveApiKey: stored.braveApiKey ?? process.env.BRAVE_API_KEY ?? null,
    brightdataSerpApiKey: stored.brightdataSerpApiKey ?? process.env.BRIGHTDATA_SERP_API_KEY ?? null,
    brightdataSerpZone: stored.brightdataSerpZone ?? process.env.BRIGHTDATA_SERP_ZONE ?? "serp",
    linkupApiKey: stored.linkupApiKey ?? process.env.LINKUP_API_KEY ?? null,
    exaApiKey: stored.exaApiKey ?? process.env.EXA_API_KEY ?? null,
    tavilyApiKey: stored.tavilyApiKey ?? process.env.TAVILY_API_KEY ?? null,
    jinaApiKey: stored.jinaApiKey ?? process.env.JINA_API_KEY ?? null,
    dailyBudgetUsd:
      stored.dailyBudgetUsd != null && Number.isFinite(Number(stored.dailyBudgetUsd))
        ? Number(stored.dailyBudgetUsd)
        : process.env.SEARCH_DAILY_BUDGET_USD != null
          ? Number(process.env.SEARCH_DAILY_BUDGET_USD)
          : null,
    googleScraping: stored.googleScraping != null ? /^(1|true|yes|on)$/i.test(stored.googleScraping) : process.env.GOOGLE_SERP_SCRAPING === "1",
    bingScraping: stored.bingScraping != null ? /^(1|true|yes|on)$/i.test(stored.bingScraping) : process.env.BING_SCRAPING === "1",
    serpProxyUrl: stored.serpProxyUrl ?? process.env.SERP_PROXY_URL ?? (process.env.WARP_SOCKS_URL ? `socks5://${process.env.WARP_SOCKS_URL}` : null),
    emailVerifierApiKey: stored.emailVerifierApiKey ?? process.env.EMAIL_VERIFIER_API_KEY ?? null,
    emailVerifierProvider: stored.emailVerifierProvider === "neverbounce" ? "neverbounce" : "zerobounce",
  };
  settingsCache = { at: Date.now(), value };
  return value;
}

export function invalidateSearchSettingsCache(): void {
  settingsCache = null;
}
