import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { markets, runEvents } from "@src/db/schema";
import { countMarkets, listMarkets, MAX_MARKETS_PER_CAMPAIGN, retireMarket, seedMarkets, suggestMarkets } from "@src/harness/markets";
import { enqueueRun, getLatestRunView, requestRunCancel } from "@src/harness/run-queue";
import { campaignNotFound, capReached, invalidArguments, ToolError } from "../errors";
import { campaignFor, resolveUserId, spawnWorker, type ToolDefinition } from "./shared";

export async function runMarketTools(): Promise<ToolDefinition[]> {
  return [
    {
      name: "list_markets",
      description:
        "List a campaign's market queue. Each market is a city × sector unit; a run works one active market, marks it saturated when it stops producing companies with email, then advances to the next pending market.",
      schema: z.object({ campaignId: z.string().uuid().optional() }),
      handler: async (input) => {
        const { campaignId } = z.object({ campaignId: z.string().uuid().optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, campaignId);
        await seedMarkets(campaign.id, campaign.niche, campaign.area).catch(() => 0);
        const rows = await listMarkets(campaign.id);
        return {
          campaignId: campaign.id,
          markets: rows,
          summary: {
            total: rows.length,
            active: rows.filter((row) => row.status === "active").length,
            pending: rows.filter((row) => row.status === "pending").length,
            saturated: rows.filter((row) => row.status === "saturated").length,
          },
        };
      },
    },
    {
      name: "add_market",
      description:
        "Append one or many markets (city × sector) to a campaign's queue so fresh geography keeps producing new companies. The run activates the next pending market automatically once the active one saturates. Pass `cities` for bulk expansion.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        city: z.string().min(2).max(120).optional(),
        cities: z.array(z.string().min(2).max(120)).max(24).optional(),
        sector: z.string().min(2).max(160).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            city: z.string().min(2).max(120).optional(),
            cities: z.array(z.string().min(2).max(120)).max(24).optional(),
            sector: z.string().min(2).max(160).optional(),
          })
          .parse(input);
        const wanted = [...new Set([...(parsed.cities ?? []), ...(parsed.city ? [parsed.city] : [])].map((city) => city.trim()).filter(Boolean))];
        if (wanted.length === 0) throw invalidArguments("pass city or cities");

        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const total = await countMarkets(campaign.id);
        const room = MAX_MARKETS_PER_CAMPAIGN - total;
        if (room <= 0) {
          throw capReached(`campaign already has ${total} markets (cap ${MAX_MARKETS_PER_CAMPAIGN}); retire markets before adding more`);
        }

        const rows = await db
          .insert(markets)
          .values(wanted.slice(0, room).map((city) => ({ campaignId: campaign.id, city, sector: parsed.sector ?? campaign.niche })))
          .onConflictDoNothing()
          .returning({ id: markets.id, city: markets.city, sector: markets.sector, status: markets.status });

        return {
          campaignId: campaign.id,
          requested: wanted.length,
          created: rows.length,
          skippedByCap: Math.max(0, wanted.length - room),
          markets: rows,
          totalMarkets: total + rows.length,
        };
      },
    },
    {
      name: "suggest_markets",
      description:
        "Rank cities the campaign has not used yet, scored by measured query yield from the ledger. Use this when campaign_health returns suggestedAction=add_market, then pass the top cities to add_market(cities).",
      schema: z.object({ campaignId: z.string().uuid().optional(), limit: z.number().int().min(1).max(24).optional() }),
      handler: async (input) => {
        const parsed = z.object({ campaignId: z.string().uuid().optional(), limit: z.number().int().min(1).max(24).optional() }).parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const suggestions = await suggestMarkets(campaign.id, campaign.niche, parsed.limit ?? 8);
        return { campaignId: campaign.id, suggestions };
      },
    },
    {
      name: "retire_market",
      description:
        "Mark a market saturated so the run stops spending turns on it. Identify it by marketId or city. If the retired market was active, the next pending market is activated immediately.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        marketId: z.string().uuid().optional(),
        city: z.string().min(2).max(120).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({ campaignId: z.string().uuid().optional(), marketId: z.string().uuid().optional(), city: z.string().min(2).max(120).optional() })
          .parse(input);
        if (!parsed.marketId && !parsed.city) throw invalidArguments("pass marketId or city");
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const result = await retireMarket(campaign.id, { marketId: parsed.marketId, city: parsed.city });
        if (!result.retired) throw invalidArguments("market not found for this campaign");
        return { campaignId: campaign.id, retired: result.retired, activated: result.next };
      },
    },
  ];
}
