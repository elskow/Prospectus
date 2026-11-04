import { db } from "@src/db";
import { campaigns, companies, contacts, leadSources, leads, queryLedger, suppressions } from "@src/db/schema";
import { isRoleEmail, isPersonalLinkedInUrl, nameMatchesEmail } from "@src/harness/contact-discovery";
import { validateCandidate, stampNotes, normalizePhone, isGenericCompanyName } from "@src/harness/validation";
import type { ValidationVerdict } from "@src/harness/validation";
import type { LeadCandidate, LeadContact } from "@src/harness/schemas";
import type { SinkLead } from "@src/adapters/sink";
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

export { normalizePhone, isGenericCompanyName } from "@src/harness/validation";
export {
  startRun,
  finishRun,
  markRunTurns,
  markRunCost,
  touchRunHeartbeat,
  pauseRun,
  getPausedRun,
  resumePausedRun,
  completePausedRun,
  claimRunById,
  claimNextQueuedRun,
  renewRunLease,
  requeueExpiredLeases,
  type RunResumeState,
} from "@src/harness/persist/runs";
export { recordQueryLedger, searchLedgerForCampaign, ensureSource } from "@src/harness/persist/query-ledger";

export interface PersistInput {
  campaignId: string | null;
  runId: string | null;
  sourceId: string;
  candidates: LeadCandidate[];
}

export interface PersistOutput {
  newCompanies: number;
  newLeads: number;
  duplicates: number;
  rejected?: number;
  flagged?: number;
}

export function fieldAgeDays(fieldProvenance: Record<string, unknown> | null, field: string): number | null {
  const entry = fieldProvenance?.[field];
  if (!entry || typeof entry !== "object") return null;
  if (!("at" in entry)) return null;
  const at = entry.at;
  if (typeof at !== "string") return null;
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / 86_400_000;
}

export function isFieldStale(fieldProvenance: Record<string, unknown> | null, field: string, ttlDays: number): boolean {
  const age = fieldAgeDays(fieldProvenance, field);
  return age === null || age > ttlDays;
}

const MAPS_COORD_RE = /@(-?\d+\.\d+),(-?\d+\.\d+)/;
const MAPS_DATA_COORD_RE = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/;

export function mapsUrlCoords(url: string | null | undefined): { lat: number; lng: number } | null {
  if (!url) return null;
  const data = url.match(MAPS_DATA_COORD_RE);
  if (data?.[1] && data[2]) {
    return { lat: Number(data[1]), lng: Number(data[2]) };
  }
  const at = url.match(MAPS_COORD_RE);
  if (at?.[1] && at[2]) {
    return { lat: Number(at[1]), lng: Number(at[2]) };
  }
  return null;
}

export function dedupeKeyFor(candidate: LeadCandidate): string {
  let domain: string | null = null;

  if (candidate.website) {
    try {
      domain = new URL(candidate.website).hostname.replace(/^www\./, "");
    } catch {
      domain = null;
    }
  }

  const identity = domain ?? candidate.phone ?? candidate.address ?? candidate.name;
  const name = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return `${name}|${identity.toLowerCase().replace(/[^a-z0-9.:@/-]+/g, "-")}`;
}

function contactDedupeKey(companyDedupeKey: string, contact: LeadContact): string | null {
  const identity = contact.linkedinUrl ?? contact.email ?? (contact.phone ? `phone:${contact.phone}` : null);
  if (!identity) return null;

  return `${companyDedupeKey}|contact|${identity.toLowerCase().replace(/[^a-z0-9.:@/-]+/g, "-")}`;
}

export function waLikely(phoneNormalized: string | null): boolean {
  return phoneNormalized !== null && /^(\+62|0)8[1-9]/.test(phoneNormalized);
}

async function upsertContacts(companyDedupeKey: string, companyId: string, input: PersistInput, candidate: LeadCandidate): Promise<number> {
  if (!candidate.contacts || candidate.contacts.length === 0) return 0;

  let saved = 0;
  for (const contact of candidate.contacts) {
    const dedupeKey = contactDedupeKey(companyDedupeKey, contact);
    if (!dedupeKey) continue;

    const provenance = {
      sourceId: input.sourceId,
      stage: "discover",
      runId: input.runId,
      at: new Date().toISOString(),
    };

    const phoneNormalized = contact.phone ? normalizePhone(contact.phone) : null;

    await db
      .insert(contacts)
      .values({
        dedupeKey,
        companyId,
        name: contact.name ?? null,
        title: contact.title ?? (contact.email && isRoleEmail(contact.email) && !contact.name ? "company/role inbox" : null),
        email: contact.email ?? null,
        phone: contact.phone ?? null,
        phoneNormalized,
        waLikely: phoneNormalized ? waLikely(phoneNormalized) : null,
        emailType: contact.email
          ? isRoleEmail(contact.email)
            ? "role"
            : contact.name && nameMatchesEmail(contact.name, contact.email)
              ? "personal"
              : null
          : null,
        linkedinUrl: contact.linkedinUrl ?? null,
        isDecisionMaker: contact.isDecisionMaker ?? null,
        raw: contact,
        fieldProvenance: { contact: provenance },
      })
      .onConflictDoUpdate({
        target: contacts.dedupeKey,
        set: {
          name: sql`coalesce(${contacts.name}, excluded.name)`,
          title: sql`coalesce(${contacts.title}, excluded.title)`,
          email: sql`coalesce(${contacts.email}, excluded.email)`,
          emailType: sql`coalesce(${contacts.emailType}, excluded.email_type)`,
          phone: sql`coalesce(${contacts.phone}, excluded.phone)`,
          phoneNormalized: sql`coalesce(${contacts.phoneNormalized}, excluded.phone_normalized)`,
          waLikely: sql`coalesce(${contacts.waLikely}, excluded.wa_likely)`,
          linkedinUrl: sql`coalesce(${contacts.linkedinUrl}, excluded.linkedin_url)`,
          isDecisionMaker: sql`coalesce(${contacts.isDecisionMaker}, excluded.is_decision_maker)`,
          raw: contact,
          fieldProvenance: sql`${contacts.fieldProvenance} || ${JSON.stringify({ contact: provenance })}::jsonb`,
        },
      });

    if (contact.email) await refreshCompanyEmailFlag(companyId);

    saved += 1;
  }

  return saved;
}

export async function upsertCrawledContacts(input: {
  companyDedupeKey: string;
  companyId: string;
  runId: string;
  people: {
    name: string | null;
    title: string | null;
    email: string | null;
    emailType: "role" | "personal" | "verified-personal" | null;
    phone: string | null;
    whatsapp: string | null;
    linkedinUrl: string | null;
  }[];
}): Promise<number> {
  let saved = 0;
  const companiesWithEmail = new Set<string>();
  const provenance = { stage: "site-crawl", runId: input.runId, at: new Date().toISOString() };
  for (const person of input.people) {
    const linkedinUrl = isPersonalLinkedInUrl(person.linkedinUrl) ? person.linkedinUrl : null;
    const identity = linkedinUrl ?? person.email ?? (person.phone ? `phone:${person.phone}` : null) ?? (person.whatsapp ? `wa:${person.whatsapp}` : null);
    if (!identity) continue;
    const dedupeKey = `${input.companyDedupeKey}|contact|${identity.toLowerCase().replace(/[^a-z0-9.:@/-]+/g, "-")}`;
    const isDecisionMaker = person.title
      ? /direktur|director|ceo|cto|coo|cfo|owner|founder|president|general manager|manajer|manager|kepala|head of|pemilik/i.test(person.title)
      : null;
    const phoneNormalized = person.phone ? normalizePhone(person.phone) : null;
    await db
      .insert(contacts)
      .values({
        dedupeKey,
        companyId: input.companyId,
        name: person.name,
        title: person.title,
        email: person.email,
        emailType: person.emailType,
        phone: person.phone,
        phoneNormalized,
        waLikely: phoneNormalized ? waLikely(phoneNormalized) : null,
        whatsapp: person.whatsapp,
        linkedinUrl,
        isDecisionMaker,
        raw: person,
        fieldProvenance: { contact: provenance },
      })
      .onConflictDoUpdate({
        target: contacts.dedupeKey,
        set: {
          name: sql`coalesce(${contacts.name}, excluded.name)`,
          title: sql`coalesce(${contacts.title}, excluded.title)`,
          email: sql`coalesce(${contacts.email}, excluded.email)`,
          emailType: sql`coalesce(${contacts.emailType}, excluded."email_type")`,
          phone: sql`coalesce(${contacts.phone}, excluded.phone)`,
          phoneNormalized: sql`coalesce(${contacts.phoneNormalized}, excluded.phone_normalized)`,
          waLikely: sql`coalesce(${contacts.waLikely}, excluded.wa_likely)`,
          whatsapp: sql`coalesce(${contacts.whatsapp}, excluded.whatsapp)`,
          linkedinUrl: sql`coalesce(${contacts.linkedinUrl}, excluded."linkedin_url")`,
          isDecisionMaker: sql`coalesce(${contacts.isDecisionMaker}, excluded."is_decision_maker")`,
          fieldProvenance: sql`${contacts.fieldProvenance} || ${JSON.stringify({ contact: provenance })}::jsonb`,
        },
      });
    if (person.email) companiesWithEmail.add(input.companyId);
    saved += 1;
  }
  for (const companyId of companiesWithEmail) await refreshCompanyEmailFlag(companyId);
  return saved;
}

export async function upsertDecisionMakerContacts(input: {
  companyDedupeKey: string;
  companyId: string;
  people: { name: string | null; title: string | null; linkedinUrl: string | null }[];
}): Promise<number> {
  let saved = 0;
  const provenance = { stage: "decision-maker-discovery", at: new Date().toISOString() };

  for (const person of input.people) {
    const linkedinUrl = isPersonalLinkedInUrl(person.linkedinUrl) ? person.linkedinUrl : null;
    if (!person.name && !linkedinUrl) continue;
    const identity = linkedinUrl ?? `${person.name}`;
    const dedupeKey = `${input.companyDedupeKey}|contact|dm|${identity.toLowerCase().replace(/[^a-z0-9/@.-]+/g, "-")}`;

    await db
      .insert(contacts)
      .values({
        dedupeKey,
        companyId: input.companyId,
        name: person.name,
        title: person.title,
        linkedinUrl,
        isDecisionMaker: true,
        raw: person,
        fieldProvenance: { contact: provenance },
      })
      .onConflictDoUpdate({
        target: contacts.dedupeKey,
        set: {
          name: sql`coalesce(contacts.name, excluded.name)`,
          title: sql`coalesce(contacts.title, excluded.title)`,
          linkedinUrl: sql`coalesce(contacts.linkedin_url, excluded.linkedin_url)`,
          isDecisionMaker: sql`coalesce(contacts.is_decision_maker, excluded.is_decision_maker)`,
          updatedAt: new Date(),
        },
      });
    saved += 1;
  }

  return saved;
}

export async function companyHasEmail(companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.companyId, companyId), isNotNull(contacts.email)))
    .limit(1);
  return Boolean(row);
}

export async function companyHasContact(companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.companyId, companyId),
        sql`(${contacts.email} is not null or ${contacts.phone} is not null or ${contacts.whatsapp} is not null or ${contacts.phoneNormalized} is not null)`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function companyContactCount(companyId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(contacts)
    .where(
      and(
        eq(contacts.companyId, companyId),
        sql`(${contacts.email} is not null or ${contacts.phone} is not null or ${contacts.whatsapp} is not null or ${contacts.phoneNormalized} is not null)`,
      ),
    );
  return Number(row?.n ?? 0);
}

export async function persistCandidates(input: PersistInput): Promise<PersistOutput> {
  const result: PersistOutput = { newCompanies: 0, newLeads: 0, duplicates: 0, rejected: 0, flagged: 0 };

  const [campaign] = input.campaignId ? await db.select({ exclusions: campaigns.exclusions }).from(campaigns).where(eq(campaigns.id, input.campaignId)) : [];
  const exclusions = campaign?.exclusions ?? [];

  const accepted: {
    candidate: LeadCandidate;
    dedupeKey: string;
    coords: { lat: number; lng: number } | null;
    verdict: ValidationVerdict;
  }[] = [];
  for (const candidate of input.candidates) {
    if (isGenericCompanyName(candidate.name)) {
      result.rejected = (result.rejected ?? 0) + 1;
      continue;
    }
    const verdict = validateCandidate({
      name: candidate.name,
      email: candidate.contacts?.find((c) => c.email)?.email ?? null,
      phone: candidate.phone,
      website: candidate.website,
      country: candidate.country,
    });
    if (verdict.level === "reject") {
      result.rejected = (result.rejected ?? 0) + 1;
      continue;
    }
    if (verdict.level === "review") {
      result.flagged = (result.flagged ?? 0) + 1;
    }
    if (matchesExclusions(candidate, exclusions)) {
      result.rejected = (result.rejected ?? 0) + 1;
      continue;
    }
    accepted.push({ candidate, dedupeKey: dedupeKeyFor(candidate), coords: mapsUrlCoords(candidate.sourceUrl), verdict });
  }

  if (accepted.length === 0) return result;
  await db.transaction(async (tx) => {
    const db = tx;

    const byDedupeKey = new Map<string, { candidate: LeadCandidate; coords: { lat: number; lng: number } | null }>();
    for (const row of accepted) byDedupeKey.set(row.dedupeKey, { candidate: row.candidate, coords: row.coords });
    const occurrences = new Map<string, number>();
    for (const row of accepted) occurrences.set(row.dedupeKey, (occurrences.get(row.dedupeKey) ?? 0) + 1);

    const provenanceAt = new Date().toISOString();
    const insertedRows = await db
      .insert(companies)
      .values(
        accepted.map((row) => {
          const coords = row.coords;
          return {
            dedupeKey: row.dedupeKey,
            name: row.candidate.name,
            website: row.candidate.website ?? null,
            address: row.candidate.address ?? null,
            city: row.candidate.city ?? null,
            province: row.candidate.province ?? null,
            ...(row.candidate.country ? { country: row.candidate.country } : {}),
            phone: row.candidate.phone ?? null,
            industryCategory: row.candidate.category ?? null,
            rating: row.candidate.rating ?? null,
            reviewCount: row.candidate.reviewCount ?? null,
            productsServices: row.candidate.productsServices ?? null,
            latitude: coords?.lat ?? null,
            longitude: coords?.lng ?? null,
            raw: row.candidate.raw ?? (row.candidate.sourceUrl ? { mapsPlaceUrl: row.candidate.sourceUrl } : null),
            fieldProvenance: {
              name: { sourceId: input.sourceId, stage: "discover", runId: input.runId, at: provenanceAt },
            },
            createdByRunId: input.runId,
            status: row.verdict.level === "review" ? ("needs_review" as const) : ("valid" as const),
            hasEmail: row.candidate.contacts?.some((c) => c.email) ?? false,
            validationNotes: row.verdict.level === "review" ? stampNotes(row.verdict.notes) : [],
          };
        }),
      )
      .onConflictDoNothing({ target: companies.dedupeKey })
      .returning({ id: companies.id, dedupeKey: companies.dedupeKey });

    const companyIdByKey = new Map<string, string>();
    for (const row of insertedRows) companyIdByKey.set(row.dedupeKey, row.id);
    result.newCompanies += insertedRows.length;

    const conflictedKeys = [...byDedupeKey.keys()].filter((key) => !companyIdByKey.has(key));
    if (conflictedKeys.length > 0) {
      const existingRows = await db
        .select({ id: companies.id, dedupeKey: companies.dedupeKey })
        .from(companies)
        .where(inArray(companies.dedupeKey, conflictedKeys));
      for (const row of existingRows) companyIdByKey.set(row.dedupeKey, row.id);

      const coordKeys = conflictedKeys.filter((key) => byDedupeKey.get(key)?.coords && companyIdByKey.has(key));
      if (coordKeys.length > 0) {
        await db.execute(sql`
        update companies set latitude = data.lat, longitude = data.lng, updated_at = now()
        from (values ${sql.join(
          coordKeys.map((key) => {
            const coords = byDedupeKey.get(key)!.coords!;
            return sql`( ${companyIdByKey.get(key)!}::uuid, ${coords.lat}::double precision, ${coords.lng}::double precision )`;
          }),
          sql`, `,
        )} ) as data(id, lat, lng)
        where companies.id = data.id and (companies.latitude is null or companies.longitude is null)
      `);
      }
    }

    const contactsByKey = new Map<string, typeof contacts.$inferInsert>();
    const phoneOnlyValues: (typeof contacts.$inferInsert)[] = [];
    const emailedCompanyIds = new Set<string>();
    for (const [dedupeKey, entry] of byDedupeKey) {
      const companyId = companyIdByKey.get(dedupeKey);
      if (!companyId) {
        result.duplicates += 1;
        continue;
      }
      const provenance = {
        sourceId: input.sourceId,
        stage: "discover",
        runId: input.runId,
        at: provenanceAt,
      };
      const namedContacts = (entry.candidate.contacts ?? []).filter((contact) => contactDedupeKey(dedupeKey, contact) !== null);
      for (const contact of namedContacts) {
        const dedupeKeyContact = contactDedupeKey(dedupeKey, contact)!;
        const phoneNormalized = contact.phone ? normalizePhone(contact.phone) : null;
        if (contactsByKey.has(dedupeKeyContact)) continue;
        contactsByKey.set(dedupeKeyContact, {
          dedupeKey: dedupeKeyContact,
          companyId,
          name: contact.name ?? null,
          title: contact.title ?? (contact.email && isRoleEmail(contact.email) && !contact.name ? "company/role inbox" : null),
          email: contact.email ?? null,
          phone: contact.phone ?? null,
          phoneNormalized,
          waLikely: phoneNormalized ? waLikely(phoneNormalized) : null,
          emailType: contact.email
            ? isRoleEmail(contact.email)
              ? "role"
              : contact.name && nameMatchesEmail(contact.name, contact.email)
                ? "personal"
                : null
            : null,
          linkedinUrl: contact.linkedinUrl ?? null,
          isDecisionMaker: contact.isDecisionMaker ?? null,
          raw: contact,
          fieldProvenance: { contact: provenance },
        });
        if (contact.email) emailedCompanyIds.add(companyId);
      }
      if (entry.candidate.phone) {
        const identity = `phone:${entry.candidate.phone}`.toLowerCase().replace(/[^a-z0-9.:@/-]+/g, "-");
        phoneOnlyValues.push({
          dedupeKey: `${dedupeKey}|contact|${identity}`,
          companyId,
          name: null,
          title: null,
          email: null,
          emailType: null,
          phone: entry.candidate.phone,
          phoneNormalized: normalizePhone(entry.candidate.phone),
          waLikely: null,
          whatsapp: null,
          linkedinUrl: null,
          isDecisionMaker: null,
          raw: null,
          fieldProvenance: { phone: { stage: "discover", sourceId: input.sourceId, runId: input.runId, at: provenanceAt } },
        });
      }
    }

    const contactValues = [...contactsByKey.values()];
    if (contactValues.length > 0) {
      await db
        .insert(contacts)
        .values(contactValues)
        .onConflictDoUpdate({
          target: contacts.dedupeKey,
          set: {
            name: sql`coalesce(${contacts.name}, excluded.name)`,
            title: sql`coalesce(${contacts.title}, excluded.title)`,
            email: sql`coalesce(${contacts.email}, excluded.email)`,
            emailType: sql`coalesce(${contacts.emailType}, excluded.email_type)`,
            phone: sql`coalesce(${contacts.phone}, excluded.phone)`,
            phoneNormalized: sql`coalesce(${contacts.phoneNormalized}, excluded.phone_normalized)`,
            waLikely: sql`coalesce(${contacts.waLikely}, excluded.wa_likely)`,
            linkedinUrl: sql`coalesce(${contacts.linkedinUrl}, excluded.linkedin_url)`,
            isDecisionMaker: sql`coalesce(${contacts.isDecisionMaker}, excluded.is_decision_maker)`,
            raw: sql`excluded.raw`,
            fieldProvenance: sql`${contacts.fieldProvenance} || excluded.field_provenance`,
          },
        });
    }

    if (phoneOnlyValues.length > 0) {
      await db.insert(contacts).values(phoneOnlyValues).onConflictDoNothing({ target: contacts.dedupeKey });
    }

    if (emailedCompanyIds.size > 0) {
      await db
        .update(companies)
        .set({ hasEmail: true, updatedAt: new Date() })
        .where(and(inArray(companies.id, [...emailedCompanyIds]), eq(companies.hasEmail, false)));
    }

    if (!input.campaignId) return result;

    const pagedCompanyIds = [...new Set(companyIdByKey.values())];
    const existingLeadRows = await db
      .select({ id: leads.id, companyId: leads.companyId })
      .from(leads)
      .where(and(eq(leads.campaignId, input.campaignId), inArray(leads.companyId, pagedCompanyIds)));
    const leadIdByCompanyId = new Map<string, string>();
    for (const row of existingLeadRows) leadIdByCompanyId.set(row.companyId, row.id);

    for (const companyId of pagedCompanyIds) {
      if (leadIdByCompanyId.has(companyId)) result.duplicates += 1;
    }

    for (const [key, count] of occurrences) {
      const companyId = companyIdByKey.get(key);
      if (count > 1 && companyId !== undefined && leadIdByCompanyId.has(companyId)) result.duplicates += count - 1;
    }

    const freshCompanyIds = pagedCompanyIds.filter((companyId) => !leadIdByCompanyId.has(companyId));
    if (freshCompanyIds.length > 0) {
      const insertedLeads = await db
        .insert(leads)
        .values(
          freshCompanyIds.map((companyId) => ({
            companyId,
            campaignId: input.campaignId!,
            status: "new" as const,
            createdByRunId: input.runId,
          })),
        )
        .onConflictDoNothing({ target: [leads.campaignId, leads.companyId] })
        .returning({ id: leads.id, companyId: leads.companyId });
      result.newLeads += insertedLeads.length;
      const racedCompanyIds = freshCompanyIds.filter((companyId) => !insertedLeads.some((lead) => lead.companyId === companyId));
      for (const companyId of racedCompanyIds) result.duplicates += 1;
      for (const lead of insertedLeads) leadIdByCompanyId.set(lead.companyId, lead.id);
    }

    const leadSourceValues = [...leadIdByCompanyId.entries()]
      .filter(([companyId]) => pagedCompanyIds.includes(companyId))
      .map(([companyId, leadId]) => ({ leadId, sourceId: input.sourceId }));
    if (leadSourceValues.length > 0) {
      await db.insert(leadSources).values(leadSourceValues).onConflictDoNothing();
    }
  });

  return result;
}

export function matchesExclusions(candidate: LeadCandidate, exclusions: string[]): boolean {
  if (exclusions.length === 0) return false;
  const haystack = [candidate.name, candidate.category ?? null, candidate.address ?? null, candidate.city ?? null]
    .filter((v): v is string => Boolean(v))
    .join(" ")
    .toLowerCase();
  return exclusions.some((term) => {
    const needle = term.trim().toLowerCase();
    return needle.length > 1 && haystack.includes(needle);
  });
}

export async function refreshCompanyEmailFlag(companyId: string): Promise<boolean> {
  const hasEmail = await companyHasEmail(companyId);
  await db.update(companies).set({ hasEmail, updatedAt: new Date() }).where(eq(companies.id, companyId));
  return hasEmail;
}

export async function promoteReadyLeads(campaignId: string): Promise<number> {
  const promoted = await db.execute<{ count: number }>(sql`
    with promoted as (
      update leads l set status = 'ready', updated_at = now()
      where l.campaign_id = ${campaignId}
        and l.status = 'new'
        and exists (select 1 from contacts k where k.company_id = l.company_id and k.email is not null)
      returning l.id
    )
    select count(*)::int as count from promoted
  `);
  const rows = promoted as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

export interface ReadyLeadExport {
  leadId: string;
  lead: SinkLead;
}

const suppressionCache: { emails: Set<string>; domains: Set<string>; loadedAt: number } = {
  emails: new Set(),
  domains: new Set(),
  loadedAt: 0,
};

const SUPPRESSION_CACHE_TTL_MS = 60_000;

export function invalidateSuppressionCache(): void {
  suppressionCache.emails = new Set();
  suppressionCache.domains = new Set();
  suppressionCache.loadedAt = 0;
}

async function suppressionSets(): Promise<{ emails: Set<string>; domains: Set<string> }> {
  if (suppressionCache.loadedAt > 0 && Date.now() - suppressionCache.loadedAt < SUPPRESSION_CACHE_TTL_MS) {
    return { emails: suppressionCache.emails, domains: suppressionCache.domains };
  }
  const rows = await db.select({ email: suppressions.email, domain: suppressions.domain }).from(suppressions);
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const row of rows) {
    if (row.email) emails.add(row.email.toLowerCase());
    if (row.domain) domains.add(row.domain.toLowerCase());
  }
  suppressionCache.emails = emails;
  suppressionCache.domains = domains;
  suppressionCache.loadedAt = Date.now();
  return { emails, domains };
}

export async function findReadyLeads(campaignId: string): Promise<SinkLead[]> {
  return (await findReadyLeadsWithIds(campaignId)).map((entry) => entry.lead);
}

export async function findReadyLeadsWithIds(campaignId: string): Promise<ReadyLeadExport[]> {
  const [campaign] = await db.select({ exportMode: campaigns.exportMode }).from(campaigns).where(eq(campaigns.id, campaignId));
  const perCompany = campaign?.exportMode !== "all_contacts";
  const rankLimit = perCompany ? 1 : 5;

  const { emails: suppressedEmails, domains: suppressedDomains } = await suppressionSets();
  const isSuppressed = (email: string | null): boolean => {
    if (!email) return false;
    const lower = email.toLowerCase();
    if (suppressedEmails.has(lower)) return true;
    const domain = lower.split("@")[1] ?? "";
    return domain.length > 0 && suppressedDomains.has(domain);
  };

  const pagedLeadIds = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.campaignId, campaignId), eq(leads.status, "ready"), isNull(leads.sheetSyncedAt)))
    .limit(500);

  if (pagedLeadIds.length === 0) return [];

  const rows = await db
    .select({
      leadId: leads.id,
      companyName: companies.name,
      city: companies.city,
      website: companies.website,
      sourceUrl: companies.raw,
      discoveredAt: leads.createdAt,
      contactName: contacts.name,
      contactTitle: contacts.title,
      contactEmail: contacts.email,
      emailVerification: contacts.emailVerification,
      contactPhone: contacts.phone,
      contactPhoneNormalized: contacts.phoneNormalized,
      contactWhatsapp: contacts.whatsapp,
      contactIsDecisionMaker: contacts.isDecisionMaker,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .leftJoin(
      contacts,
      and(
        eq(contacts.companyId, companies.id),
        sql`(${contacts.email} is not null or ${contacts.phone} is not null or ${contacts.whatsapp} is not null or ${contacts.phoneNormalized} is not null)`,
      ),
    )
    .where(
      inArray(
        leads.id,
        pagedLeadIds.map((row) => row.id),
      ),
    );

  const byLead = new Map<string, typeof rows>();
  const leadOrder: string[] = [];
  for (const row of rows) {
    if (!byLead.has(row.leadId)) {
      byLead.set(row.leadId, []);
      leadOrder.push(row.leadId);
    }
    byLead.get(row.leadId)!.push(row);
  }

  const enriched: ReadyLeadExport[] = [];
  for (const leadId of leadOrder) {
    const contactRows = byLead.get(leadId)!;
    const head = contactRows[0]!;
    const eligible = contactRows.filter((row) => !isSuppressed(row.contactEmail));
    const ranked = [...eligible].sort((a, b) => rankContact(toRankInput(b)) - rankContact(toRankInput(a))).slice(0, rankLimit);
    const sourceUrl = (head.sourceUrl as { mapsPlaceUrl?: string } | null)?.mapsPlaceUrl ?? null;
    const discoveredAt = head.discoveredAt ? head.discoveredAt.toISOString() : null;
    for (const c of ranked) {
      enriched.push({
        leadId,
        lead: {
          companyName: head.companyName,
          city: head.city,
          website: head.website,
          contactName: c.contactName,
          contactTitle: c.contactTitle,
          contactEmail: c.contactEmail,
          emailVerification: c.emailVerification,
          contactPhone: c.contactPhoneNormalized ?? c.contactPhone,
          contactWhatsapp: c.contactWhatsapp,
          isDecisionMaker: c.contactIsDecisionMaker,
          sourceUrl,
          discoveredAt,
        },
      });
    }
    if (ranked.length === 0) {
      enriched.push({
        leadId,
        lead: {
          companyName: head.companyName,
          city: head.city,
          website: head.website,
          contactName: null,
          contactTitle: null,
          contactEmail: null,
          emailVerification: null,
          contactPhone: null,
          contactWhatsapp: null,
          isDecisionMaker: null,
          sourceUrl,
          discoveredAt,
        },
      });
    }
  }
  return enriched;
}

function toRankInput(c: {
  contactIsDecisionMaker: boolean | null;
  contactName: string | null;
  contactEmail: string | null;
  contactWhatsapp: string | null;
  contactPhone: string | null;
  contactPhoneNormalized: string | null;
}) {
  return {
    isDecisionMaker: c.contactIsDecisionMaker,
    name: c.contactName,
    email: c.contactEmail,
    whatsapp: c.contactWhatsapp,
    phone: c.contactPhone,
    phoneNormalized: c.contactPhoneNormalized,
  };
}

function rankContact(c: {
  isDecisionMaker: boolean | null;
  name: string | null;
  email: string | null;
  whatsapp: string | null;
  phone: string | null;
  phoneNormalized: string | null;
}): number {
  let score = 0;
  if (c.isDecisionMaker) score += 10;
  if (c.name) score += 4;
  if (c.email) score += 2;
  if (c.whatsapp || waLikely(c.phoneNormalized)) score += 3;
  if (c.phone) score += 1;
  return score;
}

export async function getQueryYields(campaignId: string): Promise<Map<string, { crawled: number; ready: number }>> {
  const rows = await db
    .select({
      query: queryLedger.query,
      crawled: count(queryLedger.id),
      readyCount: sql<number>`coalesce(sum(${queryLedger.leadsProduced}), 0)`,
    })
    .from(queryLedger)
    .where(eq(queryLedger.campaignId, campaignId))
    .groupBy(queryLedger.query);

  const map = new Map<string, { crawled: number; ready: number }>();
  for (const row of rows) map.set(row.query, { crawled: Number(row.crawled), ready: Number(row.readyCount) });
  return map;
}

export async function countReadyLeads(campaignId: string): Promise<number> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.campaignId, campaignId), inArray(leads.status, ["ready", "synced"])));

  return rows.length;
}

export async function countUnassessed(campaignId: string): Promise<number> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.campaignId, campaignId), eq(leads.status, "new")));

  return rows.length;
}

export async function getCampaign(campaignId: string) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));

  return campaign;
}

export async function ensureContactEmailRow(input: {
  companyDedupeKey: string;
  companyId: string;
  email: string;
  emailType: "role" | "personal";
}): Promise<void> {
  const dedupeKey = `${input.companyDedupeKey}|contact|${input.email.toLowerCase()}`;
  const isRole = input.emailType === "role" || isRoleEmail(input.email);
  await db
    .insert(contacts)
    .values({
      dedupeKey,
      companyId: input.companyId,
      name: null,
      title: isRole ? "company/role inbox" : null,
      email: input.email,
      emailType: input.emailType,
      raw: { email: input.email, source: "email-finder", ownerType: isRole ? "organization" : "person" },
      fieldProvenance: { contact: { stage: "email-finder", at: new Date().toISOString() } },
    })
    .onConflictDoNothing({ target: contacts.dedupeKey });
  await refreshCompanyEmailFlag(input.companyId);
}

export async function markLeadsSynced(leadIds: string[]): Promise<void> {
  if (leadIds.length === 0) return;
  await db.update(leads).set({ status: "synced", sheetSyncedAt: new Date(), updatedAt: new Date() }).where(inArray(leads.id, leadIds));
}
