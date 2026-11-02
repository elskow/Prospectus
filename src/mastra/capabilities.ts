import type { CapabilityContext } from "@src/harness/capabilities";

export type { CapabilityContext } from "@src/harness/capabilities";

export interface ChatCapabilitySpec {
  id: string;
  costClass: "free" | "cheap" | "expensive";
  sideEffectful: boolean;
  conflictsWithActiveRun?: boolean;
  backgroundable?: boolean;
  available?: (context: CapabilityContext) => boolean;
}

export const chatCapabilitySpecs: ChatCapabilitySpec[] = [
  { id: "run-campaign", costClass: "expensive", sideEffectful: true, conflictsWithActiveRun: true, backgroundable: true },
  { id: "list-campaigns", costClass: "free", sideEffectful: false },
  { id: "create-campaign", costClass: "free", sideEffectful: true },
  { id: "lead-lookup", costClass: "free", sideEffectful: false },
  { id: "update-exclusions", costClass: "free", sideEffectful: true },
  { id: "search-history", costClass: "free", sideEffectful: false },
  { id: "update-campaign-settings", costClass: "free", sideEffectful: true },
  { id: "find-contacts", costClass: "cheap", sideEffectful: false },
  { id: "verify-email", costClass: "cheap", sideEffectful: false },
  { id: "osint-domain-lookup", costClass: "cheap", sideEffectful: false },
  { id: "web-search", costClass: "cheap", sideEffectful: false },
  { id: "read-page", costClass: "cheap", sideEffectful: false },
  { id: "think", costClass: "free", sideEffectful: false },
  { id: "update-plan", costClass: "free", sideEffectful: false },
  { id: "source-scoreboard", costClass: "free", sideEffectful: false },
  { id: "reconcile-lead", costClass: "cheap", sideEffectful: true },
  { id: "export-leads", costClass: "free", sideEffectful: false, available: (context) => context.hasSink },
];

export function buildChatTools(toolsById: Record<string, unknown>): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const spec of chatCapabilitySpecs) {
    const tool = toolsById[spec.id];
    if (tool !== undefined) tools[spec.id] = tool;
  }
  return tools;
}

export const backgroundToolConfig = {
  "run-campaign": { enabled: true, defaultDisposition: "deferred", timeoutMs: 900_000 },
} as const;
