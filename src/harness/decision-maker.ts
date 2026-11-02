import { fetchWebResults } from "@src/harness/websearch";
import { personExtractorAgent } from "@src/mastra";
import { personMentionSchema, type PersonMentionResult } from "@src/harness/schemas";

export interface WebDecisionMaker {
  name: string | null;
  title: string | null;
  linkedinUrl: string | null;
  sourceUrl: string;
  isDecisionMaker: boolean;
}

const DECISION_MAKER_RE = /\b(owner|founder|ceo|director|co-?founder|pemilik|direktur|komisaris|owner)\b/i;
const LINKEDIN_URL_RE = /https?:\/\/[a-z.]*(?:linkedin\.com)\/in\/[^\s"'<>)]+/i;

function isCompanySelfMention(candidate: string, companyName: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !/^(pt|cv|ud|tbk|persero)$/.test(t));
  const person = new Set(norm(candidate));
  const company = norm(companyName);
  if (company.length === 0 || person.size === 0) return true;
  const overlap = company.filter((t) => person.has(t)).length;
  return overlap / company.length >= 0.8;
}

export async function extractPeopleFromSiteText(companyName: string, siteContent: string | null): Promise<PersonMentionResult["people"]> {
  if (!siteContent || siteContent.length < 200) return [];
  const text = siteContent
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24_000);
  if (text.length < 200) return [];
  const prompt = [`Target company: "${companyName}"`, "Source: the company's own website text.", "", "Website text:", text].join("\n");
  const result = await personExtractorAgent.generate(prompt, {
    structuredOutput: {
      schema: personMentionSchema,
      jsonPromptInjection: true,
      errorStrategy: "fallback",
      fallbackValue: { people: [] },
    },
  });
  return (result.object?.people ?? []).filter((p): p is NonNullable<typeof p> => Boolean(p) && typeof p.name === "string" && p.name.length >= 2);
}

export async function findDecisionMakersOnWeb(companyName: string, city: string | null, limit = 5): Promise<WebDecisionMaker[]> {
  const quoted = `"${companyName}"`;
  const cityPart = city ? ` "${city}"` : "";
  const templates = [
    `${quoted}${cityPart} (founder OR owner OR pemilik OR direktur OR "direktur utama")`,
    `${quoted} site:linkedin.com/in`,
    `${quoted} ("human resources" OR "HRD" OR "hr manager" OR rekrutmen OR "human capital" OR procurement OR purchasing OR pengadaan)`,
    `${quoted} ("menurut" OR "diungkap" OR "kata" OR "dikatakan" OR "diangkat menjadi")`,
    `${quoted} (tender OR pengadaan OR lelang OR "pemenang tender")`,
    `${quoted} (asosiasi OR kadin OR hipmi OR apindo OR anggota OR pengurus OR ketua)`,
    `${quoted} ("struktur organisasi" OR manajemen OR direksi OR "tim kami" OR pimpinan)`,
  ];
  const startIndex = hashLead(companyName) % templates.length;
  const selected: string[] = [];
  for (let i = 0; i < templates.length && selected.length < 2; i += 1) {
    const template = templates[(startIndex + i) % templates.length];
    if (template) selected.push(template);
  }

  const found: WebDecisionMaker[] = [];
  const seenNames = new Set<string>();
  const seenUrls = new Set<string>();

  for (const query of selected) {
    const results = await fetchWebResults(query, 8).catch(() => []);
    const usable = results.filter((result) => DECISION_MAKER_RE.test(`${result.title} ${result.snippet ?? ""}`));
    if (usable.length === 0) continue;

    const mentions = await extractPeopleWithLlm(companyName, usable).catch(() => []);
    if (mentions.length === 0) continue;

    for (const mention of mentions) {
      if (!mention.name || seenNames.has(mention.name.toLowerCase())) continue;
      if (isCompanySelfMention(mention.name, companyName)) continue;
      const sourceIdxs = mention.sourceIndexes ?? [];
      const linkedinUrl =
        sourceIdxs
          .map((idx) => usable[idx])
          .map((result) =>
            result
              ? (LINKEDIN_URL_RE.exec(`${result.title} ${result.snippet ?? ""}`)?.[0] ?? (result.url.includes("linkedin.com/in/") ? result.url : null))
              : null,
          )
          .find((url): url is string => Boolean(url)) ?? null;
      if (linkedinUrl && seenUrls.has(linkedinUrl.toLowerCase())) continue;
      seenNames.add(mention.name.toLowerCase());
      if (linkedinUrl) seenUrls.add(linkedinUrl.toLowerCase());
      const firstSource = sourceIdxs.map((idx) => usable[idx]).find((r): r is NonNullable<typeof r> => Boolean(r));
      found.push({
        name: mention.name,
        title: mention.role ?? null,
        linkedinUrl,
        sourceUrl: firstSource?.url ?? "",
        isDecisionMaker: true,
      });
      if (found.length >= limit) return found;
    }
  }

  return found;
}

async function extractPeopleWithLlm(
  companyName: string,
  results: { title: string; snippet: string | null; url: string }[],
): Promise<PersonMentionResult["people"]> {
  const payload = results.map((result, index) => ({ index, title: result.title, snippet: result.snippet ?? "" }));
  const prompt = [`Target company: "${companyName}"`, "", "Search results:", JSON.stringify(payload)].join("\n");
  const result = await personExtractorAgent.generate(prompt, {
    structuredOutput: {
      schema: personMentionSchema,
      jsonPromptInjection: true,
      errorStrategy: "fallback",
      fallbackValue: { people: [] },
    },
  });
  return (result.object?.people ?? []).filter((p): p is NonNullable<typeof p> => Boolean(p) && typeof p.name === "string" && p.name.length >= 2);
}

function hashLead(companyName: string): number {
  let hash = 0;
  for (let i = 0; i < companyName.length; i += 1) {
    hash = (hash * 31 + companyName.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export interface PersonCorroboration {
  sourceDomain: string;
  quote: string;
  at: string;
}

function registrableDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const parts = host.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}

export function nameCoOccursWithCompany(name: string, companyName: string, text: string): boolean {
  const nameTokens = name
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const companyTokens = companyName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !/^(pt|cv|ud|tbk|persero)$/.test(t));
  if (nameTokens.length === 0 || companyTokens.length === 0) return false;
  const lower = text.toLowerCase();
  for (const companyToken of companyTokens) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(companyToken, from);
      if (idx < 0) break;
      from = idx + 1;
      const window = lower.slice(Math.max(0, idx - 120), idx + 120);
      const givenHit = nameTokens.some((t) => window.includes(t));
      const surnameHit = nameTokens.length >= 2 && nameTokens.slice(1).some((t) => window.includes(t));
      if (givenHit && (surnameHit || nameTokens.length === 1)) return true;
    }
  }
  return false;
}

export async function verifyPerson(
  companyName: string,
  person: { name: string | null; title: string | null; linkedinUrl: string | null },
  sources: { url: string; quote: string }[],
): Promise<{ independentDomains: number; corroborations: PersonCorroboration[] }> {
  if (!person.name) return { independentDomains: 0, corroborations: [] };
  const corroborations: PersonCorroboration[] = [];
  const domains = new Set<string>();
  for (const source of sources) {
    const domain = registrableDomain(source.url);
    if (!domain) continue;
    if (!nameCoOccursWithCompany(person.name, companyName, source.quote)) continue;
    if (domains.has(domain)) continue;
    domains.add(domain);
    corroborations.push({ sourceDomain: domain, quote: source.quote.slice(0, 300), at: new Date().toISOString() });
    if (corroborations.length >= 5) break;
  }
  return { independentDomains: domains.size, corroborations };
}
