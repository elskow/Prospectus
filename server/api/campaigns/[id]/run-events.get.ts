import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns, runEvents } from "@src/db/schema";
import { and, desc, eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  const query = getQuery(event);
  const limitRaw = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const rows = await db
    .select({
      id: runEvents.id,
      runId: runEvents.runId,
      stage: runEvents.stage,
      message: runEvents.message,
      createdAt: runEvents.createdAt,
    })
    .from(runEvents)
    .where(eq(runEvents.campaignId, id))
    .orderBy(desc(runEvents.createdAt))
    .limit(limit);

  return {
    events: rows.reverse().map((row) => ({
      id: row.id,
      runId: row.runId,
      stage: row.stage,
      message: row.message,
      at: row.createdAt.toISOString(),
    })),
  };
});
