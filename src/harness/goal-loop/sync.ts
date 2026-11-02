import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { leads } from "@src/db/schema";
import { findReadyLeadIds, findReadyLeads, markLeadsSynced } from "@src/harness/persistence";
import { resolveSinkForCampaign, type ResolvedSink } from "@src/harness/sink-resolver";
import type { GoalLoopOptions, ProgressEvent } from "@src/harness/goal-loop/types";

export async function syncReadyLeads(
  options: GoalLoopOptions,
  runId: string,
  deps: {
    readonly sinkAdapter?: { write: (leads: never, ctx: never) => Promise<unknown>; type: string };
    readonly emit: (event: ProgressEvent) => void;
  },
): Promise<number> {
  const pendingLeads = await findReadyLeads(options.campaignId);
  if (pendingLeads.length === 0) return 0;

  const resolved: ResolvedSink = await resolveSinkForCampaign(options.campaignId);
  const sinkResult = await resolved.adapter.write(
    pendingLeads as never,
    {
      userId: options.userId,
      runId,
      credentials: resolved.credentials,
    } as never,
  );

  const readyIds = await db.select({ id: leads.id }).from(leads).where(eq(leads.campaignId, options.campaignId));
  await markLeadsSynced(await findReadyLeadIds(options.campaignId));

  deps.emit({ stage: "sync", message: `${pendingLeads.length} contact rows → ${sinkResult.targetLocation}` });
  return pendingLeads.length;
}
