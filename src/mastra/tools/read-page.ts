import { createTool } from "@mastra/core/tools";
import { promises as dns } from "node:dns";
import { z } from "zod";

const MAX_CHARS = 12_000;

export const readPageTool = createTool({
  id: "read-page",
  description:
    "Fetch a URL and return its readable text (HTML stripped, truncated). Use it to verify what a page actually says before quoting it — search snippets are not evidence, the page is. Typical uses: open a company's about/team/contact page found via web-search, check a product's pricing page, confirm a news claim.",
  inputSchema: z.object({
    url: z.string().regex(/^https?:\/\/[^\s]+$/i),
    maxChars: z.number().int().min(500).max(50_000).nullish().describe("Text cap, default 12000"),
  }),

  execute: async (inputData) => {
    let url: URL;
    try {
      url = new URL(inputData.url);
    } catch {
      return { ok: false as const, error: "invalid URL" };
    }
    if (!/^https?:$/.test(url.protocol)) return { ok: false as const, error: "only http(s) URLs" };

    let host = url.hostname;
    try {
      await dns.lookup(host);
    } catch {
      return { ok: false as const, error: `host does not resolve: ${host}` };
    }

    let html: string;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          accept: "text/html,*/*",
        },
      });
      if (!res.ok) return { ok: false as const, error: `http ${res.status}`, url: url.toString() };
      html = await res.text();
    } catch (error) {
      return { ok: false as const, error: `fetch failed: ${error instanceof Error ? error.message : "unknown"}`, url: url.toString() };
    }

    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&#0?39;|&apos;|&#8217;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    const cap = inputData.maxChars ?? MAX_CHARS;
    return {
      ok: true as const,
      url: url.toString(),
      title,
      text: text.slice(0, cap),
      truncated: text.length > cap,
    };
  },
});
