import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { enqueueRun } from "@src/harness/run-queue";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

interface CampaignRow {
  id: string;
  name: string;
  maxTurnsPerRun: number | null;
}

type ToolContextWithRequest = {
  requestContext?: { get?: (key: string) => unknown };
};

export const runCampaignTool = createTool({
  id: "run-campaign",
  description:
    "Run the user's prospecting campaign as a background job: searches, harvests company contacts, and stores prospect rows. It runs in the background — the acknowledgement tells you it started; when it completes you will receive the result to summarize. Call this immediately whenever the user asks to run a campaign or find leads. Do NOT ask for a campaign ID first. If campaignId is omitted, the user's most recent campaign is used automatically.",
  inputSchema: z.object({
    campaignId: z.string().uuid().optional(),
    goalNewQualifiedLeads: z.number().int().min(1).max(50).optional(),
    resume: z.boolean().optional().describe("Resume a paused run instead of starting a fresh one"),
    goalIsProspectRows: z.boolean().nullish().describe("Deprecated: the goal always counts prospect rows now"),
  }),
  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      return {
        ok: false as const,
        error: "no authenticated user on this conversation",
      };
    }

    let campaign: CampaignRow | undefined;
    if (inputData.campaignId) {
      const [row] = await db
        .select({
          id: campaigns.id,
          name: campaigns.name,
          maxTurnsPerRun: campaigns.maxTurnsPerRun,
        })
        .from(campaigns)
        .where(eq(campaigns.id, inputData.campaignId));

      if (!row) {
        return { ok: false as const, error: `campaign ${inputData.campaignId} not found for this user` };
      }

      campaign = { ...row };
    } else {
      const rows = await db
        .select({
          id: campaigns.id,
          name: campaigns.name,
          maxTurnsPerRun: campaigns.maxTurnsPerRun,
        })
        .from(campaigns)
        .orderBy(desc(campaigns.createdAt));

      if (rows.length === 0) {
        return {
          ok: false as const,
          error: "the user has no campaigns yet; ask them to create one on the Campaigns page",
        };
      }

      if (rows.length > 1) {
        return {
          ok: false as const,
          needsChoice: true as const,
          campaigns: rows.map((r) => ({ id: r.id, name: r.name })),
          error: "multiple campaigns exist; ask the user which one to run",
        };
      }

      const only = rows[0];
      if (!only) {
        return {
          ok: false as const,
          error: "the user has no campaigns yet; ask them to create one on the Campaigns page",
        };
      }

      campaign = { ...only };
    }

    if (!campaign) {
      return { ok: false as const, error: "no campaign selected" };
    }

    const { id: queueId, created } = await enqueueRun({
      campaignId: campaign.id,
      trigger: "chat",
      request: {
        userId,
        goalNewReadyLeads: inputData.goalNewQualifiedLeads ?? 3,
        maxTurns: campaign.maxTurnsPerRun ?? null,
        resume: inputData.resume === true,
      },
    });

    return {
      ok: true,
      campaignName: campaign.name,
      campaignId: campaign.id,
      queueId,
      status: created ? ("queued" as const) : ("already-active" as const),
      note: created
        ? "run queued as a background job; poll run status or the campaign page for progress"
        : "a run is already active for this campaign; no new job was queued",
    };
  },
});
