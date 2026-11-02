import { createError, defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { seedMarkets } from "@src/harness/markets";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  niche: z.string().min(1).max(300),
  area: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  exclusions: z.array(z.string().min(2).max(100)).max(50).optional(),
  dailyLeadGoal: z.number().int().min(1).max(10000).optional(),
  maxTurnsPerRun: z.number().int().min(1).max(50).optional(),
  exportMode: z.enum(["one_per_company", "all_contacts"]).optional(),
});

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const body = createSchema.parse(await readBody(event));

  const [row] = await db
    .insert(campaigns)
    .values({
      userId: user.id,
      name: body.name,
      niche: body.niche,
      area: body.area ?? null,
      notes: body.notes ?? null,
      exclusions: body.exclusions ?? [],
      status: "active",
      dailyLeadGoal: body.dailyLeadGoal ?? 100,
      maxTurnsPerRun: body.maxTurnsPerRun ?? null,
      exportMode: body.exportMode ?? "one_per_company",
    })
    .returning();

  if (row) await seedMarkets(row.id, row.niche, row.area).catch(() => 0);
  return { campaign: row };
});
