import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

interface ToolContextWithRequest {
  requestContext?: { get?: (key: string) => unknown };
}

async function resolveCampaign(campaignId: string | undefined, userId: string) {
  if (campaignId) {
    const [row] = await db
      .select({ id: campaigns.id, name: campaigns.name, exclusions: campaigns.exclusions })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    return row ?? null;
  }
  const [row] = await db
    .select({ id: campaigns.id, name: campaigns.name, exclusions: campaigns.exclusions })
    .from(campaigns)
    .where(eq(campaigns.userId, userId))
    .orderBy(desc(campaigns.createdAt))
    .limit(1);
  return row ?? null;
}

export const updateExclusionsTool = createTool({
  id: "update-exclusions",
  description:
    "Add or remove excluded business types for a campaign (e.g. 'warkop', 'small cafes', 'distributor'). Excluded types are dropped during scraping and avoided in query planning. If campaignId is omitted, the most recent campaign is used.",
  inputSchema: z.object({
    campaignId: z.string().uuid().optional(),
    add: z.array(z.string().min(2)).max(20).nullish().describe("Exclusion terms to add, e.g. ['warkop', 'kedai kopi']"),
    remove: z.array(z.string().min(2)).max(20).nullish().describe("Exclusion terms to remove (exact match, case-insensitive)"),
  }),
  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      return { ok: false as const, error: "no authenticated user on this conversation" };
    }

    const campaign = await resolveCampaign(inputData.campaignId, userId);
    if (!campaign) {
      return { ok: false as const, error: inputData.campaignId ? `campaign ${inputData.campaignId} not found` : "the user has no campaigns yet" };
    }

    const current = new Set(campaign.exclusions.map((e) => e.toLowerCase()));
    const added: string[] = [];
    const removed: string[] = [];

    for (const term of inputData.add ?? []) {
      const lower = term.trim().toLowerCase();
      if (!current.has(lower)) {
        current.add(lower);
        added.push(term.trim());
      }
    }
    for (const term of inputData.remove ?? []) {
      const lower = term.trim().toLowerCase();
      if (current.has(lower)) {
        current.delete(lower);
        removed.push(term.trim());
      }
    }

    if (added.length === 0 && removed.length === 0) {
      return {
        ok: true as const,
        campaignId: campaign.id,
        campaignName: campaign.name,
        added,
        removed,
        exclusions: campaign.exclusions,
        message: "no changes needed — those terms are already applied",
      };
    }

    const next = campaign.exclusions.filter((e) => !removed.some((r) => r.toLowerCase() === e.toLowerCase())).concat(added);

    await db.update(campaigns).set({ exclusions: next, updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));

    return {
      ok: true as const,
      campaignId: campaign.id,
      campaignName: campaign.name,
      added,
      removed,
      exclusions: next,
    };
  },
});
