import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { listMarkets, seedMarkets } from "@src/harness/markets";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const [campaign] = await db.select({ id: campaigns.id, niche: campaigns.niche, area: campaigns.area }).from(campaigns).where(eq(campaigns.id, id));
  if (!campaign) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  await seedMarkets(campaign.id, campaign.niche, campaign.area).catch(() => 0);
  const markets = await listMarkets(id);
  return {
    markets,
    summary: {
      total: markets.length,
      active: markets.filter((market) => market.status === "active").length,
      pending: markets.filter((market) => market.status === "pending").length,
      saturated: markets.filter((market) => market.status === "saturated").length,
    },
  };
});
