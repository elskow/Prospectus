import { count, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { models, runs } from "@src/db/schema";
import { probeProvider } from "@src/lib/llm-gateway";
import { addProvider, defaultProvider, findProvider, listProviders, removeProvider, PROVIDER_KINDS, type ProviderView } from "@src/lib/llm-providers";
import { formatModelRef, parseModelRef } from "@src/lib/model-ref";
import { getModelSelection, setModelSelection, STAGE_KEYS, type ModelSelection, type StageKey } from "@src/lib/model-settings";
import { registerModel, syncModels } from "@src/lib/model-sync";
import { invalidArguments, ToolError } from "./errors";

interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (input: unknown) => Promise<unknown>;
}

const stageTargetSchema = z.object({
  providerId: z.string().uuid(),
  model: z.string().min(1),
});

type StageTarget = z.infer<typeof stageTargetSchema>;

async function activeRunCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(runs)
    .where(inArray(runs.status, ["queued", "running"]));
  return Number(row?.value ?? 0);
}

async function catalogCounts(): Promise<Record<string, number>> {
  const rows = await db.select({ providerId: models.providerId, value: count() }).from(models).groupBy(models.providerId);

  return Object.fromEntries(rows.map((row) => [row.providerId, Number(row.value)]));
}

function providerNotFound(providerId: string): ToolError {
  return new ToolError("PROVIDER_NOT_FOUND", `provider ${providerId} not found or disabled`);
}

function stageSelectionView(selection: ModelSelection, providers: ProviderView[]) {
  const labels = new Map(providers.map((provider) => [provider.id, provider.label]));

  return Object.fromEntries(
    STAGE_KEYS.map((stage) => {
      const parsed = parseModelRef(selection[stage]);
      return [
        stage,
        {
          ref: selection[stage],
          providerId: parsed.providerId,
          providerLabel: parsed.providerId ? (labels.get(parsed.providerId) ?? "unknown") : null,
          model: parsed.model,
        },
      ];
    }),
  );
}

export async function runLlmTools(): Promise<ToolDefinition[]> {
  return [
    {
      name: "llm_status",
      description:
        "List configured LLM providers (keys masked), the per-stage model selection, synced catalog sizes, and whether runs are active. Use before changing providers or models.",
      schema: z.object({}),
      handler: async () => {
        const [providers, selection, catalog, activeRuns] = await Promise.all([listProviders(), getModelSelection(), catalogCounts(), activeRunCount()]);

        return {
          providers: providers.map((provider) => ({
            ...provider,
            catalogModels: catalog[provider.id] ?? 0,
          })),
          selection: stageSelectionView(selection, providers),
          activeRuns,
          kinds: PROVIDER_KINDS,
        };
      },
    },
    {
      name: "llm_add_provider",
      description:
        "Add an OpenAI-compatible LLM provider. The key is encrypted at rest and never returned; only a masked hint is shown. Tries to sync the provider's model catalog immediately. Use kind '9router' for the self-hosted gateway, 'openai-compatible' for any other OpenAI-compatible endpoint.",
      schema: z
        .object({
          label: z.string().min(1),
          kind: z.enum(PROVIDER_KINDS),
          baseUrl: z.string().min(1),
          apiKey: z.string().min(1).optional(),
          keyEnv: z.string().min(1).optional(),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .refine((input) => Boolean(input.apiKey) !== Boolean(input.keyEnv), {
          message: "provide exactly one of apiKey or keyEnv",
        }),
      handler: async (input) => {
        const parsed = z
          .object({
            label: z.string().min(1),
            kind: z.enum(PROVIDER_KINDS),
            baseUrl: z.string().min(1),
            apiKey: z.string().min(1).optional(),
            keyEnv: z.string().min(1).optional(),
            headers: z.record(z.string(), z.string()).optional(),
          })
          .parse(input);

        const apiKey = parsed.apiKey ?? process.env[parsed.keyEnv ?? ""];
        if (!apiKey) throw invalidArguments(`environment variable ${parsed.keyEnv} is not set on the Prospectus MCP host`);

        const provider = await addProvider({
          label: parsed.label,
          kind: parsed.kind,
          baseUrl: parsed.baseUrl,
          apiKey,
          headers: parsed.headers,
        });

        try {
          const sync = await syncModels(provider.id);
          return { provider, sync };
        } catch (error) {
          return {
            provider,
            sync: null,
            syncError: error instanceof Error ? error.message : "model sync failed",
          };
        }
      },
    },
    {
      name: "llm_sync_models",
      description: "Refresh the model catalog for one provider from its /models endpoint. Fails when the endpoint does not expose a model list.",
      schema: z.object({ providerId: z.string().uuid() }),
      handler: async (input) => {
        const { providerId } = z.object({ providerId: z.string().uuid() }).parse(input);
        const provider = await findProvider(providerId);
        if (!provider) throw providerNotFound(providerId);
        return syncModels(providerId);
      },
    },
    {
      name: "llm_test",
      description:
        "Probe one provider/model with a tiny completion and a JSON-schema request. Returns ok, latency, whether response_format json_schema is supported, and the error when the call fails.",
      schema: z.object({ providerId: z.string().uuid(), model: z.string().min(1) }),
      handler: async (input) => {
        const { providerId, model } = z.object({ providerId: z.string().uuid(), model: z.string().min(1) }).parse(input);
        const provider = await findProvider(providerId);
        if (!provider) throw providerNotFound(providerId);
        return probeProvider(provider, model);
      },
    },
    {
      name: "llm_set_stages",
      description:
        "Set the model used by the planner, extractor, or chat stage. Each stage takes a providerId and model. The model is probed before applying and registered if the provider lacks /models. Additional runs pick up the change on their next call.",
      schema: z.object({
        planner: stageTargetSchema.optional(),
        extractor: stageTargetSchema.optional(),
        chat: stageTargetSchema.optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            planner: stageTargetSchema.optional(),
            extractor: stageTargetSchema.optional(),
            chat: stageTargetSchema.optional(),
          })
          .parse(input);

        const targets = Object.entries(parsed).filter((entry): entry is [StageKey, StageTarget] => Boolean(entry[1]));
        if (targets.length === 0) throw invalidArguments("provide at least one stage");

        const warnings: string[] = [];
        const current = await getModelSelection();
        const next: ModelSelection = { ...current };

        for (const [stage, target] of targets) {
          const provider = await findProvider(target.providerId);
          if (!provider) throw providerNotFound(target.providerId);

          const probe = await probeProvider(provider, target.model);
          if (!probe.ok) {
            throw new ToolError("PROBE_FAILED", `${provider.label}/${target.model}: ${probe.error ?? "completion failed"}`);
          }

          if (!probe.jsonSchema) {
            warnings.push(`${provider.label}/${target.model} rejected response_format json_schema; structured stages fall back to prompt-injected JSON`);
          }

          await registerModel(provider.id, target.model);
          next[stage] = formatModelRef(provider.id, target.model);
        }

        const before = await activeRunCount();
        if (before > 0) {
          warnings.push(`${before} active run(s) will switch model on their next call`);
        }

        await setModelSelection(next);

        return {
          applied: next,
          selection: stageSelectionView(next, await listProviders()),
          warnings,
          activeRuns: before,
        };
      },
    },
    {
      name: "llm_remove_provider",
      description: "Remove a provider and its synced models. Refuses while any stage uses it or when it is the last provider.",
      schema: z.object({ providerId: z.string().uuid(), confirm: z.literal(true) }),
      handler: async (input) => {
        const { providerId } = z.object({ providerId: z.string().uuid(), confirm: z.literal(true) }).parse(input);
        const providers = await listProviders();
        if (!providers.some((provider) => provider.id === providerId)) throw providerNotFound(providerId);
        if (providers.length === 1) throw new ToolError("LAST_PROVIDER", "cannot remove the only configured provider");

        const selection = await getModelSelection();
        const fallbackProviderId = (await defaultProvider())?.id ?? null;
        const usedBy = STAGE_KEYS.filter((stage) => {
          const selected = parseModelRef(selection[stage]).providerId;
          return (selected ?? fallbackProviderId) === providerId;
        });
        if (usedBy.length > 0) {
          throw new ToolError("PROVIDER_IN_USE", `provider is selected for: ${usedBy.join(", ")}; switch those stages first`);
        }

        await removeProvider(providerId);
        return { providerId, removed: true };
      },
    },
  ];
}
