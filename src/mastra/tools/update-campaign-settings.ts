import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  dailyLeadGoal: number | null;
  maxTurnsPerRun: number | null;
  scheduleEnabled: boolean;
  niche: string;
  area: string | null;
  notes: string | null;
  exclusions: string[];
}

const toolSchema = z.object({
  campaignId: z.string().min(1),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  dailyLeadGoal: z.number().int().min(1).max(10000).optional(),
  maxTurnsPerRun: z.number().int().min(1).max(50).nullish(),
  scheduleEnabled: z.boolean().optional(),
  scheduleIntervalHours: z.number().int().min(1).max(24).optional(),
  niche: z.string().min(1).optional(),
  area: z.string().nullish(),
  notes: z.string().nullish(),
  sheetSpreadsheetId: z.string().min(10).max(200).nullish(),
  sheetName: z.string().min(1).max(100).nullish(),
});

interface ToolContextWithRequest {
  requestContext?: { get: (key: string) => unknown };
}

export const updateCampaignSettingsTool = createTool({
  id: "update-campaign-settings",
  description:
    "Adjust a campaign's settings: activate/pause/archive it, set the daily lead goal, run budgets (max turns, max cost per run), schedule toggle and interval, or re-scope it (niche, area, notes). Exclusion terms go through update-exclusions instead. Only pass the fields that should change.",
  inputSchema: toolSchema,
  outputSchema: z.object({
    ok: z.boolean(),
    campaignId: z.string(),
    campaignName: z.string(),
    updatedFields: z.array(z.string()),
    applied: z.object({
      status: z.string().nullish(),
      dailyLeadGoal: z.number().nullish(),
      maxTurnsPerRun: z.number().nullish(),
      scheduleEnabled: z.boolean().nullish(),
    }),
  }),
  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("no authenticated user");
    }

    const fields = toolSchema.parse(inputData);
    const { campaignId, sheetSpreadsheetId, sheetName, ...rest } = fields;
    const changes: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));

    if (sheetSpreadsheetId !== undefined || sheetName !== undefined) {
      changes.sinkConfig = {
        googleSheets: {
          ...(sheetSpreadsheetId ? { spreadsheetId: sheetSpreadsheetId } : {}),
          ...(sheetName ? { sheetName } : {}),
        },
      };
    }

    if (Object.keys(changes).length === 0) {
      throw new Error("no settings to change: pass at least one field to update");
    }

    const updates: Record<string, unknown> = { ...changes, updatedAt: new Date() };
    const [campaign] = await db
      .update(campaigns)
      .set(updates as never)
      .where(eq(campaigns.id, campaignId))
      .returning();

    if (!campaign) {
      throw new Error(`campaign not found: ${campaignId}`);
    }

    const row = campaign as unknown as CampaignRow;
    return {
      ok: true as const,
      campaignId: campaign.id,
      campaignName: row.name,
      updatedFields: Object.keys(changes),
      applied: {
        status: row.status,
        dailyLeadGoal: row.dailyLeadGoal,
        maxTurnsPerRun: row.maxTurnsPerRun,
        scheduleEnabled: row.scheduleEnabled,
      },
    };
  },
});
