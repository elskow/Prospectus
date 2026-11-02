import { createHash } from "node:crypto";
import { Effect } from "effect";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@src/db";
import { campaigns, companies, leads } from "@src/db/schema";
import { discoverCompanyPeople } from "@src/plugins/builtin/linkedin";
import { domainHasMailInfrastructure } from "@src/harness/osint-contacts";
import { extractEmails, extractPhones, isRoleEmail, nameMatchesEmail, pageTextOf, verifyEmail, websiteMatchesCompany } from "@src/harness/contact-discovery";
import { extractContactsWithAi, type AiExtractedContact } from "@src/harness/contact-ai";
import { fetchDeepSiteContent } from "@src/harness/site-content";
import { lookupExhibitorContact } from "@src/harness/exhibitor-dirs";
import { backfillNamedContactEmails } from "@src/harness/email-backfill";
import {
  companyHasContact,
  companyHasEmail,
  isGenericCompanyName,
  matchesExclusions,
  upsertCrawledContacts,
  upsertDecisionMakerContacts,
  promoteReadyLeads,
} from "@src/harness/persistence";
import { findEmails } from "@src/harness/email-finder";
import type { LeadCandidate } from "@src/harness/schemas";
import type { StageSampling } from "@src/harness/stages";
import type { LinkedInCredentials } from "@src/harness/research-deps";
import { defaultResearchDeps } from "@src/harness/goal-loop/research";
import { recordFailure, type RunCost, type RunPorts } from "@src/harness/goal-loop/context";
import type { RunFailure } from "@src/harness/goal-loop/types";
import type { HarnessTracer } from "@src/harness/tracer";

export async function campaignExclusionsOf(campaignId: string): Promise<string[]> {
  const [row] = await db.select({ exclusions: campaigns.exclusions }).from(campaigns).where(eq(campaigns.id, campaignId));
  return row?.exclusions ?? [];
}

interface FoundLead {
  leadId: string;
  companyId: string;
  dedupeKey: string;
}

async function findLeadForCandidate(campaignId: string, candidate: LeadCandidate): Promise<FoundLead | null> {
  const { dedupeKeyFor } = await import("@src/harness/persistence");
  const [row] = await db
    .select({ leadId: leads.id, companyId: companies.id, dedupeKey: companies.dedupeKey })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(leads.campaignId, campaignId), eq(companies.dedupeKey, dedupeKeyFor(candidate))));
  return row ?? null;
}

export const harvestOneCandidate = Effect.fnUntraced(function* (input: {
  readonly ports: RunPorts;
  readonly cost: RunCost;
  readonly tracer: HarnessTracer;
  readonly sourceId: string | null;
  readonly candidate: LeadCandidate;
  readonly exclusions: string[];
  readonly siteContentCache: Map<string, string | null>;
  readonly errors: RunFailure[];
  readonly sampling: StageSampling;
  readonly onReady: () => void;
}): Effect.fn.Return<void> {
  const { ports, cost, candidate, sampling, tracer } = input;
  const deps = ports.deps;
  const research = deps.research ?? defaultResearchDeps;
  const emit = (message: string): void => {
    ports.emit({ stage: "harvest", message });
  };

  if (isGenericCompanyName(candidate.name)) {
    emit(`generic name, skipped "${candidate.name}"`);
    return;
  }
  if (matchesExclusions(candidate, input.exclusions)) {
    emit(`excluded type, skipped "${candidate.name}"`);
    return;
  }

  const found = yield* Effect.promise(() => findLeadForCandidate(ports.options.campaignId, candidate));
  if (!found) return;

  if (yield* Effect.promise(() => companyHasEmail(found.companyId))) {
    emit(`skip "${candidate.name}" — email already on file`);
    return;
  }

  const MARKETPLACE_RE = /(?:lazada|shopee|tokopedia|blibli|bukalapak|alibaba|aliexpress|olx|tiktok|instacart|amazon\.co\.id|walmart|etsy)/i;

  let website: string | null = candidate.website ?? null;
  if (!website) {
    const discovered = yield* Effect.promise(() => research.findWebsite(candidate).catch(() => null));
    if (discovered) {
      const isMarketplaceUrl = MARKETPLACE_RE.test(discovered);
      if (!isMarketplaceUrl && websiteMatchesCompany(discovered, candidate.name)) {
        website = discovered;
        yield* Effect.promise(() =>
          db
            .update(companies)
            .set({ website, updatedAt: new Date() })
            .where(eq(companies.id, found.companyId))
            .catch(() => {}),
        );
        emit(`website found for "${candidate.name}": ${website}`);
      } else {
        emit(`skipping implausible website "${discovered}" for "${candidate.name}"`);
      }
    }
  }

  const alreadyHasContact = yield* Effect.promise(() => companyHasContact(found.companyId));

  if (!alreadyHasContact) {
    const exhibitor = yield* Effect.promise(() => lookupExhibitorContact(candidate.name).catch(() => null));
    if (exhibitor?.email) {
      const exhibitorEmail = exhibitor.email;
      const saved = yield* Effect.promise(() =>
        upsertCrawledContacts({
          companyDedupeKey: found.dedupeKey,
          companyId: found.companyId,
          runId: input.ports.runId,
          people: [
            {
              name: null,
              title: "exhibitor directory",
              email: exhibitorEmail,
              emailType: isRoleEmail(exhibitorEmail) ? "role" : "personal",
              phone: exhibitor.phone,
              whatsapp: null,
              linkedinUrl: null,
            },
          ],
        }).catch(() => 0),
      );
      if (saved > 0) emit(`email from exhibitor directory for "${candidate.name}" (${exhibitorEmail})`);
    }
  }

  let siteContent: string | null = null;
  if (website && !alreadyHasContact && !input.siteContentCache.has(found.leadId)) {
    const deep = yield* Effect.promise(() => fetchDeepSiteContent(website, 12_000));
    siteContent = deep.content;
    input.ports.state.cacheContent(found.leadId, siteContent);

    if (siteContent) {
      const siteText = pageTextOf(siteContent) || siteContent;
      const aiContacts = yield* Effect.promise(() => extractContactsWithAi(candidate.name, [siteText]).catch(() => [] as AiExtractedContact[]));
      const aiEmails = [...new Set(aiContacts.map((c) => c.email).filter((e): e is string => Boolean(e)))].slice(0, 5);
      const pdfEmails = [...new Set([...aiEmails, ...extractEmails(siteContent).emails].map((e) => e.toLowerCase()))].slice(0, 5);
      const phones = extractPhones(siteContent);
      for (const ai of aiContacts.filter((c) => (c.phone || c.whatsapp) && !c.email)) {
        if (ai.phone && !phones.phones.includes(ai.phone)) phones.phones.push(ai.phone);
        if (ai.whatsapp && !phones.whatsapp) phones.whatsapp = ai.whatsapp.replace(/[^0-9+]/g, "");
      }
      if (pdfEmails.length > 0 || phones.phones.length > 0 || phones.whatsapp) {
        const mailLive = pdfEmails.some((e) => !isRoleEmail(e)) ? yield* Effect.promise(() => domainHasMailInfrastructure(website).catch(() => false)) : false;
        const saved = yield* Effect.promise(() =>
          upsertCrawledContacts({
            companyDedupeKey: found.dedupeKey,
            companyId: found.companyId,
            runId: ports.runId,
            people: [
              ...pdfEmails.map((email) => ({
                name: null,
                title: isRoleEmail(email) ? "general/role inbox" : "website",
                email,
                emailType: (isRoleEmail(email) ? "role" : mailLive ? "personal" : null) as "role" | "personal" | null,
                phone: null,
                whatsapp: null,
                linkedinUrl: null,
              })),
              ...(phones.phones.length > 0 || phones.whatsapp
                ? [
                    {
                      name: null,
                      title: "website",
                      email: null,
                      emailType: null,
                      phone: phones.phones[0] ?? null,
                      whatsapp: phones.whatsapp,
                      linkedinUrl: null,
                    },
                  ]
                : []),
            ],
          }).catch(() => 0),
        );
        if (saved > 0) emit(`${saved} contacts from website of "${candidate.name}"`);
      }

      const people = yield* Effect.promise(() => crawlPeopleFromSite(website, siteContent, candidate.name));
      if (people.length > 0) {
        const savedPeople = yield* Effect.promise(() =>
          upsertDecisionMakerContacts({
            companyDedupeKey: found.dedupeKey,
            companyId: found.companyId,
            people: people.slice(0, 5),
          }).catch(() => 0),
        );
        if (savedPeople > 0) emit(`${savedPeople} people from site of "${candidate.name}"`);
      }
    }
  }

  const hasContactNow = yield* Effect.promise(() => companyHasContact(found.companyId));

  if (!hasContactNow) {
    const creds = linkedinCredsOf(deps.sources);
    const people = yield* Effect.promise(() => decisionMakerDiscovery(candidate, found, creds, research, emit, input.errors));
    if (people.length > 0) {
      yield* Effect.promise(() =>
        upsertDecisionMakerContacts({
          companyDedupeKey: found.dedupeKey,
          companyId: found.companyId,
          people: people.slice(0, 3),
        }).catch(() => 0),
      );
    }
    const hasAfterDm = yield* Effect.promise(() => companyHasContact(found.companyId));
    if (!hasAfterDm && website) {
      yield* Effect.promise(() => fillEmailFromFinder(found, website, siteContent, people, emit, input.errors));
    }
  }

  if (website) {
    yield* Effect.promise(() =>
      backfillNamedContactEmails({ companyId: found.companyId, companyName: candidate.name, website }, tracer, (stage, message) => emit(message)).catch(
        () => 0,
      ),
    );
  }

  const promoted = yield* Effect.promise(() => promoteReadyLeads(ports.options.campaignId).catch(() => 0));
  if (promoted > 0) {
    input.onReady();
    emit(`+${promoted} prospect rows ready for "${candidate.name}" and peers`);
  }
});

async function crawlPeopleFromSite(
  website: string,
  siteContent: string | null,
  companyName: string,
): Promise<{ name: string | null; title: string | null; linkedinUrl: string | null }[]> {
  const { crawlCompanySite } = await import("@src/harness/contact-discovery");
  if (!website) return [];
  try {
    const crawl = await crawlCompanySite(website, { maxPages: 4, maxDepth: 1, deadlineMs: 45_000 });
    const structured = crawl.people
      .filter((p) => p.name && p.name.length > 3)
      .slice(0, 5)
      .map((p) => ({ name: p.name, title: p.title, linkedinUrl: null }));
    if (structured.length > 0) return structured;
    const { extractPeopleFromSiteText } = await import("@src/harness/decision-maker");
    const llmPeople = await extractPeopleFromSiteText(companyName, siteContent).catch(() => []);
    return llmPeople.slice(0, 5).map((p) => ({ name: p.name, title: p.role ?? null, linkedinUrl: null }));
  } catch {
    void siteContent;
    return [];
  }
}

function linkedinCredsOf(sources: { adapter: { type: string }; credentials: Record<string, string> }[]): LinkedInCredentials | null {
  const linkedinSource = sources.find((source) => source.adapter.type === "source:linkedin" && Boolean(source.credentials.liAt));
  return linkedinSource?.credentials.liAt ? { liAt: linkedinSource.credentials.liAt, proxyUrl: linkedinSource.credentials.proxyUrl } : null;
}

type ResearchLike = typeof defaultResearchDeps;

async function decisionMakerDiscovery(
  candidate: LeadCandidate,
  found: FoundLead | null,
  creds: LinkedInCredentials | null,
  research: ResearchLike,
  emit: (message: string) => void,
  errors: RunFailure[],
): Promise<{ name: string | null; title: string | null; linkedinUrl: string | null }[]> {
  try {
    const knownCompanyUrl = found?.companyId
      ? ((await db.select({ linkedinUrl: companies.linkedinUrl }).from(companies).where(eq(companies.id, found.companyId)).limit(1))[0]?.linkedinUrl ?? null)
      : null;

    if (creds && knownCompanyUrl) {
      try {
        const people = await discoverCompanyPeople(knownCompanyUrl, { liAt: creds.liAt, proxyUrl: creds.proxyUrl ?? undefined });
        if (people.length > 0) {
          emit(`decision makers for "${candidate.name}" via people tab: ${people.length}`);
          return people.map((person) => ({ name: person.name, title: person.title, linkedinUrl: person.linkedinUrl }));
        }
      } catch (error) {
        recordFailure(
          errors,
          "harvest",
          "people-tab-failed",
          `people-tab discovery failed for "${candidate.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const viaResearch = await research.decisionMakers(candidate, creds);
    if (viaResearch?.[0] && !creds) {
      emit(`decision maker for "${candidate.name}" via web: ${viaResearch[0].name ?? viaResearch[0].title}`);
    }
    return viaResearch ?? [];
  } catch (error) {
    recordFailure(
      errors,
      "harvest",
      "decision-maker-failed",
      `decision-maker discovery failed for "${candidate.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function fillEmailFromFinder(
  found: FoundLead,
  website: string,
  siteContent: string | null,
  people: { name: string | null; title: string | null; linkedinUrl: string | null }[],
  emit: (message: string) => void,
  errors: RunFailure[],
): Promise<void> {
  try {
    const contactName = people.find((p) => p.name)?.name ?? null;
    const emails = await findEmails({ siteContent, website, contactName });
    const best = emails.find((e) => !e.role) ?? emails.find((e) => e.role) ?? emails[0];
    if (!best) return;

    const { ensureContactEmailRow } = await import("@src/harness/persistence");
    await ensureContactEmailRow({
      companyDedupeKey: found.dedupeKey,
      companyId: found.companyId,
      email: best.email,
      emailType: best.role ? "role" : "personal",
    });
    emit(`contact email for "${found.dedupeKey.split("|")[0]}" (${best.source}, confidence ${best.confidence})`);
  } catch (error) {
    recordFailure(errors, "harvest", "email-lookup-failed", `email lookup failed for ${website}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function siteHashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
