import type { RawCompanyArtifact, SourceAdapterDefinition } from "@src/adapters/types";
import { definePlugin } from "@src/plugins/define";
import { companyFromWebTitle, fetchWebResults } from "@src/harness/websearch";

const NON_COMPANY_HOSTS =
  /google\.|duckduckgo\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|jobstreet\.|glints\.com|kalibrr\.com|glassdoor\.|indeed\.com|wikipedia\.org|blogspot\.com|medium\.com|tokopedia\.|shopee\.|bukalapak\.|kompas\.com|detik\.com|tempo\.co|cnbcindonesia\.com|idntimes\.com|liputan6\.com|cnnindonesia\.com|merdeka\.com|tirto\.id|antaranews\.com|reuters\.com|bisnis\.com|forbes\.com|crunchbase\.|bureau\.veritas|pricepanda|economictimes|ft\.com|benzinga|marketscreener|wsj\.com|bloomberg\.|investing\.com|morningstar\.|simplywall|finanzen\.net|moomoo\.|futunn|aktivan\.id| IDX:|saham|\bdirectory\b|\breview\b|\brating\b/i;

function siteFromResultUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (!host.includes(".")) return null;
    if (NON_COMPANY_HOSTS.test(host)) return null;
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return null;
  }
}

export const WEBSEARCH_SOURCE_TYPE = "source:websearch";

export const websearchPlugin = definePlugin({
  manifest: {
    name: "websearch",
    description:
      "Searches the open web (DuckDuckGo) for pages matching a query and maps results to lead artifacts. Supports dork operators (site:, OR, quotes).",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: WEBSEARCH_SOURCE_TYPE,
    label: "Web search",
    credentials: {
      fields: [
        "serperApiKey",
        "braveApiKey",
        "brightdataSerpApiKey",
        "brightdataSerpZone",
        "linkupApiKey",
        "exaApiKey",
        "tavilyApiKey",
        "jinaApiKey",
        "dailyBudgetUsd",
        "googleScraping",
        "bingScraping",
        "serpProxyUrl",
        "emailVerifierApiKey",
        "emailVerifierProvider",
      ],
    },

    crawl: async (input) => {
      const results = await fetchWebResults(input.query, input.maxResults);

      const artifacts: RawCompanyArtifact[] = results.map((result) => ({
        name: companyFromWebTitle(result.title),
        category: "Web",
        sourceUrl: result.url,
        title: result.title,
        contacts: [],
        snippet: result.snippet,
        website: siteFromResultUrl(result.url),
      }));

      return {
        query: input.query,
        artifacts,
        sourceUrl: `https://duckduckgo.com/?q=${encodeURIComponent(input.query)}`,
        warnings: [],
        schemaVersion: 1,
      };
    },
  } satisfies SourceAdapterDefinition,

  catalog: {
    type: WEBSEARCH_SOURCE_TYPE,
    kind: "source",
    label: "Web search",
    credentialFields: [
      { name: "serperApiKey", label: "Serper API key", secret: true, required: false },
      { name: "braveApiKey", label: "Brave Search API key", secret: true, required: false },
      { name: "brightdataSerpApiKey", label: "BrightData SERP API key", secret: true, required: false },
      { name: "brightdataSerpZone", label: "BrightData SERP zone", secret: false, required: false },
      { name: "linkupApiKey", label: "Linkup API key", secret: true, required: false },
      { name: "exaApiKey", label: "Exa API key", secret: true, required: false },
      { name: "tavilyApiKey", label: "Tavily API key", secret: true, required: false },
      { name: "jinaApiKey", label: "Jina API key", secret: true, required: false },
      { name: "dailyBudgetUsd", label: "Daily search budget (USD)", secret: false, required: false },
      { name: "googleScraping", label: "Enable Google browser scraping (yes/no)", secret: false, required: false },
      { name: "bingScraping", label: "Enable Bing scraping (yes/no)", secret: false, required: false },
      { name: "serpProxyUrl", label: "SERP browser proxy URL", secret: true, required: false },
      { name: "emailVerifierApiKey", label: "Email verifier API key (ZeroBounce or NeverBounce)", secret: true, required: false },
      { name: "emailVerifierProvider", label: "Email verifier provider (zerobounce/neverbounce)", secret: false, required: false },
    ],
  },
});
