import { Effect } from "effect";
import { ScraplingService, live as scraplingLive, scraplingHealthy } from "@src/harness/scrapling";
import { patchrightStealthFetch } from "@src/harness/stealth-fetch";
import { scraplingStealthChain } from "@src/harness/site-content";
import {
  inferEmailPattern,
  guessPersonalEmails,
  isRoleEmail,
  nameMatchesEmail,
  isPersonalLinkedInUrl,
  type EmailPatternGuess,
} from "@src/harness/site-crawl/email-patterns";
import { extractEmails, extractPhones, extractJsonLdPeople } from "@src/harness/site-crawl/extract";
import { extractContactsWithAi, type AiExtractedContact } from "@src/harness/contact-ai";

const scraplingChainMarkdown = (url: string): Promise<string | null> =>
  Effect.runPromise(Effect.provideService(scraplingStealthChain(url), ScraplingService, scraplingLive).pipe(Effect.orElseSucceed(() => null))).catch(
    () => null,
  );

export { verifyEmail, type EmailVerdict } from "@src/harness/site-crawl/email-verifier";
export { extractEmails, extractPhones, extractSocials, extractJsonLdPeople, isCompanySelfName } from "@src/harness/site-crawl/extract";
export {
  inferEmailPattern,
  guessPersonalEmails,
  isRoleEmail,
  nameMatchesEmail,
  isPersonalLinkedInUrl,
  type EmailPatternGuess,
} from "@src/harness/site-crawl/email-patterns";

export interface DiscoveredContact {
  name: string | null;
  title: string | null;
  email: string | null;
  emailConfidence: "observed" | "inferred" | "verified";
  emailPatternMethod: string | null;
  phone: string | null;
  whatsapp: string | null;
  linkedinUrl: string | null;
  sourceUrl: string;
}

export interface SiteCrawlResult {
  domain: string;
  pagesFetched: number;
  emails: string[];
  phones: string[];
  whatsapp: string | null;
  socials: { linkedin: string[]; instagram: string[]; twitter: string[]; facebook: string[] };
  people: { name: string; title: string | null; sourceUrl: string }[];
  emailsBySource: Map<string, string>;
  aiContacts: AiExtractedContact[];
}

const CONTACT_PATH_RE =
  /about|team|contact|kontak|impressum|profile|perusahaan|legal|company|people|staff|management|direksi|struktur|organisasi|organization|pimpinan|leadership|manajemen/i;

const ASSET_RE = /\.(png|jpe?g|gif|svg|css|js|ico|pdf|zip|woff2?|mp4|webp|xml|json)(\?|$)/i;

const GENERIC_DOMAINS = new Set([
  "waze.com",
  "google.com",
  "gmail.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "whatsapp.com",
  "tokopedia.com",
  "shopee.co.id",
  "bukalapak.com",
  "lazada.co.id",
  "lazada.com",
  "blibli.com",
  "alibaba.com",
  "aliexpress.com",
  "olx.co.id",
  "tiktok.com",
  "wordpress.com",
  "blogspot.com",
  "wix.com",
  "github.com",
]);

const SECOND_LEVEL_TLDS = new Set([
  "co",
  "or",
  "ac",
  "sch",
  "web",
  "go",
  "mil",
  "net",
  "org",
  "gov",
  "edu",
  "my",
  "biz",
  "info",
  "name",
  "shop",
  "media",
  "blog",
  "com",
  "id",
]);

function registrableDomainOf(hostname: string): string {
  const parts = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  if (parts.length <= 2) {
    return parts.join(".");
  }
  const candidate = parts[parts.length - 2]!;
  return SECOND_LEVEL_TLDS.has(candidate) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

function tokenSet(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/\b(pt|cv|tbk|persero|ud|pd|inc|ltd|llc|corp|co|company|group)\b/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

export function websiteMatchesCompany(website: string, companyName: string): boolean {
  try {
    const hostname = new URL(website).hostname.toLowerCase();
    const registrable = registrableDomainOf(hostname);
    if (GENERIC_DOMAINS.has(registrable)) {
      return false;
    }
    const domainTokens = new Set(
      registrable
        .replace(/\.(com|id|co|net|org|io|web).*$/, "")
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const nameTokens = tokenSet(companyName);
    if (nameTokens.size === 0) {
      return true;
    }
    for (const token of nameTokens) {
      for (const domainToken of domainTokens) {
        if (domainToken.startsWith(token) || token.startsWith(domainToken)) {
          return true;
        }
      }
    }
    return domainTokens.size === 0;
  } catch {
    return true;
  }
}

const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/[A-Za-z0-9_%-]+/gi;

const INSTAGRAM_RE = /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/gi;

const TWITTER_RE = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]+/gi;

const FACEBOOK_RE = /https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9_.-]+/gi;

const WHATSAPP_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?[0-9]{8,15})/i;

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

const JUNK_LOCAL_RE = /^[0-9a-f]{8,}$/;

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

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

async function fetchPage(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return await stealthFallback(url, res.status);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) {
      return null;
    }
    const text = await res.text();
    if (text.length < 5000 && !text.includes("<table")) {
      return await stealthFallback(url, res.status);
    }
    return text;
  } catch {
    return await stealthFallback(url, 0);
  }
}

let stealthAvailable: boolean | null = null;

let patchrightAvailable: boolean | null = null;

async function stealthFallback(url: string, directStatus: number): Promise<string | null> {
  if (directStatus !== 403 && directStatus !== 429 && directStatus !== 503 && directStatus !== 0 && directStatus !== 200) {
    return null;
  }
  if (stealthAvailable === null) {
    stealthAvailable = await scraplingHealthyProbe();
  }
  if (stealthAvailable) {
    const markdown = await scraplingChainMarkdown(url);
    if (markdown) {
      return markdown;
    }
  }
  if (patchrightAvailable === null) {
    const probe = await patchrightStealthFetch("https://example.com", { timeoutMs: 15_000 });
    patchrightAvailable = probe.html !== null;
  }
  if (!patchrightAvailable) {
    return null;
  }
  const page = await patchrightStealthFetch(url);
  return page.html ? page.html : null;
}

async function scraplingHealthyProbe(): Promise<boolean> {
  try {
    return await scraplingHealthy();
  } catch {
    return false;
  }
}

function sameDomain(href: string, base: string): boolean {
  try {
    const a = new URL(href, base);
    const b = new URL(base);
    return a.hostname === b.hostname || a.hostname.endsWith(`.${b.hostname.replace(/^www\./, "")}`);
  } catch {
    return false;
  }
}

const HTML_LINK_PRESERVE_RE = /<(?:a|link)\b[^>]*?\bhref="(mailto:[^"]*|tel:[^"]*|(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|whatsapp\.com)\/[^"]*)"[^>]*>/gi;

function preserveProtocolLinks(html: string): string {
  return html.replace(HTML_LINK_PRESERVE_RE, (_m, link: string) => ` ${decodeURIComponent(link.replace(/\s+/g, ""))} `);
}

export function pageTextOf(html: string): string {
  return preserveProtocolLinks(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function crawlCompanySite(
  startUrl: string,
  opts?: { maxPages?: number; maxDepth?: number; deadlineMs?: number; skipAiExtraction?: boolean },
): Promise<SiteCrawlResult> {
  const maxPages = opts?.maxPages ?? 12;
  const maxDepth = opts?.maxDepth ?? 2;
  const deadline = opts?.deadlineMs ? Date.now() + opts.deadlineMs : null;
  const outOfTime = () => deadline !== null && Date.now() > deadline;
  const base = new URL(startUrl);
  const domain = base.hostname.replace(/^www\./, "");

  const emailsBySource = new Map<string, string>();
  const phones = new Set<string>();
  const people = new Map<string, { name: string; title: string | null; sourceUrl: string }>();
  const socials: SiteCrawlResult["socials"] = { linkedin: [], instagram: [], twitter: [], facebook: [] };
  let whatsapp: string | null = null;

  const queue: { url: string; depth: number }[] = [{ url: base.origin, depth: 0 }];
  const seen = new Set<string>([base.origin.replace(/^http:/, "https:").replace(/\/\/www\./, "//")]);
  let pagesFetched = 0;
  const crawledPageTexts: string[] = [];

  const contactPriority: string[] = [];
  const deferred: string[] = [];

  while (queue.length > 0 && pagesFetched < maxPages && !outOfTime()) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    const { url, depth } = next;
    const html = await fetchPage(url);
    if (html === null) {
      continue;
    }
    pagesFetched += 1;
    crawledPageTexts.push(pageTextOf(html));

    const pagePhones = extractPhones(html);
    for (const p of pagePhones.phones) phones.add(p);
    if (whatsapp === null && pagePhones.whatsapp) {
      whatsapp = pagePhones.whatsapp;
    }

    for (const [key, re] of [
      ["linkedin", LINKEDIN_RE],
      ["instagram", INSTAGRAM_RE],
      ["twitter", TWITTER_RE],
      ["facebook", FACEBOOK_RE],
    ] as const) {
      for (const m of html.matchAll(re)) {
        const url2 = m[0].replace(/["'<].*$/, "");
        if (!socials[key].includes(url2) && socials[key].length < 5) {
          socials[key].push(url2);
        }
      }
    }

    for (const person of extractJsonLdPeople(html, url)) {
      if (!people.has(person.name)) {
        people.set(person.name, person);
      }
    }

    if (depth < maxDepth) {
      for (const m of html.matchAll(/href="([^"#]+)"/g)) {
        const href = (m[1] ?? "").trim();
        if (!href || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
          continue;
        }
        if (ASSET_RE.test(href)) {
          continue;
        }
        if (!sameDomain(href, url)) {
          continue;
        }
        try {
          const abs = new URL(href, url);
          abs.hash = "";
          const absStr = abs.toString();
          const canonicalKey = abs
            .toString()
            .replace(/^http:/, "https:")
            .replace(/\/\/www\./, "//");
          if (seen.has(canonicalKey)) {
            continue;
          }
          seen.add(canonicalKey);
          if (CONTACT_PATH_RE.test(abs.pathname)) {
            contactPriority.push(absStr);
          } else {
            deferred.push(absStr);
          }
        } catch {
          continue;
        }
      }
      if (contactPriority.length > 0) {
        for (const u of contactPriority.splice(0).slice(0, 6)) queue.push({ url: u, depth: depth + 1 });
      } else if (depth === 0) {
        for (const u of deferred.splice(0).slice(0, 4)) queue.push({ url: u, depth: depth + 1 });
      }
    }
  }

  const emails = [...emailsBySource.keys()];
  let aiContacts: AiExtractedContact[] = [];
  if (crawledPageTexts.length > 0 && !opts?.skipAiExtraction) {
    aiContacts = await extractContactsWithAi(domain, crawledPageTexts).catch(() => []);
    for (const contact of aiContacts) {
      if (contact.email && !emailsBySource.has(contact.email)) {
        emailsBySource.set(contact.email, `https://${domain} (ai-extracted)`);
      }
      if (contact.phone) phones.add(contact.phone);
      if (contact.whatsapp && !whatsapp) whatsapp = contact.whatsapp.replace(/[^0-9+]/g, "");
      if (contact.linkedinUrl && !socials.linkedin.includes(contact.linkedinUrl) && socials.linkedin.length < 5) {
        socials.linkedin.push(contact.linkedinUrl);
      }
    }
  }
  return {
    domain,
    pagesFetched,
    emails: [...emailsBySource.keys()],
    phones: [...phones],
    whatsapp,
    socials,
    people: [...people.values()],
    emailsBySource,
    aiContacts,
  };
}

export function buildDiscoveredContacts(crawl: SiteCrawlResult, personNameHints?: string[]): DiscoveredContact[] {
  const contacts: DiscoveredContact[] = [];
  const pattern = inferEmailPattern(crawl.domain, crawl.emails);
  const matchedPersonEmails = new Set<string>();

  for (const person of crawl.people) {
    const guessList = guessPersonalEmails(crawl.domain, person.name, pattern);
    let email: string | null = null;
    let confidence: DiscoveredContact["emailConfidence"] = "inferred";
    let method: string | null = pattern ? `pattern:${pattern}` : null;
    const bestGuess = guessList[0];
    if (bestGuess && crawl.emails.includes(bestGuess.email)) {
      email = bestGuess.email;
      confidence = "observed";
      method = `observed:${crawl.emailsBySource.get(email) ?? ""}`;
      matchedPersonEmails.add(email);
    }
    const title = person.title;
    contacts.push({
      name: person.name,
      title,
      email,
      emailConfidence: confidence,
      emailPatternMethod: method,
      phone: null,
      whatsapp: null,
      linkedinUrl: crawl.socials.linkedin[0] ?? null,
      sourceUrl: person.sourceUrl,
    });
    void personNameHints;
  }

  for (const email of crawl.emails) {
    if (matchedPersonEmails.has(email)) {
      continue;
    }
    const role = isRoleEmail(email);
    const guessFor = guessListForName(crawl, email, pattern);
    contacts.push({
      name: guessFor?.name ?? null,
      title: role ? "general/role inbox" : (guessFor?.title ?? null),
      email,
      emailConfidence: "observed",
      emailPatternMethod: `observed:${crawl.emailsBySource.get(email) ?? ""}`,
      phone: null,
      whatsapp: null,
      linkedinUrl: crawl.socials.linkedin[0] ?? null,
      sourceUrl: crawl.emailsBySource.get(email) ?? `https://${crawl.domain}`,
    });
  }

  for (const ai of crawl.aiContacts) {
    if (ai.email && contacts.some((c) => c.email === ai.email)) {
      continue;
    }
    if (!ai.email && ai.name && contacts.some((c) => c.name === ai.name)) {
      continue;
    }
    contacts.push({
      name: ai.name,
      title: ai.title,
      email: ai.email,
      emailConfidence: "observed",
      emailPatternMethod: ai.email ? "ai-extracted" : null,
      phone: ai.phone,
      whatsapp: ai.whatsapp,
      linkedinUrl: ai.linkedinUrl ?? crawl.socials.linkedin[0] ?? null,
      sourceUrl: `https://${crawl.domain}`,
    });
  }

  if (crawl.phones.length > 0 || crawl.whatsapp) {
    contacts.push({
      name: null,
      title: "company contact point",
      email: null,
      emailConfidence: "observed",
      emailPatternMethod: null,
      phone: crawl.phones[0] ?? null,
      whatsapp: crawl.whatsapp,
      linkedinUrl: null,
      sourceUrl: crawl.people[0]?.sourceUrl ?? `https://${crawl.domain}`,
    });
  }

  for (const person of crawl.people) {
    if (contacts.some((c) => c.name === person.name)) {
      continue;
    }
    contacts.push({
      name: person.name,
      title: person.title,
      email: null,
      emailConfidence: "inferred",
      emailPatternMethod: null,
      phone: null,
      whatsapp: null,
      linkedinUrl: null,
      sourceUrl: person.sourceUrl,
    });
  }

  return contacts;
}

function guessListForName(crawl: SiteCrawlResult, email: string, pattern: string | null): { name: string; title: string | null } | null {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.includes(".")) {
    const [first = "", last = ""] = local.split(".");
    for (const person of crawl.people) {
      const parts = person.name.toLowerCase().split(/\s+/);
      const personLast = parts[parts.length - 1] ?? "";
      if (first.length > 0 && last.length > 0 && (parts[0] ?? "").startsWith(first) && personLast.startsWith(last)) {
        return { name: person.name, title: person.title };
      }
    }
  }
  void pattern;
  return null;
}
