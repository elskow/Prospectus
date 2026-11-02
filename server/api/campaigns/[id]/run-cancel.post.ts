import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { getRunView, requestRunCancel } from "@src/harness/run-queue";

const cancelSchema = z.object({ queueId: z.string().optional(), runId: z.string().optional() });

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const body = cancelSchema.parse(await readBody(event));

  const queueId = body.queueId ?? body.runId;
  if (!queueId) return { cancelled: false };

  const run = await getRunView(queueId);
  if (!run || run.campaignId !== id) throw createError({ statusCode: 404, statusMessage: "run not found" });

  return { cancelled: await requestRunCancel(queueId) };
});
