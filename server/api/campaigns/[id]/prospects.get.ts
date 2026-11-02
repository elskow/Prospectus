import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns, companies, contacts, leadSources, leads, sources } from "@src/db/schema";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  const [totals] = await db
    .select({
      total: count(),
      ready: sql<number>`count(*) filter (where ${leads.status} in ('ready', 'synced'))::int`,
      synced: sql<number>`count(*) filter (where ${leads.status} = 'synced')::int`,
    })
    .from(leads)
    .where(eq(leads.campaignId, id));

  const rows = await db
    .select({
      id: leads.id,
      status: leads.status,
      enrichmentStatus: leads.enrichmentStatus,
      sheetSyncedAt: leads.sheetSyncedAt,
      createdAt: leads.createdAt,
      companyName: companies.name,
      companyWebsite: companies.website,
      companyPhone: companies.phone,
      companyCity: companies.city,
      companyIndustry: companies.industryCategory,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .where(eq(leads.campaignId, id))
    .orderBy(desc(leads.createdAt))
    .limit(500);

  const leadIds = rows.map((r) => r.id);

  const contactRows =
    leadIds.length > 0
      ? await db
          .select({
            leadId: leads.id,
            id: contacts.id,
            name: contacts.name,
            title: contacts.title,
            email: contacts.email,
            emailVerification: contacts.emailVerification,
            phone: contacts.phone,
            phoneNormalized: contacts.phoneNormalized,
            whatsapp: contacts.whatsapp,
            linkedinUrl: contacts.linkedinUrl,
            isDecisionMaker: contacts.isDecisionMaker,
          })
          .from(contacts)
          .innerJoin(companies, eq(contacts.companyId, companies.id))
          .innerJoin(leads, eq(leads.companyId, companies.id))
          .where(and(eq(leads.campaignId, id), inArray(leads.id, leadIds)))
      : [];

  const contactsByLead: Record<string, LeadContactRow[]> = {};
  for (const row of contactRows) {
    (contactsByLead[row.leadId] ??= []).push({
      id: row.id,
      name: row.name,
      title: row.title,
      email: row.email,
      emailVerification: row.emailVerification,
      phone: row.phone,
      phoneNormalized: row.phoneNormalized,
      whatsapp: row.whatsapp,
      linkedinUrl: row.linkedinUrl,
      isDecisionMaker: row.isDecisionMaker,
    });
  }
  for (const list of Object.values(contactsByLead)) {
    list.sort((a, b) => rank(b) - rank(a));
  }

  const sourceRows =
    leadIds.length > 0
      ? await db
          .select({ leadId: leadSources.leadId, adapterType: sources.adapterType, query: sources.query, url: sources.url })
          .from(leadSources)
          .innerJoin(sources, eq(leadSources.sourceId, sources.id))
          .where(inArray(leadSources.leadId, leadIds))
      : [];

  const sourcesByLead: Record<string, string[]> = {};
  for (const row of sourceRows) {
    const label = row.adapterType.replace("source:", "") + (row.query ? ` "${row.query}"` : row.url ? ` ${row.url}` : "");
    (sourcesByLead[row.leadId] ??= []).push(label);
  }

  return {
    campaign,
    totals: { total: totals?.total ?? 0, ready: totals?.ready ?? 0, synced: totals?.synced ?? 0 },
    leads: rows.map((row) => ({
      ...row,
      contacts: contactsByLead[row.id] ?? [],
      sourceLabels: [...new Set(sourcesByLead[row.id] ?? [])],
    })),
  };
});

function rank(c: {
  isDecisionMaker: boolean | null;
  name: string | null;
  email: string | null;
  whatsapp: string | null;
  phoneNormalized: string | null;
  phone: string | null;
}): number {
  let score = 0;
  if (c.isDecisionMaker) score += 10;
  if (c.name) score += 4;
  if (c.email) score += 2;
  if (c.whatsapp) score += 3;
  if (c.phoneNormalized || c.phone) score += 1;
  return score;
}

interface LeadContactRow {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  emailVerification: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  whatsapp: string | null;
  linkedinUrl: string | null;
  isDecisionMaker: boolean | null;
}
