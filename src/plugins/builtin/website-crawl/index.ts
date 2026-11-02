import type { RawCompanyArtifact, SourceAdapterDefinition } from "@src/adapters/types";
import { buildDiscoveredContacts, crawlCompanySite } from "@src/harness/contact-discovery";
import { definePlugin } from "@src/plugins/define";
import { companyFromWebTitle, fetchWebResults } from "@src/harness/websearch";

export const WEBSITE_CRAWL_SOURCE_TYPE = "source:website-crawl";

function normalizeSite(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (!parsed.hostname.includes(".")) return null;
    if (/google\.|duckduckgo\.|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com/.test(parsed.hostname)) return null;
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return null;
  }
}

export const websiteCrawlPlugin = definePlugin({
  manifest: {
    name: "website-crawl",
    description:
      "Discovers company websites via web search, then crawls each site (about/team/contact pages) to extract real contact people: emails, phones, WhatsApp, LinkedIn, names with titles.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: WEBSITE_CRAWL_SOURCE_TYPE,
    label: "Website contact crawler",
    credentials: { fields: [] },

    crawl: async (input) => {
      const warnings: string[] = [];
      const results = await fetchWebResults(input.query, Math.max(input.maxResults, 10));

      const artifacts: RawCompanyArtifact[] = [];
      const seenDomains = new Set<string>();

      for (const result of results) {
        const site = normalizeSite(result.url);
        if (!site || seenDomains.has(site)) continue;
        seenDomains.add(site);

        const crawl = await crawlCompanySite(site, { maxPages: 8, maxDepth: 2 });
        if (crawl.pagesFetched === 0) {
          warnings.push(`unreachable: ${site}`);
          continue;
        }

        const discovered = buildDiscoveredContacts(crawl);
        artifacts.push({
          name: companyFromWebTitle(result.title),
          category: "Web",
          sourceUrl: result.url,
          website: site,
          title: result.title,
          snippet: result.snippet,
          phone: crawl.whatsapp ?? crawl.phones[0] ?? null,
          contacts: discovered.map((c) => ({
            name: c.name,
            title: c.title,
            email: c.email,
            phone: c.phone ?? crawl.whatsapp ?? null,
            linkedinUrl: c.linkedinUrl,
            isDecisionMaker: c.title
              ? /direktur|director|ceo|cto|coo|cfo|owner|founder|president|general manager|manajer|manager|kepala|head of|pemilik/i.test(c.title)
              : null,
          })),
        });
      }

      if (artifacts.length === 0) warnings.push("no reachable company sites found for query");

      return {
        query: input.query,
        artifacts,
        sourceUrl: results[0]?.url,
        warnings,
        schemaVersion: 1,
      };
    },
  } satisfies SourceAdapterDefinition,

  catalog: {
    type: WEBSITE_CRAWL_SOURCE_TYPE,
    kind: "source",
    label: "Website contact crawler",
    credentialFields: [],
  },
});
