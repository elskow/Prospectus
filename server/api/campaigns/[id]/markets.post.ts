import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns, markets } from "@src/db/schema";
import { eq } from "drizzle-orm";

const marketSchema = z.object({
  city: z.string().min(2).max(120),
  sector: z.string().min(2).max(160).optional(),
  province: z.string().min(2).max(120).optional(),
});

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const [campaign] = await db.select({ id: campaigns.id, niche: campaigns.niche }).from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  const body = marketSchema.parse(await readBody(event));

  const [row] = await db
    .insert(markets)
    .values({
      campaignId: campaign.id,
      city: body.city,
      province: body.province ?? null,
      sector: body.sector ?? campaign.niche,
    })
    .onConflictDoNothing()
    .returning({ id: markets.id, city: markets.city, sector: markets.sector, status: markets.status });

  if (!row) {
    setResponseStatus(event, 200);
    return { created: false };
  }

  setResponseStatus(event, 201);
  return { created: true, market: row };
});
