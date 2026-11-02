import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { spawn } from "node:child_process";
import { campaigns, companies, contacts, ingestJobs, leads, markets, runEvents, runs, suppressions, users } from "@src/db/schema";
import { searchKemenperin } from "@src/harness/ingest/kemenperin";
import { dedupeKeyFor, ensureSource, persistCandidates } from "@src/harness/persistence";
import { domainHasMailInfrastructure } from "@src/harness/osint-contacts";
import { isRoleEmail, websiteMatchesCompany } from "@src/harness/contact-discovery";
import { extractEmails } from "@src/harness/site-crawl/extract";
import { enqueueRun, getLatestPausedRun, getLatestRunView, getRunView, requestRunCancel, requestRunPause } from "@src/harness/run-queue";
import { countMarkets, listMarkets, MAX_MARKETS_PER_CAMPAIGN, retireMarket, seedMarkets, suggestMarkets } from "@src/harness/markets";
import { campaignMetrics } from "@src/harness/metrics";
import { spawnRunWorker } from "@server/utils/run-spawner";
import { campaignNotFound, capReached, invalidArguments, noActiveRun, noUser, ToolError } from "./errors";

interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (input: unknown) => Promise<unknown>;
}

async function resolveUserId(): Promise<string> {
  const email = process.env.PROSPECTUS_MCP_USER_EMAIL;
  const [user] = email
    ? await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    : await db.select({ id: users.id }).from(users).orderBy(users.createdAt).limit(1);

  if (!user) throw noUser();
  return user.id;
}

async function campaignFor(userId: string, campaignId?: string) {
  const where = campaignId ? and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId)) : eq(campaigns.userId, userId);
  const [row] = await db.select().from(campaigns).where(where).orderBy(desc(campaigns.createdAt)).limit(1);
  if (!row) throw campaignNotFound();
  return row;
}

function encodeCursor(row: { id: string; name: string }): string {
  return Buffer.from(`${row.name}\u0000${row.id}`).toString("base64url");
}

function decodeCursor(raw: string | undefined): { name: string; id: string } | null {
  if (!raw) return null;
  try {
    const [name, id] = Buffer.from(raw, "base64url").toString("utf8").split("\u0000");
    if (!name || !id) return null;
    return { name, id };
  } catch {
    return null;
  }
}

function spawnWorker(queueId: string): void {
  spawnRunWorker(queueId);
}

export async function runCampaignTools(): Promise<ToolDefinition[]> {
  return [
    {
      name: "list_campaigns",
      description:
        "List the user's lead-generation campaigns. A campaign defines a niche (what to search), an area (where), and a daily goal counted in companies that have an email address on file.",
      schema: z.object({}),
      handler: async () => {
        const userId = await resolveUserId();
        const rows = await db
          .select({
            id: campaigns.id,
            name: campaigns.name,
            niche: campaigns.niche,
            area: campaigns.area,
            status: campaigns.status,
            dailyLeadGoal: campaigns.dailyLeadGoal,
            scheduleEnabled: campaigns.scheduleEnabled,
          })
          .from(campaigns)
          .where(eq(campaigns.userId, userId))
          .orderBy(desc(campaigns.createdAt));
        return { campaigns: rows };
      },
    },
    {
      name: "campaign_stats",
      description:
        "Totals for one campaign: companies known, ready (have an email on file), still collecting, and email coverage percentage. 'Ready' is what counts toward the daily goal.",
      schema: z.object({ campaignId: z.string().uuid().optional() }),
      handler: async (input) => {
        const { campaignId } = z.object({ campaignId: z.string().uuid().optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);

        const [totals] = await db
          .select({ companies: count(), ready: sql<number>`count(*) filter (where ${leads.status} = 'ready')` })
          .from(leads)
          .where(eq(leads.campaignId, campaign.id));

        const [emailStats] = await db
          .select({ withEmail: sql<number>`count(distinct ${contacts.companyId})` })
          .from(contacts)
          .innerJoin(leads, eq(leads.companyId, contacts.companyId))
          .where(and(eq(leads.campaignId, campaign.id), isNotNull(contacts.email)));

        const total = Number(totals?.companies ?? 0);
        const ready = Number(totals?.ready ?? 0);
        const withEmail = Number(emailStats?.withEmail ?? 0);

        return {
          campaignId: campaign.id,
          name: campaign.name,
          companies: total,
          ready,
          collecting: Math.max(0, total - ready),
          companiesWithEmail: withEmail,
          coveragePct: total > 0 ? Math.round((withEmail / total) * 1000) / 10 : 0,
          dailyLeadGoal: campaign.dailyLeadGoal,
        };
      },
    },
    {
      name: "search_prospects",
      description:
        "Search prospects in a campaign. Returns company name, city, website and the contact email when present. Use emailOnly to restrict to companies that can be emailed. Page with cursor: pass the previous nextCursor to continue.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        query: z.string().max(120).optional(),
        emailOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().max(400).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            query: z.string().max(120).optional(),
            emailOnly: z.boolean().optional(),
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().max(400).optional(),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const limit = parsed.limit ?? 50;
        const after = decodeCursor(parsed.cursor);

        const rows = (await db.execute(sql`
          select c.id, c.name, c.city, c.website, l.status,
                 (select k.email from contacts k where k.company_id = c.id and k.email is not null
                  order by (k.is_decision_maker is true) desc, (k.name is not null) desc, (k.email_verification is not null) desc, k.created_at
                  limit 1) as email
          from companies c
          join leads l on l.company_id = c.id
          where l.campaign_id = ${campaign.id}
            ${parsed.query ? sql`and c.name ilike ${`%${parsed.query}%`}` : sql``}
            ${parsed.emailOnly ? sql`and exists (select 1 from contacts k where k.company_id = c.id and k.email is not null)` : sql``}
            ${after ? sql`and (c.name, c.id) > (${after.name}, ${after.id})` : sql``}
          order by c.name, c.id
          limit ${limit + 1}
        `)) as unknown as { id: string; name: string }[];

        const page = rows.slice(0, limit);
        const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null;
        return { campaignId: campaign.id, prospects: page, nextCursor };
      },
    },
    {
      name: "list_markets",
      description:
        "List a campaign's market queue. Each market is a city × sector unit; a run works one active market, marks it saturated when it stops producing companies with email, then advances to the next pending market.",
      schema: z.object({ campaignId: z.string().uuid().optional() }),
      handler: async (input) => {
        const { campaignId } = z.object({ campaignId: z.string().uuid().optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);
        await seedMarkets(campaign.id, campaign.niche, campaign.area).catch(() => 0);
        const rows = await listMarkets(campaign.id);
        return {
          campaignId: campaign.id,
          markets: rows,
          summary: {
            total: rows.length,
            active: rows.filter((row) => row.status === "active").length,
            pending: rows.filter((row) => row.status === "pending").length,
            saturated: rows.filter((row) => row.status === "saturated").length,
          },
        };
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
      name: "add_market",
      description:
        "Append one or many markets (city × sector) to a campaign's queue so fresh geography keeps producing new companies. The run activates the next pending market automatically once the active one saturates. Pass `cities` for bulk expansion.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        city: z.string().min(2).max(120).optional(),
        cities: z.array(z.string().min(2).max(120)).max(24).optional(),
        sector: z.string().min(2).max(160).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            city: z.string().min(2).max(120).optional(),
            cities: z.array(z.string().min(2).max(120)).max(24).optional(),
            sector: z.string().min(2).max(160).optional(),
          })
          .parse(input);
        const wanted = [...new Set([...(parsed.cities ?? []), ...(parsed.city ? [parsed.city] : [])].map((city) => city.trim()).filter(Boolean))];
        if (wanted.length === 0) throw invalidArguments("pass city or cities");

        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const total = await countMarkets(campaign.id);
        const room = MAX_MARKETS_PER_CAMPAIGN - total;
        if (room <= 0) {
          throw capReached(`campaign already has ${total} markets (cap ${MAX_MARKETS_PER_CAMPAIGN}); retire markets before adding more`);
        }

        const rows = await db
          .insert(markets)
          .values(wanted.slice(0, room).map((city) => ({ campaignId: campaign.id, city, sector: parsed.sector ?? campaign.niche })))
          .onConflictDoNothing()
          .returning({ id: markets.id, city: markets.city, sector: markets.sector, status: markets.status });

        return {
          campaignId: campaign.id,
          requested: wanted.length,
          created: rows.length,
          skippedByCap: Math.max(0, wanted.length - room),
          markets: rows,
          totalMarkets: total + rows.length,
        };
      },
    },
    {
      name: "suggest_markets",
      description:
        "Rank cities the campaign has not used yet, scored by measured query yield from the ledger. Use this when campaign_health returns suggestedAction=add_market, then pass the top cities to add_market(cities).",
      schema: z.object({ campaignId: z.string().uuid().optional(), limit: z.number().int().min(1).max(24).optional() }),
      handler: async (input) => {
        const parsed = z.object({ campaignId: z.string().uuid().optional(), limit: z.number().int().min(1).max(24).optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const suggestions = await suggestMarkets(campaign.id, campaign.niche, parsed.limit ?? 8);
        return { campaignId: campaign.id, suggestions };
      },
    },
    {
      name: "retire_market",
      description:
        "Mark a market saturated so the run stops spending turns on it. Identify it by marketId or city. If the retired market was active, the next pending market is activated immediately.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        marketId: z.string().uuid().optional(),
        city: z.string().min(2).max(120).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({ campaignId: z.string().uuid().optional(), marketId: z.string().uuid().optional(), city: z.string().min(2).max(120).optional() })
          .parse(input);
        if (!parsed.marketId && !parsed.city) throw invalidArguments("pass marketId or city");
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const result = await retireMarket(campaign.id, { marketId: parsed.marketId, city: parsed.city });
        if (!result.retired) throw invalidArguments("market not found for this campaign");
        return { campaignId: campaign.id, retired: result.retired, activated: result.next };
      },
    },
    {
      name: "campaign_metrics",
      description:
        "Throughput metrics for a campaign: emails and companies added in the last hour and day, queries and leads in the last 24h, run outcomes with average turns, per-market gains, and the suppression count. Use it to steer strategy rather than guess.",
      schema: z.object({ campaignId: z.string().uuid().optional() }),
      handler: async (input) => {
        const { campaignId } = z.object({ campaignId: z.string().uuid().optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);
        const metrics = await campaignMetrics(campaign.id);
        if (!metrics) throw campaignNotFound();
        return metrics;
      },
    },
    {
      name: "campaign_health",
      description:
        "One call that answers what to do next for a campaign: active/pending/saturated markets, totals, the last run with its reason, and a suggestedAction (wait, resume_run, start_run, add_market, create_campaign).",
      schema: z.object({ campaignId: z.string().uuid().optional() }),
      handler: async (input) => {
        const { campaignId } = z.object({ campaignId: z.string().uuid().optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);

        const marketRows = await listMarkets(campaign.id);
        const active = marketRows.filter((market) => market.status === "active");
        const pending = marketRows.filter((market) => market.status === "pending");
        const saturated = marketRows.filter((market) => market.status === "saturated");
        const lastRun = await getLatestRunView(campaign.id);

        const [totals] = await db
          .select({ companies: count(), ready: sql<number>`count(*) filter (where ${leads.status} in ('ready', 'synced'))` })
          .from(leads)
          .where(eq(leads.campaignId, campaign.id));
        const [today] = await db
          .select({ ready: sql<number>`count(*)::int` })
          .from(leads)
          .where(and(eq(leads.campaignId, campaign.id), sql`${leads.status} in ('ready', 'synced')`, sql`${leads.updatedAt} >= current_date`));

        const running = lastRun ? ["queued", "running"].includes(lastRun.status) : false;
        const suggestedAction = running
          ? "wait"
          : lastRun?.status === "paused"
            ? "resume_run"
            : pending.length > 0
              ? "start_run"
              : marketRows.length > 0
                ? "add_market"
                : "create_campaign";

        return {
          campaignId: campaign.id,
          name: campaign.name,
          goal: campaign.dailyLeadGoal,
          companies: Number(totals?.companies ?? 0),
          ready: Number(totals?.ready ?? 0),
          readyToday: Number(today?.ready ?? 0),
          markets: {
            total: marketRows.length,
            active: active.map((market) => ({ id: market.id, city: market.city, sector: market.sector, emailed: market.emailed })),
            pending: pending.length,
            saturated: saturated.length,
          },
          lastRun: lastRun
            ? { queueId: lastRun.queueId, status: lastRun.status, reason: lastRun.result?.reason ?? lastRun.error, result: lastRun.result }
            : null,
          suggestedAction,
        };
      },
    },
    {
      name: "agent_brief",
      description:
        "One compact call for an autonomous agent: campaign identity, goal progress, market queue, latest run, latest ingest, and the single next action. Prefer this over several status calls in cron jobs.",
      schema: z.object({ campaignId: z.string().uuid().optional() }),
      handler: async (input) => {
        const { campaignId } = z.object({ campaignId: z.string().uuid().optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);

        const [marketRows, lastRun] = await Promise.all([listMarkets(campaign.id), getLatestRunView(campaign.id)]);
        const active = marketRows.filter((market) => market.status === "active");
        const pending = marketRows.filter((market) => market.status === "pending");
        const saturated = marketRows.filter((market) => market.status === "saturated");

        const [totals] = await db
          .select({ companies: count(), ready: sql<number>`count(*) filter (where ${leads.status} in ('ready', 'synced'))` })
          .from(leads)
          .where(eq(leads.campaignId, campaign.id));

        const [today] = await db
          .select({ ready: sql<number>`count(*)::int` })
          .from(leads)
          .where(and(eq(leads.campaignId, campaign.id), sql`${leads.status} in ('ready', 'synced')`, sql`${leads.updatedAt} >= current_date`));

        const [ingest] = await db
          .select({
            id: ingestJobs.id,
            status: ingestJobs.status,
            pagesDone: ingestJobs.pagesDone,
            pagesTarget: ingestJobs.pagesTarget,
            updatedAt: ingestJobs.updatedAt,
          })
          .from(ingestJobs)
          .where(and(eq(ingestJobs.campaignId, campaign.id), eq(ingestJobs.source, "kemenperin")))
          .orderBy(desc(ingestJobs.createdAt))
          .limit(1);

        const running = lastRun ? ["queued", "running"].includes(lastRun.status) : false;
        const ready = Number(totals?.ready ?? 0);
        const readyToday = Number(today?.ready ?? 0);
        const suggestedAction = running
          ? "wait"
          : lastRun?.status === "paused"
            ? "resume_run"
            : pending.length > 0
              ? "start_run"
              : marketRows.length > 0
                ? "add_market"
                : "create_campaign";

        const blockers: string[] = [];
        if (!running && lastRun?.status === "failed") blockers.push(`last run failed: ${lastRun.error ?? lastRun.result?.reason ?? "unknown"}`);
        if (!running && pending.length === 0) blockers.push("no pending markets");
        if (running && (lastRun?.result?.newReadyLeads ?? 0) === 0) blockers.push("active run has not produced a ready lead yet");

        return {
          campaign: {
            id: campaign.id,
            name: campaign.name,
            niche: campaign.niche,
            area: campaign.area,
            status: campaign.status,
            goal: campaign.dailyLeadGoal,
          },
          progress: {
            ready,
            readyToday,
            goal: campaign.dailyLeadGoal,
            companies: Number(totals?.companies ?? 0),
            remaining: Math.max(0, campaign.dailyLeadGoal - readyToday),
          },
          markets: {
            total: marketRows.length,
            active: active.map((market) => ({ city: market.city, sector: market.sector, emailed: market.emailed })),
            pending: pending.length,
            saturated: saturated.length,
          },
          lastRun: lastRun
            ? {
                queueId: lastRun.queueId,
                status: lastRun.status,
                reason: lastRun.result?.reason ?? lastRun.error,
                turnsUsed: lastRun.result?.turnsUsed ?? null,
                newReadyLeads: lastRun.result?.newReadyLeads ?? null,
              }
            : null,
          ingest: ingest
            ? { id: ingest.id, status: ingest.status, pagesDone: ingest.pagesDone, pagesTarget: ingest.pagesTarget, updatedAt: ingest.updatedAt }
            : null,
          blockers,
          suggestedAction,
        };
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
      name: "import_suppressions",
      description:
        "Record do-not-contact entries so Prospectus never exports them again. Accepts exact emails and/or whole domains, e.g. from the CRM after sending. Applied to exports and lead rows.",
      schema: z.object({
        emails: z.array(z.string().email()).max(500).optional(),
        domains: z.array(z.string().min(3).max(120)).max(500).optional(),
        reason: z.string().max(200).optional(),
        source: z.string().max(80).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            emails: z.array(z.string().email()).max(500).optional(),
            domains: z.array(z.string().min(3).max(120)).max(500).optional(),
            reason: z.string().max(200).optional(),
            source: z.string().max(80).optional(),
          })
          .parse(input);
        const emails = [...new Set((parsed.emails ?? []).map((email) => email.trim().toLowerCase()))];
        const domains = [
          ...new Set(
            (parsed.domains ?? []).map((domain) =>
              domain
                .trim()
                .toLowerCase()
                .replace(/^www\./, ""),
            ),
          ),
        ];
        if (emails.length === 0 && domains.length === 0) throw invalidArguments("pass emails or domains");

        let inserted = 0;
        if (emails.length > 0) {
          const rows = await db
            .insert(suppressions)
            .values(emails.map((email) => ({ email, reason: parsed.reason ?? null, source: parsed.source ?? "manual" })))
            .onConflictDoNothing()
            .returning({ id: suppressions.id });
          inserted += rows.length;
        }
        for (const domain of domains) {
          const rows = await db
            .insert(suppressions)
            .values({ domain, reason: parsed.reason ?? null, source: parsed.source ?? "manual" })
            .onConflictDoNothing()
            .returning({ id: suppressions.id });
          inserted += rows.length;
        }
        return { requested: emails.length + domains.length, inserted };
      },
    },
    {
      name: "import_list",
      description:
        "Import a list the user already has (rows with name and optionally email/phone/website/city). Deduplicates against existing companies and returns a verdict per row: imported, exists, or skipped. Rows are stored with provenance source:manual-import.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        rows: z
          .array(
            z.object({
              name: z.string().min(2).max(200),
              email: z.string().email().optional(),
              phone: z.string().max(40).optional(),
              website: z.string().url().optional(),
              city: z.string().max(120).optional(),
              category: z.string().max(160).optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            rows: z
              .array(
                z.object({
                  name: z.string().min(2).max(200),
                  email: z.string().email().optional(),
                  phone: z.string().max(40).optional(),
                  website: z.string().url().optional(),
                  city: z.string().max(120).optional(),
                  category: z.string().max(160).optional(),
                }),
              )
              .min(1)
              .max(500),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);

        const insertedRun = await db
          .insert(runs)
          .values({
            campaignId: campaign.id,
            status: "succeeded",
            trigger: "manual",
            finishedAt: new Date(),
            result: { status: "succeeded", reason: "import:list", turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 },
          })
          .returning({ id: runs.id });
        const run = insertedRun[0];
        if (!run) throw new Error("failed to record the import run");

        const sourceId = await ensureSource("source:manual-import", "provided list");
        const candidates = parsed.rows.map((row) => ({
          name: row.name,
          phone: row.phone ?? null,
          website: row.website ?? null,
          city: row.city ?? null,
          category: row.category ?? null,
          contacts: row.email ? [{ name: null, title: null, email: row.email.toLowerCase(), phone: null, linkedinUrl: null, isDecisionMaker: null }] : null,
          sourceUrl: row.website ?? null,
        }));

        const verdicts: { name: string; status: "imported" | "exists" | "skipped"; companyId?: string }[] = [];
        const fresh = [];
        for (const candidate of candidates) {
          const key = dedupeKeyFor(candidate);
          let [existing] = await db.select({ id: companies.id }).from(companies).where(eq(companies.dedupeKey, key)).limit(1);
          if (!existing) {
            [existing] = await db
              .select({ id: companies.id })
              .from(companies)
              .where(sql`lower(${companies.name}) = ${candidate.name.toLowerCase()}`)
              .limit(1);
          }
          if (existing) verdicts.push({ name: candidate.name, status: "exists", companyId: existing.id });
          else {
            verdicts.push({ name: candidate.name, status: "imported" });
            fresh.push(candidate);
          }
        }

        const persisted =
          fresh.length > 0
            ? await persistCandidates({ campaignId: campaign.id, runId: run.id, sourceId, candidates: fresh })
            : { newCompanies: 0, newLeads: 0, duplicates: 0 };
        const skipped = verdicts.filter((verdict) => verdict.status === "imported").length - persisted.newCompanies;
        for (let index = verdicts.length - 1; index >= 0 && skipped > 0; index -= 1) {
          if (verdicts[index]?.status !== "imported") continue;
          verdicts[index] = { name: verdicts[index]!.name, status: "skipped" };
        }

        return {
          campaignId: campaign.id,
          requested: parsed.rows.length,
          imported: persisted.newCompanies,
          leads: persisted.newLeads,
          exists: verdicts.filter((verdict) => verdict.status === "exists").length,
          rows: verdicts,
        };
      },
    },
    {
      name: "check_contacts",
      description:
        "Validate a batch of emails and check whether Prospectus already has them: format, domain, MX, role/personal, and existing contact/company/campaign matches.",
      schema: z.object({ emails: z.array(z.string().min(3).max(200)).min(1).max(200) }),
      handler: async (input) => {
        const { emails } = z.object({ emails: z.array(z.string().min(3).max(200)).min(1).max(200) }).parse(input);
        const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()))];

        const found = await db
          .select({
            email: contacts.email,
            companyId: companies.id,
            companyName: companies.name,
            website: companies.website,
            leadStatus: leads.status,
            campaignId: leads.campaignId,
          })
          .from(contacts)
          .innerJoin(companies, eq(companies.id, contacts.companyId))
          .leftJoin(leads, eq(leads.companyId, companies.id))
          .where(sql`lower(${contacts.email}) in ${sql.raw(`(${normalized.map((email) => `'${email.replace(/'/g, "''")}'`).join(",")})`)}`);

        const byEmail = new Map<string, typeof found>();
        for (const row of found) {
          if (!row.email) continue;
          const list = byEmail.get(row.email.toLowerCase()) ?? [];
          list.push(row);
          byEmail.set(row.email.toLowerCase(), list);
        }

        const results = [];
        const domainCache = new Map<string, boolean>();
        const domains = [...new Set(normalized.map((email) => email.split("@")[1] ?? "").filter(Boolean))];
        const queue = [...domains];
        await Promise.all(
          Array.from({ length: Math.min(10, queue.length) }, async () => {
            while (queue.length > 0) {
              const domain = queue.shift();
              if (!domain) return;
              domainCache.set(domain, await domainHasMailInfrastructure(domain).catch(() => false));
            }
          }),
        );

        for (const email of normalized) {
          const domain = email.split("@")[1] ?? "";
          const formatOk = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);
          const mxLive = formatOk && domain ? (domainCache.get(domain) ?? false) : false;
          const matches = byEmail.get(email) ?? [];
          results.push({
            email,
            formatOk,
            domain,
            mxLive,
            role: isRoleEmail(email),
            alreadyInDb: matches.length > 0,
            company: matches[0] ? { id: matches[0].companyId, name: matches[0].companyName, website: matches[0].website } : null,
            campaigns: matches.map((match) => ({ campaignId: match.campaignId, leadStatus: match.leadStatus })),
          });
        }
        return { checked: results.length, results };
      },
    },
    {
      name: "lookup_company",
      description:
        "Look up whether a company is already known: by name, website domain, or contact email. Returns the record, its emails, and the campaigns it appears in.",
      schema: z.object({ name: z.string().max(200).optional(), domain: z.string().max(160).optional(), email: z.string().max(200).optional() }),
      handler: async (input) => {
        const parsed = z
          .object({ name: z.string().max(200).optional(), domain: z.string().max(160).optional(), email: z.string().max(200).optional() })
          .parse(input);
        if (!parsed.name && !parsed.domain && !parsed.email) throw invalidArguments("pass name, domain or email");

        const rows = await db
          .select({
            companyId: companies.id,
            name: companies.name,
            website: companies.website,
            city: companies.city,
            address: companies.address,
            category: companies.industryCategory,
            email: contacts.email,
          })
          .from(companies)
          .leftJoin(contacts, eq(contacts.companyId, companies.id))
          .where(
            parsed.email
              ? sql`lower(${contacts.email}) = ${parsed.email.toLowerCase()}`
              : parsed.domain
                ? sql`(${companies.website} ilike ${`%${parsed.domain}%`} or lower(${contacts.email}) like ${`%@${parsed.domain.toLowerCase()}`})`
                : sql`${companies.name} ilike ${`%${parsed.name}%`}`,
          )
          .limit(20);

        if (rows.length === 0) return { found: false, companies: [] };
        const companyIds = [...new Set(rows.map((row) => row.companyId))];
        const leadRows = await db
          .select({ companyId: leads.companyId, campaignId: leads.campaignId, status: leads.status, createdAt: leads.createdAt })
          .from(leads)
          .where(sql`${leads.companyId} in ${sql.raw(`('${companyIds.join("','")}')`)}`);

        const byCompany = new Map<string, typeof rows>();
        for (const row of rows) {
          const list = byCompany.get(row.companyId) ?? [];
          list.push(row);
          byCompany.set(row.companyId, list);
        }

        return {
          found: true,
          companies: [...byCompany.entries()].map(([companyId, list]) => ({
            id: companyId,
            name: list[0]?.name,
            website: list[0]?.website,
            city: list[0]?.city,
            address: list[0]?.address,
            category: list[0]?.category,
            emails: [...new Set(list.map((row) => row.email).filter((email): email is string => Boolean(email)))],
            leads: leadRows.filter((lead) => lead.companyId === companyId),
          })),
        };
      },
    },
    {
      name: "enrich_from_url",
      description:
        "Given a website URL, crawl its contact/about pages and extract every email found. Returns the addresses; with campaignId and persist=true it also attaches them to a company record.",
      schema: z.object({ url: z.string().url(), campaignId: z.string().uuid().optional(), persist: z.boolean().optional() }),
      handler: async (input) => {
        const parsed = z.object({ url: z.string().url(), campaignId: z.string().uuid().optional(), persist: z.boolean().optional() }).parse(input);
        const origin = new URL(parsed.url).origin;
        const pages = [parsed.url, `${origin}/kontak`, `${origin}/hubungi-kami`, `${origin}/contact`, `${origin}/about`];

        const emails = new Set<string>();
        let pagesRead = 0;
        const fetched = await Promise.all(
          [...new Set(pages)].map(async (page) => {
            try {
              const response = await fetch(page, { headers: { "user-agent": "Mozilla/5.0 Chrome/156" }, signal: AbortSignal.timeout(12_000) });
              if (!response.ok) return null;
              return await response.text();
            } catch {
              return null;
            }
          }),
        );
        for (const html of fetched) {
          if (!html) continue;
          pagesRead += 1;
          for (const email of extractEmails(html).emails) {
            const lower = email.toLowerCase();
            if (lower.endsWith(".png") || lower.endsWith(".jpg")) continue;
            emails.add(lower);
          }
        }

        const found = [...emails];
        if (!parsed.persist || !parsed.campaignId || found.length === 0) {
          return { url: parsed.url, pagesRead, emails: found, persisted: false };
        }

        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const hostname = new URL(parsed.url).hostname.replace(/^www\./, "");
        const name = hostname.split(".")[0] ?? hostname;
        const insertedRun = await db
          .insert(runs)
          .values({
            campaignId: campaign.id,
            status: "succeeded",
            trigger: "manual",
            finishedAt: new Date(),
            result: { status: "succeeded", reason: "enrich:url", turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 },
          })
          .returning({ id: runs.id });
        const run = insertedRun[0];
        if (!run) throw new Error("failed to record the enrichment run");
        const sourceId = await ensureSource("source:url-enrich", parsed.url);
        const persisted = await persistCandidates({
          campaignId: campaign.id,
          runId: run.id,
          sourceId,
          candidates: [
            {
              name,
              website: origin,
              contacts: found.map((email) => ({ name: null, title: null, email, phone: null, linkedinUrl: null, isDecisionMaker: null })),
              sourceUrl: parsed.url,
            },
          ],
        });

        return { url: parsed.url, pagesRead, emails: found, persisted: true, company: persisted.newCompanies > 0 ? "created" : "existing" };
      },
    },
    {
      name: "search_directory",
      description:
        "Search an official company directory by name or KBLI and return matching rows (name, phone, email, KBLI). Use it for targeted lookups; for bulk, use start_ingest.",
      schema: z.object({
        source: z.enum(["kemenperin"]).optional(),
        name: z.string().max(120).optional(),
        kbli: z.string().max(10).optional(),
        limit: z.number().int().min(1).max(80).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            source: z.enum(["kemenperin"]).optional(),
            name: z.string().max(120).optional(),
            kbli: z.string().max(10).optional(),
            limit: z.number().int().min(1).max(80).optional(),
          })
          .parse(input);
        if (!parsed.name && !parsed.kbli) throw invalidArguments("pass name or kbli");
        const rows = await searchKemenperin({ name: parsed.name, kbli: parsed.kbli, limit: parsed.limit });
        return { source: "kemenperin", matched: rows.length, rows };
      },
    },
    {
      name: "start_ingest",
      description:
        "Start a background directory ingest (paginated walk) into a campaign. Returns a jobId immediately; poll ingest_status. Kemenperin carries published emails for ~30k companies.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        source: z.enum(["kemenperin"]).optional(),
        pages: z.number().int().min(1).max(2000).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({ campaignId: z.string().uuid().optional(), source: z.enum(["kemenperin"]).optional(), pages: z.number().int().min(1).max(2000).optional() })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const pages = parsed.pages ?? 50;
        const source = parsed.source ?? "kemenperin";

        const [running] = await db
          .select({ id: ingestJobs.id, pagesTarget: ingestJobs.pagesTarget, pagesDone: ingestJobs.pagesDone })
          .from(ingestJobs)
          .where(and(eq(ingestJobs.campaignId, campaign.id), eq(ingestJobs.source, source), sql`${ingestJobs.status} in ('queued', 'running')`))
          .orderBy(desc(ingestJobs.createdAt))
          .limit(1);
        if (running) {
          return {
            campaignId: campaign.id,
            jobId: running.id,
            source,
            pagesTarget: running.pagesTarget,
            status: "already-running",
            note: `an ingest is already active for this campaign (${running.pagesDone}/${running.pagesTarget} pages)`,
          };
        }

        const inserted = await db.insert(ingestJobs).values({ campaignId: campaign.id, source, pagesTarget: pages }).returning({ id: ingestJobs.id });
        const job = inserted[0];
        if (!job) throw new Error("failed to create ingest job");

        const child = spawn(process.env.BUN_BIN ?? "bun", ["scripts/ingest-kemenperin.ts", campaign.id, String(pages), job.id], {
          cwd: process.cwd(),
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
        child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
        child.unref();

        return { campaignId: campaign.id, jobId: job.id, source, pagesTarget: pages, status: "queued" };
      },
    },
    {
      name: "ingest_status",
      description:
        "Status of directory ingests: pages done, rows seen, emails, new companies/leads, and any error. Pass jobId for one job, or omit for recent jobs.",
      schema: z.object({ jobId: z.string().uuid().optional(), limit: z.number().int().min(1).max(20).optional() }),
      handler: async (input) => {
        const parsed = z.object({ jobId: z.string().uuid().optional(), limit: z.number().int().min(1).max(20).optional() }).parse(input);
        const rows = await db
          .select()
          .from(ingestJobs)
          .where(parsed.jobId ? eq(ingestJobs.id, parsed.jobId) : undefined)
          .orderBy(desc(ingestJobs.createdAt))
          .limit(parsed.limit ?? 5);
        return {
          jobs: rows.map((row) => ({
            jobId: row.id,
            campaignId: row.campaignId,
            source: row.source,
            status: row.status,
            pages: `${row.pagesDone}/${row.pagesTarget}`,
            rowsSeen: row.rowsSeen,
            rowsWithEmail: row.rowsWithEmail,
            newCompanies: row.newCompanies,
            newLeads: row.newLeads,
            error: row.error,
            startedAt: row.createdAt,
            finishedAt: row.finishedAt,
          })),
        };
      },
    },
    {
      name: "export_prospects",
      description:
        "Export a campaign's prospects as CSV text (company, city, website, email, status). Use emailOnly to export only companies with an email address. Page with cursor: pass the previous nextCursor.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        emailOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        cursor: z.string().max(400).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            emailOnly: z.boolean().optional(),
            limit: z.number().int().min(1).max(5000).optional(),
            cursor: z.string().max(400).optional(),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const limit = parsed.limit ?? 500;
        const after = decodeCursor(parsed.cursor);

        const rows = (await db.execute(sql`
          select c.id, c.name, coalesce(c.city, '') as city, coalesce(c.website, '') as website,
                 coalesce((select k.email from contacts k where k.company_id = c.id and k.email is not null
                           order by (k.is_decision_maker is true) desc, (k.name is not null) desc, (k.email_verification is not null) desc, k.created_at
                           limit 1), '') as email,
                 l.status
          from companies c
          join leads l on l.company_id = c.id
          where l.campaign_id = ${campaign.id}
            ${parsed.emailOnly ? sql`and exists (select 1 from contacts k where k.company_id = c.id and k.email is not null)` : sql``}
            ${after ? sql`and (c.name, c.id) > (${after.name}, ${after.id})` : sql``}
          order by c.name, c.id
          limit ${limit + 1}
        `)) as unknown as { id: string; name: string; city: string; website: string; email: string; status: string }[];

        const suppressedEmails = new Set(
          (await db.select({ email: suppressions.email }).from(suppressions))
            .map((row) => row.email?.toLowerCase())
            .filter((email): email is string => Boolean(email)),
        );
        const suppressedDomains = new Set(
          (await db.select({ domain: suppressions.domain }).from(suppressions))
            .map((row) => row.domain?.toLowerCase())
            .filter((domain): domain is string => Boolean(domain)),
        );
        const usable = rows.filter((row) => {
          const email = row.email.toLowerCase();
          if (!email) return true;
          if (suppressedEmails.has(email)) return false;
          return !suppressedDomains.has(email.split("@")[1] ?? "");
        });

        const page = usable.slice(0, limit);
        const nextCursor = rows.length > limit ? encodeCursor((page[page.length - 1] ?? rows[limit - 1])!) : null;

        const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const lines = ["company,city,website,email,status"];
        for (const row of page) {
          lines.push([row.name, row.city, row.website, row.email, row.status].map(escape).join(","));
        }

        return { campaignId: campaign.id, rowCount: lines.length - 1, nextCursor, csv: lines.join("\n") };
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
