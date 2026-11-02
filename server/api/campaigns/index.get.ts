import { defineEventHandler, getQuery } from "h3";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns, leads, runs } from "@src/db/schema";

export default defineEventHandler(async (event) => {
  const rows = await db
    .select({
      campaign: campaigns,
      totalLeads: sql<number>`count(${leads.id})::int`,
      readyLeads: sql<number>`count(${leads.id}) filter (where ${leads.status} in ('ready', 'synced'))::int`,
      lastRunAt: sql<string | null>`(
        select max(coalesce(${runs.finishedAt}, ${runs.startedAt}))::text
        from ${runs}
        where ${runs.campaignId} = ${campaigns.id}
      )`,
    })
    .from(campaigns)
    .leftJoin(leads, eq(leads.campaignId, campaigns.id))
    .groupBy(campaigns.id)
    .orderBy(desc(campaigns.createdAt));

  return {
    campaigns: rows.map((row) => ({
      ...row.campaign,
      totalLeads: row.totalLeads,
      readyLeads: row.readyLeads,
      lastRunAt: row.lastRunAt,
    })),
  };
});
