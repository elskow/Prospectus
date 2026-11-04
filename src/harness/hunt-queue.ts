import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@src/db";
import { huntJobs, type HuntTargetOutcome } from "@src/db/schema";
import { huntCompany, pickHuntTargets, type HuntFilter } from "@src/harness/master-hunt";

export interface HuntJobView {
  id: string;
  status: string;
  filter: unknown;
  requestedCount: number;
  processedCount: number;
  emailsFound: number;
  outcomes: HuntTargetOutcome[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const CONCURRENCY = 6;
const STALL_REAP_INTERVAL_MS = 5 * 60_000;
const STALL_THRESHOLD = "15 minutes";
let lastReapAt = 0;

async function reapStalledJobs(): Promise<void> {
  const now = Date.now();
  if (now - lastReapAt < STALL_REAP_INTERVAL_MS) return;
  lastReapAt = now;
  await db
    .update(huntJobs)
    .set({ status: "failed", error: "stalled: no progress for 15m", finishedAt: new Date() })
    .where(sql`${huntJobs.status} = 'running' and ${huntJobs.updatedAt} < now() - ${STALL_THRESHOLD}::interval`)
    .catch(() => {});
}

function toView(row: typeof huntJobs.$inferSelect): HuntJobView {
  return {
    id: row.id,
    status: row.status,
    filter: row.filter ?? {},
    requestedCount: row.requestedCount,
    processedCount: row.processedCount,
    emailsFound: row.emailsFound,
    outcomes: row.outcomes ?? [],
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

async function executeHuntJob(jobId: string, targets: { id: string; name: string; website: string }[]): Promise<void> {
  const queue = [...targets];
  let processed = 0;
  let emailsFound = 0;
  let failures = 0;
  let firstError: string | null = null;
  const outcomes: HuntTargetOutcome[] = [];

  const flush = async () => {
    await db.update(huntJobs).set({ processedCount: processed, emailsFound, outcomes, updatedAt: new Date() }).where(eq(huntJobs.id, jobId));
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) return;
        try {
          const result = await huntCompany(target);
          emailsFound += result.emailsFound;
          outcomes.push({ companyId: target.id, emailsFound: result.emailsFound, outcome: result.outcome });
        } catch (error) {
          failures += 1;
          outcomes.push({ companyId: target.id, emailsFound: 0, outcome: "site_unreachable" });
          firstError ??= error instanceof Error ? error.message : String(error);
        }
        processed += 1;
        await flush();
      }
    }),
  );

  const allFailed = failures === targets.length;
  await db
    .update(huntJobs)
    .set({
      status: allFailed ? "failed" : "succeeded",
      processedCount: processed,
      emailsFound,
      outcomes,
      error: allFailed ? firstError : null,
      updatedAt: new Date(),
      finishedAt: new Date(),
    })
    .where(eq(huntJobs.id, jobId));
}

export async function createHuntJob(input: { filter: HuntFilter; createdByUserId: string }): Promise<{ jobId: string; requestedCount: number }> {
  await reapStalledJobs();
  const jobId = randomUUID();
  const targets = await pickHuntTargets(input.filter);

  await db.insert(huntJobs).values({
    id: jobId,
    status: "running",
    filter: input.filter,
    requestedCount: targets.length,
    processedCount: 0,
    emailsFound: 0,
    createdByUserId: input.createdByUserId,
  });

  return { jobId, requestedCount: targets.length };
}

export async function runHuntJob(jobId: string): Promise<void> {
  const [row] = await db.select({ filter: huntJobs.filter, status: huntJobs.status }).from(huntJobs).where(eq(huntJobs.id, jobId)).limit(1);
  if (!row || row.status !== "running") return;
  const targets = await pickHuntTargets(filterOf(row.filter));
  if (targets.length === 0) {
    await db
      .update(huntJobs)
      .set({ status: "succeeded", requestedCount: 0, processedCount: 0, emailsFound: 0, updatedAt: new Date(), finishedAt: new Date() })
      .where(eq(huntJobs.id, jobId));
    return;
  }
  await executeHuntJob(jobId, targets);
}

function filterOf(raw: unknown): HuntFilter {
  return raw && typeof raw === "object" ? (raw as HuntFilter) : {};
}

export async function getHuntJob(jobId: string): Promise<HuntJobView | null> {
  await reapStalledJobs();
  const [row] = await db.select().from(huntJobs).where(eq(huntJobs.id, jobId)).limit(1);
  return row ? toView(row) : null;
}

export async function listHuntJobs(limit = 20): Promise<HuntJobView[]> {
  await reapStalledJobs();
  const rows = await db
    .select()
    .from(huntJobs)
    .orderBy(sql`${huntJobs.createdAt} desc`)
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(toView);
}
