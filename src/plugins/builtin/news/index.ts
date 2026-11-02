import type { RawCompanyArtifact, SourceAdapterDefinition } from "@src/adapters/types";
import { companyFromHeadline, fetchNewsHeadlines } from "@src/harness/news";
import { definePlugin } from "@src/plugins/define";

export const NEWS_SOURCE_TYPE = "source:news";

export const newsPlugin = definePlugin({
  manifest: {
    name: "news",
    description: "Searches Google News RSS for articles matching a query and maps headlines to lead artifacts.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: NEWS_SOURCE_TYPE,
    label: "Google News",
    credentials: {
      fields: [],
    },

    crawl: async (input) => {
      const headlines = await fetchNewsHeadlines(input.query, input.maxResults);

      const artifacts: RawCompanyArtifact[] = headlines.map((headline) => ({
        name: companyFromHeadline(headline.title),
        category: "News",
        sourceUrl: headline.link,
        title: headline.title,
        contacts: [],
      }));

      return {
        query: input.query,
        artifacts,
        sourceUrl: `https://news.google.com/search?q=${encodeURIComponent(input.query)}`,
        warnings: [],
        schemaVersion: 1,
      };
    },
  } satisfies SourceAdapterDefinition,

  catalog: {
    type: NEWS_SOURCE_TYPE,
    kind: "source",
    label: "Google News",
    credentialFields: [],
  },
});
