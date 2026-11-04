import { randomUUID } from "node:crypto";
import { db } from "@src/db";
import { runs } from "@src/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export async function startRun(campaignId: string, trigger: "schedule" | "manual", queuedRunId?: string): Promise<string | null> {
  if (queuedRunId) {
    const claimed = await db.execute<{ id: string }>(sql`
      update runs
      set status = 'running', started_at = now(), heartbeat_at = now(), trace_id = ${queuedRunId}
      where id = ${queuedRunId} and campaign_id = ${campaignId} and status = 'queued'
      returning id
    `);
    const claimedId = (claimed as unknown as { id: string }[])[0]?.id;
    if (claimedId) return claimedId;

    const owned = await db.execute<{ id: string }>(sql`
      select id from runs
      where id = ${queuedRunId} and campaign_id = ${campaignId} and status = 'running' and lease_owner is not null
    `);
    return (owned as unknown as { id: string }[])[0]?.id ?? null;
  }

  const runId = randomUUID();
  const claim = await db.execute<{ id: string }>(sql`
    insert into runs (id, campaign_id, trigger, status, trace_id)
    select ${runId}, ${campaignId}, ${trigger}, 'running', ${runId}
    where not exists (select 1 from runs where campaign_id = ${campaignId} and status in ('running', 'queued'))
    returning id
  `);
  return (claim as unknown as { id: string }[])[0]?.id ?? null;
}

export async function finishRun(runId: string, status: "succeeded" | "failed" | "cancelled", error?: string): Promise<void> {
  await db
    .update(runs)
    .set({ status, error: error ?? null, finishedAt: new Date() })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["running", "failed"])));
}

export async function completePausedRun(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "succeeded", error: null, finishedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "paused")));
}

export async function markRunTurns(runId: string, turns: number): Promise<void> {
  await db
    .update(runs)
    .set({ turns })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["running"])));
}

export async function markRunCost(runId: string, costUsd: number): Promise<void> {
  await db
    .update(runs)
    .set({ costUsd })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["running"])));
}

export async function touchRunHeartbeat(runId: string): Promise<void> {
  await db.execute(sql`
    update runs
    set heartbeat_at = now(),
        lease_expires_at = case
          when lease_owner is null then lease_expires_at
          else now() + interval '120 seconds'
        end
    where id = ${runId} and status = 'running'
  `);
}

export interface RunResumeState {
  acceptedInsights: string[];
  plannedQueryNorms: string[];
  completedQueryNorms: string[];
  stallTurns: number;
  newReadyThisRun: number;
  goalNewReadyLeads: number;
}

export async function pauseRun(runId: string, turnsUsed: number, costUsdUsed: number, resumeState: RunResumeState): Promise<void> {
  await db.update(runs).set({ status: "paused", turns: turnsUsed, costUsd: costUsdUsed, resumeState }).where(eq(runs.id, runId));
}

export async function getPausedRun(campaignId: string): Promise<{ id: string; turns: number; costUsd: number; resumeState: RunResumeState | null } | null> {
  const [row] = await db
    .select({ id: runs.id, turns: runs.turns, costUsd: runs.costUsd, resumeState: runs.resumeState })
    .from(runs)
    .where(and(eq(runs.campaignId, campaignId), eq(runs.status, "paused")))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  if (!row) return null;
  const state = row.resumeState as RunResumeState | null;
  return { id: row.id, turns: row.turns, costUsd: row.costUsd, resumeState: state };
}

export async function resumePausedRun(runId: string): Promise<void> {
  await db.update(runs).set({ status: "running", finishedAt: null, error: null }).where(eq(runs.id, runId));
}

const DEFAULT_LEASE_MS = 120_000;

export async function claimRunById(runId: string, owner: string, leaseMs = DEFAULT_LEASE_MS): Promise<Record<string, unknown> | null> {
  const claimed = await db.execute<Record<string, unknown>>(sql`
    update runs
    set status = 'running',
        lease_owner = ${owner},
        lease_expires_at = now() + (${leaseMs} || ' milliseconds')::interval,
        attempt = attempt + 1,
        started_at = now(),
        heartbeat_at = now(),
        error = null
    where id = ${runId} and status = 'queued'
    returning id, campaign_id, trigger, request
  `);
  return (claimed as unknown as Record<string, unknown>[])[0] ?? null;
}

export async function claimNextQueuedRun(owner: string, leaseMs = DEFAULT_LEASE_MS): Promise<string | null> {
  const claimed = await db.execute<{ id: string }>(sql`
    with next as (
      select id from runs
      where status = 'queued'
      order by started_at
      for update skip locked
      limit 1
    )
    update runs r
    set status = 'running',
        lease_owner = ${owner},
        lease_expires_at = now() + (${leaseMs} || ' milliseconds')::interval,
        attempt = r.attempt + 1,
        started_at = now(),
        heartbeat_at = now(),
        error = null
    from next
    where r.id = next.id
    returning r.id
  `);
  return (claimed as unknown as { id: string }[])[0]?.id ?? null;
}

export async function renewRunLease(runId: string, owner: string, leaseMs = DEFAULT_LEASE_MS): Promise<void> {
  await db.execute(sql`
    update runs
    set heartbeat_at = now(),
        lease_expires_at = now() + (${leaseMs} || ' milliseconds')::interval
    where id = ${runId} and lease_owner = ${owner} and status = 'running'
  `);
}

export async function requeueExpiredLeases(maxAttempts = 2): Promise<number> {
  const requeued = await db.execute<{ id: string }>(sql`
    update runs
    set status = case when attempt < ${maxAttempts} then 'queued' else 'failed' end,
        lease_owner = null,
        lease_expires_at = null,
        finished_at = case when attempt < ${maxAttempts} then null else now() end,
        error = case when attempt < ${maxAttempts} then null else 'lease expired after ' || attempt || ' attempt(s)' end
    where status = 'running' and lease_expires_at is not null and lease_expires_at < now()
    returning id
  `);
  return (requeued as unknown as { id: string }[]).length;
}
