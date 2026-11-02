import { TransientSourceError } from "@src/harness/errors";

const NEWS_RSS_TIMEOUT_MS = 10_000;
const NEWS_RSS_URL = "https://news.google.com/rss/search?q=";
const NEWS_RSS_PARAMS = "&hl=id&gl=ID&ceid=ID:id";
const NEWS_UA = "Mozilla/5.0 (compatible; ProspectusBot/1.0)";

export interface NewsHeadline {
  title: string;
  link: string;
  publishedAt: string | null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function tagText(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match?.[1]) return null;
  const text = decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
  return text.length > 0 ? text : null;
}

export function companyFromHeadline(title: string): string {
  const separator = title.lastIndexOf(" - ");
  return separator > 0 ? title.slice(0, separator).trim() : title.trim();
}

export async function fetchNewsHeadlines(query: string, limit = 10): Promise<NewsHeadline[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NEWS_RSS_TIMEOUT_MS);

  let xml: string;
  try {
    const res = await fetch(`${NEWS_RSS_URL}${encodeURIComponent(query)}${NEWS_RSS_PARAMS}`, {
      signal: controller.signal,
      headers: { "User-Agent": NEWS_UA },
    });
    if (!res.ok) {
      throw new TransientSourceError(`google news rss returned ${res.status}`, res.status >= 500 ? 2000 : null);
    }
    xml = await res.text();
  } catch (error) {
    if (error instanceof TransientSourceError) throw error;
    throw new TransientSourceError(`google news rss fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const headlines: NewsHeadline[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    if (!block) continue;
    const title = tagText(block, "title");
    const link = tagText(block, "link");
    if (!title || !link) continue;
    headlines.push({ title, link, publishedAt: tagText(block, "pubDate") });
    if (headlines.length >= limit) break;
  }

  return headlines;
}

function tokenOverlap(companyName: string, title: string): number {
  const companyTokens = new Set(
    companyName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !/^(pt|cv|ud|tbk|persero)$/i.test(t)),
  );
  if (companyTokens.size === 0) return 0;
  const titleTokens = new Set(title.toLowerCase().split(/[^a-z0-9]+/));
  let hits = 0;
  for (const token of companyTokens) {
    if (titleTokens.has(token)) hits += 1;
  }
  return hits / companyTokens.size;
}

export async function findCompanyNews(companyName: string, limit = 20): Promise<NewsHeadline | null> {
  const headlines = await fetchNewsHeadlines(companyName, limit);
  const needle = companyName.toLowerCase();
  const exact = headlines.find((headline) => headline.title.toLowerCase().includes(needle));
  if (exact) return exact;
  let best: { headline: NewsHeadline; score: number } | null = null;
  for (const headline of headlines) {
    const score = tokenOverlap(companyName, headline.title);
    if (score >= 0.6 && (!best || score > best.score)) best = { headline, score };
  }
  return best?.headline ?? null;
}
