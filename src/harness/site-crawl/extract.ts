import type { SiteCrawlResult } from "@src/harness/contact-discovery";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const PHONE_RE = /(?:\+62|62|0)8[1-9][0-9]{6,11}|\+?[0-9][0-9\s().-]{7,17}[0-9]/g;

const WHATSAPP_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?[0-9]{8,15})/i;

const JUNK_LOCAL_RE = /^[0-9a-f]{8,}$/;

const WEBMAIL_DOMAIN_RE = /gmail\.com|yahoo\.|hotmail\.|outlook\.com|icloud\.com|aol\.com|proton\.|yandex\.|mail\.com|live\.com/i;

const TOP_LEVEL_DOMAINS = new Set([
  "com",
  "net",
  "org",
  "id",
  "co",
  "io",
  "ai",
  "edu",
  "gov",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "dev",
  "app",
  "sg",
  "my",
  "th",
  "ph",
  "vn",
  "au",
  "uk",
  "de",
  "jp",
  "kr",
  "cn",
  "in",
  "us",
  "ca",
  "fr",
  "es",
  "it",
  "nl",
  "se",
  "ch",
  "br",
  "mx",
  "za",
]);

const JUNK_PATTERNS = [
  "example.com",
  "domain.com",
  "email.com",
  "yourdomain",
  "sentry",
  "wixpress",
  "no-reply",
  "noreply@",
  "donotreply",
  "user@",
  "test@",
  "sentry.io",
  "godaddy.com",
  "cloudflare",
];

const ROLE_PREFIXES = ["info", "admin", "contact", "sales", "support", "hello", "hrd", "marketing", "office", "cs", "cs@"];

const OBFUSCATIONS: [RegExp, string][] = [
  [/\[\s*at\s*\]/gi, "@"],
  [/\(\s*at\s*\)/gi, "@"],
  [/\s+at\s+/gi, "@"],
  [/\[\s*dot\s*\]/gi, "."],
  [/\(\s*dot\s*\)/gi, "."],
  [/\s+dot\s+/gi, "."],
];

/\b(direktur|director|ceo|cto|coo|cfo|cmo|owner|founder|co-?founder|president|managing|manager|manajer|general manager|kepala|head of|vp|vice president|supervisor|admin|hrd|hr manager|procurement|purchasing|pemilik|principal|partner)\b/i;

const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/[A-Za-z0-9_%-]+/gi;
const INSTAGRAM_RE = /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/gi;
const TWITTER_RE = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+/gi;
const FACEBOOK_RE = /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.-]+/gi;

interface JsonLdRecord {
  "@type"?: unknown;
  "@graph"?: unknown[];
  name?: unknown;
  jobTitle?: unknown;
  employee?: unknown;
  founder?: unknown;
  member?: unknown;
}

const jsonLdRecordOf = (value: unknown): JsonLdRecord | null => (value !== null && typeof value === "object" ? (value as JsonLdRecord) : null);

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

function decodeCloudflareEmail(encoded: string): string | null {
  try {
    const key = Number.parseInt(encoded.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < encoded.length; i += 2) {
      out += String.fromCharCode(Number.parseInt(encoded.slice(i, i + 2), 16) ^ key);
    }
    return out.includes("@") ? out : null;
  } catch {
    return null;
  }
}

function isJunkEmail(email: string): boolean {
  const [local = "", domain = ""] = email.split("@");
  if (email.split("@").length !== 2) {
    return true;
  }
  if (local.length > 30 || local.length === 0) {
    return true;
  }
  if (!domain.includes(".")) {
    return true;
  }
  const tld = domain.split(".").pop() ?? "";
  if (!TOP_LEVEL_DOMAINS.has(tld.toLowerCase())) {
    return true;
  }
  if (JUNK_LOCAL_RE.test(local)) {
    return true;
  }
  const lower = email.toLowerCase();
  return JUNK_PATTERNS.some((p) => lower.includes(p));
}

export function extractEmails(html: string): { emails: string[]; mailtos: string[] } {
  const mailtos: string[] = [];
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const addr = decodeURIComponent(m[1] ?? "")
      .trim()
      .toLowerCase();
    if (addr.includes("@") && !isJunkEmail(addr)) {
      mailtos.push(addr);
    }
  }
  const cf: string[] = [];
  for (const m of html.matchAll(/data-cfemail="([0-9a-fA-F]+)"/g)) {
    const decoded = decodeCloudflareEmail(m[1] ?? "");
    if (decoded && !isJunkEmail(decoded)) {
      cf.push(decoded.toLowerCase());
    }
  }
  let text = html;
  for (const [re, repl] of OBFUSCATIONS) text = text.replace(re, repl);
  const found = new Set<string>([...mailtos, ...cf]);
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase().replace(/\.$/, "");
    if (!isJunkEmail(email)) {
      found.add(email);
    }
  }
  return { emails: [...found], mailtos };
}

export function extractPhones(html: string): { phones: string[]; whatsapp: string | null } {
  const waMatch = html.match(WHATSAPP_RE);
  const telHrefs = new Set<string>();
  for (const m of html.matchAll(/tel:([+0-9()\s.-]{7,20})/gi)) telHrefs.add((m[1] ?? "").trim());
  const text = html.replace(/<[^>]+>/g, " ");
  const phones = new Set<string>(telHrefs);
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0] ?? "";
    const digits = raw.replace(/[^0-9]/g, "");
    if (!/^(?:\+?62|0)8[1-9]/.test(digits.replace(/^\+/, "")) && !raw.startsWith("+")) {
      continue;
    }
    if (digits.length >= 9 && digits.length <= 14) {
      phones.add(raw.trim());
    }
  }
  const waDigits = waMatch ? (waMatch[1] ?? "").replace(/[^0-9]/g, "") : null;
  return { phones: [...phones].slice(0, 10), whatsapp: waDigits };
}

export function extractSocials(html: string): SiteCrawlResult["socials"] {
  const uniq = (re: RegExp): string[] => [...new Set([...html.matchAll(re)].map((m) => m[0].replace(/["'<].*$/, "")))];
  return {
    linkedin: uniq(LINKEDIN_RE).slice(0, 5),
    instagram: uniq(INSTAGRAM_RE).slice(0, 3),
    twitter: uniq(TWITTER_RE).slice(0, 3),
    facebook: uniq(FACEBOOK_RE).slice(0, 3),
  };
}

export function isCompanySelfName(candidate: string, pageHtml: string): boolean {
  const normTokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/&amp;/g, "&")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !/^(pt|cv|ud|tbk|persero|the|mebel|furniture|jepara|indonesia|official|shop|store|kayu|jati|wood|home|living)$/.test(t));
  const person = normTokens(candidate);
  if (person.length === 0) return true;

  const ogSiteName = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(pageHtml)?.[1];
  const titleTag = /<title[^>]*>([^<]+)<\/title>/i.exec(pageHtml)?.[1];
  const personNorm = person.join(" ");
  const jsonNameSources = [...pageHtml.matchAll(/"name"\s*:\s*"([^"]{3,80})"/g)].map((m) => m[1] ?? "").filter((v) => normTokens(v).join(" ") !== personNorm);
  const strongSources = [ogSiteName, titleTag].filter((v): v is string => Boolean(v));
  const weakSources = jsonNameSources.filter((v) => normTokens(v).length >= 2);

  for (const source of [...strongSources, ...weakSources]) {
    const brand = normTokens(source);
    if (brand.length === 0) continue;
    const overlap = brand.filter((t) => person.includes(t)).length;
    const threshold = strongSources.includes(source) ? 0.75 : 1;
    if (overlap / brand.length >= threshold) return true;
  }
  return false;
}

export function extractJsonLdPeople(html: string, sourceUrl: string): { name: string; title: string | null; sourceUrl: string }[] {
  const people: { name: string; title: string | null; sourceUrl: string }[] = [];
  const seen = new Set<string>();
  const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const script of scripts) {
    const body = script
      .replace(/^<script[^>]*>/i, "")
      .replace(/<\/script>$/i, "")
      .trim();
    if (!body) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      const graph = jsonLdRecordOf(node)?.["@graph"] ?? [];
      const objs: unknown[] = [node, ...graph];
      for (const obj of objs) {
        const record = jsonLdRecordOf(obj);
        if (!record) {
          continue;
        }
        for (const key of ["employee", "founder", "member"] as const) {
          const nested = record[key];
          if (Array.isArray(nested)) {
            objs.push(...nested);
          } else if (nested && typeof nested === "object") {
            objs.push(nested);
          }
        }
        const type = record["@type"];
        const typeStr = Array.isArray(type) ? type.join(",") : typeof type === "string" ? type : "";
        if (!/person|employee/i.test(typeStr)) {
          continue;
        }
        const name = typeof record.name === "string" ? record.name.trim() : "";
        if (!name || name.length < 5 || name.length > 60 || seen.has(name)) {
          continue;
        }
        if (isCompanySelfName(name, html)) {
          continue;
        }
        const jobTitle = typeof record.jobTitle === "string" ? record.jobTitle.trim() : null;
        seen.add(name);
        people.push({ name, title: jobTitle, sourceUrl });
        if (people.length >= 10) {
          return people;
        }
      }
    }
  }
  return people;
}
