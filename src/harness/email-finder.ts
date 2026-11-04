import { hasMailExchange } from "@src/harness/dns-cache";

export interface FoundEmail {
  email: string;
  source: "site" | "pattern";
  confidence: number;
  role: string | null;
  discoveryMethod: "observed" | "pattern-inferred";
}

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MAILTO_REGEX = /mailto:([^"'>\s?]+)/gi;
const JUNK_LOCAL = /noreply|no-reply|donotreply|privacy|gdpr|sentry|wixpress|cloudflare|unsubscribe|abuse|postmaster|hostmaster|example|smtp|mailer-daemon/;
const JUNK_DOMAIN = /^(example\.(com|org|net)|test\.com|domain\.com|email\.com|yourdomain\.(com|org))$/;
const IMAGE_LOCAL_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?)$/;
const ROLE_LOCAL =
  /^(info|contact|sales|admin|hrd|hr|marketing|office|hello|halo|cs|support|service|customerservice|customercare|enquiry|inquiry|general|humas|sekretariat|purchasing|procurement|corsec|legal|finance|accounting|billing|partner|career|recruit|lowongan)/;
const SITE_CONFIDENCE = 0.9;
const PATTERN_CONFIDENCE = 0.6;
const MAX_PATTERN_CANDIDATES = 4;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

const WEBMAIL_DOMAINS =
  /^(gmail\.com|googlemail\.com|yahoo\.(com|co\.id|co\.uk)|hotmail\.(com|co\.id)|outlook\.com|live\.com|aol\.com|icloud\.com|ymail\.com)$/;

function isJunk(email: string): boolean {
  const [local, domain] = email.split("@");
  if (!local || !domain) return true;
  if (local.length < 2 || domain.length < 4) return true;
  if (JUNK_LOCAL.test(local)) return true;
  if (JUNK_DOMAIN.test(domain)) return true;
  if (IMAGE_LOCAL_EXT.test(local)) return true;
  return false;
}

function roleOf(email: string): string | null {
  const local = email.split("@")[0] ?? "";
  const match = local.match(ROLE_LOCAL);
  return match?.[1] ?? null;
}

function registrableOf(domain: string): string {
  const parts = domain
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : domain;
}

function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function asciiToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

export function patternCandidatesFor(name: string, domain: string): string[] {
  const tokens = name.trim().split(/\s+/).map(asciiToken).filter(Boolean);
  const first = tokens[0];
  if (!first) return [];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : null;

  const locals = [first];
  if (last) {
    locals.push(`${first}.${last}`, last, `${first[0]}${last}`, `${first[0]}.${last}`);
  }

  const candidates: string[] = [];
  for (const local of locals) {
    const email = `${local}@${domain}`;
    if (!candidates.includes(email)) candidates.push(email);
    if (candidates.length >= MAX_PATTERN_CANDIDATES) break;
  }
  return candidates;
}

export async function findEmails(input: { siteContent: string | null; website: string | null; contactName?: string | null }): Promise<FoundEmail[]> {
  const found = new Map<string, FoundEmail>();

  if (input.siteContent) {
    const raw: string[] = [];
    for (const match of input.siteContent.matchAll(MAILTO_REGEX)) {
      if (match[1]) raw.push(match[1]);
    }
    for (const match of input.siteContent.matchAll(EMAIL_REGEX)) {
      if (match[0]) raw.push(match[0]);
    }
    for (const value of raw) {
      const email = normalizeEmail(value);
      if (isJunk(email) || found.has(email)) continue;
      const emailDomain = email.split("@")[1] ?? "";
      if (input.website && !WEBMAIL_DOMAINS.test(emailDomain)) {
        const siteDomain = domainOf(input.website);
        if (siteDomain && registrableOf(emailDomain) !== registrableOf(siteDomain)) continue;
      }
      found.set(email, { email, source: "site", confidence: SITE_CONFIDENCE, role: roleOf(email), discoveryMethod: "observed" });
    }
  }

  const domain = domainOf(input.website);
  const contactName = input.contactName?.trim() || null;
  if (domain && contactName) {
    const hasMx = await hasMailExchange(domain);
    if (hasMx) {
      for (const email of patternCandidatesFor(contactName, domain)) {
        if (isJunk(email) || found.has(email)) continue;
        found.set(email, { email, source: "pattern", confidence: PATTERN_CONFIDENCE, role: null, discoveryMethod: "pattern-inferred" });
      }
    }
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}
