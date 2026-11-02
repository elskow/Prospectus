import { createTool } from "@mastra/core/tools";
import { fetchWebResults } from "@src/harness/websearch";
import { z } from "zod";

export const webSearchTool = createTool({
  id: "web-search",
  description:
    "Search the live web (DuckDuckGo, Indonesian region by default). Returns title, URL, snippet per result. You have no reliable memory about specific companies — any factual claim about a company's products, clients, size, contacts, or news must come from this tool or read-page results, quoted with its source URL. If results are empty, say so; never substitute prior knowledge.",
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).nullish().describe("Results to return, default 10"),
    lang: z.string().nullish().describe("Region code like id-id or en-us, default id-id"),
  }),

  execute: async (inputData) => {
    const results = await fetchWebResults(inputData.query, inputData.limit ?? 10);
    return {
      ok: true as const,
      query: inputData.query,
      results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      note: results.length === 0 ? "no results — try rephrasing, different language, or site: targeting" : undefined,
    };
  },
});
