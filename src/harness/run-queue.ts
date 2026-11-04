import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@src/db";
import { runs } from "@src/db/schema";

export interface RunRequest {
  userId?: string;
  goalNewReadyLeads?: number;
  maxTurns?: number | null;
  resume?: boolean;
}

export interface RunView {
  queueId: string;
  runId: string;
  campaignId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "paused";
  error: string | null;
  result: {
    status: string;
    reason?: string;
    turnsUsed: number;
    costUsd?: number;
    newReadyLeads: number;
    totalReadyLeads: number;
    errors?: { stage: string; code: string; message: string }[];
  } | null;
}

const ACTIVE: RunView["status"][] = ["queued", "running"];

const MAX_ACTIVE_RUNS = Number(process.env.MAX_ACTIVE_RUNS ?? 3);

export async function activeRunCount(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(runs)
    .where(inArray(runs.status, ACTIVE));
  return Number(row?.total ?? 0);
}

export async function enqueueRun(input: {
  campaignId: string;
  trigger: "schedule" | "manual";
  request: RunRequest;
  idempotencyKey?: string | null;
}): Promise<{ id: string; created: boolean; reason?: "exists" | "capacity" }> {
  if ((await activeRunCount()) >= MAX_ACTIVE_RUNS) {
    const existing = await findActiveRun(input.campaignId);
    return existing ? { id: existing.id, created: false, reason: "exists" } : { id: "", created: false, reason: "capacity" };
  }

  const inserted = await db.execute<{ id: string }>(sql`
    insert into runs (campaign_id, status, trigger, request, idempotency_key)
    values (${input.campaignId}, 'queued', ${input.trigger}, ${JSON.stringify(input.request)}::jsonb, ${input.idempotencyKey ?? null})
    on conflict do nothing
    returning id
  `);

  const created = (inserted as unknown as { id: string }[])[0];
  if (created) return { id: created.id, created: true };

  const existing = await findActiveRun(input.campaignId);
  if (existing) return { id: existing.id, created: false, reason: "exists" };

  const [latest] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.campaignId, input.campaignId), eq(runs.status, "queued")))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return { id: latest?.id ?? "", created: false, reason: "exists" };
}

export async function findActiveRun(campaignId: string): Promise<{ id: string; status: string } | null> {
  const [row] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.campaignId, campaignId), inArray(runs.status, ACTIVE)))
    .limit(1);
  return row ?? null;
}

export async function getRunView(queueId: string): Promise<RunView | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, queueId)).limit(1);
  if (!row) return null;
  return toView(row);
}

export async function getLatestRunView(campaignId: string): Promise<RunView | null> {
  const [row] = await db.select().from(runs).where(eq(runs.campaignId, campaignId)).orderBy(desc(runs.startedAt)).limit(1);
  return row ? toView(row) : null;
}

function toView(row: typeof runs.$inferSelect): RunView {
  return {
    queueId: row.id,
    runId: row.traceId ?? row.id,
    campaignId: row.campaignId,
    status: row.status as RunView["status"],
    error: row.error,
    result: row.result ?? null,
  };
}

export async function requestRunCancel(queueId: string): Promise<boolean> {
  const updated = await db.execute<{ id: string }>(sql`
    update runs set status = 'cancelled', error = coalesce(error, 'cancelled by user'), finished_at = now()
    where id = ${queueId} and status in ('queued', 'running')
    returning id
  `);
  return (updated as unknown as { id: string }[]).length > 0;
}

export async function requestRunPause(queueId: string): Promise<boolean> {
  const updated = await db.execute<{ id: string }>(sql`
    update runs set status = 'paused', lease_owner = null, lease_expires_at = null
    where id = ${queueId} and status in ('queued', 'running')
    returning id
  `);
  return (updated as unknown as { id: string }[]).length > 0;
}

export async function getLatestPausedRun(campaignId: string): Promise<RunView | null> {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.campaignId, campaignId), eq(runs.status, "paused")))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return row ? toView(row) : null;
}

export async function isRunCancelled(queueId: string): Promise<boolean> {
  const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, queueId)).limit(1);
  return row?.status === "cancelled";
}

export async function saveRunResult(queueId: string, result: RunView["result"]): Promise<void> {
  if (!result) return;
  await db.update(runs).set({ result }).where(eq(runs.id, queueId));
}

export async function failQueuedRun(queueId: string, error: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(and(eq(runs.id, queueId), inArray(runs.status, ["queued", "running"])));
}
