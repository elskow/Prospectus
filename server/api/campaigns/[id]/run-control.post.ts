import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns, runs } from "@src/db/schema";
import { finishRun } from "@src/harness/persistence";
import { schedulerTick } from "@src/harness/scheduler";

const controlSchema = z.object({ action: z.enum(["start", "stop"]) });

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const body = controlSchema.parse(await readBody(event));

  const [campaign] = await db
    .select({ id: campaigns.id, status: campaigns.status, scheduleEnabled: campaigns.scheduleEnabled })
    .from(campaigns)
    .where(eq(campaigns.id, id));
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  if (body.action === "start") {
    await db.update(campaigns).set({ status: "active", scheduleEnabled: true, updatedAt: new Date() }).where(eq(campaigns.id, id));
    void schedulerTick();
    return { campaignId: id, mode: "continuous", running: true };
  }

  await db.update(campaigns).set({ status: "paused", scheduleEnabled: false, updatedAt: new Date() }).where(eq(campaigns.id, id));

  const [activeRun] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.campaignId, id), eq(runs.status, "running")))
    .limit(1);

  if (activeRun) {
    await finishRun(activeRun.id, "cancelled", "campaign stopped by user");
  }

  return { campaignId: id, mode: "continuous", running: false };
});
