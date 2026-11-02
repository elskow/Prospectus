import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { runEvents } from "@src/db/schema";
import { getLatestRunView, getRunView } from "@src/harness/run-queue";
import { and, desc, eq, gt } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const query = getQuery(event);
  const queueId = typeof query.queueId === "string" ? query.queueId : null;
  const sinceRaw = typeof query.since === "string" ? query.since : null;
  const since = sinceRaw ? new Date(sinceRaw) : null;

  const run = queueId ? await getRunView(queueId) : await getLatestRunView(id);
  if (!run) {
    return { queueId: null, status: "idle", progress: [], error: null, result: null, runId: null, cursor: null };
  }
  if (run.campaignId !== id) throw createError({ statusCode: 404, statusMessage: "run not found" });

  const events = await db
    .select({ stage: runEvents.stage, message: runEvents.message, at: runEvents.createdAt })
    .from(runEvents)
    .where(
      since && !Number.isNaN(since.getTime())
        ? and(eq(runEvents.campaignId, id), eq(runEvents.runId, run.queueId), gt(runEvents.createdAt, since))
        : and(eq(runEvents.campaignId, id), eq(runEvents.runId, run.queueId)),
    )
    .orderBy(desc(runEvents.createdAt))
    .limit(200);

  const progress = events.slice().reverse();

  return {
    queueId: run.queueId,
    runId: run.runId,
    status: run.status,
    progress,
    cursor: progress.at(-1)?.at ?? since?.toISOString() ?? null,
    error: run.error,
    result: run.result,
  };
});
