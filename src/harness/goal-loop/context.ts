import { Context } from "effect";
import type { BudgetState } from "@src/harness/errors";
import type { StageSampling } from "@src/harness/stages";
import type { GoalLoopDeps, GoalLoopOptions, ProgressEvent, RunFailure } from "@src/harness/goal-loop/types";
import type { RunResumeState } from "@src/harness/persistence";
import type { StageKey } from "@src/lib/model-settings";
import type { HarnessTracer } from "@src/harness/tracer";
import type { KnownArtifactIndex } from "@src/harness/artifact-filter";

export class RunCost {
  constructor(
    readonly budget: BudgetState,
    private readonly rates: Record<StageKey, { inputPerM: number; outputPerM: number }>,
  ) {}

  readonly trackUsage = (stage: StageKey, usage: { inputTokens: number; outputTokens: number } | null): void => {
    if (!usage) return;
    const rate = this.rates[stage];
    this.budget.costUsdUsed += (usage.inputTokens * rate.inputPerM + usage.outputTokens * rate.outputPerM) / 1_000_000;
  };
}

export const RunCostService = Context.Service<RunCost, RunCost>()("goal-loop/RunCost");

export class RunState {
  plannedQueryNorms = new Set<string>();
  completedQueryNorms = new Set<string>();
  acceptedInsights: string[] = [];
  siteContentCache = new Map<string, string | null>();
  idleTurns = 0;
  stallTurns = 0;
  duplicatePlanStreak = 0;
  newReady = 0;
  errors: RunFailure[] = [];
  crawlState = { consecutiveDeadCrawls: 0, disabled: false };
  cellsSweptThisRun = new Set<string>();
  knownArtifacts: KnownArtifactIndex = { domains: new Set(), phones: new Set(), names: new Set() };
  sampling: StageSampling;

  constructor(sampling: StageSampling) {
    this.sampling = sampling;
  }

  cacheContent(leadId: string, content: string | null): void {
    if (this.siteContentCache.size >= 30) {
      const oldest = this.siteContentCache.keys().next().value;
      if (oldest !== undefined) this.siteContentCache.delete(oldest);
    }
    this.siteContentCache.set(leadId, content);
  }
}

export const RunStateService = Context.Service<RunState, RunState>()("goal-loop/RunState");

export class RunPorts {
  constructor(
    readonly deps: GoalLoopDeps,
    readonly options: GoalLoopOptions,
    readonly runId: string,
    readonly tracer: HarnessTracer,
    readonly state: RunState,
  ) {}

  readonly emit = (event: ProgressEvent): void => {
    this.deps.onProgress?.(event);
  };
}

export const RunPortsService = Context.Service<RunPorts, RunPorts>()("goal-loop/RunPorts");

export function recordFailure(errors: RunFailure[], stage: RunFailure["stage"], code: string, message: string): void {
  errors.push({ stage, code, message });
  if (errors.length > 200) errors.splice(0, errors.length - 200);
}

export function resumeStateOf(state: RunState, goalNewReadyLeads: number, stallTurns: number): RunResumeState {
  return {
    acceptedInsights: state.acceptedInsights,
    plannedQueryNorms: [...state.plannedQueryNorms],
    completedQueryNorms: [...state.completedQueryNorms],
    stallTurns,
    newReadyThisRun: state.newReady,
    goalNewReadyLeads,
  };
}
