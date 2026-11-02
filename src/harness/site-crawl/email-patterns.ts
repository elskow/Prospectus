const ROLE_PREFIXES = ["info", "admin", "contact", "sales", "support", "hello", "hrd", "marketing", "office", "cs", "cs@"];

export interface EmailPatternGuess {
  email: string;
  pattern: string;
  confidence: number;
}

export function inferEmailPattern(domain: string, observedEmails: string[]): string | null {
  const locals = observedEmails.filter((e) => e.endsWith(`@${domain}`)).map((e) => e.split("@")[0] ?? "");
  const personal = locals.filter((l) => !ROLE_PREFIXES.includes(l.toLowerCase()));
  if (personal.length === 0) {
    return null;
  }
  const dotted = personal.find((l) => l.includes("."));
  if (dotted) {
    {
    }
    const parts = dotted.split(".");
    if (parts.length === 2) {
      {
      }
      if (parts[0]?.length === 1) {
        return "f.last";
      }
      if (parts[1]?.length === 1) {
        return "first.l";
      }
      return "first.last";
    }
  }
  const longLocal = personal.find((l) => l.length >= 5 && /^[a-z]+$/.test(l));
  if (longLocal && personal.some((l) => l !== longLocal && !l.startsWith(longLocal[0] ?? ""))) {
    return "flast";
  }
  return "first";
}

export function guessPersonalEmails(domain: string, personName: string, pattern: string | null): EmailPatternGuess[] {
  if (!pattern || pattern === "first") {
    return [];
  }
  const parts = personName
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((p): p is string => p.length > 0);
  if (parts.length < 2) {
    return [];
  }
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  const guesses: EmailPatternGuess[] = [];
  if (pattern === "first.last") {
    guesses.push({ email: `${first}.${last}@${domain}`, pattern, confidence: 0.55 });
  }
  if (pattern === "flast") {
    guesses.push({ email: `${first}${last}@${domain}`, pattern, confidence: 0.45 });
  }
  if (pattern === "f.last") {
    guesses.push({ email: `${first[0]}.${last}@${domain}`, pattern, confidence: 0.4 });
  }
  if (pattern === "first.l") {
    guesses.push({ email: `${first}.${last[0]}@${domain}`, pattern, confidence: 0.4 });
  }
  return guesses;
}

const LINKEDIN_NON_PERSONAL_SLUG_RE = /^(pt|cv|ud)[^a-z]?[-_.0-9]|^(pt|cv|ud)[a-z]{3,}|[-_.](pt|cv|ud)$|^(about|jobs|posts|pulse|company|school|pub)$/i;

export function isPersonalLinkedInUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  const match = /linkedin\.com\/(in|company|pub|school)\/([^/?#\s]+)/i.exec(url);
  if (!match) {
    return false;
  }
  if (match[1]?.toLowerCase() !== "in") {
    return false;
  }
  const slug = match[2] ?? "";
  if (!/^[a-z0-9][a-z0-9-%.-]+$/i.test(slug) || !/[a-z]/i.test(slug)) {
    return false;
  }
  if (/^(\d+[a-z]?-){2,}/i.test(slug) && /^[a-z]/i.test(slug)) {
    const words = slug.split("-");
    if (words.length >= 2 && words.every((w) => w && !NON_PERSONAL_WORD_RE.test(w))) {
      return true;
    }
  }
  return !LINKEDIN_NON_PERSONAL_SLUG_RE.test(slug);
}

const NON_PERSONAL_WORD_RE = /^(pt|cv|ud)$/i;

export function isRoleEmail(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (ROLE_PREFIXES.includes(local)) {
    return true;
  }
  return ROLE_PREFIXES.some((p) => local.startsWith(`${p}.`) || (local.startsWith(p) && local.length <= p.length + 3));
}

export function nameMatchesEmail(name: string, email: string): boolean {
  const local =
    email
      .split("@")[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, "") ?? "";
  if (!local) {
    return false;
  }
  const parts = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return false;
  }
  const joined = parts.join("");
  if (local === joined) {
    return true;
  }
  if (local.startsWith(parts[0] ?? "") && local.endsWith(parts[parts.length - 1] ?? "")) {
    return true;
  }
  if (local.length >= 4 && parts.some((p) => p.length >= 3 && local.includes(p))) {
    return true;
  }
  return false;
}
