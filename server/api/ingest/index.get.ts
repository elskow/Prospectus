import { desc } from "drizzle-orm";
import { defineEventHandler } from "h3";
import { db } from "@src/db";
import { ingestJobs } from "@src/db/schema";
import { listDirectoryAdapters } from "@src/harness/ingest/registry";
import { ensureAdaptersRegistered } from "@src/harness/ingest/bootstrap";
import { reapStalledIngestJobs } from "@src/harness/ingest/reaper";
import { requireUser } from "@server/utils/auth";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  ensureAdaptersRegistered();
  await reapStalledIngestJobs();
  const jobs = await db.select().from(ingestJobs).orderBy(desc(ingestJobs.createdAt)).limit(20);
  return { adapters: listDirectoryAdapters(), jobs };
});
