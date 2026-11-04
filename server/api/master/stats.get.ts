import { defineEventHandler } from "h3";
import { sql } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { companies } from "@src/db/schema";

interface StatsShape {
  total: number;
  withEmail: number;
  needsReview: number;
  rejected: number;
  cachedAt: number;
}

let cache: StatsShape | null = null;

export default defineEventHandler(async (event) => {
  await requireUser(event);
  if (cache && Date.now() - cache.cachedAt < 60_000) {
    const { cachedAt: _cachedAt, ...stats } = cache;
    return stats;
  }

  const row = (
    await db
      .select({
        total: sql<number>`count(*)::int`,
        withEmail: sql<number>`count(*) filter (where ${companies.hasEmail})::int`,
        needsReview: sql<number>`count(*) filter (where ${companies.status} = 'needs_review')::int`,
        rejected: sql<number>`count(*) filter (where ${companies.status} = 'rejected')::int`,
      })
      .from(companies)
  )[0];

  cache = { total: row?.total ?? 0, withEmail: row?.withEmail ?? 0, needsReview: row?.needsReview ?? 0, rejected: row?.rejected ?? 0, cachedAt: Date.now() };
  const { cachedAt: _cachedAt, ...stats } = cache;
  return stats;
});
