import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { campaigns, runEvents, runs } from "@src/db/schema";
import { runGoalLoop } from "@src/harness/goal-loop";
import { claimRunById, renewRunLease } from "@src/harness/persist/runs";
import { failQueuedRun, saveRunResult } from "@src/harness/run-queue";
import { resolveSources } from "@src/harness/source-resolver";
import { buildMastraStages } from "@src/harness/stages";

const LEASE_MS = 120_000;
const LEASE_RENEW_MS = 30_000;
const CANCEL_GRACE_MS = 8_000;

function log(message: string): void {
  process.stderr.write(`[run-worker] ${message}\n`);
}

async function main(): Promise<number> {
  const queueId = process.argv[2] ?? process.env.RUN_QUEUE_ID ?? "";
  if (!queueId) {
    log("missing run id: pass it as the first argument or RUN_QUEUE_ID");
    return 2;
  }

  const owner = `${process.pid}:${queueId.slice(0, 8)}`;
  const claimed = await claimRunById(queueId, owner, LEASE_MS);
  if (!claimed) {
    log(`run ${queueId} is not queued (already claimed or finished)`);
    return 0;
  }

  const campaignId = String(claimed.campaign_id ?? "");
  const [row] = await db.select().from(runs).where(eq(runs.id, queueId)).limit(1);
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);

  if (!campaign) {
    await failQueuedRun(queueId, "campaign not found");
    return 1;
  }

  const request = row?.request ?? {};
  const leaseTimer = setInterval(() => {
    void renewRunLease(queueId, owner, LEASE_MS).catch(() => {});
  }, LEASE_RENEW_MS);
  leaseTimer.unref?.();

  try {
    const sources = await resolveSources();
    if (sources.length === 0) {
      await failQueuedRun(queueId, "no usable source adapters configured: connect Google Maps, LinkedIn, X, or Threads in Settings");
      return 1;
    }

    let cancelled = false;
    let pauseRequested = false;
    let cancelWatchdog: ReturnType<typeof setTimeout> | null = null;
    const cancelTimer = setInterval(() => {
      void db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, queueId))
        .limit(1)
        .then(([current]) => {
          if (current?.status === "paused") pauseRequested = true;
          if (current?.status !== "cancelled" || cancelled) return;
          cancelled = true;
          cancelWatchdog = setTimeout(() => {
            log(`run ${queueId} cancelled mid-flight; exiting after grace period`);
            process.exit(0);
          }, CANCEL_GRACE_MS);
          cancelWatchdog.unref?.();
        })
        .catch(() => {});
    }, 3_000);
    cancelTimer.unref?.();

    try {
      const result = await runGoalLoop(
        {
          stages: buildMastraStages(),
          sources,
          shouldCancel: () => cancelled,
          shouldPause: () => pauseRequested,
          onProgress: (event) => {
            void db
              .insert(runEvents)
              .values({
                runId: queueId,
                campaignId,
                stage: event.stage,
                message: event.message,
                detail: event.detail ?? null,
                durationMs: event.durationMs ?? null,
              })
              .catch(() => {});
          },
        },
        {
          campaignId,
          userId: request.userId ?? campaign.userId,
          trigger: (claimed.trigger as "schedule" | "chat" | "manual") ?? "manual",
          goalNewReadyLeads: request.goalNewReadyLeads ?? campaign.dailyLeadGoal,
          maxTurns: request.maxTurns ?? campaign.maxTurnsPerRun ?? null,
          maxWallClockHours: 12,
          resume: request.resume === true,
          runId: queueId,
        },
      );

      await saveRunResult(queueId, {
        status: result.status,
        reason: result.reason,
        turnsUsed: result.turnsUsed,
        costUsd: result.costUsdUsed,
        newReadyLeads: result.newReadyLeads,
        totalReadyLeads: result.totalReadyLeads,
        errors: result.errors.slice(0, 50),
      });
      return 0;
    } finally {
      clearInterval(cancelTimer);
      if (cancelWatchdog) clearTimeout(cancelWatchdog);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`run ${queueId} failed: ${message}`);
    await failQueuedRun(queueId, message).catch(() => {});
    return 1;
  } finally {
    clearInterval(leaseTimer);
  }
}

const code = await main();
process.exit(code);
