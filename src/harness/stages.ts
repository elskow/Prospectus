import type { EnrichableCompany, EnrichmentResult } from "@src/adapters/types";
import { expansionSchema, extractionSchema, queryPlanSchema, type LeadCandidate, type QueryPlan } from "@src/harness/schemas";
import { webSearchTool } from "@src/mastra/tools/web-search";
import { leadExtractorAgent, mastra, queryPlannerAgent, modelForId } from "@src/mastra";

const EXTRACTION_FALLBACK_MODEL = process.env.EXTRACTION_FALLBACK_MODEL ?? "oao/deepseek-v4.1-flash";

export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StageResult<T> {
  value: T;
  usage: StageUsage | null;
}

export interface StageSampling {
  planner: number;
  extractor: number;
}

export const DEFAULT_SAMPLING: StageSampling = {
  planner: 0.4,
  extractor: 0.2,
};

export interface StageRunner {
  planQueries(
    spec: { niche: string; area: string | null; notes: string | null; exclusions: string[] },
    acceptedInsights: string[],
    sampling: StageSampling,
  ): Promise<StageResult<QueryPlan>>;
  expandQueries(query: string, burnedStems: string[], sampling: StageSampling): Promise<StageResult<string[]>>;
  extractCandidates(artifacts: unknown[], sampling: StageSampling): Promise<StageResult<{ candidates: LeadCandidate[]; droppedCount: number }>>;
  enrichCompany(company: EnrichableCompany, siteContent: string | null, sampling: StageSampling): Promise<StageResult<EnrichmentResult>>;
}

function usageOf(result: { usage?: { inputTokens?: number; outputTokens?: number } | null }): StageUsage | null {
  const usage = result.usage;

  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return null;

  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

function guardObject<T>(result: { object?: T | undefined }, stage: string): T {
  if (result.object === undefined || result.object === null) {
    throw new Error(`${stage} returned invalid structured output`);
  }

  return result.object;
}

const AGENT_CALL_TIMEOUT_MS = 480_000;
const AGENT_CALL_RETRIES = 1;
const AGENT_RETRY_BASE_DELAY_MS = 4_000;

async function withAgentResilience<T>(stage: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= AGENT_CALL_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, AGENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      await promise;
    }
    try {
      return await call(AbortSignal.timeout(AGENT_CALL_TIMEOUT_MS));
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|timeout/i.test(message) && attempt === AGENT_CALL_RETRIES) break;
    }
  }
  throw lastError instanceof Error ? new Error(`${stage} failed: ${lastError.message}`) : new Error(`${stage} failed`);
}

export function buildMastraStages(): StageRunner {
  return {
    async expandQueries(query, burnedStems, sampling) {
      const prompt = [
        `Original query: ${query}`,
        burnedStems.length > 0 ? `Already-tried query stems (forbidden core concepts): ${burnedStems.slice(0, 25).join("; ")}` : "No burned stems.",
      ].join("\n");

      try {
        const result = await withAgentResilience("query expansion", (signal) =>
          queryPlannerAgent.generate<{ expansions: string[] }>(prompt, {
            modelSettings: { temperature: Math.min(0.8, sampling.planner + 0.3) },
            structuredOutput: {
              schema: expansionSchema,
              jsonPromptInjection: true,
            },
            abortSignal: signal,
          } as const),
        );

        if (result.object?.expansions?.length) return { value: result.object.expansions, usage: usageOf(result) };
      } catch {
        return { value: [], usage: null };
      }

      return { value: [], usage: null };
    },

    async planQueries(spec, acceptedInsights, sampling) {
      const prompt = [
        `Campaign niche: ${spec.niche}`,
        spec.area ? `Area: ${spec.area}` : "No area constraint.",
        spec.notes ? `Stakeholder notes: ${spec.notes}` : "",
        spec.exclusions.length > 0 ? `EXCLUDED business types (never plan queries toward these): ${spec.exclusions.join("; ")}` : "",
        acceptedInsights.length > 0
          ? `Queries that previously produced leads: ${JSON.stringify(acceptedInsights)}`
          : "No leads yet: start from the most direct queries matching the niche.",
      ]
        .filter(Boolean)
        .join("\n");

      const options = {
        modelSettings: { temperature: sampling.planner },
        structuredOutput: {
          schema: queryPlanSchema,
          jsonPromptInjection: true,
        },
      } as const;

      let lastError: unknown = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await withAgentResilience("query planning", (signal) =>
            queryPlannerAgent.generate<QueryPlan>(prompt, { ...options, abortSignal: signal }),
          );
          return { value: guardObject(result, "query planning"), usage: usageOf(result) };
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError instanceof Error ? lastError : new Error("query planning failed after retry");
    },

    async extractCandidates(artifacts, sampling) {
      const generate = async (signal: AbortSignal, modelOverride?: string) => {
        const overrideModel = modelOverride ? await modelForId(modelOverride) : undefined;

        return leadExtractorAgent.generate<{ candidates: LeadCandidate[]; droppedCount: number }>(`Artifacts: ${JSON.stringify(artifacts).slice(0, 60000)}`, {
          modelSettings: { temperature: sampling.extractor },
          ...(overrideModel ? { model: overrideModel } : {}),
          structuredOutput: {
            schema: extractionSchema,
            jsonPromptInjection: true,
            errorStrategy: "fallback",
            fallbackValue: { candidates: [], droppedCount: 0 },
          },
          abortSignal: signal,
        });
      };

      const result = await (async () => {
        try {
          return await withAgentResilience("candidate extraction", (signal) => generate(signal));
        } catch (error) {
          try {
            return await withAgentResilience("candidate extraction (fallback provider)", (signal) => generate(signal, EXTRACTION_FALLBACK_MODEL));
          } catch {
            throw error;
          }
        }
      })();

      if (result.usedFallbackValue) {
        return {
          value: { candidates: [], droppedCount: 0, quarantined: true },
          usage: usageOf(result),
        };
      }

      const object = guardObject(result, "candidate extraction");

      return {
        value: { candidates: object.candidates ?? [], droppedCount: object.droppedCount ?? 0 },
        usage: usageOf(result),
      };
    },

    async enrichCompany(company, siteContent, sampling) {
      const result = await withAgentResilience("company enrichment", (signal) =>
        leadExtractorAgent.generate<{
          digitalPresence: { hasEcommerce: boolean; techSignals: string[] } | null;
        }>(
          [
            "Analyze a company's website content and report its digital presence.",
            "Return digitalPresence (ecommerce capability, tech signals). Use null when the content does not support it.",
            `Company: ${JSON.stringify({ name: company.name, website: company.website, city: company.city })}`,
            `Site content: ${siteContent ? siteContent.slice(0, 30000) : "(unavailable)"}`,
          ].join("\n"),

          {
            modelSettings: { temperature: sampling.extractor },
            structuredOutput: {
              schema: zEnrichmentAnalysis,
              jsonPromptInjection: true,
            },
            abortSignal: signal,
          },
        ),
      );

      const object = guardObject(result, "company enrichment");
      const enrichedFields: EnrichmentResult["enrichedFields"] = [];

      if (object.digitalPresence) enrichedFields.push({ field: "digitalPresence", value: object.digitalPresence, stage: "website-analysis", confidence: 0.7 });

      return {
        value: {
          status: enrichedFields.length > 0 ? (siteContent ? "complete" : "partial") : "failed",
          enrichedFields,
          warnings: siteContent ? [] : ["website content unavailable"],
        },
        usage: usageOf(result),
      };
    },
  };
}

import { z } from "zod";

const zEnrichmentAnalysis = z.object({
  digitalPresence: z
    .object({
      hasEcommerce: z.boolean(),
      techSignals: z.array(z.string()),
    })
    .nullable(),
});

export { mastra };
