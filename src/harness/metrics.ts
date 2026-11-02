import { and, eq, sql } from "drizzle-orm";
import { db } from "@src/db";
import { campaigns, contacts, leads, runs, suppressions } from "@src/db/schema";

export interface CampaignMetrics {
  campaignId: string;
  emails: { lastHour: number; lastDay: number; total: number };
  companies: { lastHour: number; lastDay: number; total: number };
  queries: { lastDay: number; leadsPerDay: number };
  runs: { lastDay: number; succeeded: number; failed: number; avgTurns: number };
  markets: { city: string; status: string; emailed: number; discovered: number }[];
  suppressions: number;
}

export async function campaignMetrics(campaignId: string): Promise<CampaignMetrics | null> {
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;

  const [emailCounts] = await db
    .select({
      lastHour: sql<number>`count(*) filter (where ${contacts.createdAt} > now() - interval '1 hour')::int`,
      lastDay: sql<number>`count(*) filter (where ${contacts.createdAt} > now() - interval '24 hours')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(contacts)
    .innerJoin(leads, eq(leads.companyId, contacts.companyId))
    .where(and(eq(leads.campaignId, campaignId), sql`${contacts.email} is not null`));

  const [companyCounts] = await db
    .select({
      lastHour: sql<number>`count(*) filter (where ${leads.createdAt} > now() - interval '1 hour')::int`,
      lastDay: sql<number>`count(*) filter (where ${leads.createdAt} > now() - interval '24 hours')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(leads)
    .where(eq(leads.campaignId, campaignId));

  const queryRows = (await db.execute<{ queries: number; leads: number }>(sql`
    select count(*)::int as queries, coalesce(sum(leads_produced), 0)::int as leads
    from query_ledger
    where campaign_id = ${campaignId} and created_at > now() - interval '24 hours'
  `)) as unknown as { queries: number; leads: number }[];
  const queryCounts = queryRows[0];

  const [runCounts] = await db
    .select({
      lastDay: sql<number>`count(*) filter (where ${runs.startedAt} > now() - interval '24 hours')::int`,
      succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
    })
    .from(runs)
    .where(eq(runs.campaignId, campaignId));

  const [turnCounts] = await db
    .select({ avgTurns: sql<number>`coalesce(avg(${runs.turns}), 0)::float` })
    .from(runs)
    .where(and(eq(runs.campaignId, campaignId), sql`${runs.startedAt} > now() - interval '24 hours'`));

  const marketRows = (await db.execute<{ city: string; status: string; emailed: number; discovered: number }>(sql`
    select city, status, emailed, discovered from markets where campaign_id = ${campaignId} order by created_at
  `)) as unknown as { city: string; status: string; emailed: number; discovered: number }[];

  const [suppressionCount] = await db.select({ total: sql<number>`count(*)::int` }).from(suppressions);

  return {
    campaignId,
    emails: { lastHour: Number(emailCounts?.lastHour ?? 0), lastDay: Number(emailCounts?.lastDay ?? 0), total: Number(emailCounts?.total ?? 0) },
    companies: { lastHour: Number(companyCounts?.lastHour ?? 0), lastDay: Number(companyCounts?.lastDay ?? 0), total: Number(companyCounts?.total ?? 0) },
    queries: { lastDay: Number(queryCounts?.queries ?? 0), leadsPerDay: Number(queryCounts?.leads ?? 0) },
    runs: {
      lastDay: Number(runCounts?.lastDay ?? 0),
      succeeded: Number(runCounts?.succeeded ?? 0),
      failed: Number(runCounts?.failed ?? 0),
      avgTurns: Math.round((turnCounts?.avgTurns ?? 0) * 10) / 10,
    },
    markets: marketRows,
    suppressions: Number(suppressionCount?.total ?? 0),
  };
}
