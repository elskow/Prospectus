import { Effect } from "effect";
import { loadSearchSettings } from "@src/harness/websearch/settings";
import type { BackendKey } from "@src/harness/websearch/types";

interface BackendStatus {
  continuousErrors: number;
  suspendedUntil: number;
  reason: string;
}

const backendStatuses = new Map<BackendKey, BackendStatus>();

const SUSPEND_WINDOWS_MS: Record<string, number> = {
  "401": 3_600_000,
  "402": 3_600_000,
  "403": 86_400_000,
  "429": 3_600_000,
};

function suspendWindow(status: number | undefined, message: string): number {
  const known = status ? SUSPEND_WINDOWS_MS[String(status)] : undefined;
  if (known) {
    return known;
  }
  if (/quota|exceeded|credit|payment/i.test(message)) {
    return 3_600_000;
  }
  if (/unauthorized|forbidden|invalid api key/i.test(message)) {
    return 86_400_000;
  }
  return 30_000;
}

interface WithStatus {
  status?: number;
}

function statusPropertyOf(error: unknown): number | undefined {
  return (error as WithStatus | null)?.status;
}

function statusFromError(error: unknown): number | undefined {
  const status = statusPropertyOf(error);
  if (typeof status === "number") {
    return status;
  }
  const match = error instanceof Error ? error.message.match(/\b(4\d\d|5\d\d)\b/) : null;
  return match ? Number(match[1]) : undefined;
}

export function tripBreaker(key: BackendKey, error: unknown): void {
  const status = backendStatuses.get(key) ?? { continuousErrors: 0, suspendedUntil: 0, reason: "" };
  status.continuousErrors += 1;
  const window = suspendWindow(statusFromError(error), error instanceof Error ? error.message : String(error));
  status.suspendedUntil = Date.now() + (status.continuousErrors > 2 ? window * 2 : window);
  status.reason = error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120);
  backendStatuses.set(key, status);
}

export function resumeBreaker(key: BackendKey): void {
  backendStatuses.set(key, { continuousErrors: 0, suspendedUntil: 0, reason: "" });
}

export function isSuspended(key: BackendKey): boolean {
  const status = backendStatuses.get(key);
  return Boolean(status && status.suspendedUntil > Date.now());
}

const DEFAULT_DAILY_BUDGET_USD = 5;

const EST_COST_PER_1K_USD: Partial<Record<BackendKey, number>> = {
  serper: 1,
  brightdata: 2.5,
  linkup: 1.5,
  exa: 5,
  tavily: 1,
  brave: 5,
};

const dailyUsage = new Map<BackendKey, { day: string; calls: number }>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export const underBudget = (key: BackendKey): Effect.Effect<boolean> =>
  Effect.flatMap(
    Effect.promise(() => loadSearchSettings()),
    (settings) =>
      Effect.sync(() => {
        const cap = settings.dailyBudgetUsd ?? DEFAULT_DAILY_BUDGET_USD;
        if (cap <= 0) {
          return true;
        }
        const unitCost = EST_COST_PER_1K_USD[key];
        if (!unitCost) {
          return true;
        }
        const day = todayKey();
        const usage = dailyUsage.get(key);
        if (!usage || usage.day !== day) {
          return true;
        }
        return (usage.calls / 1000) * unitCost < cap;
      }),
  );

export function recordCall(key: BackendKey): void {
  const day = todayKey();
  const usage = dailyUsage.get(key);
  if (!usage || usage.day !== day) {
    dailyUsage.set(key, { day, calls: 1 });
  } else {
    usage.calls += 1;
  }
}

export type RetrievalOutcome = "success" | "no_results" | "rate_limited" | "auth_error" | "blocked" | "timeout" | "provider_error";

export interface RetrievalAttempt {
  backend: string;
  outcome: RetrievalOutcome;
  resultCount: number;
  latencyMs: number;
  at: string;
}

const attemptLog: RetrievalAttempt[] = [];

const ATTEMPT_LOG_LIMIT = 500;

export function classifyOutcome(error: unknown): RetrievalOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (/rate limit|429|anomaly/i.test(message)) {
    return "rate_limited";
  }
  if (/401|unauthorized|invalid api key/i.test(message)) {
    return "auth_error";
  }
  if (/402|credit|quota|payment|exceeded/i.test(message)) {
    return "auth_error";
  }
  if (/403|forbidden|blocked|captcha/i.test(message)) {
    return "blocked";
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return "timeout";
  }
  return "provider_error";
}

export function recordAttempt(attempt: RetrievalAttempt): void {
  attemptLog.push(attempt);
  if (attemptLog.length > ATTEMPT_LOG_LIMIT) {
    attemptLog.splice(0, attemptLog.length - ATTEMPT_LOG_LIMIT);
  }
}

export function recentRetrievalAttempts(): readonly RetrievalAttempt[] {
  return attemptLog;
}
