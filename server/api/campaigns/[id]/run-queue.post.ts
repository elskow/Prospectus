import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "h3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { enqueueRun } from "@src/harness/run-queue";
import { spawnRunWorker } from "@server/utils/run-spawner";

const enqueueSchema = z.object({
  goalNewReadyLeads: z.number().int().min(1).max(1000).optional(),
  maxTurns: z.number().int().min(1).max(20).optional(),
  resume: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const body = enqueueSchema.parse(await readBody(event).catch(() => ({})));

  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  const goalNewReadyLeads = body.goalNewReadyLeads ?? campaign.dailyLeadGoal;
  const maxTurns = body.maxTurns ?? campaign.maxTurnsPerRun ?? null;

  const {
    id: queueId,
    created,
    reason,
  } = await enqueueRun({
    campaignId: campaign.id,
    trigger: "manual",
    idempotencyKey: body.idempotencyKey ?? null,
    request: {
      userId: user.id,
      goalNewReadyLeads,
      maxTurns,
      resume: body.resume === true,
    },
  });

  if (!queueId) {
    throw createError({
      statusCode: 429,
      statusMessage: reason === "capacity" ? "run capacity reached: wait for an active run to finish" : "could not enqueue run",
    });
  }

  if (created) spawnRunWorker(queueId);

  setResponseStatus(event, 202);
  return { queueId, status: created ? "queued" : "already-active" };
});
