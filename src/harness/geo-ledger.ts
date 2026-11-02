import { and, eq, sql } from "drizzle-orm";
import { db } from "@src/db";
import { companies, geoCells } from "@src/db/schema";
import { cellCenter, cellsForRegion, isInsideCell } from "@src/harness/geo-cells";
import geohash from "ngeohash";

const EMPTY_DONE_THRESHOLD = 2;

const MAX_ACTIVE_CELLS = 6;

export function nicheNormOf(niche: string, area: string | null): string {
  return `${niche} ${area ?? ""}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index] ?? 0;
}

function boundedBox(points: { lat: number; lng: number }[]): { south: number; west: number; north: number; east: number } | null {
  if (points.length === 0) return null;
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const low = points.length >= 20 ? 0.1 : 0;
  const high = points.length >= 20 ? 0.9 : 1;
  const south = percentile(lats, low);
  const north = percentile(lats, high);
  const west = percentile(lngs, low);
  const east = percentile(lngs, high);
  const padLat = Math.max((north - south) * 0.2, 0.01);
  const padLng = Math.max((east - west) * 0.2, 0.01);
  return { south: south - padLat, west: west - padLng, north: north + padLat, east: east + padLng };
}

export async function regionFromCampaign(
  campaignId: string,
  area?: string | null,
): Promise<{ south: number; west: number; north: number; east: number } | null> {
  const rows = await db
    .select({ lat: companies.latitude, lng: companies.longitude, city: companies.city, address: companies.address })
    .from(companies)
    .where(
      and(
        sql`${companies.latitude} is not null`,
        sql`${companies.longitude} is not null`,
        sql`exists (select 1 from leads l where l.company_id = ${companies.id} and l.campaign_id = ${campaignId})`,
      ),
    );

  const points = rows.filter((row): row is { lat: number; lng: number; city: string | null; address: string | null } => row.lat !== null && row.lng !== null);
  if (points.length < 3) return null;

  const needle = area?.trim().toLowerCase() ?? "";
  if (needle.length > 1) {
    const local = points.filter((point) => {
      const haystack = `${point.city ?? ""} ${point.address ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
    const localBox = boundedBox(local);
    if (localBox) return localBox;
  }

  return boundedBox(points);
}

const MAX_REGION_CELLS = 2000;

function choosePrecision(region: { south: number; west: number; north: number; east: number }): number {
  for (const precision of [5, 4, 3, 2]) {
    if (cellsForRegion(region, precision).length <= MAX_REGION_CELLS) return precision;
  }
  return 2;
}

export async function resolveRegion(campaignId: string, area?: string | null): Promise<{ south: number; west: number; north: number; east: number } | null> {
  return await regionFromCampaign(campaignId, area);
}

export async function pickUncoveredCells(
  campaignId: string,
  niche: string,
  area: string | null,
  region: { south: number; west: number; north: number; east: number },
): Promise<{ hash: string; lat: number; lng: number }[]> {
  const norm = nicheNormOf(niche, area);
  const precision = choosePrecision(region);
  const all = cellsForRegion(region, precision);
  const swept = await db
    .select({ cellHash: geoCells.cellHash, doneAt: geoCells.doneAt, consecutiveEmpty: geoCells.consecutiveEmpty, capHit: geoCells.capHit })
    .from(geoCells)
    .where(and(eq(geoCells.campaignId, campaignId), eq(geoCells.nicheNorm, norm)));
  const stateByHash = new Map(swept.map((s) => [s.cellHash, s]));

  const known = await db
    .select({ lat: companies.latitude, lng: companies.longitude })
    .from(companies)
    .where(and(sql`${companies.latitude} is not null`, sql`${companies.longitude} is not null`));

  const open: string[] = [];
  for (const hash of all) {
    const s = stateByHash.get(hash);
    if (!s || (!s.doneAt && s.consecutiveEmpty < EMPTY_DONE_THRESHOLD)) open.push(hash);
  }

  const refinable = open.filter((h) => (stateByHash.get(h)?.capHit ?? 0) > 0);
  const plain = open.filter((h) => !refinable.includes(h));
  const density = new Map<string, number>();
  for (const hash of plain) {
    density.set(hash, known.filter((k) => k.lat !== null && k.lng !== null && isInsideCell(hash, k.lat, k.lng)).length);
  }
  const centerLat = (region.north + region.south) / 2;
  const centerLng = (region.east + region.west) / 2;
  const distance = (hash: string) => {
    const c = cellCenter(hash);
    return Math.hypot(c.lat - centerLat, c.lng - centerLng);
  };

  const orderedPlain = [...plain].sort((a, b) => {
    const byDensity = (density.get(b) ?? 0) - (density.get(a) ?? 0);
    return byDensity !== 0 ? byDensity : distance(a) - distance(b);
  });

  const candidates = [...refinable.flatMap((h) => cellsForRegionInCell(h)), ...orderedPlain];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const h of candidates) {
    if (!seen.has(h)) {
      seen.add(h);
      result.push(h);
    }
  }
  return result.slice(0, MAX_ACTIVE_CELLS).map((hash) => ({ hash, ...cellCenter(hash) }));
}

function cellsForRegionInCell(hash: string): string[] {
  const b = geohash.decode_bbox(hash);
  return cellsForRegion({ south: b[0], west: b[1], north: b[2], east: b[3] }, hash.length + 1);
}

export async function recordCellSweep(input: {
  campaignId: string;
  niche: string;
  area: string | null;
  cellHash: string;
  newCompanies: number;
  capHit: boolean;
}): Promise<void> {
  const norm = nicheNormOf(input.niche, input.area);
  const center = cellCenter(input.cellHash);
  const [existing] = await db
    .select({ id: geoCells.id, consecutiveEmpty: geoCells.consecutiveEmpty, doneAt: geoCells.doneAt })
    .from(geoCells)
    .where(and(eq(geoCells.campaignId, input.campaignId), eq(geoCells.nicheNorm, norm), eq(geoCells.cellHash, input.cellHash)));

  const consecutiveEmpty = input.newCompanies === 0 ? (existing?.consecutiveEmpty ?? 0) + 1 : 0;
  const isDone = consecutiveEmpty >= EMPTY_DONE_THRESHOLD;

  if (existing) {
    await db
      .update(geoCells)
      .set({
        sweepCount: sql`${geoCells.sweepCount} + 1`,
        companiesFound: sql`${geoCells.companiesFound} + ${input.newCompanies}`,
        consecutiveEmpty,
        capHit: input.capHit ? sql`${geoCells.capHit} + 1` : geoCells.capHit,
        doneAt: isDone ? new Date() : existing.doneAt,
        lastSweptAt: new Date(),
      })
      .where(eq(geoCells.id, existing.id));
    return;
  }

  await db.insert(geoCells).values({
    campaignId: input.campaignId,
    nicheNorm: norm,
    cellHash: input.cellHash,
    centerLat: center.lat,
    centerLng: center.lng,
    sweepCount: 1,
    companiesFound: input.newCompanies,
    consecutiveEmpty,
    capHit: input.capHit ? 1 : 0,
    doneAt: isDone ? new Date() : null,
    lastSweptAt: new Date(),
  });
}

export async function cellCoverage(campaignId: string, niche: string, area: string | null): Promise<{ swept: number; done: number; companies: number }> {
  const norm = nicheNormOf(niche, area);
  const [row] = await db
    .select({
      swept: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${geoCells.doneAt} is not null)::int`,
      found: sql<number>`coalesce(sum(${geoCells.companiesFound}), 0)::int`,
    })
    .from(geoCells)
    .where(and(eq(geoCells.campaignId, campaignId), eq(geoCells.nicheNorm, norm)));
  return { swept: row?.swept ?? 0, done: row?.done ?? 0, companies: row?.found ?? 0 };
}

export async function companiesInCell(hash: string): Promise<number> {
  const b = geohash.decode_bbox(hash);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(companies)
    .where(and(sql`${companies.latitude} between ${b[0]} and ${b[2]}`, sql`${companies.longitude} between ${b[1]} and ${b[3]}`));
  return row?.n ?? 0;
}
