import { db } from "@src/db";
import { campaigns, companies, contacts, leadSources, leads, queryLedger, suppressions } from "@src/db/schema";
import { isRoleEmail, isPersonalLinkedInUrl, nameMatchesEmail } from "@src/harness/contact-discovery";
import type { LeadCandidate, LeadContact } from "@src/harness/schemas";
import type { SinkLead } from "@src/adapters/sink";
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

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
  campaignId: string;
  runId: string;
  sourceId: string;
  candidates: LeadCandidate[];
}

export interface PersistOutput {
  newCompanies: number;
  newLeads: number;
  duplicates: number;
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

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9+]/g, "");
  let national = digits.replace(/^\+?62/, "0").replace(/\D/g, "");
  if (national.startsWith("62")) national = `0${national.slice(2)}`;
  if (!national.startsWith("0") || national.length < 9 || national.length > 14) return null;
  return `+62${national.slice(1)}`;
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
    saved += 1;
  }
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

const GENERIC_NAME_PATTERN =
  /^(perusahaan|pt|cv|ud|kantor|toko|usaha|bisnis|company|business|pabrik|distributor|supplier|vendor|agent|agen)(\s+(manufaktur|manufacturing|industri|industry|umum|general|jasa|services|logistik|logistics|konsultan|consulting|teknik|engineering|dagang|trading|spbu|grosir|wholesale|eceran|retail))?$/i;

export function isGenericCompanyName(name: string): boolean {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length < 3) return true;
  return GENERIC_NAME_PATTERN.test(normalized);
}

export async function persistCandidates(input: PersistInput): Promise<PersistOutput> {
  const result: PersistOutput = { newCompanies: 0, newLeads: 0, duplicates: 0 };

  const [campaign] = await db.select({ exclusions: campaigns.exclusions }).from(campaigns).where(eq(campaigns.id, input.campaignId));
  const exclusions = campaign?.exclusions ?? [];

  for (const candidate of input.candidates) {
    if (isGenericCompanyName(candidate.name)) {
      result.duplicates += 1;
      continue;
    }
    if (matchesExclusions(candidate, exclusions)) {
      result.duplicates += 1;
      continue;
    }
    const dedupeKey = dedupeKeyFor(candidate);
    const coords = mapsUrlCoords(candidate.sourceUrl);
    const inserted = await db
      .insert(companies)
      .values({
        dedupeKey,
        name: candidate.name,
        website: candidate.website ?? null,
        address: candidate.address ?? null,
        city: candidate.city ?? null,
        phone: candidate.phone ?? null,
        industryCategory: candidate.category ?? null,
        rating: candidate.rating ?? null,
        reviewCount: candidate.reviewCount ?? null,
        productsServices: candidate.productsServices ?? null,
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        raw: candidate.sourceUrl ? { mapsPlaceUrl: candidate.sourceUrl } : null,
        fieldProvenance: {
          name: { sourceId: input.sourceId, stage: "discover", runId: input.runId, at: new Date().toISOString() },
        },
        createdByRunId: input.runId,
      })
      .onConflictDoNothing({ target: companies.dedupeKey })
      .returning({ id: companies.id });

    let companyId = inserted[0]?.id;

    if (!companyId) {
      const [existing] = await db.select({ id: companies.id }).from(companies).where(eq(companies.dedupeKey, dedupeKey));
      if (!existing) {
        result.duplicates += 1;
        continue;
      }
      companyId = existing.id;
      if (coords) {
        await db
          .update(companies)
          .set({ latitude: coords.lat, longitude: coords.lng })
          .where(and(eq(companies.id, companyId), sql`(${companies.latitude} is null or ${companies.longitude} is null)`));
      }
    } else {
      result.newCompanies += 1;
    }

    await upsertContacts(dedupeKey, companyId, input, candidate);

    if (candidate.phone) {
      const identity = `phone:${candidate.phone}`.toLowerCase().replace(/[^a-z0-9.:@/-]+/g, "-");
      await db
        .insert(contacts)
        .values({
          dedupeKey: `${dedupeKey}|contact|${identity}`,
          companyId,
          name: null,
          title: null,
          email: null,
          emailType: null,
          phone: candidate.phone,
          phoneNormalized: normalizePhone(candidate.phone),
          waLikely: null,
          whatsapp: null,
          linkedinUrl: null,
          isDecisionMaker: null,
          raw: null,
          fieldProvenance: { phone: { stage: "discover", sourceId: input.sourceId, runId: input.runId, at: new Date().toISOString() } },
        })
        .onConflictDoNothing({ target: contacts.dedupeKey });
    }

    const [existingLead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.campaignId, input.campaignId), eq(leads.companyId, companyId)));

    if (existingLead) {
      result.duplicates += 1;
      await db.insert(leadSources).values({ leadId: existingLead.id, sourceId: input.sourceId }).onConflictDoNothing();
      continue;
    }

    const [lead] = await db
      .insert(leads)
      .values({
        companyId,
        campaignId: input.campaignId,
        status: "new",
        createdByRunId: input.runId,
      })
      .returning({ id: leads.id });

    if (!lead) {
      result.duplicates += 1;
      continue;
    }

    await db.insert(leadSources).values({ leadId: lead.id, sourceId: input.sourceId }).onConflictDoNothing();
    result.newLeads += 1;
  }

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

export async function findReadyLeads(campaignId: string): Promise<SinkLead[]> {
  const [campaign] = await db.select({ exportMode: campaigns.exportMode }).from(campaigns).where(eq(campaigns.id, campaignId));
  const perCompany = campaign?.exportMode !== "all_contacts";

  const suppressedEmails = new Set(
    (await db.select({ email: suppressions.email }).from(suppressions))
      .map((row) => row.email?.toLowerCase())
      .filter((email): email is string => Boolean(email)),
  );
  const suppressedDomains = new Set(
    (await db.select({ domain: suppressions.domain }).from(suppressions))
      .map((row) => row.domain?.toLowerCase())
      .filter((domain): domain is string => Boolean(domain)),
  );
  const isSuppressed = (email: string | null): boolean => {
    if (!email) return false;
    const lower = email.toLowerCase();
    if (suppressedEmails.has(lower)) return true;
    const domain = lower.split("@")[1] ?? "";
    return domain.length > 0 && suppressedDomains.has(domain);
  };

  const rows = await db
    .select({
      leadId: leads.id,
      companyName: companies.name,
      city: companies.city,
      website: companies.website,
      sourceUrl: companies.raw,
      discoveredAt: leads.createdAt,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(leads.campaignId, campaignId), eq(leads.status, "ready"), isNull(leads.sheetSyncedAt)))
    .limit(500);

  const enriched: SinkLead[] = [];
  for (const row of rows) {
    const companyId = await companyIdOfLead(row.leadId);
    if (!companyId) continue;
    const contactRows = await db
      .select({
        name: contacts.name,
        title: contacts.title,
        email: contacts.email,
        emailVerification: contacts.emailVerification,
        phone: contacts.phone,
        phoneNormalized: contacts.phoneNormalized,
        whatsapp: contacts.whatsapp,
        isDecisionMaker: contacts.isDecisionMaker,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.companyId, companyId),
          sql`(${contacts.email} is not null or ${contacts.phone} is not null or ${contacts.whatsapp} is not null or ${contacts.phoneNormalized} is not null)`,
        ),
      );

    const eligible = contactRows.filter((contact) => !isSuppressed(contact.email));
    const ranked = [...eligible].sort((a, b) => rankContact(b) - rankContact(a)).slice(0, perCompany ? 1 : 5);
    const sourceUrl = (row.sourceUrl as { mapsPlaceUrl?: string } | null)?.mapsPlaceUrl ?? null;
    for (const c of ranked) {
      enriched.push({
        companyName: row.companyName,
        city: row.city,
        website: row.website,
        contactName: c.name,
        contactTitle: c.title,
        contactEmail: c.email,
        emailVerification: c.emailVerification,
        contactPhone: c.phoneNormalized ?? c.phone,
        contactWhatsapp: c.whatsapp,
        isDecisionMaker: c.isDecisionMaker,
        sourceUrl,
        discoveredAt: row.discoveredAt ? row.discoveredAt.toISOString() : null,
      });
    }
    if (ranked.length === 0) {
      enriched.push({
        companyName: row.companyName,
        city: row.city,
        website: row.website,
        contactName: null,
        contactTitle: null,
        contactEmail: null,
        emailVerification: null,
        contactPhone: null,
        contactWhatsapp: null,
        isDecisionMaker: null,
        sourceUrl,
        discoveredAt: row.discoveredAt ? row.discoveredAt.toISOString() : null,
      });
    }
  }
  return enriched;
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

async function companyIdOfLead(leadId: string): Promise<string | null> {
  const [row] = await db.select({ companyId: leads.companyId }).from(leads).where(eq(leads.id, leadId));
  return row?.companyId ?? null;
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
}

export async function findReadyLeadIds(campaignId: string): Promise<string[]> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.campaignId, campaignId), eq(leads.status, "ready"), isNull(leads.sheetSyncedAt)))
    .limit(1000);
  return rows.map((r) => r.id);
}

export async function markLeadsSynced(leadIds: string[]): Promise<void> {
  if (leadIds.length === 0) return;
  await db.update(leads).set({ status: "synced", sheetSyncedAt: new Date(), updatedAt: new Date() }).where(inArray(leads.id, leadIds));
}
