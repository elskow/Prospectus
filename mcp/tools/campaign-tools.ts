import { count, desc, eq, isNotNull, sql, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { campaigns, companies, contacts, ingestJobs, leads, markets, runEvents } from "@src/db/schema";
import { countMarkets, listMarkets, MAX_MARKETS_PER_CAMPAIGN, retireMarket, seedMarkets, suggestMarkets } from "@src/harness/markets";
import { enqueueRun, getLatestRunView, requestRunCancel } from "@src/harness/run-queue";
import { campaignMetrics } from "@src/harness/metrics";
import { campaignNotFound, capReached, invalidArguments, ToolError } from "../errors";
import { campaignFor, decodeCursor, encodeCursor, resolveUserId, spawnWorker, type ToolDefinition } from "./shared";

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
        "Search prospects in a campaign. Returns company name, city, country, website and the contact email when present. Use emailOnly to restrict to companies that can be emailed, country to restrict to one country. Page with cursor: pass the previous nextCursor.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        query: z.string().max(120).optional(),
        emailOnly: z.boolean().optional(),
        country: z.string().min(2).max(80).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().max(400).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            query: z.string().max(120).optional(),
            emailOnly: z.boolean().optional(),
            country: z.string().min(2).max(80).optional(),
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().max(400).optional(),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const limit = parsed.limit ?? 50;
        const after = decodeCursor(parsed.cursor);

        const rows = (await db.execute(sql`
          select c.id, c.name, c.city, c.country, c.website, l.status,
                 (select k.email from contacts k where k.company_id = c.id and k.email is not null
                  order by (k.is_decision_maker is true) desc, (k.name is not null) desc, (k.email_verification is not null) desc, k.created_at
                  limit 1) as email
          from companies c
          join leads l on l.company_id = c.id
          where l.campaign_id = ${campaign.id}
            ${parsed.query ? sql`and c.name ilike ${`%${parsed.query}%`}` : sql``}
            ${parsed.emailOnly ? sql`and exists (select 1 from contacts k where k.company_id = c.id and k.email is not null)` : sql``}
            ${parsed.country ? sql`and c.country = ${parsed.country}` : sql``}
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
        "One compact call for an autonomous agent: campaign identity, goal progress, market queue, latest run, latest ingest, master database stats (total companies, with email, needs review, rejected, hunt pool), blockers, and the single next action. Prefer this over several status calls in cron jobs.",
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

        const [master] = await db
          .select({
            total: sql<number>`count(*)::int`,
            withEmail: sql<number>`count(*) filter (where ${companies.hasEmail})::int`,
            needsReview: sql<number>`count(*) filter (where ${companies.status} = 'needs_review')::int`,
            rejected: sql<number>`count(*) filter (where ${companies.status} = 'rejected')::int`,
            huntPool: sql<number>`count(*) filter (where ${companies.website} is not null and ${companies.emailHuntAttempts} < 2 and not exists (select 1 from contacts k where k.company_id = ${companies.id} and k.email is not null))::int`,
          })
          .from(companies);

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
          master: {
            totalCompanies: Number(master?.total ?? 0),
            withEmail: Number(master?.withEmail ?? 0),
            needsReview: Number(master?.needsReview ?? 0),
            rejected: Number(master?.rejected ?? 0),
            huntPool: Number(master?.huntPool ?? 0),
          },
          blockers,
          suggestedAction,
        };
      },
    },
  ];
}
