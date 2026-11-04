import type { SinkAdapterDefinition, SourceAdapterDefinition } from "@src/adapters/types";
import type { LinkedInCredentials, ResearchDeps } from "@src/harness/research-deps";
import type { ResolvedSource } from "@src/harness/source-resolver";
import type { StageRunner, StageSampling } from "@src/harness/stages";

export interface ProgressEvent {
  stage: "plan" | "scrape" | "extract" | "harvest" | "persist" | "sync" | "turn" | "done" | "error";
  message: string;
  data?: unknown;
  detail?: Record<string, unknown>;
  durationMs?: number;
}

export interface GoalLoopDeps {
  stages: StageRunner;
  sources: ResolvedSource[];
  sinkAdapter?: Pick<SinkAdapterDefinition, "write" | "type">;
  research?: ResearchDeps;
  onProgress?: (event: ProgressEvent) => void;
  shouldCancel?: () => boolean;
  shouldPause?: () => boolean;
  onRunStarted?: (runId: string) => void;
}

export interface GoalLoopOptions {
  campaignId: string;
  userId: string;
  trigger: "schedule" | "manual";
  goalNewReadyLeads: number;
  maxTurns?: number | null;
  maxWallClockHours?: number;
  alreadyUsedCostUsd?: number;
  resume?: boolean;
  runId?: string;
}

export type RunStatus = "succeeded" | "goal-unmet" | "budget-exhausted" | "failed" | "cancelled" | "already-running";

export interface RunFailure {
  stage: ProgressEvent["stage"] | "run";
  code: string;
  message: string;
}

export interface GoalLoopResult {
  status: RunStatus;
  reason?: string;
  runId: string;
  turnsUsed: number;
  costUsdUsed: number;
  newReadyLeads: number;
  totalReadyLeads: number;
  errors: RunFailure[];
}

export type { LinkedInCredentials, ResearchDeps, SinkAdapterDefinition, SourceAdapterDefinition, StageRunner, StageSampling };
