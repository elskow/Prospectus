import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { and, eq, lt } from "drizzle-orm";
import { db } from "@src/db";
import { runs } from "@src/db/schema";
import { requeueExpiredLeases } from "@src/harness/persistence";

const WORKER_ENTRY = resolve(process.cwd(), "workers/run-worker.ts");
const DISPATCH_GRACE_MS = 5_000;
const MAX_DISPATCH_PER_TICK = 3;

export function spawnRunWorker(queueId: string): void {
  const child = spawn(process.env.BUN_BIN ?? "bun", [WORKER_ENTRY, queueId], {
    env: { ...process.env, RUN_QUEUE_ID: queueId },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.on("error", (error) => {
    process.stderr.write(`[run-spawner] failed to spawn worker for ${queueId}: ${error.message}\n`);
  });
  child.unref();
}

export async function dispatchQueuedRuns(): Promise<number> {
  await requeueExpiredLeases().catch(() => 0);

  const queued = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, "queued"), lt(runs.startedAt, new Date(Date.now() - DISPATCH_GRACE_MS))))
    .limit(MAX_DISPATCH_PER_TICK);

  for (const row of queued) spawnRunWorker(row.id);
  return queued.length;
}
