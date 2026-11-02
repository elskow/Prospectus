import { db } from "@src/db";
import { queryLedger, sources } from "@src/db/schema";
import { and, desc, eq } from "drizzle-orm";

export async function recordQueryLedger(entry: {
  campaignId: string;
  query: string;
  queryNorm: string;
  backend: string;
  resultCount: number;
  runId: string | null;
}): Promise<void> {
  await db.insert(queryLedger).values(entry);
}

export async function searchLedgerForCampaign(
  campaignId: string,
  limit = 80,
): Promise<{ query: string; resultCount: number; leadsProduced: number; backend: string; createdAt: Date }[]> {
  return await db
    .select({
      query: queryLedger.query,
      resultCount: queryLedger.resultCount,
      leadsProduced: queryLedger.leadsProduced,
      backend: queryLedger.backend,
      createdAt: queryLedger.createdAt,
    })
    .from(queryLedger)
    .where(eq(queryLedger.campaignId, campaignId))
    .orderBy(desc(queryLedger.createdAt))
    .limit(limit);
}

export async function ensureSource(adapterType: string, query: string): Promise<string> {
  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.adapterType, adapterType), eq(sources.query, query)));
  if (existing) {
    await db.update(sources).set({ lastScrapedAt: new Date() }).where(eq(sources.id, existing.id));
    return existing.id;
  }

  const createdRows = await db.insert(sources).values({ adapterType, query, lastScrapedAt: new Date() }).returning({ id: sources.id });

  const created = createdRows[0];
  if (!created) throw new Error("source insert returned no rows");

  return created.id;
}
