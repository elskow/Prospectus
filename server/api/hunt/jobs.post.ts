import { spawn } from "node:child_process";
import { createError, defineEventHandler, readValidatedBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { createHuntJob } from "@src/harness/hunt-queue";

const bodySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  industry: z.string().trim().min(1).max(160).optional(),
  onlyNoEmail: z.boolean().optional(),
  companyIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export function spawnHuntWorker(jobId: string): void {
  const child = spawn(process.env.BUN_BIN ?? "bun", ["-e", HUNT_WORKER_SNIPPET, "hunt-worker", jobId], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.on("error", (error) => {
    process.stderr.write(`[hunt-spawner] failed to spawn hunt worker for ${jobId}: ${error.message}\n`);
  });
  child.unref();
}

const HUNT_WORKER_SNIPPET = `import { runHuntJob } from "./src/harness/hunt-queue"; runHuntJob(process.argv[2]).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });`;

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const parsed = await readValidatedBody(event, bodySchema.safeParse);
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "invalid hunt filter" });
  const { jobId, requestedCount } = await createHuntJob({ filter: parsed.data, createdByUserId: user.id });
  if (requestedCount > 0) spawnHuntWorker(jobId);
  return { jobId, requestedCount, status: "queued" };
});
