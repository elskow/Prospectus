import { eq } from "drizzle-orm";
import { createError, defineEventHandler, getRouterParam } from "h3";
import { db } from "@src/db";
import { ingestJobs } from "@src/db/schema";
import { requireUser } from "@server/utils/auth";
import { ensureAdaptersRegistered } from "@src/harness/ingest/bootstrap";
import { reapStalledIngestJobs } from "@src/harness/ingest/reaper";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  ensureAdaptersRegistered();
  await reapStalledIngestJobs();
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing job id" });
  const [job] = await db.select().from(ingestJobs).where(eq(ingestJobs.id, id));
  if (!job) throw createError({ statusCode: 404, statusMessage: "ingest job not found" });
  return { job };
});
