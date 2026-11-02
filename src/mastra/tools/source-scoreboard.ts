import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns, leadSources, leads, runEvents, runs, sources } from "@src/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

type ToolContextWithRequest = {
  requestContext?: { get?: (key: string) => unknown };
};

const ERROR_SAMPLE_MAX = 80;
const SAMPLES_PER_SOURCE = 3;

export const sourceScoreboardTool = createTool({
  id: "source-scoreboard",
  description:
    "Per-source performance for a campaign: how many candidates each discovery source (Google Maps, LinkedIn, Instagram, X, websearch) produced, how many qualified, and its most frequent errors. Use it to decide which sources to trust or drop before planning more discovery work.",
  inputSchema: z.object({
    campaignId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
  }),

  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      return { ok: false as const, error: "no authenticated user on this conversation" };
    }

    let campaignId = inputData.campaignId;
    if (!campaignId) {
      const owned = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.userId, userId)).orderBy(desc(campaigns.createdAt)).limit(2);
      if (owned.length === 0) return { ok: false as const, error: "the user has no campaigns yet" };
      if (owned.length > 1) {
        return {
          ok: false as const,
          needsChoice: true as const,
          error: "multiple campaigns exist; ask the user which one",
        };
      }
      campaignId = owned[0]?.id;
    }
    if (!campaignId) return { ok: false as const, error: "no campaign selected" };

    const [campaign] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)));
    if (!campaign) return { ok: false as const, error: `campaign ${campaignId} not found for this user` };

    let runId = inputData.runId;
    if (runId) {
      const [run] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.campaignId, campaignId)));
      if (!run) return { ok: false as const, error: `run ${runId} not found for this campaign` };
    }

    const leadAgg = await db
      .select({
        sourceId: sources.id,
        adapterType: sources.adapterType,
        query: sources.query,
        total: sql<number>`count(distinct ${leads.id})::int`,
        qualified: sql<number>`count(distinct ${leads.id}) filter (where ${leads.status} in ('qualified','synced'))::int`,
        rejected: sql<number>`count(distinct ${leads.id}) filter (where ${leads.status} = 'rejected')::int`,
      })
      .from(leadSources)
      .innerJoin(sources, eq(sources.id, leadSources.sourceId))
      .innerJoin(leads, eq(leads.id, leadSources.leadId))
      .where(eq(leads.campaignId, campaignId))
      .groupBy(sources.id, sources.adapterType, sources.query);

    const bySource = new Map<string, { label: string; query: string | null; candidatesFound: number; qualified: number; rejected: number; errors: string[] }>();
    for (const row of leadAgg) {
      const label = row.adapterType.replace(/^source:/, "");
      const key = row.query ? `${label} "${row.query}"` : label;
      const entry = bySource.get(key) ?? { label: key, query: row.query, candidatesFound: 0, qualified: 0, rejected: 0, errors: [] };
      entry.candidatesFound += row.total;
      entry.qualified += row.qualified;
      entry.rejected += row.rejected;
      bySource.set(key, entry);
    }

    const errorFilters = [
      eq(runEvents.campaignId, campaignId),
      sql`${runEvents.message} ilike any (array['%failed for%','%found 0%','%no %profiles found%','%transient on%','%fatal on%','%after retries%'])`,
    ];
    const errorRows = await db
      .select({ message: runEvents.message })
      .from(runEvents)
      .where(and(...errorFilters))
      .orderBy(desc(runEvents.createdAt))
      .limit(400);

    for (const { message } of errorRows) {
      for (const entry of bySource.values()) {
        if (matchesSource(message, entry.label)) {
          if (entry.errors.length < SAMPLES_PER_SOURCE && !entry.errors.some((e) => e === message.slice(0, ERROR_SAMPLE_MAX))) {
            entry.errors.push(message.slice(0, ERROR_SAMPLE_MAX));
          }
        }
      }
    }

    const scoreboard = [...bySource.values()]
      .map((e) => ({
        source: e.label,
        candidatesFound: e.candidatesFound,
        qualified: e.qualified,
        rejected: e.rejected,
        qualifiedRate: e.candidatesFound > 0 ? Math.round((e.qualified / e.candidatesFound) * 100) / 100 : 0,
        errorSamples: e.errors,
      }))
      .sort((a, b) => b.qualified - a.qualified || b.candidatesFound - a.candidatesFound);

    if (scoreboard.length === 0) {
      return { ok: true as const, campaignId, scoreboard: [], note: "no leads discovered yet for this campaign" };
    }
    return { ok: true as const, campaignId, ...(runId ? { runId } : {}), scoreboard };
  },
});

function matchesSource(message: string, label: string): boolean {
  const short = label.split(" ")[0]?.toLowerCase() ?? label.toLowerCase();
  if (message.toLowerCase().includes(short)) return true;
  if (short.includes("google") && /maps|places/i.test(message)) return true;
  if (short.includes("instagram") && /instagram|profile/i.test(message)) return true;
  return false;
}
