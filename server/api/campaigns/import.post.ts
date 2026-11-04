import { createError, defineEventHandler, readValidatedBody } from "h3";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns, companies, leads } from "@src/db/schema";
import { promoteReadyLeads } from "@src/harness/persistence";
import { createHuntJob } from "@src/harness/hunt-queue";
import { spawnHuntWorker } from "@server/api/hunt/jobs.post";

const bodySchema = z.object({
  campaignId: z.string().uuid(),
  companyIds: z.array(z.string().uuid()).min(1).max(5000),
  hunt: z.boolean().optional(),
});

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const parsed = await readValidatedBody(event, bodySchema.safeParse);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "invalid import payload" });
  const body = parsed.data;

  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, body.campaignId), eq(campaigns.userId, user.id)))
    .limit(1);
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  const existing = await db.select({ id: companies.id }).from(companies).where(inArray(companies.id, body.companyIds));
  const existingIds = existing.map((row) => row.id);

  let imported = 0;
  if (existingIds.length > 0) {
    const inserted = await db
      .insert(leads)
      .values(existingIds.map((companyId) => ({ companyId, campaignId: body.campaignId, status: "new" as const, createdByRunId: null })))
      .onConflictDoNothing({ target: [leads.campaignId, leads.companyId] })
      .returning({ id: leads.id });
    imported = inserted.length;
  }

  await promoteReadyLeads(body.campaignId);

  let huntJobId: string | undefined;
  if (body.hunt && existingIds.length > 0) {
    const filter: Parameters<typeof createHuntJob>[0]["filter"] = { companyIds: existingIds, onlyNoEmail: true };
    const job = await createHuntJob({ filter, createdByUserId: user.id });
    spawnHuntWorker(job.jobId);
    huntJobId = job.jobId;
  }

  return { imported, duplicates: body.companyIds.length - imported, huntJobId };
});
