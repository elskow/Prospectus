import { spawn } from "node:child_process";
import { fetchHtmlWithChallengeFallback } from "./cf-fetch";
import type { DirectoryAdapter, DirectoryPage, DirectoryRow } from "./registry";
import { registerDirectoryAdapter } from "./registry";

const BASE = "https://www.indotrading.com";
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
const PROFILES_PER_PAGE = 25;
const MAX_CONSECUTIVE_MISSES = 20;
const LISTING_ID_SPAN = 20;
const DESC_MAX = 300;
const SOFT_404_MARK = "tidak ada perusahaan ditemukan";
const CARD_RE = /class="card-detail-company/g;
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

async function fetchHtml(url: string): Promise<string | null> {
  const html = await fetchHtmlWithChallengeFallback(url, fetchViaBun);
  if (html === null) {
    return null;
  }
  await pace(REQUEST_DELAY_MS);
  return html;
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

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
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

function cleanWebsite(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || !/^https?:\/\//i.test(candidate)) return null;
  if (/indotrading\.com|image1ws\.indotrading|buyer\.indotrading/i.test(candidate)) return null;
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
  return parts.length > 1 ? (parts[parts.length - 2] ?? null) : null;
}

interface OrganizationLd {
  name?: string;
  url?: string;
  description?: string;
  address?: { streetAddress?: string; addressLocality?: string; addressRegion?: string; addressCountry?: string };
}

function organizationJsonLd(source: string): OrganizationLd | null {
  const blocks = source.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "")) as (OrganizationLd & { "@type"?: string }) | OrganizationLd[];
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
  industry: string | null;
}

function parseCards(source: string): ListingCard[] {
  const starts = [...source.matchAll(CARD_RE)].map((match) => match.index ?? 0);
  const cards: ListingCard[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : Math.min(source.length, start + 30_000);
    const segment = source.slice(start, end);
    const productsAt = segment.indexOf("k-latest-products-row");
    const card = productsAt > 0 ? segment.slice(0, productsAt) : segment;
    const nameHtml = matchFirst(card, /<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const slug = matchFirst(card, /<a[^>]*href="([^"]+)"[^>]*>\s*<h3/i);
    if (!nameHtml || !slug || !slug.startsWith("/")) continue;
    const name = text(nameHtml);
    if (!name) continue;
    const alamatAt = card.indexOf(">Alamat<");
    const address = text(matchFirst(alamatAt >= 0 ? card.slice(alamatAt, alamatAt + 500) : "", /class="address-company[^"]*"[^>]*>([\s\S]*?)<\/p>/i));
    const category = text(matchFirst(card, /kategori-link[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i));
    cards.push({ name, slug, address: address || null, industry: category || null });
  }
  return cards;
}

interface ProfileParse {
  name: string | null;
  description: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  website: string | null;
  industry: string | null;
}

function profileInfoTable(source: string): { alamat: string | null; bidang: string | null } {
  const start = source.indexOf('class="mb-20 profile-info');
  if (start < 0) return { alamat: null, bidang: null };
  const segment = source.slice(start, start + 4000);
  const cellAfter = (label: string): string | null => {
    const labelAt = segment.indexOf(`>${label}<`);
    if (labelAt < 0) return null;
    const value = text(matchFirst(segment.slice(labelAt, labelAt + 400), /<div class="w-70"[^>]*>([\s\S]*?)<\/div>/));
    return value || null;
  };
  return { alamat: cellAfter("Alamat"), bidang: cellAfter("Bidang Perusahaan") };
}

function parseProfile(source: string): ProfileParse {
  const jsonLd = organizationJsonLd(source);
  const table = profileInfoTable(source);
  const descSource = matchFirst(source, /id="compro-desc-id"[^>]*>([\s\S]*?)<\/div>/i) ?? jsonLd?.description;
  const website =
    matchFirst(source, /id="website-company"[^>]*href="([^"]+)"/i) ??
    matchFirst(
      source,
      /href="(https?:\/\/(?!([a-z0-9.-]*indotrading\.com|cdn\.jsdelivr\.net|www\.googletagmanager\.com|play\.google\.com|twitter\.com|www\.facebook\.com|www\.youtube\.com|www\.instagram\.com|([a-z0-9-]+\.)*tawk\.help)(\/|"))[^"]+)"/i,
    ) ??
    "";
  return {
    name: text(jsonLd?.name) || text(matchFirst(source, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) || null,
    description: descSource ? truncate(text(descSource), DESC_MAX) : null,
    address: table.alamat ?? (text(jsonLd?.address?.streetAddress) || null),
    city: text(jsonLd?.address?.addressLocality) || null,
    province: text(jsonLd?.address?.addressRegion) || null,
    website: cleanWebsite(website),
    industry: table.bidang,
  };
}

function listingRow(card: ListingCard, listingId: number): DirectoryRow {
  const sourceUrl = `${BASE}${card.slug}`;
  return {
    name: card.name,
    website: null,
    phone: null,
    email: null,
    address: card.address,
    city: card.address ? cityFromAddress(card.address) : null,
    province: null,
    country: "Indonesia",
    industry: card.industry,
    sourceUrl,
    raw: { sourceUrl, listingPage: listingId },
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
    industry: profile.industry ?? row.industry,
    raw: {
      ...(row.raw ?? {}),
      description: profile.description,
      profileName: profile.name,
      profileCity: profile.city,
      profileProvince: profile.province,
    },
  };
}

function encodeCursor(next: number): string {
  return JSON.stringify({ next });
}

function decodeCursor(cursor: string): number {
  const parsed = JSON.parse(cursor) as { next?: unknown };
  const next = Number(parsed.next);
  if (!Number.isInteger(next) || next < 1) throw new Error(`invalid indotrading cursor: ${cursor}`);
  return next;
}

async function pageFrom(listingId: number): Promise<DirectoryPage> {
  const rows: DirectoryRow[] = [];
  let consecutiveMisses = 0;
  let next = listingId;
  let exhausted = false;
  while (rows.length < PROFILES_PER_PAGE) {
    if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
      exhausted = true;
      break;
    }
    const listing = await fetchHtml(`${BASE}/company/${next}`);
    const cards = listing ? parseCards(listing) : [];
    if (!listing || listing.toLowerCase().includes(SOFT_404_MARK) || cards.length === 0) {
      consecutiveMisses += LISTING_ID_SPAN;
      next += LISTING_ID_SPAN;
      continue;
    }
    for (const card of cards) {
      if (rows.length >= PROFILES_PER_PAGE) break;
      const profile = await fetchHtml(`${BASE}${card.slug}`);
      if (!profile) {
        consecutiveMisses += 1;
        continue;
      }
      consecutiveMisses = 0;
      rows.push(enrichRow(listingRow(card, next), parseProfile(profile)));
    }
    next += 1;
  }
  return { rows, cursor: exhausted ? null : encodeCursor(next) };
}

export const indotradingAdapter: DirectoryAdapter = {
  id: "indotrading",
  label: "Indotrading company profiles (ID)",
  defaultPageSize: 4,
  async firstPage(): Promise<DirectoryPage> {
    return pageFrom(1);
  },
  async nextPage(cursor: string): Promise<DirectoryPage> {
    return pageFrom(decodeCursor(cursor));
  },
};

registerDirectoryAdapter(indotradingAdapter);
