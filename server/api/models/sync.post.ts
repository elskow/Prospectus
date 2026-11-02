import { createError, defineEventHandler, readBody } from "h3";
import { requireUser } from "@server/utils/auth";
import { syncModels } from "@src/lib/model-sync";
import { defaultProvider, findProvider } from "@src/lib/llm-providers";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const body = await readBody<{ providerId?: string }>(event).catch(() => null);
  const provider = body?.providerId ? await findProvider(body.providerId) : await defaultProvider();

  if (!provider) {
    throw createError({ statusCode: 422, statusMessage: "no LLM provider configured; add one first" });
  }

  try {
    const result = await syncModels(provider.id);
    return { ...result, providerId: provider.id, providerLabel: provider.label };
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: err instanceof Error ? err.message : "model sync failed" });
  }
});
