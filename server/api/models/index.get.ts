import { eq } from "drizzle-orm";
import { defineEventHandler } from "h3";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { llmProviders, models } from "@src/db/schema";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const rows = await db
    .select({
      providerId: models.providerId,
      providerLabel: llmProviders.label,
      id: models.id,
      ownedBy: models.ownedBy,
      contextLength: models.contextLength,
      maxCompletionTokens: models.maxCompletionTokens,
      capabilities: models.capabilities,
      pricing: models.pricing,
      isCombo: models.isCombo,
      syncedAt: models.syncedAt,
    })
    .from(models)
    .innerJoin(llmProviders, eq(llmProviders.id, models.providerId))
    .orderBy(models.id);

  return { models: rows };
});
