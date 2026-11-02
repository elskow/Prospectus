import { fetchWebResults } from "@src/harness/websearch/orchestrator";
import type { WebResult } from "@src/harness/websearch/types";

const AGGREGATOR_HOSTS =
  /google\.|duckduckgo\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|jobstreet\.|glints\.com|kalibrr\.com|glassdoor\.|indeed\.com|wikipedia\.org|medium\.com|tokopedia\.|shopee\.|bukalapak\.|kompas\.com|detik\.com|tempo\.co|cnbcindonesia\.com|idntimes\.com|liputan6\.com|cnnindonesia\.com|merdeka\.com|tirto\.id|antaranews\.com|reuters\.com|bisnis\.com|crunchbase\.|marketscreener|bloomberg\.|investing\.com|morningstar\.|simplywall|daftarperusahaan|companieshouse|voffice\.|ekatalog|e-katalog|ruparupa|olx\.|foursquare|yelp\.|tripadvisor|yellowpages|paginasamarillas|dnb\.com|dunbradstreet|orbis|biznet|yellow\.id|perusahaan\.id|indeksonline|cariuan|infobis|indotrading|qerja|urbanhire|jobsdb|sociabuzz|linktr\.ee|whatsapp\.com|wa\.me|t\.me/i;

const NON_COMPANY_HOST_RE = /\.(sch\.id|ac\.id|go\.id|mil\.id|web\.id|or\.id)$|^(mail|smtp|webmail|blog|shop|store|kasir|pos)\./i;

export function siteCandidateFromResults(name: string, results: WebResult[]): string | null {
  const needle = name.toLowerCase();
  const tokens = new Set(needle.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  for (const result of results) {
    try {
      const host = new URL(result.url).hostname.replace(/^www\./, "");
      if (!host.includes(".") || AGGREGATOR_HOSTS.test(host) || NON_COMPANY_HOST_RE.test(host)) {
        continue;
      }
      const core = host.split(".").slice(0, -1).join("-");
      const hay = `${result.title}\n${result.snippet ?? ""}\n${host}`.toLowerCase();
      const brandHit = [...tokens].filter((t) => hay.includes(t)).length >= Math.min(2, tokens.size);
      const hostHit = [...tokens].some((t) => t.length > 3 && core.includes(t));
      if (brandHit || hostHit) {
        return `https://${host}`;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export interface IdentityProbe {
  verified: boolean;
  matchedTitle: string | null;
  matchedUrl: string | null;
}

export async function probeCompanyIdentity(name: string, city: string | null, perQueryLimit = 6): Promise<IdentityProbe> {
  const quoted = `"${name}"`;
  const results = await fetchWebResults(`${quoted} ${city ?? ""}`.trim(), perQueryLimit).catch(() => []);
  const tokens = new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !/^(pt|cv|ud|tbk|persero)$/i.test(t)),
  );
  if (tokens.size === 0) {
    return { verified: false, matchedTitle: null, matchedUrl: null };
  }
  const genericTokens = [...tokens].filter((t) =>
    /^(perusahaan|company|business|usaha|manufaktur|manufacturing|industri|industry|kantor|office|pabrik|factory|distributor|supplier|logistik|logistics|jasa|services|konstruksi|construction|teknik|engineering|dagang|trading|umum|general)$/i.test(
      t,
    ),
  );
  if (genericTokens.length === tokens.size) {
    return { verified: false, matchedTitle: null, matchedUrl: null };
  }
  const distinctive = [...tokens].filter((t) => !genericTokens.includes(t));
  const corpHostRe = /(\.co\.id|\.or\.id|\.ac\.id|\.id|\.com|\.net|\.biz|\.web\.id)/;
  for (const result of results) {
    try {
      const host = new URL(result.url).hostname.replace(/^www\./, "");
      if (AGGREGATOR_HOSTS.test(host) || DOCUMENT_HOSTS.test(host) || !corpHostRe.test(host)) {
        continue;
      }
      if (DIRECTORY_TITLE_RE.test(result.title)) {
        continue;
      }
      const core = host.split(".").slice(0, -1).join("-");
      const titleHits = distinctive.filter((t) => result.title.toLowerCase().includes(t)).length;
      const hostHit = distinctive.some((t) => t.length > 3 && core.includes(t));
      if (hostHit || titleHits >= Math.min(2, distinctive.length)) {
        {
        }
        return { verified: true, matchedTitle: result.title, matchedUrl: result.url };
      }
    } catch {
      continue;
    }
  }
  return { verified: false, matchedTitle: null, matchedUrl: null };
}

export async function findCompanyWebsite(name: string, city: string | null, perQueryLimit = 6): Promise<string | null> {
  const quoted = `"${name}"`;
  const results = await fetchWebResults(`${quoted} ${city ?? ""} (situs resmi OR official website)`.trim(), perQueryLimit).catch(() => []);
  if (results.length > 0) {
    {
    }
    const site = siteCandidateFromResults(name, results);
    if (site) {
      return site;
    }
  }
  const fallback = await fetchWebResults(`${quoted} ${city ?? ""}`.trim(), perQueryLimit).catch(() => []);
  return siteCandidateFromResults(name, fallback);
}

const DOCUMENT_HOSTS =
  /scribd\.|slideshare\.|docs\.google|drive\.google|docplayer\.|coursehero\.|academia\.edu|researchgate\.|pdfcoffee|idoc\.pub|vdocuments|123docz|dokumen\.pub|1library|pdfslide|karir\.|lowongan|jobspedia|rumahmakan|infodari|wiki/i;

const DIRECTORY_TITLE_RE = /\b(daftar|list of|directory|yellow pages|database)\b/i;

export interface ProfilePdf {
  url: string;
  excerpt: string;
}

const PDF_HINT_RE = /(profil|profile|company|annual|laporan|tahunan|leaflet|brochure|brosur)/i;

const PDF_EXCERPT_CHARS = 12_000;

async function extractPdfExcerpt(url: string): Promise<ProfilePdf | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ProspectusBot/1.0)" },
    });
    if (!res.ok) {
      return null;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!contentType.includes("pdf") && buf.subarray(0, 4).toString() !== "%PDF") {
      return null;
    }
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const text = await parser.getText();
    await parser.destroy();
    const clean = text.text.replace(/\s+/g, " ").trim();
    if (clean.length < 500) {
      return null;
    }
    return { url, excerpt: clean.slice(0, PDF_EXCERPT_CHARS) };
  } catch {
    return null;
  }
}

export async function findCompanyProfilePdf(name: string, city: string | null): Promise<ProfilePdf | null> {
  const quoted = `"${name}"`;
  const queries = [`${quoted} (profil OR "company profile" OR laporan tahunan) filetype:pdf`];
  for (const query of queries) {
    const results = await fetchWebResults(query, 6).catch(() => []);
    const candidates = results.filter((r) => r.url.toLowerCase().endsWith(".pdf") || PDF_HINT_RE.test(r.title));
    for (const candidate of candidates.slice(0, 2)) {
      const pdf = await extractPdfExcerpt(candidate.url);
      if (pdf) {
        return pdf;
      }
    }
  }
  return null;
}

export function companyFromWebTitle(title: string): string {
  const separatorMatch = title.match(/\s+[–—|\-·]\s+/);
  const candidate = separatorMatch && separatorMatch.index != null && separatorMatch.index > 0 ? title.slice(0, separatorMatch.index) : title;
  return candidate.replace(/\s*\((?:[^)]*)\)\s*$/, "").trim() || title.trim();
}

export interface CandidateWebEvidence {
  query: string;
  results: WebResult[];
}

export interface DeepWebEvidence extends CandidateWebEvidence {
  pageContents?: { url: string; excerpt: string }[];
}

const PAGE_EXCERPT_CHARS = 4000;

const MAX_PAGES_PER_EVIDENCE = 2;

async function fetchPageExcerpt(url: string): Promise<{ url: string; excerpt: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ProspectusBot/1.0)" },
    });
    if (!res.ok) {
      return null;
    }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url, excerpt: text.slice(0, PAGE_EXCERPT_CHARS) };
  } catch {
    return null;
  }
}

export function crossValidationQueries(name: string, city: string | null): string[] {
  const quoted = `"${name}"`;
  return [
    `${quoted}${city ? ` "${city}"` : ""} (founder OR owner OR pemilik OR direktur)`,
    `${quoted} site:linkedin.com/company`,
    `${quoted} (headcount OR karyawan OR employees)`,
    `${quoted} (news OR berita OR pendanaan OR funding)`,
  ];
}

export async function crossValidateCandidate(name: string, city: string | null, perQueryLimit = 5): Promise<DeepWebEvidence[]> {
  const queries = crossValidationQueries(name, city);
  const evidence = await Promise.allSettled(
    queries.map(async (query) => {
      const results = await fetchWebResults(query, perQueryLimit);
      const seen = new Set<string>();
      const pages = results
        .filter((r) => {
          try {
            const host = new URL(r.url).hostname.replace(/^www\./, "");
            if (seen.has(host)) {
              return false;
            }
            seen.add(host);
            return true;
          } catch {
            return false;
          }
        })
        .slice(0, MAX_PAGES_PER_EVIDENCE);
      const excerpts = (await Promise.allSettled(pages.map((r) => fetchPageExcerpt(r.url)))).flatMap((e) =>
        e.status === "fulfilled" && e.value && e.value.excerpt.length > 200 ? [e.value] : [],
      );
      return { query, results, pageContents: excerpts };
    }),
  );
  const fulfilled: DeepWebEvidence[] = [];
  for (const entry of evidence) {
    if (entry.status === "fulfilled" && entry.value.results.length > 0) {
      fulfilled.push(entry.value);
    }
  }
  return fulfilled;
}
