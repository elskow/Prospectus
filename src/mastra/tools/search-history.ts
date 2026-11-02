import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { searchLedgerForCampaign } from "@src/harness/persistence";

interface ToolContextWithRequest {
  requestContext?: { get?: (key: string) => unknown };
}

export const searchHistoryTool = createTool({
  id: "search-history",
  description:
    "Show the search queries a campaign has already run, most recent first, with result counts and leads produced. Use it to see which angles are burned before proposing new queries or diagnosing why a run finds nothing. If campaignId is omitted, the most recent campaign is used.",
  inputSchema: z.object({
    campaignId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    campaignId: z.string(),
    campaignName: z.string(),
    totalQueries: z.number(),
    queries: z.array(
      z.object({
        query: z.string(),
        backend: z.string(),
        resultCount: z.number(),
        leadsProduced: z.number(),
        ranAt: z.string(),
      }),
    ),
  }),
  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("no authenticated user");
    }

    let campaignId = inputData.campaignId;
    if (!campaignId) {
      const [row] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.userId, userId)).orderBy(desc(campaigns.createdAt)).limit(1);
      campaignId = row?.id;
    }
    if (!campaignId) {
      throw new Error("the user has no campaigns yet");
    }

    const [campaign] = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.id, campaignId));
    if (!campaign) {
      throw new Error(`campaign ${campaignId} not found`);
    }

    const rows = await searchLedgerForCampaign(campaign.id, inputData.limit ?? 80);

    return {
      ok: true as const,
      campaignId: campaign.id,
      campaignName: campaign.name,
      totalQueries: rows.length,
      queries: rows.map((r) => ({
        query: r.query,
        backend: r.backend,
        resultCount: r.resultCount,
        leadsProduced: r.leadsProduced,
        ranAt: r.createdAt.toISOString(),
      })),
    };
  },
});
