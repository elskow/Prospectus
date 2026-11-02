import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns, leads } from "@src/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

type ToolContextWithRequest = {
  requestContext?: { get?: (key: string) => unknown };
};

export const listCampaignsTool = createTool({
  id: "list-campaigns",
  description:
    "List the current user's lead generation campaigns with their status, daily lead goal, and qualified/total lead counts. Call this when the user asks what campaigns exist or wants an overview before running one.",
  inputSchema: z.object({}),

  execute: async (_inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      return {
        ok: false as const,
        error: "no authenticated user on this conversation",
      };
    }

    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        dailyLeadGoal: campaigns.dailyLeadGoal,
        totalLeads: sql<number>`count(${leads.id})::int`,
        qualifiedLeads: sql<number>`count(${leads.id}) filter (where ${leads.status} = 'qualified')::int`,
      })
      .from(campaigns)
      .leftJoin(leads, eq(leads.campaignId, campaigns.id))
      .where(eq(campaigns.status, "active"))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt));

    return {
      ok: true as const,
      campaigns: rows,
    };
  },
});
