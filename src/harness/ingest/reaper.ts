import { sql } from "drizzle-orm";
import { db } from "@src/db";
import { ingestJobs } from "@src/db/schema";

const STALL_REAP_INTERVAL_MS = 5 * 60_000;
let lastReapAt = 0;

export function reapStalledIngestJobs(): Promise<void> {
  const now = Date.now();
  if (now - lastReapAt < STALL_REAP_INTERVAL_MS) return Promise.resolve();
  lastReapAt = now;
  return db
    .update(ingestJobs)
    .set({ status: "failed", error: "stalled: no progress for 30m", finishedAt: new Date() })
    .where(sql`${ingestJobs.status} in ('queued', 'running') and ${ingestJobs.updatedAt} < now() - interval '30 minutes' and ${ingestJobs.finishedAt} is null`)
    .then(() => undefined)
    .catch(() => undefined);
}
