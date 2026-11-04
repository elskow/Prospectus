import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { campaigns, ingestJobs, leads, runEvents, runs } from "@src/db/schema";
import { enqueueRun, getLatestPausedRun, getLatestRunView, getRunView, requestRunCancel, requestRunPause } from "@src/harness/run-queue";
import { seedMarkets } from "@src/harness/markets";
import { campaignNotFound, invalidArguments, noActiveRun, ToolError } from "../errors";
import { campaignFor, resolveUserId, spawnWorker, type ToolDefinition } from "./shared";

export async function runRunTools(): Promise<ToolDefinition[]> {
  return [
    {
      name: "start_run",
      description:
        "Queue a campaign run as a background job. Returns immediately with a queueId; the job survives client disconnects and runs in a separate worker process. Pass idempotencyKey to make retries safe. If a run is already active, no new job is queued.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        goalCompaniesWithEmail: z.number().int().min(1).max(5000).optional(),
        maxTurns: z.number().int().min(1).max(50).optional(),
        idempotencyKey: z.string().min(8).max(120).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            goalCompaniesWithEmail: z.number().int().min(1).max(5000).optional(),
            maxTurns: z.number().int().min(1).max(50).optional(),
            idempotencyKey: z.string().min(8).max(120).optional(),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);

        const {
          id: queueId,
          created,
          reason,
        } = await enqueueRun({
          campaignId: campaign.id,
          trigger: "manual",
          idempotencyKey: parsed.idempotencyKey ?? null,
          request: {
            userId,
            goalNewReadyLeads: parsed.goalCompaniesWithEmail ?? campaign.dailyLeadGoal,
            maxTurns: parsed.maxTurns ?? campaign.maxTurnsPerRun ?? null,
          },
        });

        if (reason === "capacity") {
          throw new ToolError("CAP_REACHED", "run capacity reached: wait for an active run to finish");
        }
        if (created) spawnWorker(queueId);

        return {
          campaignId: campaign.id,
          queueId,
          status: created ? "queued" : "already-active",
          note: created ? "background job queued; poll run_status" : "a run is already active for this campaign",
        };
      },
    },
    {
      name: "cancel_run",
      description: "Cancel a queued or running campaign job by queueId. Cancellation is cooperative: the worker stops at its next checkpoint.",
      schema: z.object({ queueId: z.string().uuid() }),
      handler: async (input) => {
        const { queueId } = z.object({ queueId: z.string().uuid() }).parse(input);
        return { queueId, cancelled: await requestRunCancel(queueId) };
      },
    },
    {
      name: "run_status",
      description:
        "Latest run for a campaign: status (queued, running, succeeded, failed, cancelled, paused), turns, result and recent progress events. Runs are durable background jobs, so this is accurate even if the client that started it disconnected.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        eventLimit: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        const { campaignId, eventLimit } = z
          .object({ campaignId: z.string().uuid().optional(), eventLimit: z.number().int().min(1).max(100).optional() })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);
        const run = await getLatestRunView(campaign.id);
        if (!run) return { campaignId: campaign.id, status: "idle", events: [] };

        const events = await db
          .select({ stage: runEvents.stage, message: runEvents.message, at: runEvents.createdAt })
          .from(runEvents)
          .where(and(eq(runEvents.campaignId, campaign.id), eq(runEvents.runId, run.queueId)))
          .orderBy(desc(runEvents.createdAt))
          .limit(eventLimit ?? 20);

        return { campaignId: campaign.id, queueId: run.queueId, status: run.status, result: run.result, error: run.error, events: events.reverse() };
      },
    },
    {
      name: "list_runs",
      description: "Recent run history for a campaign, newest first: status, reason, turns, cost, timestamps. Use it to audit what an unattended agent did.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        since: z.string().optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({ campaignId: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional(), since: z.string().optional() })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const since = parsed.since ? new Date(parsed.since) : null;

        const rows = await db
          .select({
            id: runs.id,
            status: runs.status,
            trigger: runs.trigger,
            turns: runs.turns,
            costUsd: runs.costUsd,
            error: runs.error,
            result: runs.result,
            startedAt: runs.startedAt,
            finishedAt: runs.finishedAt,
            attempt: runs.attempt,
          })
          .from(runs)
          .where(
            since && !Number.isNaN(since.getTime())
              ? and(eq(runs.campaignId, campaign.id), sql`${runs.startedAt} >= ${since}`)
              : eq(runs.campaignId, campaign.id),
          )
          .orderBy(desc(runs.startedAt))
          .limit(parsed.limit ?? 20);

        return {
          campaignId: campaign.id,
          runs: rows.map((row) => ({
            queueId: row.id,
            status: row.status,
            trigger: row.trigger,
            reason: row.result?.reason ?? row.error,
            turns: row.turns,
            costUsd: row.costUsd,
            attempt: row.attempt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
          })),
        };
      },
    },
    {
      name: "pause_run",
      description:
        "Pause the active run of a campaign at the next turn boundary. Progress is checkpointed so resume_run continues from it. Nothing is lost; the worker exits cleanly.",
      schema: z.object({ campaignId: z.string().uuid().optional(), queueId: z.string().uuid().optional() }),
      handler: async (input) => {
        const parsed = z.object({ campaignId: z.string().uuid().optional(), queueId: z.string().uuid().optional() }).parse(input);
        const queueId = parsed.queueId ?? (await getLatestRunView((await campaignFor(await resolveUserId(), parsed.campaignId)).id))?.queueId;
        if (!queueId) throw noActiveRun("no run to pause");
        return { queueId, paused: await requestRunPause(queueId) };
      },
    },
    {
      name: "resume_run",
      description:
        "Resume the campaign's paused run, continuing from its checkpointed state (accepted insights, planned and completed queries, stall counters). Returns a new queueId.",
      schema: z.object({ campaignId: z.string().uuid().optional() }),
      handler: async (input) => {
        const { campaignId } = z.object({ campaignId: z.string().uuid().optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);
        const paused = await getLatestPausedRun(campaign.id);
        if (!paused) return { campaignId: campaign.id, resumed: false, reason: "no paused run for this campaign" };

        const {
          id: queueId,
          created,
          reason,
        } = await enqueueRun({
          campaignId: campaign.id,
          trigger: "manual",
          request: {
            userId,
            goalNewReadyLeads: campaign.dailyLeadGoal,
            maxTurns: campaign.maxTurnsPerRun ?? null,
            resume: true,
          },
        });
        if (reason === "capacity") {
          throw new ToolError("CAP_REACHED", "run capacity reached: wait for an active run to finish");
        }
        if (created) spawnWorker(queueId);
        return { campaignId: campaign.id, resumed: created, queueId, previousQueueId: paused.queueId };
      },
    },
    {
      name: "wait_for_run",
      description:
        "Block until a run finishes or the timeout expires, then return the same payload as run_status. Use this instead of polling in a loop. Returns timedOut: true when the run is still active at the deadline.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        queueId: z.string().uuid().optional(),
        timeoutSeconds: z.number().int().min(1).max(120).optional(),
        since: z.string().optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            queueId: z.string().uuid().optional(),
            timeoutSeconds: z.number().int().min(1).max(120).optional(),
            since: z.string().optional(),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const deadline = Date.now() + (parsed.timeoutSeconds ?? 60) * 1000;

        let run = parsed.queueId ? await getRunView(parsed.queueId) : await getLatestRunView(campaign.id);
        if (!run) return { campaignId: campaign.id, status: "idle", events: [], timedOut: false };

        while (run && ["queued", "running"].includes(run.status) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          run = parsed.queueId ? await getRunView(parsed.queueId) : await getLatestRunView(campaign.id);
        }
        if (!run) return { campaignId: campaign.id, status: "idle", events: [], timedOut: false };

        const sinceDate = parsed.since ? new Date(parsed.since) : null;
        const events = await db
          .select({ stage: runEvents.stage, message: runEvents.message, at: runEvents.createdAt })
          .from(runEvents)
          .where(
            sinceDate && !Number.isNaN(sinceDate.getTime())
              ? and(eq(runEvents.campaignId, campaign.id), eq(runEvents.runId, run.queueId), sql`${runEvents.createdAt} > ${sinceDate}`)
              : and(eq(runEvents.campaignId, campaign.id), eq(runEvents.runId, run.queueId)),
          )
          .orderBy(desc(runEvents.createdAt))
          .limit(40);

        return {
          campaignId: campaign.id,
          queueId: run.queueId,
          status: run.status,
          result: run.result,
          error: run.error,
          timedOut: ["queued", "running"].includes(run.status),
          events: events.reverse(),
        };
      },
    },
    {
      name: "create_campaign",
      description:
        "Create a lead-generation campaign. A campaign defines a niche (what to search), an area (where; comma-separate for several cities), and a daily goal counted in companies with an email on file. Markets are seeded automatically from area x niche. Before calling this, confirm the sector scope (with examples), area coverage, and exclusions with the user, and present a draft; a one-line request is incomplete. Use it before start_run when the user asks for a new search.",
      schema: z.object({
        name: z.string().min(1).max(120),
        niche: z.string().min(1).max(300),
        area: z.string().max(200).optional(),
        notes: z.string().max(2000).optional(),
        exclusions: z.array(z.string().min(2).max(100)).max(50).optional(),
        dailyLeadGoal: z.number().int().min(1).max(10000).optional(),
        maxTurnsPerRun: z.number().int().min(1).max(50).optional(),
        exportMode: z.enum(["one_per_company", "all_contacts"]).optional(),
        sheetSpreadsheetId: z.string().min(10).max(200).optional(),
        sheetName: z.string().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            name: z.string().min(1).max(120),
            niche: z.string().min(1).max(300),
            area: z.string().max(200).optional(),
            notes: z.string().max(2000).optional(),
            exclusions: z.array(z.string().min(2).max(100)).max(50).optional(),
            dailyLeadGoal: z.number().int().min(1).max(10000).optional(),
            maxTurnsPerRun: z.number().int().min(1).max(50).optional(),
            exportMode: z.enum(["one_per_company", "all_contacts"]).optional(),
            sheetSpreadsheetId: z.string().min(10).max(200).optional(),
            sheetName: z.string().min(1).max(100).optional(),
          })
          .parse(input);
        const userId = await resolveUserId();

        const existing = await db
          .select({ id: campaigns.id, name: campaigns.name, niche: campaigns.niche, area: campaigns.area })
          .from(campaigns)
          .where(and(eq(campaigns.userId, userId), sql`lower(${campaigns.name}) = lower(${parsed.name})`))
          .limit(1);
        if (existing[0]) {
          const seededExisting = await seedMarkets(existing[0].id, existing[0].niche, existing[0].area).catch(() => 0);
          return {
            campaignId: existing[0].id,
            name: existing[0].name,
            niche: existing[0].niche,
            area: existing[0].area,
            marketsSeeded: seededExisting,
            created: false,
          };
        }

        const inserted = await db
          .insert(campaigns)
          .values({
            userId,
            name: parsed.name,
            niche: parsed.niche,
            area: parsed.area ?? null,
            notes: parsed.notes ?? null,
            exclusions: parsed.exclusions ?? [],
            status: "active",
            dailyLeadGoal: parsed.dailyLeadGoal ?? 100,
            maxTurnsPerRun: parsed.maxTurnsPerRun ?? null,
            exportMode: parsed.exportMode ?? "one_per_company",
            sinkConfig:
              parsed.sheetSpreadsheetId || parsed.sheetName
                ? {
                    googleSheets: {
                      ...(parsed.sheetSpreadsheetId ? { spreadsheetId: parsed.sheetSpreadsheetId } : {}),
                      ...(parsed.sheetName ? { sheetName: parsed.sheetName } : {}),
                    },
                  }
                : {},
          })
          .returning({ id: campaigns.id, name: campaigns.name, niche: campaigns.niche, area: campaigns.area });
        const campaign = inserted[0];
        if (!campaign) throw invalidArguments("campaign insert failed");

        const seeded = await seedMarkets(campaign.id, campaign.niche, campaign.area).catch(() => 0);
        return { campaignId: campaign.id, name: campaign.name, niche: campaign.niche, area: campaign.area, marketsSeeded: seeded, created: true };
      },
    },
    {
      name: "update_campaign",
      description:
        "Update a campaign: name, niche, area, notes, exclusions, daily goal, turn/cost caps, schedule, or its Google Sheets destination (sheetSpreadsheetId, sheetName). Changing niche or area seeds additional markets.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        name: z.string().min(1).max(120).optional(),
        niche: z.string().min(1).max(300).optional(),
        area: z.string().max(200).nullish(),
        notes: z.string().max(2000).nullish(),
        exclusions: z.array(z.string().min(2).max(100)).max(50).optional(),
        dailyLeadGoal: z.number().int().min(1).max(10000).optional(),
        maxTurnsPerRun: z.number().int().min(1).max(50).nullish(),
        exportMode: z.enum(["one_per_company", "all_contacts"]).optional(),
        scheduleEnabled: z.boolean().optional(),
        scheduleIntervalHours: z.number().int().min(1).max(24).optional(),
        sheetSpreadsheetId: z.string().min(10).max(200).nullish(),
        sheetName: z.string().min(1).max(100).nullish(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            name: z.string().min(1).max(120).optional(),
            niche: z.string().min(1).max(300).optional(),
            area: z.string().max(200).nullish(),
            notes: z.string().max(2000).nullish(),
            exclusions: z.array(z.string().min(2).max(100)).max(50).optional(),
            dailyLeadGoal: z.number().int().min(1).max(10000).optional(),
            maxTurnsPerRun: z.number().int().min(1).max(50).nullish(),
            exportMode: z.enum(["one_per_company", "all_contacts"]).optional(),
            scheduleEnabled: z.boolean().optional(),
            scheduleIntervalHours: z.number().int().min(1).max(24).optional(),
            sheetSpreadsheetId: z.string().min(10).max(200).nullish(),
            sheetName: z.string().min(1).max(100).nullish(),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const { campaignId: _ignored, sheetSpreadsheetId, sheetName, ...fields } = parsed;

        const updates: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([, value]) => (value !== undefined && value !== null && value !== false ? true : value === false)),
        );

        if (sheetSpreadsheetId !== undefined || sheetName !== undefined) {
          updates.sinkConfig = {
            googleSheets: {
              ...(sheetSpreadsheetId ? { spreadsheetId: sheetSpreadsheetId } : {}),
              ...(sheetName ? { sheetName } : {}),
            },
          };
        }

        if (Object.keys(updates).length === 0) throw invalidArguments("no fields to update");

        const updated = await db
          .update(campaigns)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(campaigns.id, campaign.id))
          .returning({
            id: campaigns.id,
            name: campaigns.name,
            niche: campaigns.niche,
            area: campaigns.area,
            dailyLeadGoal: campaigns.dailyLeadGoal,
            sinkConfig: campaigns.sinkConfig,
          });
        const row = updated[0];
        if (!row) throw invalidArguments("campaign update failed");

        if (parsed.niche || parsed.area !== undefined) {
          await seedMarkets(row.id, row.niche, row.area).catch(() => 0);
        }

        return { campaign: row };
      },
    },
    {
      name: "delete_campaign",
      description:
        "Permanently delete a campaign and everything under it (leads, companies attributed only to it via cascade, markets, runs, events). Requires confirm: true. Cancel any active run first; the worker will be stopped by the cascade.",
      schema: z.object({ campaignId: z.string().uuid(), confirm: z.literal(true) }),
      handler: async (input) => {
        const parsed = z.object({ campaignId: z.string().uuid(), confirm: z.literal(true) }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const deleted = await db
          .delete(campaigns)
          .where(and(eq(campaigns.id, campaign.id), eq(campaigns.userId, userId)))
          .returning({ id: campaigns.id });
        return { campaignId: campaign.id, deleted: deleted.length > 0 };
      },
    },
  ];
}
