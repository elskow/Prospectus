import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireUser } from "@server/utils/auth";
import { getHuntJob } from "@src/harness/hunt-queue";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing job id" });
  const job = await getHuntJob(id);
  if (!job) throw createError({ statusCode: 404, statusMessage: "hunt job not found" });
  return { job };
});
