import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@src/db";
import { models } from "@src/db/schema";
import { findProvider, type ResolvedProvider } from "@src/lib/llm-providers";

export interface RouterModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: { vision?: boolean; reasoning?: boolean; tools?: boolean };
  pricing?: { prompt?: number; completion?: number };
}

export interface ModelSyncResult {
  fetched: number;
  upserted: number;
  syncedAt: string;
}

export async function fetchProviderModels(provider: ResolvedProvider): Promise<RouterModelEntry[]> {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.headers },
  });

  if (!response.ok) {
    throw new Error(`model listing failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { data?: RouterModelEntry[] };

  return body.data ?? [];
}

function normalize(providerId: string, entry: RouterModelEntry) {
  return {
    providerId,
    id: entry.id,
    ownedBy: entry.owned_by ?? "unknown",
    contextLength: entry.context_length ?? null,
    maxCompletionTokens: entry.max_completion_tokens ?? null,
    capabilities: {
      vision: entry.capabilities?.vision ?? false,
      reasoning: entry.capabilities?.reasoning ?? false,
      tools: entry.capabilities?.tools ?? false,
    },
    pricing: {
      promptPerM: entry.pricing?.prompt,
      completionPerM: entry.pricing?.completion,
    },
    isCombo: entry.owned_by === "combo" && !entry.id.includes("/"),
    syncedAt: new Date(),
  };
}

export async function registerModel(providerId: string, model: string): Promise<void> {
  const syncedAt = new Date();
  await db
    .insert(models)
    .values({ providerId, id: model, ownedBy: "manual", syncedAt })
    .onConflictDoUpdate({ target: [models.providerId, models.id], set: { syncedAt } });
}

export async function syncModels(providerId: string): Promise<ModelSyncResult> {
  const provider = await findProvider(providerId);
  if (!provider) throw new Error("provider not found or disabled");

  const entries = await fetchProviderModels(provider);
  const startedAt = new Date();
  const rows = entries.map((entry) => normalize(providerId, entry));

  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    await db
      .insert(models)
      .values(chunk)
      .onConflictDoUpdate({
        target: [models.providerId, models.id],
        set: {
          ownedBy: sql`excluded.owned_by`,
          contextLength: sql`excluded.context_length`,
          maxCompletionTokens: sql`excluded.max_completion_tokens`,
          capabilities: sql`excluded.capabilities`,
          pricing: sql`excluded.pricing`,
          isCombo: sql`excluded.is_combo`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }

  await db.delete(models).where(and(eq(models.providerId, providerId), lt(models.syncedAt, startedAt)));

  return { fetched: entries.length, upserted: rows.length, syncedAt: new Date().toISOString() };
}
