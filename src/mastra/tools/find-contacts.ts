import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { companies, contacts } from "@src/db/schema";
import { buildDiscoveredContacts, crawlCompanySite, guessPersonalEmails, inferEmailPattern, verifyEmail } from "@src/harness/contact-discovery";
import { fetchWebResults } from "@src/harness/websearch";
import { desc, ilike } from "drizzle-orm";
import { z } from "zod";

interface VerdictedContact {
  name: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
  whatsapp: string | null;
  linkedinUrl: string | null;
  sourceUrl: string;
  isDecisionMaker: boolean | null;
}

export const findContactsTool = createTool({
  id: "find-contacts",
  description:
    "Find real contact people at a company: crawls the company website (about/team/contact pages), extracts emails, phones, WhatsApp, LinkedIn, and people with job titles. Observed emails are returned as-is; pattern-inferred personal emails are SMTP-verified before inclusion with an explicit emailStatus. Prefer this over guessing contact details when the user asks who to contact at a company.",
  inputSchema: z.object({
    companyName: z.string().min(1),
    website: z.string().url().nullish().describe("Known website of the company; skipped discovery when provided"),
  }),

  execute: async (inputData) => {
    let site = inputData.website ?? null;
    if (!site) {
      const results = await fetchWebResults(inputData.companyName, 5);
      site = results[0]?.url ?? null;
      if (site && /google\.|duckduckgo\.|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|wikipedia\.org/.test(site)) {
        const second = results.find(
          (r) => !/google\.|duckduckgo\.|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|wikipedia\.org/.test(r.url),
        );
        site = second?.url ?? null;
      }
    }
    if (!site) {
      return { ok: false as const, error: `could not find a website for "${inputData.companyName}"` };
    }

    let baseUrl: string;
    try {
      const parsed = new URL(site.startsWith("http") ? site : `https://${site}`);
      baseUrl = `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      return { ok: false as const, error: `invalid website "${site}"` };
    }

    const crawl = await crawlCompanySite(baseUrl, { maxPages: 10, maxDepth: 2 });
    if (crawl.pagesFetched === 0) {
      return { ok: false as const, error: `website unreachable: ${baseUrl}` };
    }

    const discovered = buildDiscoveredContacts(crawl);
    const pattern = inferEmailPattern(crawl.domain, crawl.emails);

    const verdicted: VerdictedContact[] = [];
    let smtpBudget = 2;
    let unreachable: string | null = null;
    for (const contact of discovered) {
      let email = contact.email;
      let emailStatus: string | null = contact.emailConfidence === "observed" ? "observed" : null;

      if (!email && contact.name) {
        const guesses = guessPersonalEmails(crawl.domain, contact.name, pattern);
        const guess = guesses[0];
        if (guess) {
          if (unreachable) {
            emailStatus = `inferred-unverified:${unreachable}`;
          } else if (smtpBudget > 0) {
            smtpBudget -= 1;
            const verdict = await verifyEmail(guess.email, { timeoutMs: 8_000 });
            if (verdict.reason === "smtp_unreachable") unreachable = verdict.reason;
            if (verdict.valid) {
              email = guess.email;
              emailStatus = `verified:inferred-${guess.pattern}`;
            } else {
              emailStatus = `inferred-unverified:${verdict.reason}`;
            }
          } else {
            emailStatus = `inferred-candidate:${guess.pattern}`;
          }
        }
      }

      verdicted.push({
        name: contact.name,
        title: contact.title,
        email,
        emailStatus,
        phone: contact.phone,
        whatsapp: contact.whatsapp,
        linkedinUrl: contact.linkedinUrl,
        sourceUrl: contact.sourceUrl,
        isDecisionMaker: contact.title
          ? /direktur|director|ceo|cto|coo|cfo|owner|founder|president|general manager|manajer|manager|kepala|head of|pemilik/i.test(contact.title)
          : null,
      });
    }

    await persistDiscoveredContacts(inputData.companyName, baseUrl, verdicted);

    const withEmail = verdicted.filter((c) => c.email !== null);

    return {
      ok: true as const,
      company: inputData.companyName,
      website: baseUrl,
      pagesFetched: crawl.pagesFetched,
      contacts: verdicted,
      contactableCount: withEmail.length,
      socials: crawl.socials,
      note: withEmail.length === 0 ? "no published emails found; contacts carry phone/WhatsApp/LinkedIn or were named on team pages" : undefined,
    };
  },
});

async function persistDiscoveredContacts(companyName: string, website: string, verdicted: VerdictedContact[]): Promise<void> {
  const domain = new URL(website).hostname.replace(/^www\./, "");
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const companyDedupeKey = `${slug}|${domain}`;

  const existing = await db.select({ id: companies.id }).from(companies).where(ilike(companies.dedupeKey, companyDedupeKey)).limit(1);
  let companyId = existing[0]?.id;
  if (!companyId) {
    const inserted = await db
      .insert(companies)
      .values({ dedupeKey: companyDedupeKey, name: companyName, website, fieldProvenance: { source: "find-contacts-tool", at: new Date().toISOString() } })
      .onConflictDoNothing({ target: companies.dedupeKey })
      .returning({ id: companies.id });
    companyId = inserted[0]?.id;
    if (!companyId) {
      const again = await db.select({ id: companies.id }).from(companies).where(ilike(companies.dedupeKey, companyDedupeKey)).limit(1);
      companyId = again[0]?.id;
    }
  }
  if (!companyId) return;

  const provenance = { stage: "find-contacts-tool", website, at: new Date().toISOString() };
  for (const contact of verdicted) {
    const identity = contact.linkedinUrl ?? contact.email ?? (contact.phone ? `phone:${contact.phone}` : contact.name ? `name:${contact.name}` : null);
    if (!identity) continue;
    const dedupeKey = `${companyDedupeKey}|contact|${identity.toLowerCase().replace(/[^a-z0-9.:@/-]+/g, "-")}`;
    await db
      .insert(contacts)
      .values({
        dedupeKey,
        companyId,
        name: contact.name,
        title: contact.title,
        email: contact.email,
        emailType: contact.emailStatus?.startsWith("verified") ? "verified-personal" : contact.isDecisionMaker ? "personal" : "role",
        phone: contact.phone,
        whatsapp: contact.whatsapp,
        linkedinUrl: contact.linkedinUrl,
        isDecisionMaker: contact.isDecisionMaker,
        raw: contact,
        fieldProvenance: { contact: provenance },
      })
      .onConflictDoUpdate({
        target: contacts.dedupeKey,
        set: {
          name: contact.name,
          title: contact.title,
          email: contact.email,
          phone: contact.phone,
          whatsapp: contact.whatsapp,
          linkedinUrl: contact.linkedinUrl,
          isDecisionMaker: contact.isDecisionMaker,
          raw: contact,
          fieldProvenance: { contact: provenance },
        },
      });
  }
}
