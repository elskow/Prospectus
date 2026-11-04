import { spawn } from "node:child_process";
import { fetchHtmlWithChallengeFallback } from "./cf-fetch";
import type { DirectoryAdapter, DirectoryPage, DirectoryRow } from "./registry";
import { registerDirectoryAdapter } from "./registry";

const BASE = "https://www.indonetwork.co.id";
const BUN_PROXY_URL = (process.env.SCRAPE_PROXY_URL ?? "socks5://127.0.0.1:1080").replace(/^socks5:\/\//, "http://");
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0";
const BROWSER_HEADERS = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.5",
};
const BUN_FETCH_SCRIPT = `const res = await fetch(process.argv[1], {
  headers: ${JSON.stringify(BROWSER_HEADERS)},
  proxy: ${JSON.stringify(BUN_PROXY_URL)},
  redirect: "follow",
  signal: AbortSignal.timeout(30_000),
});
if (res.status === 429 || res.status === 503) {
  process.exit(3);
}
if (!res.ok) process.exit(2);
process.stdout.write(await res.text());
`;
const REQUEST_DELAY_MS = 400;
const RATE_LIMIT_WAIT_MS = 5_000;
const RATE_LIMIT_EXIT = 3;
const FETCH_TIMEOUT_MS = 30_000;
const ROWS_PER_PAGE = 25;
const MAX_CONSECUTIVE_MISSES = 8;
const DESC_MAX = 300;
const CATEGORY = "mesin-peralatan-industri";
const CARD_RE = /<li class="company-row">/g;
const PROVINCE_RE =
  /(jawa (barat|timur|tengah)|sumatera (utara|selatan|barat|tengah)|kalimantan (barat|timur|selatan|tengah|utara)|sulawesi (utara|selatan|tengah|tenggara|barat)|banten|bali|nusa tenggara (barat|timur)|papua( barat)?|maluku( utara)?|d?i? ?jakarta|di yogyakarta|yogyakarta|aceh|riau|kepulauan riau|jambi|bengkulu|lampung|gorontalo)/i;

let lastRequestAt = 0;

async function pace(minGapMs: number): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (lastRequestAt > 0 && elapsed < minGapMs) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, minGapMs - elapsed);
    await promise;
  }
  lastRequestAt = Date.now();
}

function fetchViaBun(url: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const child = spawn("bun", ["-e", BUN_FETCH_SCRIPT, url], {
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    shell: false,
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.on("error", () => resolve(null));
  child.on("close", (code) => {
    if (code === 0) {
      resolve(stdout);
    } else if (code === RATE_LIMIT_EXIT) {
      setTimeout(() => resolve(null), RATE_LIMIT_WAIT_MS);
    } else {
      resolve(null);
    }
  });
  return promise;
}

async function fetchHtml(url: string): Promise<string | null> {
  const html = await fetchHtmlWithChallengeFallback(url, fetchViaBun);
  if (html === null) {
    return null;
  }
  await pace(REQUEST_DELAY_MS);
  return html;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2013;/gi, "–")
    .replace(/&#x2026;/gi, "…");
}

function text(value: string | null | undefined): string {
  return decodeEntities(value?.replace(/<[^>]+>/g, " ") ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchFirst(source: string, pattern: RegExp): string | null {
  const match = pattern.exec(source);
  return match?.[1] ?? null;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`;
}

function cleanWebsite(value: string | null | undefined): string | null {
  const candidate = value?.trim() ?? "";
  if (!candidate || !/^https?:\/\//i.test(candidate)) return null;
  if (/indonetwork\.co\.id|image\.indonetwork/i.test(candidate)) return null;
  return candidate;
}

function cityFromAddress(address: string): string | null {
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const kabAt = parts.findIndex((part) => /^(kab(upaten)?\.?|kota)\b/i.test(part));
  if (kabAt >= 0) return parts[kabAt] ?? null;
  const provinceAt = parts.map((part) => PROVINCE_RE.test(part)).lastIndexOf(true);
  if (provinceAt > 0) return parts[provinceAt - 1] ?? null;
  return null;
}

function provinceFromAddress(address: string): string | null {
  const provinceAt = address
    .split(",")
    .map((part) => PROVINCE_RE.test(part))
    .lastIndexOf(true);
  return provinceAt >= 0 ? (address.split(",")[provinceAt]?.trim() ?? null) : null;
}

interface OrganizationLd {
  name?: string;
  url?: string;
  address?: { streetAddress?: string; addressLocality?: string; addressRegion?: string };
}

function organizationJsonLd(source: string): OrganizationLd | null {
  const blocks = source.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "")) as
        (OrganizationLd & { "@type"?: string }) | (OrganizationLd & { "@type"?: string })[];
      const candidate = Array.isArray(parsed) ? parsed.find((entry) => entry && typeof entry === "object" && "address" in entry) : parsed;
      if (candidate && "address" in candidate) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

interface ListingCard {
  name: string;
  slug: string;
  address: string | null;
  description: string | null;
}

function parseCards(source: string): ListingCard[] {
  const starts = [...source.matchAll(CARD_RE)].map((match) => match.index ?? 0);
  const cards: ListingCard[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : Math.min(source.length, start + 30_000);
    const card = source.slice(start, end);
    const nameHtml = matchFirst(card, /class="company-row__name"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const slug = matchFirst(card, /class="company-row__name"[^>]*>\s*<a[^>]*href="([^"]+)"/i);
    if (!nameHtml || !slug || !slug.startsWith("/company/")) continue;
    const name = text(nameHtml);
    if (!name) continue;
    const address = text(matchFirst(card, /class="company-row__address"[^>]*>([\s\S]*?)<\/p>/i));
    const description = truncate(text(matchFirst(card, /class="company-row__description"[^>]*>([\s\S]*?)<\/p>/i)), DESC_MAX);
    cards.push({ name, slug, address: address || null, description: description || null });
  }
  return cards;
}

interface ProfileParse {
  name: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  website: string | null;
}

function parseProfile(source: string): ProfileParse {
  const jsonLd = organizationJsonLd(source);
  const website = matchFirst(source, /class="official-site__link"[^>]*href="([^"]+)"/i) ?? "";
  return {
    name: text(jsonLd?.name) || text(matchFirst(source, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) || null,
    address: text(jsonLd?.address?.streetAddress) || null,
    city: text(jsonLd?.address?.addressLocality) || null,
    province: text(jsonLd?.address?.addressRegion) || null,
    website: cleanWebsite(website),
  };
}

function listingRow(card: ListingCard, pageNo: number): DirectoryRow {
  const sourceUrl = `${BASE}${card.slug}`;
  const address = card.address;
  return {
    name: card.name,
    website: null,
    phone: null,
    email: null,
    address,
    city: address ? cityFromAddress(address) : null,
    province: address ? provinceFromAddress(address) : null,
    country: "Indonesia",
    industry: null,
    sourceUrl,
    raw: { indonetworkSlug: card.slug.replace(/^\/company\//, ""), listingPage: pageNo, description: card.description },
  };
}

function enrichRow(row: DirectoryRow, profile: ProfileParse): DirectoryRow {
  return {
    ...row,
    name: profile.name ?? row.name,
    website: profile.website ?? row.website,
    address: profile.address ?? row.address,
    city: profile.city ?? row.city,
    province: profile.province ?? row.province,
    raw: { ...(row.raw ?? {}) },
  };
}

interface Cursor {
  page: number;
}

function decodeCursor(cursor: string): Cursor {
  const parsed = JSON.parse(cursor) as { page?: unknown };
  const page = Number(parsed.page);
  if (!Number.isInteger(page) || page < 1) throw new Error(`invalid indonetwork cursor: ${cursor}`);
  return { page };
}

function listingUrl(page: number): string {
  return page <= 1 ? `${BASE}/k/${CATEGORY}/perusahaan` : `${BASE}/k/${CATEGORY}/perusahaan/${page}`;
}

async function pageFrom(pageNo: number): Promise<DirectoryPage> {
  const rows: DirectoryRow[] = [];
  let misses = 0;
  let page = pageNo;
  let exhausted = false;
  while (rows.length < ROWS_PER_PAGE) {
    if (misses >= MAX_CONSECUTIVE_MISSES) {
      exhausted = true;
      break;
    }
    const listing = await fetchHtml(listingUrl(page));
    const cards = listing ? parseCards(listing) : [];
    if (!listing || cards.length === 0) {
      misses += 1;
      continue;
    }
    misses = 0;
    for (const card of cards) {
      if (rows.length >= ROWS_PER_PAGE) break;
      const profile = await fetchHtml(`${BASE}${card.slug}`);
      if (!profile) {
        misses += 1;
        continue;
      }
      misses = 0;
      rows.push(enrichRow(listingRow(card, page), parseProfile(profile)));
    }
    page += 1;
  }
  return { rows, cursor: exhausted || rows.length === 0 ? null : JSON.stringify({ page } satisfies Cursor) };
}

export const indonetworkAdapter: DirectoryAdapter = {
  id: "indonetwork",
  label: "Indonetwork supplier directory (ID)",
  defaultPageSize: 4,
  async firstPage(): Promise<DirectoryPage> {
    return pageFrom(1);
  },
  async nextPage(cursor: string): Promise<DirectoryPage> {
    return pageFrom(decodeCursor(cursor).page);
  },
};

registerDirectoryAdapter(indonetworkAdapter);
