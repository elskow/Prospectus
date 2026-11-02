export class TransientSourceError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export class FatalSourceError extends Error {}

export interface BudgetState {
  turnsUsed: number;
  maxTurns: number | null;
  costUsdUsed: number;
  wallClockDeadlineMs: number | null;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

export function checkBudget(budget: BudgetState): BudgetDecision {
  if (budget.maxTurns !== null && budget.turnsUsed >= budget.maxTurns) {
    return { allowed: false, reason: `max turns reached (${budget.maxTurns})` };
  }

  if (budget.wallClockDeadlineMs !== null && Date.now() >= budget.wallClockDeadlineMs) {
    return { allowed: false, reason: "wall-clock time limit reached" };
  }

  return { allowed: true };
}
