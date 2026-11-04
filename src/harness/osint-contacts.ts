import { extractPhones, pageTextOf } from "@src/harness/contact-discovery";
import { extractContactsWithAi } from "@src/harness/contact-ai";
import { hasMailExchange } from "@src/harness/dns-cache";
import { fetchWebResults, type WebResult } from "@src/harness/websearch";

export interface OsintContactHarvest {
  emails: string[];
  phones: string[];
  whatsapp: string | null;
  sourceUrls: string[];
}

const OSINT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

const DIRECTORY_HINT =
  "(indotrading OR yellowpages OR infobis OR perusahaan OR daftarperusahaan OR caribisnis OR direktori OR " + '"company profile" OR profil) kontak email';

export async function harvestContactsFromSearch(companyName: string, website: string | null): Promise<OsintContactHarvest> {
  const domain =
    website
      ?.toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "") ?? null;
  const query = domain ? `"@${domain}" OR ("${companyName}" AND (email OR kontak OR "hubungi kami"))` : `"${companyName}" (email OR kontak OR "hubungi kami")`;
  const results = await fetchWebResults(query, 8).catch(() => []);

  let directoryResults: WebResult[] = [];
  const firstPass = await collectContactEvidence(companyName, domain, results);
  const needsDirectory = firstPass.emails.length === 0;
  if (needsDirectory) {
    directoryResults = await fetchWebResults(`"${companyName}" ${DIRECTORY_HINT}`, 6).catch(() => []);
  }

  const { emails, phones, whatsapp, sourceUrls } = await mergeDirectoryEvidence(companyName, domain, firstPass, directoryResults);
  return { emails, phones, whatsapp, sourceUrls };
}

async function collectContactEvidence(companyName: string, domain: string | null, results: WebResult[]) {
  if (results.length === 0)
    return { emails: [] as string[], phones: [] as string[], whatsapp: null as string | null, sourceUrls: [] as string[], pageTexts: [] as string[] };

  const pages = await Promise.allSettled(
    results.slice(0, 4).map(async (result) => {
      const res = await fetch(result.url, { signal: AbortSignal.timeout(8_000), headers: { "user-agent": OSINT_UA } });
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    }),
  );

  const pageTexts: string[] = [];
  const phones = new Set<string>();
  let whatsapp: string | null = null;
  const sourceUrls: string[] = [];
  for (let i = 0; i < results.length && i < 4; i += 1) {
    const page = pages[i];
    if (!page || page.status !== "fulfilled") continue;
    const html = page.value;
    pageTexts.push(pageTextOf(html));
    const { phones: pagePhones, whatsapp: pageWa } = extractPhones(html);
    for (const phone of pagePhones) phones.add(phone);
    if (!whatsapp && pageWa) whatsapp = pageWa;
    const result = results[i];
    if (!result) continue;
    sourceUrls.push(result.url);
  }

  const aiContacts = await extractContactsWithAi(companyName, pageTexts).catch(() => []);
  const emails = new Set<string>();
  for (const contact of aiContacts) {
    if (contact.email && (!domain || contact.email.endsWith(`@${domain}`))) emails.add(contact.email);
  }

  return { emails: [...emails].slice(0, 5), phones: [...phones].slice(0, 3), whatsapp, sourceUrls, pageTexts };
}

async function mergeDirectoryEvidence(
  companyName: string,
  domain: string | null,
  firstPass: Awaited<ReturnType<typeof collectContactEvidence>>,
  directoryResults: WebResult[],
): Promise<OsintContactHarvest> {
  if (directoryResults.length === 0) {
    return { emails: firstPass.emails, phones: firstPass.phones, whatsapp: firstPass.whatsapp, sourceUrls: firstPass.sourceUrls };
  }

  const pages = await Promise.allSettled(
    directoryResults.slice(0, 3).map(async (result) => {
      const res = await fetch(result.url, { signal: AbortSignal.timeout(8_000), headers: { "user-agent": OSINT_UA } });
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    }),
  );

  const pageTexts: string[] = [];
  const sourceUrls = [...firstPass.sourceUrls];
  for (let i = 0; i < directoryResults.length && i < 3; i += 1) {
    const page = pages[i];
    if (!page || page.status !== "fulfilled") continue;
    pageTexts.push(pageTextOf(page.value));
    const result = directoryResults[i];
    if (result) sourceUrls.push(result.url);
  }

  const aiContacts = await extractContactsWithAi(companyName, pageTexts).catch(() => []);
  const emails = new Set(firstPass.emails);
  for (const contact of aiContacts) {
    if (contact.email && (!domain || contact.email.endsWith(`@${domain}`) || !isWebmailLocal(contact.email))) emails.add(contact.email);
  }
  const phones = new Set(firstPass.phones);
  let whatsapp = firstPass.whatsapp;
  for (const contact of aiContacts) {
    if (contact.phone && phones.size < 3) phones.add(contact.phone);
    if (!whatsapp && contact.whatsapp) whatsapp = contact.whatsapp.replace(/[^0-9+]/g, "");
  }

  return { emails: [...emails].slice(0, 5), phones: [...phones].slice(0, 3), whatsapp, sourceUrls };
}

function isWebmailLocal(email: string): boolean {
  return /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|ymail)\./i.test(email);
}

export async function domainHasMailInfrastructure(domainRaw: string): Promise<boolean> {
  const domain = domainRaw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  if (!domain) return false;
  return hasMailExchange(domain);
}

export async function whatsappReachable(phoneRaw: string): Promise<boolean> {
  const digits = phoneRaw.replace(/[^0-9]/g, "").replace(/^0/, "62");
  if (digits.length < 10 || digits.length > 15) return false;
  try {
    const res = await fetch(`https://wa.me/${digits}`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8_000) });
    if (res.status === 404 || res.status === 410) return false;
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface PersonEmailEvidence {
  email: string;
  domain: string;
  sourceUrl: string;
  mentionsPerson: boolean;
}

const JUNK_EMAIL_LOCAL_RE = /^(no-?reply|donotreply|postmaster|abuse|webmaster|hostmaster|mailer|noreply)/i;

const EVIDENCE_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export async function harvestPersonEmailEvidence(companyName: string, personName: string, websiteDomain: string | null): Promise<PersonEmailEvidence[]> {
  const personTokens = personName
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const queries = [
    `"${personName}" "${companyName}" (email OR kontak OR contact)`,
    `"${personName}" "${companyName}" site:idnfinancials.com OR site:carisaham.com OR site:idx.co.id`,
  ];
  const evidence = new Map<string, PersonEmailEvidence>();

  for (const query of queries) {
    const results = await fetchWebResults(query, 8).catch(() => []);
    const pages = await Promise.allSettled(
      results.slice(0, 4).map(async (result) => {
        const res = await fetch(result.url, { signal: AbortSignal.timeout(8_000), headers: { "user-agent": OSINT_UA } });
        if (!res.ok) throw new Error(String(res.status));
        return { url: result.url, html: await res.text() };
      }),
    );

    for (const page of pages) {
      if (page.status !== "fulfilled") continue;
      const { url, html } = page.value;
      for (const match of html.matchAll(EVIDENCE_EMAIL_RE)) {
        const email = match[0].toLowerCase();
        const local = email.split("@")[0] ?? "";
        const domain = email.split("@")[1] ?? "";
        if (JUNK_EMAIL_LOCAL_RE.test(local)) continue;
        if (WEBMAIL_LOCAL.test(domain)) continue;
        if (websiteDomain && domain !== websiteDomain && domain.endsWith(`.${websiteDomain}`)) continue;
        const mentionsPerson = personTokens.some((token) => local.includes(token));
        const existing = evidence.get(email);
        if (existing && existing.mentionsPerson) continue;
        evidence.set(email, { email, domain, sourceUrl: url, mentionsPerson });
      }
    }
  }

  return [...evidence.values()].sort((a, b) => Number(b.mentionsPerson) - Number(a.mentionsPerson)).slice(0, 5);
}

const WEBMAIL_LOCAL = /gmail\.|yahoo\.|hotmail\.|outlook\.|icloud\./;
