import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";
import { getQueryYields } from "@src/harness/persistence";

const PLANNER_SAMPLE_LIMIT = 40;

export interface LedgerInsight {
  exhausted: string[];
  productive: { query: string; leads: number }[];
  exclusions: string[];
}

export async function assembleLedgerInsights(campaignId: string): Promise<LedgerInsight> {
  const yields = await getQueryYields(campaignId);
  const exhausted = [...yields.entries()].filter(([, y]) => y.crawled >= 2 && y.ready === 0).map(([q]) => q);
  const productive = [...yields.entries()]
    .filter(([, y]) => y.ready > 0)
    .sort((a, b) => b[1].ready - a[1].ready)
    .slice(0, 5)
    .map(([query, y]) => ({ query, leads: y.ready }));

  const [campaign] = await db.select({ exclusions: campaigns.exclusions }).from(campaigns).where(eq(campaigns.id, campaignId));

  return { exhausted, productive, exclusions: campaign?.exclusions ?? [] };
}

export async function ledgerSampleForPrompt(campaignId: string, limit = PLANNER_SAMPLE_LIMIT): Promise<string> {
  const { searchLedgerForCampaign } = await import("@src/harness/persistence");
  const ledger = await searchLedgerForCampaign(campaignId, limit);
  if (ledger.length === 0) return "";
  return ledger
    .slice()
    .reverse()
    .map((r) => `"${r.query}" → ${r.resultCount} results, ${r.leadsProduced} leads (${r.backend})`)
    .join("; ");
}
