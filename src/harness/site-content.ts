import { Effect } from "effect";
import { ScraplingService, live as scraplingLive, type ScrapedPage } from "@src/harness/scrapling";
import { patchrightStealthFetch, htmlToText } from "@src/harness/stealth-fetch";

export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

const DEEP_SITE_PATHS = [
  "/about",
  "/about-us",
  "/tentang-kami",
  "/profil",
  "/company-profile",
  "/profil-perusahaan",
  "/karir",
  "/careers",
  "/lowongan",
  "/kontak",
  "/contact",
];

const DEEP_SITE_LINK_RE = /href="([^"#]+)"[^>]*>/gi;

const DEEP_SITE_PATH_HINT_RE = /about|tentang|profil|company|karir|career|lowongan|kontak|contact|glance|visi|sejarah|history|manajemen|organisasi/i;

function stripHtml(html: string): string | null {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

const withWww = (url: string): string | null => {
  if (!/^https?:\/\/[^/]+\./.test(url)) {
    return null;
  }
  const next = url.replace(/^(https?:\/\/)([^/]+)/, (_m: string, scheme: string, host: string) => `${scheme}www.${host.replace(/^www\./, "")}`);
  return next === url ? null : next;
};

const usable = (page: ScrapedPage): string | null => (page.status === 200 && page.markdown ? page.markdown : null);

export const scraplingStealthChain = (url: string): Effect.Effect<string | null, never, ScraplingService> =>
  Effect.gen(function* () {
    const scrapling = yield* ScraplingService;
    const http = yield* Effect.orElseSucceed(Effect.map(scrapling.httpFetch(url), usable), () => null);
    if (http) {
      return http;
    }
    const stealth = yield* Effect.orElseSucceed(Effect.map(scrapling.stealthFetch(url, { solveCloudflare: true }), usable), () => null);
    if (stealth) {
      return stealth;
    }
    const next = withWww(url);
    if (!next) {
      return null;
    }
    const httpWww = yield* Effect.orElseSucceed(Effect.map(scrapling.httpFetch(next), usable), () => null);
    if (httpWww) {
      return httpWww;
    }
    return yield* Effect.orElseSucceed(Effect.map(scrapling.stealthFetch(next, { solveCloudflare: true }), usable), () => null);
  });

const runChain = (url: string): Promise<string | null> =>
  Effect.runPromise(Effect.provideService(scraplingStealthChain(url), ScraplingService, scraplingLive).pipe(Effect.orElseSucceed(() => null)));

export async function fetchPageText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA },
    });
    clearTimeout(timer);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/")) return res.ok ? null : stealthPageText(url, res.status);
    const html = await res.text();
    return stripHtml(html);
  } catch {
    return stealthPageText(url, 0);
  }
}

export async function stealthPageText(url: string, directStatus: number): Promise<string | null> {
  if (directStatus !== 403 && directStatus !== 429 && directStatus !== 503 && directStatus !== 0) {
    return null;
  }
  const markdown = await runChain(url);
  if (markdown) {
    return markdown;
  }
  const fallback = await patchrightStealthFetch(url);
  if (!fallback.html) {
    return null;
  }
  return htmlToText(fallback.html) || null;
}

function extractHtmlLinks(html: string, base: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(DEEP_SITE_LINK_RE)) {
    const href = match[1];
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    try {
      const resolved = new URL(href, base);
      if (resolved.hostname !== new URL(base).hostname.replace(/^www\./, "") && resolved.hostname.replace(/^www\./, "") !== new URL(base).hostname) {
        continue;
      }
      if (!DEEP_SITE_PATH_HINT_RE.test(resolved.pathname)) {
        continue;
      }
      if (!resolved.pathname.endsWith(".html") && resolved.pathname !== "/" && resolved.pathname.split("/").pop()?.includes(".")) {
        continue;
      }
      links.push(resolved.origin + resolved.pathname);
    } catch {
      continue;
    }
  }
  return [...new Set(links)];
}

export interface DeepSiteContent {
  content: string | null;
  etag: string | null;
  lastModified: string | null;
  unchanged: boolean;
}

export async function fetchDeepSiteContent(
  website: string,
  timeoutMs = 12_000,
  validators?: { etag: string | null; lastModified: string | null },
): Promise<DeepSiteContent> {
  const base = website.replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let homeHtml: string;
  let etag: string | null = null;
  let lastModified: string | null = null;
  try {
    const headers: Record<string, string> = { "User-Agent": BROWSER_UA };
    if (validators?.etag) {
      headers["If-None-Match"] = validators.etag;
    }
    if (validators?.lastModified) {
      headers["If-Modified-Since"] = validators.lastModified;
    }
    const res = await fetch(base, { signal: controller.signal, redirect: "follow", headers });
    clearTimeout(timer);
    if (res.status === 304) {
      return { content: null, etag: validators?.etag ?? null, lastModified: validators?.lastModified ?? null, unchanged: true };
    }
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/")) {
      const stealth = res.ok ? null : await stealthPageText(base, res.status);
      return { content: stealth ? stealth.slice(0, 60_000) : null, etag: null, lastModified: null, unchanged: false };
    }
    etag = res.headers.get("etag");
    lastModified = res.headers.get("last-modified");
    homeHtml = await res.text();
  } catch {
    clearTimeout(timer);
    return { content: null, etag: null, lastModified: null, unchanged: false };
  }
  const guessedPaths = DEEP_SITE_PATHS.slice(0, 6);
  const harvested = extractHtmlLinks(homeHtml, base).slice(0, 5);
  const candidates = [...new Set([...harvested, ...guessedPaths.map((path) => `${base}${path}`)])].slice(0, 7);
  const texts = await Promise.all([fetchPageText(base, timeoutMs), ...candidates.map((url) => fetchPageText(url, Math.min(timeoutMs, 8_000)))]).then((parts) =>
    parts.map((p) => p ?? null),
  );
  const merged = [stripHtml(homeHtml), ...texts].filter((t): t is string => Boolean(t)).join(" \n\n ");
  if (!merged.trim()) {
    return { content: null, etag, lastModified, unchanged: false };
  }
  return { content: merged.slice(0, 60_000), etag, lastModified, unchanged: false };
}

export async function fetchSiteContent(website: string, timeoutMs = 12_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(website, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    const html = await res.text();
    return stripHtml(html);
  } catch {
    return null;
  }
}
