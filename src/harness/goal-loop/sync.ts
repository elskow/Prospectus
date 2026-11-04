import { findReadyLeadsWithIds, markLeadsSynced } from "@src/harness/persistence";
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
  const pendingLeads = await findReadyLeadsWithIds(options.campaignId);
  if (pendingLeads.length === 0) return 0;

  const resolved: ResolvedSink = await resolveSinkForCampaign(options.campaignId);
  const sinkResult = await resolved.adapter.write(
    pendingLeads.map((entry) => entry.lead) as never,
    {
      userId: options.userId,
      runId,
      credentials: resolved.credentials,
    } as never,
  );

  await markLeadsSynced([...new Set(pendingLeads.map((entry) => entry.leadId))]);

  deps.emit({ stage: "sync", message: `${pendingLeads.length} contact rows → ${sinkResult.targetLocation}` });
  return pendingLeads.length;
}
