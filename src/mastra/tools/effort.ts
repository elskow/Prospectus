import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const thinkTool = createTool({
  id: "think",
  description:
    "A scratchpad for explicit reasoning with no side effects. Call it to think through what you know before acting: after receiving tool results (process what changed), before a decision (list the options and pick one with a reason), and before committing (verify every constraint is satisfied). It changes nothing and returns your thought verbatim.",
  inputSchema: z.object({
    thought: z.string().min(1).describe("The reasoning itself: rules to respect, facts collected, checks to run, or the decision just made"),
  }),

  execute: async (inputData) => {
    return { ok: true as const, thought: inputData.thought };
  },
});

const planState = new Map<string, { explanation: string; items: { step: string; status: string }[] }>();

export const updatePlanTool = createTool({
  id: "update-plan",
  description:
    "Create or rewrite your working plan: a short explanation plus ordered steps, each pending / in_progress / completed. At most one step may be in_progress. Call it whenever the plan changes materially or a step finishes — the plan persists for the whole task and keeps long work coherent.",
  inputSchema: z.object({
    explanation: z.string().describe("One or two sentences on the current strategy"),
    items: z
      .array(z.object({ step: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }))
      .min(1)
      .max(30),
  }),

  execute: async (inputData, context) => {
    const key = context?.agent?.threadId ?? context?.agent?.resourceId ?? "default";
    planState.set(key, { explanation: inputData.explanation, items: inputData.items });
    const inProgress = inputData.items.filter((i) => i.status === "in_progress").map((i) => i.step);
    if (inProgress.length > 1) {
      return {
        ok: false as const,
        error: `at most one step may be in_progress; got ${inProgress.length}: ${inProgress.join(", ")}`,
      };
    }
    return { ok: true as const, plan: inputData.items, explanation: inputData.explanation };
  },
});

export function currentPlan(agent: { threadId?: string } | null | undefined) {
  return planState.get(agent?.threadId ?? "default") ?? null;
}
