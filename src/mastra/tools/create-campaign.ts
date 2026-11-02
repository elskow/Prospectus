import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { z } from "zod";

type ToolContextWithRequest = {
  requestContext?: { get?: (key: string) => unknown };
};

export const createCampaignTool = createTool({
  id: "create-campaign",
  description:
    "Create a new prospecting campaign for the current user: a niche (what businesses to hunt), an area, optional notes and exclusions, and a daily lead goal. The campaign starts in active status. Call this when the user describes a new hunt to set up.",
  inputSchema: z.object({
    name: z.string().min(1),
    niche: z.string().min(1).describe("What businesses to hunt, e.g. 'konsultan pajak di Surabaya' or 'pabrik furniture Jepara'"),
    area: z.string().nullish().describe("Geography to search within"),
    notes: z.string().nullish().describe("Free-text guidance for query planning; never gates"),
    exclusions: z.array(z.string()).nullish().describe("Business types to exclude, e.g. ['warkop', 'warung kopi']"),
    dailyLeadGoal: z.number().int().min(1).optional(),
  }),

  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      return {
        ok: false as const,
        error: "no authenticated user on this conversation",
      };
    }

    const [created] = await db
      .insert(campaigns)
      .values({
        userId,
        name: inputData.name,
        niche: inputData.niche,
        area: inputData.area ?? null,
        notes: inputData.notes ?? null,
        exclusions: inputData.exclusions ?? [],
        status: "active",
        ...(inputData.dailyLeadGoal !== undefined ? { dailyLeadGoal: inputData.dailyLeadGoal } : {}),
      })
      .returning({ id: campaigns.id, name: campaigns.name });

    if (!created) {
      return {
        ok: false as const,
        error: "failed to create campaign",
      };
    }

    return {
      ok: true as const,
      campaign: created,
    };
  },
});
