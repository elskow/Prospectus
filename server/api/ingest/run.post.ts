import { spawn } from "node:child_process";
import { createError, defineEventHandler, readValidatedBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { ingestJobs } from "@src/db/schema";
import { getDirectoryAdapter, listDirectoryAdapters } from "@src/harness/ingest/registry";
import { ensureAdaptersRegistered } from "@src/harness/ingest/bootstrap";

const bodySchema = z.object({
  adapterId: z.string().trim().min(1),
  pages: z.number().int().min(1).max(5000).optional(),
  campaignId: z.string().uuid().optional(),
});

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  ensureAdaptersRegistered();
  const parsed = await readValidatedBody(event, bodySchema.safeParse);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "invalid ingest body" });
  const { adapterId, pages, campaignId } = parsed.data;
  const adapter = getDirectoryAdapter(adapterId);
  if (!adapter)
    throw createError({
      statusCode: 400,
      statusMessage: `unknown directory adapter: ${adapterId}. known: ${listDirectoryAdapters()
        .map((a) => a.id)
        .join(", ")}`,
    });

  const inserted = await db
    .insert(ingestJobs)
    .values({
      campaignId: campaignId ?? null,
      source: adapterId,
      status: "queued",
      pagesTarget: pages ?? adapter.defaultPageSize,
    })
    .returning({ id: ingestJobs.id });
  const job = inserted[0];
  if (!job) throw createError({ statusCode: 500, statusMessage: "failed to create the ingest job" });

  const args = ["scripts/ingest-directory.ts", adapterId, String(pages ?? adapter.defaultPageSize), job.id];
  if (campaignId) args.push("--campaign", campaignId);
  const child = spawn(process.env.BUN_BIN ?? "bun", args, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.on("error", (error) => {
    process.stderr.write(`[ingest-spawner] failed to spawn ingest worker for ${job.id}: ${error.message}\n`);
  });
  child.unref();

  return { jobId: job.id, pagesTarget: pages ?? adapter.defaultPageSize, status: "queued" };
});
