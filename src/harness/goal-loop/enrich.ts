import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@src/db";
import { companies, contacts, leads } from "@src/db/schema";
import type { StageRunner } from "@src/harness/stages";
import type { GoalLoopOptions, ProgressEvent, RunFailure } from "@src/harness/goal-loop/types";
import { recordFailure, type RunState } from "@src/harness/goal-loop/context";
import type { ResolvedSource } from "@src/harness/source-resolver";
import type { HarnessTracer } from "@src/harness/tracer";
import { INSTAGRAM_SOURCE_TYPE, instagramPlugin } from "@src/plugins/builtin/instagram";
import { findDecisionMakersOnWeb } from "@src/harness/decision-maker";
import { buildDiscoveredContacts, crawlCompanySite, isRoleEmail, nameMatchesEmail, verifyEmail, websiteMatchesCompany } from "@src/harness/contact-discovery";
import { domainHasMailInfrastructure, harvestContactsFromSearch, whatsappReachable } from "@src/harness/osint-contacts";
import { verifyEmailRemote } from "@src/harness/email-verifier";
import { backfillNamedContactEmails } from "@src/harness/email-backfill";
import { fetchDeepSiteContent } from "@src/harness/site-content";
import { companyContactCount, normalizePhone, upsertCrawledContacts, upsertDecisionMakerContacts, waLikely } from "@src/harness/persistence";

const ENRICHMENT_TRANSIENT_RE = /timeout|aborted|ECONNRESET|ECONNREFUSED|socket hang up|429|5\d\d|rate.?limit|fetch failed/i;

export interface EnrichTarget {
  leadId: string;
  companyId: string;
  companyName: string;
  website: string | null;
  city: string | null;
  dedupeKey: string;
  enrichmentStatus: string;
}

export interface EnrichDeps {
  readonly stages: StageRunner;
  readonly options: GoalLoopOptions;
  readonly runId: string;
  readonly tracer: HarnessTracer;
  readonly sources: ResolvedSource[];
  readonly trackUsage: (stage: "planner" | "extractor", usage: { inputTokens: number; outputTokens: number } | null) => void;
  readonly errors: RunFailure[];
  readonly state: RunState;
  readonly siteContentCache: Map<string, string | null>;
  readonly crawlState: { consecutiveDeadCrawls: number; disabled: boolean };
  readonly emit: (event: ProgressEvent) => void;
  readonly shouldCancel?: () => boolean;
}

export async function enrichTargets(campaignId: string, limit = 20): Promise<EnrichTarget[]> {
  return await db
    .select({
      leadId: leads.id,
      companyId: companies.id,
      companyName: companies.name,
      website: companies.website,
      city: companies.city,
      dedupeKey: companies.dedupeKey,
      enrichmentStatus: leads.enrichmentStatus,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .where(
      and(
        eq(leads.campaignId, campaignId),
        inArray(leads.status, ["new", "ready"]),
        inArray(leads.enrichmentStatus, ["pending", "failed", "partial"]),
        sql`${leads.enrichmentAttempts} < 3`,
        sql`not exists (select 1 from contacts c where c.company_id = ${leads.companyId} and c.email is not null)`,
      ),
    )
    .orderBy(leads.createdAt)
    .limit(limit);
}

export type EnrichAttempt = "done" | "transient" | "timeout";

const ENRICH_SPAN_TIMEOUT_MS = 10 * 60_000;

function raced<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const ENRICH_CONCURRENCY = 6;

export async function runEnrichPass(deps: EnrichDeps, targets: EnrichTarget[]): Promise<void> {
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, queue.length) }, async () => {
    while (true) {
      if (deps.shouldCancel?.()) return;
      const target = queue.shift();
      if (!target) return;
      await enrichTargetWithRetry(deps, target);
    }
  });
  await Promise.all(workers);
}

async function enrichTargetWithRetry(deps: EnrichDeps, target: EnrichTarget): Promise<void> {
  const attempted = await deps.tracer.span(
    `enrich "${target.companyName}"`,
    () => raced(enrichOneLead(deps, target), ENRICH_SPAN_TIMEOUT_MS, "timeout" as const),
    (result) => ({ company: target.companyName, attempted: result }),
  );
  deps.emit({ stage: "persist", message: `enrich span "${target.companyName}" (${attempted})` });
  await deps.tracer.flush();
  if (attempted === "timeout") {
    recordFailure(
      deps.errors,
      "harvest",
      "enrich-span-timeout",
      `enrich span "${target.companyName}" exceeded ${ENRICH_SPAN_TIMEOUT_MS / 1000}s and was abandoned`,
    );
  }
  if (attempted === "transient") {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5_000);
    await promise;
    await enrichOneLead(deps, target);
  }
}

interface CrawledContact {
  name: string | null;
  title: string | null;
  email: string | null;
  emailType: "role" | "personal" | "verified-personal" | null;
  phone: string | null;
  whatsapp: string | null;
  linkedinUrl: string | null;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function linkedinCreds(sources: ResolvedSource[]): { liAt: string; proxyUrl: string | null } | null {
  const source = sources.find((s) => s.adapter.type === "source:linkedin" && Boolean(s.credentials.liAt));
  return source?.credentials.liAt ? { liAt: source.credentials.liAt, proxyUrl: source.credentials.proxyUrl ?? null } : null;
}

async function enrichOneLead(deps: EnrichDeps, target: EnrichTarget): Promise<EnrichAttempt> {
  const { runId, errors, siteContentCache, crawlState, emit, state } = deps;
  try {
    await db
      .update(leads)
      .set({ enrichmentStatus: "partial", enrichmentAttempts: sql`${leads.enrichmentAttempts} + 1`, updatedAt: new Date() })
      .where(eq(leads.id, target.leadId));

    let siteContent: string | null = null;
    if (target.website) {
      if (siteContentCache.has(target.leadId)) {
        siteContent = siteContentCache.get(target.leadId) ?? null;
      } else {
        siteContent = (await fetchDeepSiteContent(target.website)).content;
        state.cacheContent(target.leadId, siteContent);
      }
    }

    const creds = linkedinCreds(deps.sources);
    const linkedinSampled = hashString(target.leadId) % 3 === 0;
    const contactCount = await companyContactCount(target.companyId).catch(() => 0);

    if (contactCount === 0) {
      const webPeople = await findDecisionMakersOnWeb(target.companyName, target.city ?? null).catch(
        () => [] as { name: string | null; title: string | null; linkedinUrl: string | null; sourceUrl: string }[],
      );
      if (webPeople.length > 0) {
        const savedWeb = await upsertDecisionMakerContacts({
          companyDedupeKey: target.dedupeKey,
          companyId: target.companyId,
          people: webPeople.slice(0, 5).map((person) => ({ name: person.name, title: person.title, linkedinUrl: person.linkedinUrl })),
        }).catch(() => 0);
        if (savedWeb > 0) {
          emit({ stage: "persist", message: `${savedWeb} stakeholders from web search for "${target.companyName}"` });
        }
      }

      if (creds && linkedinSampled) {
        const linkedinPeople = await discoverPeopleSafe(target.companyName, target.city ?? null, creds);
        if (linkedinPeople.length > 0) {
          const savedDm = await upsertDecisionMakerContacts({
            companyDedupeKey: target.dedupeKey,
            companyId: target.companyId,
            people: linkedinPeople.filter((p) => p.name || p.linkedinUrl).slice(0, 3),
          }).catch(() => 0);
          if (savedDm > 0) emit({ stage: "persist", message: `${savedDm} decision makers from LinkedIn for "${target.companyName}"` });
        }
      }
    }

    let crawlContacts: CrawledContact[] | null = null;
    if (target.website && !crawlState.disabled) {
      const deadCrawl = () => {
        crawlState.consecutiveDeadCrawls += 1;
        if (crawlState.consecutiveDeadCrawls >= 8) {
          crawlState.disabled = true;
          emit({
            stage: "persist",
            message: `site-crawl disabled for the rest of this batch: ${crawlState.consecutiveDeadCrawls} consecutive websites yielded zero contacts`,
          });
        }
      };
      try {
        const websitePlausible = target.website ? websiteMatchesCompany(target.website, target.companyName) : false;
        if (!websitePlausible) {
          emit({ stage: "persist", message: `website "${target.website}" implausible for "${target.companyName}" — using search-engine contact harvest` });
        }
        const crawl = websitePlausible
          ? await crawlCompanySite(target.website, { maxPages: 6, maxDepth: 2, deadlineMs: 90_000 })
          : {
              domain: "",
              pagesFetched: 0,
              emails: [],
              phones: [],
              whatsapp: null,
              socials: { linkedin: [], instagram: [], twitter: [], facebook: [] },
              people: [],
              emailsBySource: new Map<string, string>(),
              aiContacts: [],
            };
        if (crawl.pagesFetched > 0) {
          const discovered = buildDiscoveredContacts(crawl).slice(0, 5);
          let smtpBudget = 2;
          for (const contact of discovered) {
            if (!contact.email) continue;
            if (contact.emailConfidence === "observed") {
              const verdict = await verifyEmail(contact.email, { smtp: false, timeoutMs: 4000 }).catch(() => null);
              if (verdict && !verdict.valid) {
                contact.email = null;
                contact.emailConfidence = "inferred";
                contact.emailPatternMethod = `rejected:${verdict.stage}`;
              }
            } else if (smtpBudget > 0 && contact.name) {
              smtpBudget -= 1;
              const mailLive = target.website ? await domainHasMailInfrastructure(target.website).catch(() => true) : true;
              if (!mailLive) {
                contact.emailPatternMethod = `smtp-skipped:no-mail-infra:${contact.emailPatternMethod ?? "pattern"}`;
                continue;
              }
              const remoteVerdict = await verifyEmailRemote(contact.email).catch(() => null);
              if (remoteVerdict) {
                if (remoteVerdict.status === "valid") {
                  contact.emailConfidence = "verified";
                  contact.emailPatternMethod = `remote-${remoteVerdict.provider}:${contact.emailPatternMethod ?? "pattern"}`;
                } else if (remoteVerdict.status === "invalid") {
                  contact.email = null;
                  contact.emailConfidence = "inferred";
                  contact.emailPatternMethod = `rejected:${remoteVerdict.provider}-${remoteVerdict.status}`;
                } else {
                  contact.emailPatternMethod = `${remoteVerdict.provider}-${remoteVerdict.status}:${contact.emailPatternMethod ?? "pattern"}`;
                }
                continue;
              }
              const verdict = await verifyEmail(contact.email, { smtp: false, timeoutMs: 4000 }).catch(() => null);
              if (verdict && verdict.valid) {
                contact.emailPatternMethod = `mx:${contact.emailPatternMethod ?? "pattern"}`;
              }
            }
          }
          crawlContacts = discovered.map((c) => ({
            name: c.name,
            title: c.title,
            email: c.email,
            emailType:
              c.emailConfidence === "verified"
                ? ("verified-personal" as const)
                : c.emailConfidence === "observed"
                  ? isRoleEmail(c.email ?? "")
                    ? ("role" as const)
                    : ("personal" as const)
                  : isRoleEmail(c.email ?? "")
                    ? ("role" as const)
                    : null,
            phone: c.phone,
            whatsapp: c.whatsapp,
            linkedinUrl: c.linkedinUrl,
          }));
          for (const c of crawlContacts)
            if (c.email && (c.emailType === "role" || !c.emailType)) c.name = c.name && nameMatchesEmail(c.name, c.email) ? c.name : null;
        }
      } catch (error) {
        crawlContacts = null;
        deadCrawl();
        recordFailure(
          errors,
          "harvest",
          "contact-crawl-failed",
          `contact crawl failed for "${target.companyName}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (crawlContacts === null || crawlContacts.length === 0) deadCrawl();
      else crawlState.consecutiveDeadCrawls = 0;
    }

    if (!crawlContacts || crawlContacts.length === 0) {
      const osint = await harvestContactsFromSearch(target.companyName, target.website ?? null).catch(() => null);
      if (osint && (osint.emails.length > 0 || osint.phones.length > 0 || osint.whatsapp)) {
        const mailLive = osint.emails.length > 0 && target.website ? await domainHasMailInfrastructure(target.website).catch(() => false) : false;
        const email = osint.emails[0] ?? null;
        crawlContacts = [
          {
            name: null,
            title: email && isRoleEmail(email) ? "general/role inbox" : null,
            email,
            emailType: email ? (isRoleEmail(email) ? ("role" as const) : mailLive ? ("personal" as const) : null) : null,
            phone: osint.phones[0] ?? null,
            whatsapp: osint.whatsapp,
            linkedinUrl: null,
          },
        ];
        emit({ stage: "persist", message: `osint contact rescue for "${target.companyName}" (search-engine harvest)` });
      }
    }

    if ((!crawlContacts || crawlContacts.length === 0) && hashString(target.leadId) % 2 === 0) {
      const igSource = deps.sources.find((source) => source.adapter.type === INSTAGRAM_SOURCE_TYPE);
      if (igSource) {
        const igResult = await instagramPlugin.definition
          .crawl({ query: target.companyName, maxResults: 1 }, { userId: deps.options.userId, runId, credentials: igSource.credentials })
          .catch(() => null);
        const igContacts = igResult?.artifacts.flatMap((artifact) => artifact.contacts ?? []) ?? [];
        if (igContacts.length > 0) {
          const savedIg = await upsertCrawledContacts({
            companyDedupeKey: target.dedupeKey,
            companyId: target.companyId,
            runId,
            people: igContacts.slice(0, 2).map((c) => ({
              name: c.name ?? null,
              title: c.title ?? "instagram bio",
              email: c.email ?? null,
              emailType: (c.email && !isRoleEmail(c.email) ? "personal" : c.email ? "role" : null) as "role" | "personal" | null,
              phone: c.phone ?? null,
              whatsapp: null,
              linkedinUrl: c.linkedinUrl ?? null,
            })),
          }).catch(() => 0);
          if (savedIg > 0) emit({ stage: "persist", message: `${savedIg} contacts from Instagram bio of "${target.companyName}"` });
        }
      }
    }

    if (target.website) {
      await backfillNamedContactEmails(
        { companyId: target.companyId, companyName: target.companyName, website: target.website },
        deps.tracer,
        (stage, message) => emit({ stage, message }),
      );
    }

    if (crawlContacts) {
      for (const contact of crawlContacts) {
        if (!contact.whatsapp && contact.phone) {
          const normalized = normalizePhone(contact.phone);
          if (normalized && waLikely(normalized)) {
            contact.whatsapp = normalized;
          } else {
            const reachable = await whatsappReachable(contact.phone).catch(() => false);
            if (reachable) contact.whatsapp = contact.phone.replace(/[^0-9+]/g, "").replace(/^0/, "+62");
          }
        }
      }
    }

    if (crawlContacts && crawlContacts.length > 0) {
      const saved = await upsertCrawledContacts({
        companyDedupeKey: target.dedupeKey,
        companyId: target.companyId,
        runId,
        people: crawlContacts,
      }).catch(() => 0);
      if (saved > 0) emit({ stage: "persist", message: `${saved} contacts crawled from "${target.companyName}"` });
    }

    const [emailRow] = await db
      .select({ n: count() })
      .from(contacts)
      .where(and(eq(contacts.companyId, target.companyId), isNotNull(contacts.email)));
    const hasEmail = Number(emailRow?.n ?? 0) > 0;
    const crawledNothing = crawlContacts === null && Boolean(target.website);
    await db
      .update(leads)
      .set({
        enrichmentStatus: hasEmail || (!crawledNothing && crawlContacts !== null && crawlContacts.length > 0) ? "complete" : "partial",
        updatedAt: new Date(),
      })
      .where(eq(leads.id, target.leadId));

    emit({
      stage: "persist",
      message: `enriched "${target.companyName}"`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(errors, "harvest", "enrichment-failed", `enrichment failed for "${target.companyName}": ${message}`);
    await db.update(leads).set({ enrichmentStatus: "failed", updatedAt: new Date() }).where(eq(leads.id, target.leadId));
    return ENRICHMENT_TRANSIENT_RE.test(message) ? "transient" : "done";
  }
  return "done";
}

async function discoverPeopleSafe(
  companyName: string,
  city: string | null,
  creds: { liAt: string; proxyUrl: string | null },
): Promise<{ name: string | null; title: string | null; linkedinUrl: string | null }[]> {
  const { discoverPeople } = await import("@src/plugins/builtin/linkedin");
  return discoverPeople(companyName, city, { liAt: creds.liAt, proxyUrl: creds.proxyUrl ?? undefined }).catch(
    () => [] as { name: string | null; title: string | null; linkedinUrl: string | null }[],
  );
}
