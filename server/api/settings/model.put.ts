import { defineEventHandler, readValidatedBody, createError } from "h3";
import { requireUser } from "@server/utils/auth";
import { getModelSelection, modelSelectionSchema, setModelSelection } from "@src/lib/model-settings";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const parsed = await readValidatedBody(event, modelSelectionSchema.safeParse);
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: "invalid model selection" });
  }
  try {
    await setModelSelection(parsed.data);
  } catch (err) {
    throw createError({ statusCode: 422, statusMessage: err instanceof Error ? err.message : "model selection rejected" });
  }
  return { selection: await getModelSelection() };
});
