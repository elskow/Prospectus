import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "h3";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns, companies, contacts, leads } from "@src/db/schema";
import { serializeLeadsCsv } from "@src/plugins/builtin/csv/serialize";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  const rows = await db
    .select({
      leadId: leads.id,
      companyName: companies.name,
      city: companies.city,
      website: companies.website,
      raw: companies.raw,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .innerJoin(companies, eq(leads.companyId, companies.id))
    .where(and(eq(leads.campaignId, id), inArray(leads.status, ["ready", "synced"])))
    .orderBy(desc(leads.createdAt));

  const leadCompanyIds = await db
    .select({ id: leads.id, companyId: leads.companyId })
    .from(leads)
    .where(
      inArray(
        leads.id,
        rows.map((r) => r.leadId),
      ),
    );
  const companyIdByLead = new Map(leadCompanyIds.map((r) => [r.id, r.companyId]));

  const contactRows =
    rows.length > 0
      ? await db
          .select({
            companyId: contacts.companyId,
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
              inArray(contacts.companyId, [...companyIdByLead.values()]),
              or(isNotNull(contacts.email), isNotNull(contacts.phone), isNotNull(contacts.phoneNormalized), isNotNull(contacts.whatsapp)),
            ),
          )
      : [];

  const byCompany = new Map<string, typeof contactRows>();
  for (const c of contactRows) (byCompany.get(c.companyId) ?? byCompany.set(c.companyId, []).get(c.companyId))?.push(c);

  const ranked = (list: typeof contactRows) => [...list].sort((a, b) => rank(b) - rank(a)).slice(0, 5);

  const csvRows = rows.flatMap((row) => {
    const companyId = companyIdByLead.get(row.leadId);
    const list = companyId ? (byCompany.get(companyId) ?? []) : [];
    const entries = list.length > 0 ? ranked(list) : [null];
    return entries.map((c) => ({
      companyName: row.companyName,
      city: row.city,
      website: row.website,
      contactName: c?.name ?? null,
      contactTitle: c?.title ?? null,
      contactEmail: c?.email ?? null,
      emailVerification: c?.emailVerification ?? null,
      contactPhone: c?.phoneNormalized ?? c?.phone ?? null,
      contactWhatsapp: c?.whatsapp ?? null,
      isDecisionMaker: c?.isDecisionMaker ?? null,
      sourceUrl: (row.raw as { mapsPlaceUrl?: string } | null)?.mapsPlaceUrl ?? null,
      discoveredAt: row.createdAt ? row.createdAt.toISOString() : null,
    }));
  });

  const csv = serializeLeadsCsv(csvRows);

  setResponseHeader(event, "content-type", "text/csv; charset=utf-8");
  setResponseHeader(event, "content-disposition", `attachment; filename="prospects-${id}.csv"`);
  return csv;
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
