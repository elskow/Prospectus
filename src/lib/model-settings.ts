import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { appSettings, models } from "@src/db/schema";
import { defaultProvider, findProvider } from "@src/lib/llm-providers";
import { parseModelRef } from "@src/lib/model-ref";

export const STAGE_KEYS = ["planner", "extractor"] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

export const modelSelectionSchema = z.object({
  planner: z.string().min(1),
  extractor: z.string().min(1),
});

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const MODEL_SETTINGS_KEY = "model-selection";

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  planner: "ht/bandelbanget/deepseek-v4.1-flash",
  extractor: "ht/bandelbanget/deepseek-v4.1-flash",
};

let selectionCache: { value: ModelSelection; expiresAt: number } | null = null;
const SELECTION_CACHE_TTL_MS = 15_000;

export async function getModelSelection(): Promise<ModelSelection> {
  if (selectionCache && selectionCache.expiresAt > Date.now()) return selectionCache.value;
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, MODEL_SETTINGS_KEY)).limit(1);
  if (!row) return DEFAULT_MODEL_SELECTION;
  const parsed = modelSelectionSchema.safeParse(row.value);
  if (!parsed.success) return DEFAULT_MODEL_SELECTION;
  selectionCache = { value: parsed.data, expiresAt: Date.now() + SELECTION_CACHE_TTL_MS };
  return parsed.data;
}

export function setCachedModelSelection(selection: ModelSelection): void {
  selectionCache = { value: selection, expiresAt: Date.now() + SELECTION_CACHE_TTL_MS };
}

export function getSyncModelSelection(): ModelSelection {
  return selectionCache?.value ?? DEFAULT_MODEL_SELECTION;
}

export async function primeModelSelectionCache(): Promise<void> {
  selectionCache = null;
  await getModelSelection();
}

async function knownModel(ref: string): Promise<boolean> {
  const parsed = parseModelRef(ref);
  const provider = parsed.providerId ? await findProvider(parsed.providerId) : await defaultProvider();
  if (!provider) return false;

  const [row] = await db
    .select({ id: models.id })
    .from(models)
    .where(and(eq(models.providerId, provider.id), eq(models.id, parsed.model)))
    .limit(1);

  return Boolean(row);
}

export async function setModelSelection(selection: ModelSelection): Promise<void> {
  for (const stage of STAGE_KEYS) {
    if (!(await knownModel(selection[stage]))) {
      throw new Error(`model "${selection[stage]}" is not in the synced provider catalog; sync models first`);
    }
  }
  await db
    .insert(appSettings)
    .values({ key: MODEL_SETTINGS_KEY, value: selection, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: selection, updatedAt: new Date() } });
  setCachedModelSelection(selection);
}

export interface StagePricing {
  inputPerM: number;
  outputPerM: number;
}

const FALLBACK_PRICING: StagePricing = { inputPerM: 0.15, outputPerM: 0.6 };

export async function getStagePricing(): Promise<Record<StageKey, StagePricing>> {
  const selection = await getModelSelection();
  const catalog = await db.select({ providerId: models.providerId, id: models.id, pricing: models.pricing }).from(models);
  const byRef = new Map(catalog.map((row) => [`${row.providerId}::${row.id}`, row.pricing]));
  const result = {} as Record<StageKey, StagePricing>;

  for (const stage of STAGE_KEYS) {
    const parsed = parseModelRef(selection[stage]);
    const provider = parsed.providerId ? await findProvider(parsed.providerId) : await defaultProvider();
    const pricing = provider ? byRef.get(`${provider.id}::${parsed.model}`) : undefined;

    result[stage] =
      pricing?.promptPerM != null && pricing?.completionPerM != null ? { inputPerM: pricing.promptPerM, outputPerM: pricing.completionPerM } : FALLBACK_PRICING;
  }

  return result;
}
