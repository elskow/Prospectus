import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@src/db";
import { markets } from "@src/db/schema";
import { neighbouringCities, observedCities } from "@src/harness/geo-vocabulary";

export interface MarketRow extends Record<string, unknown> {
  id: string;
  campaignId: string;
  city: string;
  province: string | null;
  sector: string;
  status: "pending" | "active" | "saturated";
  discovered: number;
  emailed: number;
  attempts: number;
}

const MAX_MARKETS = 24;
const MIN_SATURATION_TURNS = 3;

function splitList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;/|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

export async function seedMarkets(campaignId: string, niche: string, area: string | null): Promise<number> {
  const cities = splitList(area);
  const sectors = splitList(niche);
  const cityList = cities.length > 0 ? cities : ["Indonesia"];
  const sectorList = sectors.length > 0 ? sectors : [niche];

  const pairs: { city: string; sector: string }[] = [];
  for (const city of cityList) {
    for (const sector of sectorList) {
      pairs.push({ city, sector });
      if (pairs.length >= MAX_MARKETS) break;
    }
    if (pairs.length >= MAX_MARKETS) break;
  }

  if (pairs.length === 0) return 0;

  const inserted = await db
    .insert(markets)
    .values(pairs.map((pair) => ({ campaignId, city: pair.city, sector: pair.sector })))
    .onConflictDoNothing()
    .returning({ id: markets.id });

  return inserted.length;
}

export async function ensureActiveMarket(campaignId: string, niche: string, area: string | null): Promise<MarketRow | null> {
  const [active] = await db
    .select()
    .from(markets)
    .where(and(eq(markets.campaignId, campaignId), eq(markets.status, "active")))
    .orderBy(desc(markets.lastGainAt), markets.createdAt)
    .limit(1);
  if (active) return active as MarketRow;

  await seedMarkets(campaignId, niche, area).catch(() => 0);

  const activated = await db.execute<MarketRow>(sql`
    with next as (
      select id from markets
      where campaign_id = ${campaignId} and status = 'pending'
      order by created_at
      for update skip locked
      limit 1
    )
    update markets m
    set status = 'active', attempts = m.attempts + 1, updated_at = now()
    from next
    where m.id = next.id
    returning m.*
  `);
  return (activated as unknown as MarketRow[])[0] ?? null;
}

export async function advanceMarket(campaignId: string): Promise<MarketRow | null> {
  await db
    .update(markets)
    .set({ status: "saturated", updatedAt: new Date() })
    .where(and(eq(markets.campaignId, campaignId), eq(markets.status, "active")));

  const activated = await db.execute<MarketRow>(sql`
    with next as (
      select id from markets
      where campaign_id = ${campaignId} and status = 'pending'
      order by created_at
      for update skip locked
      limit 1
    )
    update markets m
    set status = 'active', attempts = m.attempts + 1, updated_at = now()
    from next
    where m.id = next.id
    returning m.*
  `);
  return (activated as unknown as MarketRow[])[0] ?? null;
}

export async function recordMarketGain(marketId: string, discovered: number, emailed: number): Promise<void> {
  if (discovered <= 0 && emailed <= 0) return;
  await db
    .update(markets)
    .set({
      discovered: sql`${markets.discovered} + ${discovered}`,
      emailed: sql`${markets.emailed} + ${emailed}`,
      lastGainAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(markets.id, marketId));
}

export async function listMarkets(campaignId: string): Promise<MarketRow[]> {
  const rows = await db.select().from(markets).where(eq(markets.campaignId, campaignId)).orderBy(markets.createdAt);
  return rows as MarketRow[];
}

export async function countMarkets(campaignId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(markets)
    .where(eq(markets.campaignId, campaignId));
  return Number(row?.total ?? 0);
}

export interface MarketSuggestion {
  city: string;
  sector: string;
  expectedLeadsPerQuery: number | null;
  measuredQueries: number;
  basis: string;
}

export async function suggestMarkets(campaignId: string, niche: string, limit = 8): Promise<MarketSuggestion[]> {
  const existingMarkets = await listMarkets(campaignId);
  const existing = new Set(existingMarkets.map((market) => market.city.toLowerCase()));
  const active = existingMarkets.find((market) => market.status === "active")?.city ?? null;

  const rows = (await db.execute<{ query: string; leads_produced: number }>(sql`
    select query, leads_produced from query_ledger where campaign_id = ${campaignId}
  `)) as unknown as { query: string; leads_produced: number }[];

  const observed = await observedCities().catch(() => [] as string[]);
  const neighbours = active ? await neighbouringCities(active) : [];
  const pool = [...new Set([...observed, ...neighbours])].filter((city) => !existing.has(city.toLowerCase()));

  const measured = new Map<string, { leads: number; queries: number }>();
  for (const row of rows) {
    const haystack = row.query.toLowerCase();
    for (const city of pool) {
      if (!haystack.includes(city.toLowerCase())) continue;
      const entry = measured.get(city) ?? { leads: 0, queries: 0 };
      entry.leads += Number(row.leads_produced ?? 0);
      entry.queries += 1;
      measured.set(city, entry);
    }
  }

  return pool
    .map((city) => {
      const entry = measured.get(city);
      const avg = entry && entry.queries > 0 ? entry.leads / entry.queries : null;
      const fromRegistry = neighbours.some((neighbour) => neighbour.toLowerCase() === city.toLowerCase());
      return {
        city,
        sector: niche,
        expectedLeadsPerQuery: avg === null ? null : Math.round(avg * 10) / 10,
        measuredQueries: entry?.queries ?? 0,
        basis:
          avg !== null
            ? `query ledger: ${entry?.queries} queries, ${entry?.leads} leads`
            : fromRegistry
              ? `region registry: same province as ${active}`
              : "observed in company data — fresh geography",
      };
    })
    .sort((a, b) => (b.expectedLeadsPerQuery ?? 0) - (a.expectedLeadsPerQuery ?? 0))
    .slice(0, limit);
}

export async function retireMarket(
  campaignId: string,
  target: { marketId?: string; city?: string },
): Promise<{ retired: MarketRow | null; next: MarketRow | null }> {
  const [row] = await db
    .select()
    .from(markets)
    .where(
      and(eq(markets.campaignId, campaignId), target.marketId ? eq(markets.id, target.marketId) : sql`lower(${markets.city}) = lower(${target.city ?? ""})`),
    )
    .limit(1);
  if (!row) return { retired: null, next: null };

  const wasActive = row.status === "active";
  const updated = await db.update(markets).set({ status: "saturated", updatedAt: new Date() }).where(eq(markets.id, row.id)).returning();

  if (!wasActive) return { retired: (updated[0] as MarketRow | undefined) ?? null, next: null };

  const activated = await db.execute<MarketRow>(sql`
    with next as (
      select id from markets
      where campaign_id = ${campaignId} and status = 'pending'
      order by created_at
      for update skip locked
      limit 1
    )
    update markets m
    set status = 'active', attempts = m.attempts + 1, updated_at = now()
    from next
    where m.id = next.id
    returning m.*
  `);
  return {
    retired: (updated[0] as MarketRow | undefined) ?? null,
    next: (activated as unknown as MarketRow[])[0] ?? null,
  };
}

export const MAX_MARKETS_PER_CAMPAIGN = 24;

export { MIN_SATURATION_TURNS };
