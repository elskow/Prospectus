import { touchRunHeartbeat, finishRun, markRunTurns, markRunCost } from "@src/harness/persistence";
import type { BudgetState } from "@src/harness/errors";

export interface RunLifecycle {
  budget: BudgetState;
  startHeartbeat(runId: string): void;
  finish(runId: string, budget: BudgetState, runStatus: "succeeded" | "failed" | "cancelled", failureMessage?: string): Promise<void>;
}

export function createRunLifecycle(budget: BudgetState): RunLifecycle {
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  return {
    budget,
    startHeartbeat(runId: string): void {
      heartbeat = setInterval(() => {
        void touchRunHeartbeat(runId).catch(() => {});
      }, 60_000);
      heartbeat.unref?.();
    },
    async finish(runId, budget, runStatus, failureMessage): Promise<void> {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      await markRunTurns(runId, budget.turnsUsed);
      await markRunCost(runId, budget.costUsdUsed);
      await finishRun(runId, runStatus, failureMessage);
    },
  };
}
