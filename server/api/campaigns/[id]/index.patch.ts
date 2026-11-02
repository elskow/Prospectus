import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { seedMarkets } from "@src/harness/markets";

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  niche: z.string().min(1).max(300).optional(),
  area: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  exclusions: z.array(z.string().min(2).max(100)).max(50).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  dailyLeadGoal: z.number().int().min(1).max(10000).optional(),
  maxTurnsPerRun: z.number().int().min(1).max(50).nullish(),
  exportMode: z.enum(["one_per_company", "all_contacts"]).optional(),
  scheduleEnabled: z.boolean().optional(),
  scheduleIntervalHours: z.number().int().min(1).max(24).optional(),
  sinkConfig: z
    .object({
      googleSheets: z
        .object({
          spreadsheetId: z.string().min(10).max(200).optional(),
          sheetName: z.string().min(1).max(100).optional(),
        })
        .optional(),
    })
    .optional(),
});

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const body = updateSchema.parse(await readBody(event));

  const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };

  const [row] = await db
    .update(campaigns)
    .set(updates as never)
    .where(eq(campaigns.id, id))
    .returning();
  if (!row) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  if (body.niche || body.area !== undefined) {
    await seedMarkets(row.id, row.niche, row.area).catch(() => 0);
  }
  return { campaign: row };
});
