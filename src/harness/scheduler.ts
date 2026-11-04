import { Effect } from "effect";
import { db } from "@src/db";
import { campaigns, companies, contacts, leads, runs } from "@src/db/schema";
import { finishRun, requeueExpiredLeases } from "@src/harness/persistence";
import { enqueueRun } from "@src/harness/run-queue";
import { pruneCache } from "@src/harness/websearch/cache";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

const TICK_INTERVAL_MS = 5 * 60_000;
const FIRST_TICK_DELAY_MS = 15_000;
const SCHEDULE_COOLDOWN_FALLBACK_MS = 24 * 60 * 60_000;
const STALE_RUN_THRESHOLD_MS = 10 * 60_000;
let lastDedupeSweepAt = 0;
const DEDUPE_SWEEP_COOLDOWN_MS = 24 * 60 * 60_000;
let lastCachePruneAt = 0;
const CACHE_PRUNE_COOLDOWN_MS = 60 * 60_000;

async function sweepStaleRuns(): Promise<number> {
  const stale = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.heartbeatAt, new Date(Date.now() - STALE_RUN_THRESHOLD_MS))));

  for (const run of stale) {
    await finishRun(run.id, "failed", "run marked failed: process died or run exceeded 1h without a heartbeat");
  }

  return stale.length;
}

const DEDUPE_SIMILARITY_THRESHOLD = 0.6;
const DEDUPE_SWEEP_LIMIT = 40;

async function sweepFuzzyDuplicates(): Promise<number> {
  await db.execute(sql`select set_limit(${DEDUPE_SIMILARITY_THRESHOLD})`);
  const candidates = await db.execute(sql`
    select
      a.id as keep_id, b.id as drop_id,
      a.website as keep_website, a.phone as keep_phone,
      b.website as drop_website, b.phone as drop_phone
    from companies a
    join companies b
      on a.id < b.id
      and a.name % b.name
      and lower(coalesce(a.city, '')) = lower(coalesce(b.city, ''))
      and left(lower(a.name), 1) = left(lower(b.name), 1)
      and (
        (a.website is not null and b.website is not null
          and regexp_replace(lower(a.website), '^https?://(www\.)?', '') = regexp_replace(lower(b.website), '^https?://(www\.)?', ''))
        or (a.phone is not null and b.phone is not null
          and regexp_replace(a.phone, '\D', '', 'g') = regexp_replace(b.phone, '\D', '', 'g')
          and length(regexp_replace(a.phone, '\D', '', 'g')) >= 8)
      )
    limit ${DEDUPE_SWEEP_LIMIT}
  `);

  const rows = candidates as unknown as { keep_id: string; drop_id: string }[];
  let merged = 0;
  for (const row of rows) {
    const keepId = row.keep_id;
    const dropId = row.drop_id;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into lead_sources (lead_id, source_id, scraped_at)
          select keep_leads.id, drop_ls.source_id, drop_ls.scraped_at
          from lead_sources drop_ls
          join leads drop_leads on drop_leads.id = drop_ls.lead_id and drop_leads.company_id = ${dropId}
          join leads keep_leads on keep_leads.company_id = ${keepId} and keep_leads.campaign_id = drop_leads.campaign_id
          on conflict do nothing
        `);
        await tx.execute(sql`
          delete from leads d
          where d.company_id = ${dropId}
            and exists (select 1 from leads k where k.company_id = ${keepId} and k.campaign_id = d.campaign_id)
        `);
        await tx.update(leads).set({ companyId: keepId }).where(eq(leads.companyId, dropId));
        await tx.execute(sql`
          delete from contacts c
          where c.company_id = ${dropId}
            and exists (select 1 from contacts k where k.dedupe_key = c.dedupe_key)
        `);
        await tx.update(contacts).set({ companyId: keepId }).where(eq(contacts.companyId, dropId));
        await tx.delete(companies).where(eq(companies.id, dropId));
      });
      merged += 1;
    } catch (error) {
      console.error(`[scheduler] dedupe merge ${dropId} -> ${keepId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return merged;
}

export interface SchedulerTickResult {
  started: string[];
}

export async function schedulerTick(): Promise<SchedulerTickResult> {
  const lock = await db.execute(sql`select pg_try_advisory_lock(728364512789) as acquired`);
  const acquired = (lock as unknown as { acquired: boolean }[])[0]?.acquired ?? false;
  if (!acquired) return { started: [] };
  try {
    return await runSchedulerTick();
  } finally {
    await db.execute(sql`select pg_advisory_unlock(728364512789)`).catch(() => {});
  }
}

async function runSchedulerTick(): Promise<SchedulerTickResult> {
  await requeueExpiredLeases().catch(() => 0);
  await sweepStaleRuns();
  if (Date.now() - lastCachePruneAt >= CACHE_PRUNE_COOLDOWN_MS) {
    lastCachePruneAt = Date.now();
    Effect.runFork(Effect.ignore(pruneCache()));
  }
  if (Date.now() - lastDedupeSweepAt >= DEDUPE_SWEEP_COOLDOWN_MS) {
    lastDedupeSweepAt = Date.now();
    try {
      const merged = await sweepFuzzyDuplicates();
      if (merged > 0) console.log(`[scheduler] fuzzy-dedupe sweep merged ${merged} duplicate companies`);
    } catch (error) {
      console.error(`[scheduler] fuzzy-dedupe sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const due = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, "active"), eq(campaigns.scheduleEnabled, true)));

  const started: string[] = [];

  for (const campaign of due) {
    const [lastScheduled] = await db
      .select({ startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.campaignId, campaign.id), eq(runs.trigger, "schedule")))
      .orderBy(desc(runs.startedAt))
      .limit(1);

    const cooldownMs = Math.max(60_000, (campaign.scheduleIntervalHours ?? 4) * 60 * 60_000);
    if (lastScheduled && Date.now() - lastScheduled.startedAt.getTime() < cooldownMs) continue;

    const { created } = await enqueueRun({
      campaignId: campaign.id,
      trigger: "schedule",
      request: {
        userId: campaign.userId,
        goalNewReadyLeads: campaign.dailyLeadGoal,
        maxTurns: campaign.maxTurnsPerRun ?? null,
        resume: true,
      },
    }).catch(() => ({ created: false, id: "" }));

    if (created) started.push(campaign.id);
  }

  return { started };
}

export function startScheduler(): void {
  const first = setTimeout(() => {
    void schedulerTick();
  }, FIRST_TICK_DELAY_MS);

  first.unref();

  const timer = setInterval(() => {
    void schedulerTick();
  }, TICK_INTERVAL_MS);

  timer.unref();
}
