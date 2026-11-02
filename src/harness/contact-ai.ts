import { contactExtractorAgent } from "@src/mastra";
import { pageContactExtractionSchema, type PageContactExtraction } from "@src/harness/schemas";

export interface AiExtractedContact {
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  linkedinUrl: string | null;
}

const MAX_TEXT_CHARS = 60_000;

function appearsInText(value: string, haystack: string): boolean {
  const raw = value.replace(/\s+/g, " ").trim();
  if (raw.length < 5) return false;
  if (haystack.includes(raw)) return true;
  return raw.length >= 8 && haystack.replace(/\s+/g, "").includes(raw.replace(/\s+/g, ""));
}

const PLACEHOLDER_RE = /example\.(com|org)|domain\.com|your(domain|name|email)|sentry|wixpress|no-?reply|donotreply|user@|test@/i;

function acceptableEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && !PLACEHOLDER_RE.test(email);
}

export async function extractContactsWithAi(companyName: string, pageTexts: string[]): Promise<AiExtractedContact[]> {
  const usable = pageTexts.filter((t): t is string => Boolean(t && t.trim().length >= 40));
  if (usable.length === 0) return [];

  const text = usable.join("\n\n---\n\n").slice(0, MAX_TEXT_CHARS);

  const result = await contactExtractorAgent.generate<PageContactExtraction>(
    [`Target company: "${companyName}"`, "The text below is raw page content from the company's website.", "", "Page text:", text].join("\n"),
    {
      structuredOutput: {
        schema: pageContactExtractionSchema,
        jsonPromptInjection: true,
        errorStrategy: "fallback",
        fallbackValue: { contacts: [] },
      },
    },
  );

  const emitted = result.object?.contacts ?? [];
  const verified: AiExtractedContact[] = [];
  const seenEmails = new Set<string>();

  for (const contact of emitted) {
    if (!contact) continue;

    const email = contact.email?.toLowerCase().trim() ?? null;
    if (email && (!appearsInText(email, text) || !acceptableEmail(email))) continue;
    if (email && seenEmails.has(email)) continue;
    if (email) seenEmails.add(email);

    const phone = contact.phone?.trim() ?? null;
    if (phone && !appearsInText(phone, text)) continue;

    const whatsapp = contact.whatsapp?.trim() ?? null;
    if (whatsapp && !appearsInText(whatsapp, text)) continue;

    const linkedinUrl = contact.linkedinUrl?.trim() ?? null;
    if (linkedinUrl && (!/^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(linkedinUrl) || !appearsInText(linkedinUrl, text))) continue;

    const name = contact.name?.trim() ?? null;
    if (name && !appearsInText(name, text)) continue;

    if (!email && !phone && !whatsapp && !linkedinUrl) continue;

    verified.push({
      name: name || null,
      title: contact.title?.trim() || null,
      email,
      phone,
      whatsapp,
      linkedinUrl,
    });
  }

  return verified.slice(0, 10);
}
