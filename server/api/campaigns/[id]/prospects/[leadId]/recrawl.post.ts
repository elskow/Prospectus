import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { companies, contacts, leads } from "@src/db/schema";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const campaignId = getRouterParam(event, "id");
  const leadId = getRouterParam(event, "leadId");
  if (!campaignId || !leadId) throw createError({ statusCode: 400, statusMessage: "missing ids" });

  const [lead] = await db
    .select({ id: leads.id, companyId: leads.companyId })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.campaignId, campaignId)));
  if (!lead) throw createError({ statusCode: 404, statusMessage: "lead not found" });

  await db.delete(contacts).where(eq(contacts.companyId, lead.companyId));

  await db.update(leads).set({ status: "new", enrichmentStatus: "pending", sheetSyncedAt: null, updatedAt: new Date() }).where(eq(leads.id, leadId));

  return { ok: true, leadId, message: "re-crawl queued: contacts regenerate on the next run" };
});
